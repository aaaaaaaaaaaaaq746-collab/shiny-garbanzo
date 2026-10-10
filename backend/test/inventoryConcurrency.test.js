const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

/**
 * Concurrency invariants for the inventory service (P2-R1, N5). DB-backed.
 *
 * These drive the service directly with overlapping calls. They check
 * invariants, not one particular interleaving, so they hold whatever order
 * MongoDB happens to serve the requests in.
 */

const { startDb, resetDb, stopDb } = require("./helpers");
const Food = require("../models/FoodItem");
const Movement = require("../models/InventoryMovement");
const inventory = require("../services/inventory");

before(startDb);
after(stopDb);
beforeEach(resetDb);

const actor = { _id: new mongoose.Types.ObjectId(), role: "admin" };

async function trackedFood(stock, reserved = 0) {
  return Food.create({
    name: `C ${Math.random().toString(36).slice(2, 7)}`,
    price: 10,
    trackInventory: true,
    stock,
    reserved,
    lowStockThreshold: 0,
  });
}

/** Run the calls together and split them into successes and failures. */
async function settleAll(calls) {
  const outcomes = await Promise.allSettled(calls);
  return {
    ok: outcomes.filter((o) => o.status === "fulfilled").map((o) => o.value),
    failed: outcomes.filter((o) => o.status === "rejected").map((o) => o.reason),
  };
}

/**
 * The lost-update check. Each applied adjustment records the stock it started
 * from (stockAfter - stockDelta). Two adjustments that started from the same
 * value means one of them was computed from stale data, which is a lost update.
 */
async function adjustmentStarts(foodId) {
  const rows = await Movement.find({ food: foodId, type: "adjustment" }).lean();
  return rows.map((r) => ({ before: r.stockAfter - r.stockDelta, delta: r.stockDelta, after: r.stockAfter }));
}

// -------------------------------------------------------- N5: adjust "set"

test("N5: concurrent set-to adjustments never lose an update", async () => {
  const item = await trackedFood(10);
  const targets = [20, 30, 40, 50, 60];

  const { ok, failed } = await settleAll(
    targets.map((setTo) =>
      inventory.adjustStock({ foodId: item._id, setTo, reason: "count", actor })
    )
  );

  // Every refusal must be a clean conflict, never a silent overwrite.
  for (const err of failed) {
    assert.equal(err.code, "CONCURRENT_UPDATE", `unexpected error: ${err.message}`);
    assert.equal(err.statusCode, 409);
  }
  assert.ok(ok.length >= 1, "at least one set should win");

  const fresh = await Food.findById(item._id);
  const starts = await adjustmentStarts(item._id);

  assert.equal(starts.length, ok.length, "one ledger row per applied adjustment");
  // Stock equals the start plus every applied change.
  assert.equal(
    fresh.stock,
    10 + starts.reduce((sum, s) => sum + s.delta, 0),
    "final stock matches the sum of applied changes"
  );
  // No two applied adjustments were computed from the same starting value.
  const befores = starts.map((s) => s.before);
  assert.equal(new Set(befores).size, befores.length, "no lost update: starting values are distinct");
});

test("N5: concurrent signed deltas each apply exactly once or are refused", async () => {
  const item = await trackedFood(0);

  const { ok, failed } = await settleAll(
    Array.from({ length: 8 }, () =>
      inventory.adjustStock({ foodId: item._id, delta: 1, reason: "receive", actor })
    )
  );

  for (const err of failed) assert.equal(err.code, "CONCURRENT_UPDATE");

  const fresh = await Food.findById(item._id);
  assert.equal(fresh.stock, ok.length, "stock rises by exactly the number of applied deltas");

  const befores = (await adjustmentStarts(item._id)).map((s) => s.before);
  assert.equal(new Set(befores).size, befores.length);
});

test("N5: setting a value equal to current stock is refused (400), nothing written", async () => {
  const item = await trackedFood(7);
  await assert.rejects(
    inventory.adjustStock({ foodId: item._id, setTo: 7, reason: "same", actor }),
    (err) => err.code === "NO_CHANGE" && err.statusCode === 400
  );
  assert.equal(await Movement.countDocuments({ food: item._id }), 0);
});

test("N5: a set that would make stock negative is refused (400)", async () => {
  // Set mode cannot take stock below zero. setTo is validated upstream as >= 0.
  const item = await trackedFood(3, 0);
  await assert.rejects(
    inventory.adjustStock({ foodId: item._id, delta: -5, reason: "oops", actor }),
    (err) => err.code === "NEGATIVE_STOCK"
  );
  assert.equal((await Food.findById(item._id)).stock, 3);
});

// -------------------------------------------------------- P2-R1: reserve

test("P2-R1: concurrent reservations never oversell", async () => {
  const item = await trackedFood(5);

  const { ok, failed } = await settleAll(
    Array.from({ length: 10 }, () =>
      inventory.reserveOne({
        foodId: item._id,
        quantity: 1,
        orderId: new mongoose.Types.ObjectId(),
        actor: null,
      })
    )
  );

  assert.equal(ok.length, 5, "exactly the available quantity is reserved");
  assert.equal(failed.length, 5);
  for (const err of failed) assert.equal(err.code, "INSUFFICIENT_STOCK");

  const fresh = await Food.findById(item._id);
  assert.equal(fresh.reserved, 5);
  assert.ok(fresh.stock - fresh.reserved >= 0, "available never goes negative");
});

test("P2-R1: a repeated reservation for the same order line is claimed once", async () => {
  const item = await trackedFood(10);
  const orderId = new mongoose.Types.ObjectId();

  const first = await inventory.reserveOne({ foodId: item._id, quantity: 2, orderId, actor: null });
  const second = await inventory.reserveOne({ foodId: item._id, quantity: 2, orderId, actor: null });

  assert.equal(first.reserved, 2);
  assert.equal(second.duplicate, true);
  assert.equal((await Food.findById(item._id)).reserved, 2, "reserved counted once");
  assert.equal(await Movement.countDocuments({ food: item._id, type: "reserve" }), 1);
});

test("P2-R1: a refused reservation leaves no claim behind", async () => {
  const item = await trackedFood(1);
  const orderId = new mongoose.Types.ObjectId();

  await assert.rejects(
    inventory.reserveOne({ foodId: item._id, quantity: 4, orderId, actor: null }),
    (err) => err.code === "INSUFFICIENT_STOCK"
  );
  assert.equal(await Movement.countDocuments({ food: item._id, type: "reserve" }), 0);
});

// -------------------------------------------------------- P2-R1: consume

test("P2-R1: concurrent consumes of one order reduce stock exactly once", async () => {
  const item = await trackedFood(10, 0);
  const orderId = new mongoose.Types.ObjectId();
  await inventory.reserveOne({ foodId: item._id, quantity: 2, orderId, actor: null });

  const order = {
    _id: orderId,
    items: [{ food: item._id, quantity: 2, reservedQty: 2, inventoryTracked: true, stockConsumed: false }],
  };

  await settleAll(
    Array.from({ length: 5 }, () => inventory.consumeOrder({ order, actor }))
  );

  const fresh = await Food.findById(item._id);
  assert.equal(fresh.stock, 8, "stock reduced by 2 once, not five times");
  assert.equal(fresh.reserved, 0, "reservation released once");
  assert.equal(await Movement.countDocuments({ food: item._id, type: "consume" }), 1);
  assert.ok(fresh.stock >= 0 && fresh.reserved >= 0, "counters never go negative");
});

test("P2-R1: concurrent releases of one order return reserved stock exactly once", async () => {
  const item = await trackedFood(10, 0);
  const orderId = new mongoose.Types.ObjectId();
  await inventory.reserveOne({ foodId: item._id, quantity: 3, orderId, actor: null });

  const order = {
    _id: orderId,
    items: [{ food: item._id, quantity: 3, reservedQty: 3, inventoryTracked: true, stockReleased: false }],
  };

  await settleAll(
    Array.from({ length: 5 }, () => inventory.releaseOrder({ order, actor, reason: "cancel" }))
  );

  const fresh = await Food.findById(item._id);
  assert.equal(fresh.reserved, 0);
  assert.equal(fresh.stock, 10, "stock itself is untouched by a release");
  assert.equal(await Movement.countDocuments({ food: item._id, type: "release" }), 1);
});
