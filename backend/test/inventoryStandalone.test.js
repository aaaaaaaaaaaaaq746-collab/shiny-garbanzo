const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

/**
 * Phase 4 — non-transactional deployment.
 *
 * The production MONGO_URI points at a STANDALONE mongod, which rejects
 * multi-document transactions. These tests run against exactly that topology
 * (the default helpers.js harness) and prove the fallback is genuinely safe:
 * no oversell, no double release, no double consume, no negative counters.
 *
 * This is real database integration, not mocking.
 */

const { api, startDb, resetDb, stopDb, makeFood } = require("./helpers");
const mongoose = require("mongoose");
const inventory = require("../services/inventory");
const Order = require("../models/Order");
const Movement = require("../models/InventoryMovement");

before(startDb);
after(stopDb);
beforeEach(resetDb);

const order = (token, body) =>
  api().post("/api/orders").set("Authorization", `Bearer ${token}`).send(body);
const patchStatus = (token, id, body) =>
  api().put(`/api/orders/${id}/status`).set("Authorization", `Bearer ${token}`).send(body);
const cancel = (token, id, body = {}) =>
  api().post(`/api/orders/${id}/cancel`).set("Authorization", `Bearer ${token}`).send(body);

async function tokenFor(role) {
  const email = `${role}-${Math.random().toString(36).slice(2, 10)}@college.edu`;
  const User = require("../models/User");
  await User.create({ name: role, email, password: "password123", role });
  const res = await api().post("/api/auth/login").send({ email, password: "password123" });
  return { token: res.body.token, email };
}

async function trackedFood(stock) {
  const Food = require("../models/FoodItem");
  return Food.create({
    name: `S ${Math.random().toString(36).slice(2, 7)}`,
    price: 10,
    trackInventory: true,
    stock,
    reserved: 0,
    lowStockThreshold: 2,
  });
}

async function counters(id) {
  const Food = require("../models/FoodItem");
  const f = await Food.findById(id);
  return { stock: f.stock, reserved: f.reserved, available: f.availableQty };
}

// ======================================================== ENVIRONMENT

test("this deployment does NOT support transactions, as expected", () => {
  // Confirms the suite is genuinely exercising the non-transactional path.
  assert.equal(inventory.transactionsSupported(), false);
});

test("withOptionalTransaction runs without a session on this topology", async () => {
  // The driver does not reliably surface the topology error through
  // withTransaction, so the contract we actually depend on is asserted here:
  // no session is opened and the work still executes.
  let sawSession = "unset";
  const result = await inventory.withOptionalTransaction(async (session) => {
    sawSession = session;
    return "done";
  });

  assert.equal(sawSession, null, "no session may be created when transactions are unavailable");
  assert.equal(result.session, null);
  assert.equal(result.result, "done", "the work must still run");
});

// ================================================ SAFETY ON STANDALONE

test("concurrent orders cannot oversell without transactions", async () => {
  const s = await tokenFor("student");
  const food = await trackedFood(5);

  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      order(s.token, { items: [{ food: food._id.toString(), quantity: 1 }] })
    )
  );

  const created = results.filter((r) => r.status === 201).length;
  const refused = results.filter((r) => r.status === 409).length;

  assert.equal(created, 5, "never more than the available quantity");
  assert.equal(refused, 3);
  assert.equal(await Order.countDocuments({}), 5);

  const c = await counters(food._id);
  assert.equal(c.reserved, 5);
  assert.equal(c.available, 0);
  assert.ok(c.stock >= 0 && c.reserved >= 0);
});

test("a failed multi-item order compensates cleanly without transactions", async () => {
  const s = await tokenFor("student");
  const good = await trackedFood(100);
  const bad = await trackedFood(1);

  const res = await order(s.token, {
    items: [
      { food: good._id.toString(), quantity: 3 },
      { food: bad._id.toString(), quantity: 4 },
    ],
  });

  assert.equal(res.status, 409);
  assert.deepEqual(await counters(good._id), { stock: 100, reserved: 0, available: 100 },
    "the successful line must be compensated");
  assert.deepEqual(await counters(bad._id), { stock: 1, reserved: 0, available: 1 });
  assert.equal(await Order.countDocuments({}), 0, "no orphan order");
  assert.equal(await Movement.countDocuments({ type: "reserve" }), 0);
});

test("reserve, consume and release all work without transactions", async () => {
  const s = await tokenFor("student");
  const admin = await tokenFor("admin");
  const food = await trackedFood(10);

  const created = await order(s.token, { items: [{ food: food._id.toString(), quantity: 3 }] });
  assert.deepEqual(await counters(food._id), { stock: 10, reserved: 3, available: 7 });

  await patchStatus(admin.token, created.body._id, { status: "Preparing" });
  assert.deepEqual(await counters(food._id), { stock: 7, reserved: 0, available: 7 });

  // Consumed stock is not auto-restored by a cancellation during preparation.
  await patchStatus(admin.token, created.body._id, { status: "Cancelled", reason: "no-show" });
  assert.deepEqual(await counters(food._id), { stock: 7, reserved: 0, available: 7 });

  const types = (await Movement.find({ food: food._id }).sort({ at: 1 })).map((m) => m.type);
  assert.deepEqual(types, ["reserve", "consume"], "no release after consumption");
});

test("cancelling before preparation releases exactly once without transactions", async () => {
  const s = await tokenFor("student");
  const food = await trackedFood(10);
  const created = await order(s.token, { items: [{ food: food._id.toString(), quantity: 4 }] });

  await Promise.all([
    cancel(s.token, created.body._id),
    cancel(s.token, created.body._id),
    cancel(s.token, created.body._id),
  ]);

  assert.deepEqual(await counters(food._id), { stock: 10, reserved: 0, available: 10 });
  assert.equal(
    await Movement.countDocuments({ food: food._id, type: "release" }),
    1,
    "the ledger's unique operation id prevents a double release"
  );
});

test("concurrent orders then concurrent cancels return the stock exactly once", async () => {
  const s = await tokenFor("student");
  const food = await trackedFood(6);

  const placed = await Promise.all(
    Array.from({ length: 6 }, () =>
      order(s.token, { items: [{ food: food._id.toString(), quantity: 1 }] })
    )
  );
  const ids = placed.filter((r) => r.status === 201).map((r) => r.body._id);
  assert.equal(ids.length, 6);
  assert.deepEqual(await counters(food._id), { stock: 6, reserved: 6, available: 0 });

  // Cancel them all at once.
  await Promise.all(ids.map((id) => cancel(s.token, id)));

  assert.deepEqual(await counters(food._id), { stock: 6, reserved: 0, available: 6 });
  assert.equal(await Movement.countDocuments({ food: food._id, type: "release" }), 6);
});

test("counters never go negative under sustained concurrency", async () => {
  const s = await tokenFor("student");
  const admin = await tokenFor("admin");
  const food = await trackedFood(4);

  const placed = await Promise.all(
    Array.from({ length: 6 }, () =>
      order(s.token, { items: [{ food: food._id.toString(), quantity: 1 }] })
    )
  );
  const ids = placed.filter((r) => r.status === 201).map((r) => r.body._id);

  // Race consumption and cancellation together.
  await Promise.all([
    ...ids.map((id) => patchStatus(admin.token, id, { status: "Preparing" }).catch(() => {})),
    ...ids.map((id) => cancel(s.token, id).catch(() => {})),
  ]);

  const Food = require("../models/FoodItem");
  const f = await Food.findById(food._id);
  assert.ok(f.stock >= 0, "physical stock must never be negative");
  assert.ok(f.reserved >= 0, "reserved must never be negative");
  assert.ok(f.stock <= 4, "stock cannot exceed what we started with");

  // The ledger still balances: reserved equals sum of outstanding reserves.
  const reserves = await Movement.find({ food: food._id, type: "reserve" });
  const consumed = await Movement.find({ food: food._id, type: "consume" });
  const released = await Movement.find({ food: food._id, type: "release" });
  assert.equal(
    f.reserved,
    reserves.reduce((s, m) => s + m.reservedDelta, 0) -
      Math.abs(consumed.reduce((s, m) => s + m.reservedDelta, 0)) -
      Math.abs(released.reduce((s, m) => s + m.reservedDelta, 0)),
    "reserved must equal the ledger's net movement"
  );
});

test("legacy untracked items are unaffected on a standalone deployment", async () => {
  const s = await tokenFor("student");
  const legacy = await makeFood({ name: "Legacy", price: 10 });

  const res = await order(s.token, { items: [{ food: legacy._id.toString(), quantity: 5 }] });
  assert.equal(res.status, 201);
  assert.equal(await Movement.countDocuments({ food: legacy._id }), 0,
    "no ledger entries for untracked items");
  assert.equal((await Order.findById(res.body._id)).items[0].inventoryTracked, false);
});