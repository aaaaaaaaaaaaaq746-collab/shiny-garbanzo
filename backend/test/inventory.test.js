const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

/**
 * Phase 4 — Inventory management.
 *
 * These run against a REAL single-node replica set (see helpersReplSet.js), so
 * the transaction path is genuinely exercised. No mocking: every assertion
 * below reads the actual database state.
 */

const {
  api,
  startDb,
  resetDb,
  stopDb,
  trackedFood,
  tokenFor,
  counters,
  makeFood,
  mongoose,
} = require("./helpersReplSet");

const inventory = require("../services/inventory");
const Food = require("../models/FoodItem");
const Order = require("../models/Order");
const Movement = require("../models/InventoryMovement");

before(startDb);
after(stopDb);
beforeEach(resetDb);

const order = (token, body) => api().post("/api/orders").set("Authorization", `Bearer ${token}`).send(body);
const patchStatus = (token, id, body) =>
  api().put(`/api/orders/${id}/status`).set("Authorization", `Bearer ${token}`).send(body);
const cancel = (token, id, body = {}) =>
  api().post(`/api/orders/${id}/cancel`).set("Authorization", `Bearer ${token}`).send(body);
const movementsFor = (foodId) => Movement.find({ food: foodId }).sort({ at: 1 });

// ======================================================== ENVIRONMENT

test("the test environment really supports transactions", () => {
  // Guard: if this ever regresses, the suite is no longer proving what it claims.
  assert.equal(inventory.transactionsSupported(), true,
    "these tests require a replica set to exercise the transaction path");
});

// ============================================ 1. BACKWARD COMPATIBILITY

test("existing food documents without inventory fields remain functional", async () => {
  // Raw insert shaped like a pre-Phase-4 document: no inventory fields at all.
  const id = new mongoose.Types.ObjectId();
  await mongoose.connection.collection("fooditems").insertOne({
    _id: id,
    name: "Legacy Item",
    description: "from before Phase 4",
    price: 60,
    category: "General",
    available: true,
    prepTimeMinutes: 15,
    lowStockThreshold: 5,
  });

  const fresh = await Food.findById(id);
  assert.equal(fresh.trackInventory, false, "defaults to untracked");
  assert.equal(fresh.sellableQty(), Infinity, "legacy item stays unlimited");
  assert.equal(fresh.soldOut, false);
  assert.equal(fresh.availableQty, null);

  // It still appears on the menu and can be ordered normally.
  const menu = await api().get("/api/food");
  assert.ok(menu.body.some((f) => String(f._id) === String(id)));

  const s = await tokenFor("student");
  const res = await order(s.token, { items: [{ food: id.toString(), quantity: 3 }] });
  assert.equal(res.status, 201, "a legacy item must still be orderable");
  assert.equal(res.body.items[0].inventoryTracked, false);
});

test("a pre-Phase-4 item with stock 0 still behaves as sold out", async () => {
  // Phase 1 semantics: a non-null `stock` capped availability even without tracking.
  const legacy = await makeFood({ name: "Legacy Zero", price: 10, stock: 0 });
  assert.equal(legacy.sellableQty(), 0);
  assert.equal(legacy.soldOut, true);

  const s = await tokenFor("student");
  const res = await order(s.token, { items: [{ food: legacy._id.toString(), quantity: 1 }] });
  assert.equal(res.status, 409);
});

test("an untracked item is never limited by inventory", async () => {
  const unlimited = await makeFood({ name: "Unlimited", price: 10 });
  const s = await tokenFor("student");
  const res = await order(s.token, { items: [{ food: unlimited._id.toString(), quantity: 20 }] });
  assert.equal(res.status, 201);
  assert.equal(res.body.total, 200);
});

// ============================================= 2. ENABLE TRACKING

test("inventory tracking can be enabled for an existing item", async () => {
  const admin = await tokenFor("admin");
  const food = await makeFood({ name: "To Track", price: 50 });

  const res = await api()
    .post(`/api/inventory/${food._id}/tracking`)
    .set("Authorization", `Bearer ${admin.token}`)
    .send({ enabled: true, stock: 25, reason: "Opening stock count" });

  assert.equal(res.status, 200);
  assert.equal(res.body.trackInventory, true);
  assert.equal(res.body.stock, 25);
  assert.equal(res.body.reserved, 0);
  assert.equal(res.body.availableQty, 25);

  // The enabling action is auditable.
  const moves = await movementsFor(food._id);
  assert.equal(moves.length, 1);
  assert.equal(moves[0].type, "adjustment");
  assert.ok(moves[0].reason.includes("Opening stock"));
});

test("enabling tracking requires a starting stock quantity", async () => {
  const admin = await tokenFor("admin");
  const food = await makeFood({ name: "No Stock Given", price: 50 });

  const res = await api()
    .post(`/api/inventory/${food._id}/tracking`)
    .set("Authorization", `Bearer ${admin.token}`)
    .send({ enabled: true });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /starting stock/i);
});

// =============================== 3-5. RESERVATION ON ORDER CREATION

test("a valid order reserves the correct stock quantity", async () => {
  const s = await tokenFor("student");
  const food = await trackedFood(10);

  const res = await order(s.token, { items: [{ food: food._id.toString(), quantity: 3 }] });
  assert.equal(res.status, 201);

  assert.deepEqual(await counters(food._id), { stock: 10, reserved: 3, available: 7 });

  const item = (await Order.findById(res.body._id)).items[0];
  assert.equal(item.inventoryTracked, true);
  assert.equal(item.reservedQty, 3);
  assert.equal(item.stockReserved, true);
});

test("an order exceeding available stock is rejected and reserves nothing", async () => {
  const s = await tokenFor("student");
  const food = await trackedFood(5);

  const res = await order(s.token, { items: [{ food: food._id.toString(), quantity: 6 }] });

  assert.equal(res.status, 409);
  assert.match(res.body.message, /left|sold out/i);

  // Nothing reserved, and no orphaned order left behind.
  assert.deepEqual(await counters(food._id), { stock: 5, reserved: 0, available: 5 });
  assert.equal(await Order.countDocuments({}), 0, "no partial order may survive");
});

test("a multi-item order fails completely when one tracked item is short", async () => {
  const s = await tokenFor("student");
  const plenty = await trackedFood(50);
  const scarce = await trackedFood(2);

  const res = await order(s.token, {
    items: [
      { food: plenty._id.toString(), quantity: 5 },
      { food: scarce._id.toString(), quantity: 3 }, // only 2 available
    ],
  });

  assert.equal(res.status, 409);

  // All-or-nothing: the item that succeeded must be rolled back.
  assert.deepEqual(await counters(plenty._id), { stock: 50, reserved: 0, available: 50 });
  assert.deepEqual(await counters(scarce._id), { stock: 2, reserved: 0, available: 2 });
  assert.equal(await Order.countDocuments({}), 0);
});

test("reserving exactly the available quantity is allowed", async () => {
  const s = await tokenFor("student");
  const food = await trackedFood(4);

  const res = await order(s.token, { items: [{ food: food._id.toString(), quantity: 4 }] });
  assert.equal(res.status, 201);
  assert.deepEqual(await counters(food._id), { stock: 4, reserved: 4, available: 0 });

  // Now nothing is left for a second order.
  const again = await order(s.token, { items: [{ food: food._id.toString(), quantity: 1 }] });
  assert.equal(again.status, 409);
});

// ================================================ 6. CONCURRENCY

test("concurrent orders cannot oversell a tracked item", async () => {
  const s = await tokenFor("student");
  const food = await trackedFood(5);

  // Six simultaneous orders for 1 unit each, but only 5 exist.
  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      order(s.token, { items: [{ food: food._id.toString(), quantity: 1 }] })
    )
  );

  const created = results.filter((r) => r.status === 201);
  const refused = results.filter((r) => r.status === 409);

  assert.equal(created.length, 5, "exactly the available quantity may be sold");
  assert.equal(refused.length, 1);
  assert.equal(await Order.countDocuments({}), 5);

  const c = await counters(food._id);
  assert.equal(c.reserved, 5);
  assert.equal(c.stock, 5, "physical stock is untouched until preparation");
  assert.equal(c.available, 0);
  assert.ok(c.stock >= 0 && c.reserved >= 0, "counters must never go negative");
});

test("concurrent larger orders cannot oversell either", async () => {
  const s = await tokenFor("student");
  const food = await trackedFood(10);

  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      order(s.token, { items: [{ food: food._id.toString(), quantity: 4 }] })
    )
  );

  const created = results.filter((r) => r.status === 201).length;
  assert.ok(created <= 2, `at most 2 orders of 4 may fit in 10 units, got ${created}`);
  assert.deepEqual(await counters(food._id), { stock: 10, reserved: created * 4, available: 10 - created * 4 });
});

// ==================== 7-8. RELEASE ON CANCEL / REJECT

test("cancelling a Pending order releases stock exactly once", async () => {
  const s = await tokenFor("student");
  const food = await trackedFood(10);
  const created = await order(s.token, { items: [{ food: food._id.toString(), quantity: 4 }] });

  assert.deepEqual(await counters(food._id), { stock: 10, reserved: 4, available: 6 });

  const res = await cancel(s.token, created.body._id);
  assert.equal(res.status, 200);
  assert.deepEqual(await counters(food._id), { stock: 10, reserved: 0, available: 10 });

  const released = (await movementsFor(food._id)).filter((m) => m.type === "release");
  assert.equal(released.length, 1, "exactly one release movement");
});

test("rejecting an eligible order releases the outstanding reservation", async () => {
  const s = await tokenFor("student");
  const admin = await tokenFor("admin");
  const food = await trackedFood(10);
  const created = await order(s.token, { items: [{ food: food._id.toString(), quantity: 2 }] });

  const res = await patchStatus(admin.token, created.body._id, {
    status: "Rejected",
    reason: "Ingredient shortfall",
  });
  assert.equal(res.status, 200);

  assert.deepEqual(await counters(food._id), { stock: 10, reserved: 0, available: 10 });
  const released = (await movementsFor(food._id)).filter((m) => m.type === "release");
  assert.equal(released.length, 1);
  assert.ok(released[0].reason);
});

// ======================= 9-10. CONSUMPTION ON PREPARATION

test("starting preparation consumes the reservation exactly once", async () => {
  const s = await tokenFor("student");
  const admin = await tokenFor("admin");
  const food = await trackedFood(10);
  const created = await order(s.token, { items: [{ food: food._id.toString(), quantity: 3 }] });

  const res = await patchStatus(admin.token, created.body._id, { status: "Preparing" });
  assert.equal(res.status, 200);

  // Physical stock drops, reservation clears.
  assert.deepEqual(await counters(food._id), { stock: 7, reserved: 0, available: 7 });

  const consumed = (await movementsFor(food._id)).filter((m) => m.type === "consume");
  assert.equal(consumed.length, 1);
});

test("direct advancement to Ready or Completed still consumes stock once", async () => {
  const s = await tokenFor("student");
  const admin = await tokenFor("admin");

  // Pending -> Completed, skipping Preparing entirely (allowed by the lifecycle).
  const food = await trackedFood(20);
  const created = await order(s.token, { items: [{ food: food._id.toString(), quantity: 4 }] });

  const res = await patchStatus(admin.token, created.body._id, { status: "Completed" });
  assert.equal(res.status, 200);

  assert.deepEqual(await counters(food._id), { stock: 16, reserved: 0, available: 16 });
  const consumed = (await movementsFor(food._id)).filter((m) => m.type === "consume");
  assert.equal(consumed.length, 1, "skip-ahead must still consume exactly once");
});

test("walking the full lifecycle consumes only once", async () => {
  const s = await tokenFor("student");
  const admin = await tokenFor("admin");
  const food = await trackedFood(30);
  const created = await order(s.token, { items: [{ food: food._id.toString(), quantity: 5 }] });

  for (const status of ["Accepted", "Preparing", "Ready", "Completed"]) {
    const res = await patchStatus(admin.token, created.body._id, { status });
    assert.equal(res.status, 200, `step to ${status} failed`);
  }

  assert.deepEqual(await counters(food._id), { stock: 25, reserved: 0, available: 25 });
  const consumed = (await movementsFor(food._id)).filter((m) => m.type === "consume");
  assert.equal(consumed.length, 1);
});

// ============================== 11. DUPLICATE / IDEMPOTENCY

test("repeated cancellation cannot release stock twice", async () => {
  const s = await tokenFor("student");
  const food = await trackedFood(10);
  const created = await order(s.token, { items: [{ food: food._id.toString(), quantity: 3 }] });

  const [a, b, c] = await Promise.all([
    cancel(s.token, created.body._id),
    cancel(s.token, created.body._id),
    cancel(s.token, created.body._id),
  ]);

  // Exactly one request performs the transition; a racer that loses the
  // conditional update gets 409. Both outcomes are safe.
  const codes = [a, b, c].map((r) => r.status);
  assert.equal(codes.filter((s) => s === 200).length, 1, `expected one winner, got ${codes}`);
  for (const code of codes) assert.ok([200, 409].includes(code));

  assert.deepEqual(await counters(food._id), { stock: 10, reserved: 0, available: 10 },
    "stock must be returned exactly once despite three requests");
  assert.equal((await movementsFor(food._id)).filter((m) => m.type === "release").length, 1);
});

test("repeated preparation-start requests consume stock only once", async () => {
  const s = await tokenFor("student");
  const admin = await tokenFor("admin");
  const food = await trackedFood(10);
  const created = await order(s.token, { items: [{ food: food._id.toString(), quantity: 4 }] });

  // Only the first succeeds; the rest conflict (already Preparing) or 409.
  await Promise.all([
    patchStatus(admin.token, created.body._id, { status: "Preparing" }),
    patchStatus(admin.token, created.body._id, { status: "Preparing" }),
    patchStatus(admin.token, created.body._id, { status: "Preparing" }),
  ]);

  assert.deepEqual(await counters(food._id), { stock: 6, reserved: 0, available: 6 });
  assert.equal((await movementsFor(food._id)).filter((m) => m.type === "consume").length, 1);
});

test("a replayed reservation is ignored via the ledger's unique operation id", async () => {
  const s = await tokenFor("student");
  const food = await trackedFood(10);
  const created = await order(s.token, { items: [{ food: food._id.toString(), quantity: 2 }] });
  const doc = await Order.findById(created.body._id);

  // Simulate a retried request replaying the same movement.
  await inventory.reserveOrder({ order: doc, items: doc.items, actor: { _id: null, role: null } });

  assert.deepEqual(await counters(food._id), { stock: 10, reserved: 2, available: 8 },
    "a duplicate reservation must not double-count");
  assert.equal((await movementsFor(food._id)).filter((m) => m.type === "reserve").length, 1);
});

// ============ 12. CANCELLATION DURING PREPARATION

test("cancelling during preparation does not restore consumed stock", async () => {
  const s = await tokenFor("student");
  const admin = await tokenFor("admin");
  const food = await trackedFood(10);
  const created = await order(s.token, { items: [{ food: food._id.toString(), quantity: 3 }] });

  await patchStatus(admin.token, created.body._id, { status: "Preparing" });
  assert.deepEqual(await counters(food._id), { stock: 7, reserved: 0, available: 7 });

  // The documented exception: admins may cancel a Preparing order.
  const res = await patchStatus(admin.token, created.body._id, {
    status: "Cancelled",
    reason: "Customer no-show",
  });
  assert.equal(res.status, 200);

  // Stock was already consumed; it must NOT silently return.
  assert.deepEqual(await counters(food._id), { stock: 7, reserved: 0, available: 7 });
  assert.equal((await movementsFor(food._id)).filter((m) => m.type === "release").length, 0,
    "no automatic release after consumption");
});

test("recoverable stock after a preparation cancellation needs an explicit adjustment", async () => {
  const s = await tokenFor("student");
  const admin = await tokenFor("admin");
  const food = await trackedFood(10);
  const created = await order(s.token, { items: [{ food: food._id.toString(), quantity: 3 }] });

  await patchStatus(admin.token, created.body._id, { status: "Preparing" });
  await patchStatus(admin.token, created.body._id, { status: "Cancelled", reason: "no-show" });
  assert.deepEqual(await counters(food._id), { stock: 7, reserved: 0, available: 7 });

  // Recovering the unused portion is a deliberate, audited admin action.
  const adjust = await api()
    .post(`/api/inventory/${food._id}/adjust`)
    .set("Authorization", `Bearer ${admin.token}`)
    .send({ delta: 3, reason: "Returned unused from cancelled order" });

  assert.equal(adjust.status, 200);
  assert.deepEqual(await counters(food._id), { stock: 10, reserved: 0, available: 10 });
});

// ============ 13-14. AUTHORIZATION

test("manual stock adjustments require authorization and a reason", async () => {
  const admin = await tokenFor("admin");
  const food = await trackedFood(10);
  const url = `/api/inventory/${food._id}/adjust`;

  // No reason.
  const noReason = await api()
    .post(url).set("Authorization", `Bearer ${admin.token}`).send({ delta: 5 });
  assert.equal(noReason.status, 400);
  assert.match(noReason.body.message, /reason/i);

  // Valid adjustment.
  const ok = await api()
    .post(url)
    .set("Authorization", `Bearer ${admin.token}`)
    .send({ delta: 5, reason: "Supplier delivery" });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.stock, 15);
});

test("students and staff cannot perform inventory operations", async () => {
  const admin = await tokenFor("admin");
  const student = await tokenFor("student");
  const staff = await tokenFor("staff");
  const food = await trackedFood(10);

  for (const actor of [student, staff]) {
    const adjust = await api()
      .post(`/api/inventory/${food._id}/adjust`)
      .set("Authorization", `Bearer ${actor.token}`)
      .send({ delta: 5, reason: "sneaky" });
    assert.equal(adjust.status, 403, `${actor.email} must not adjust stock`);

    const track = await api()
      .post(`/api/inventory/${food._id}/tracking`)
      .set("Authorization", `Bearer ${actor.token}`)
      .send({ enabled: true, stock: 99 });
    assert.equal(track.status, 403, `${actor.email} must not change tracking`);

    const read = await api().get("/api/inventory").set("Authorization", `Bearer ${actor.token}`);
    assert.equal(read.status, 403, `${actor.email} must not read the inventory report`);

    const movements = await api()
      .get(`/api/inventory/${food._id}/movements`)
      .set("Authorization", `Bearer ${actor.token}`);
    assert.equal(movements.status, 403);
  }

  // Stock untouched by the refused attempts.
  assert.deepEqual(await counters(food._id), { stock: 10, reserved: 0, available: 10 });
  assert.ok(await api().get("/api/inventory").set("Authorization", `Bearer ${admin.token}`));
});

// ================== 15. INVALID QUANTITIES

test("negative, fractional and malformed adjustments are rejected", async () => {
  const admin = await tokenFor("admin");
  const food = await trackedFood(10);
  const url = `/api/inventory/${food._id}/adjust`;

  for (const delta of [-100, 0, 1.5, "5", null, NaN, {}]) {
    const res = await api()
      .post(url).set("Authorization", `Bearer ${admin.token}`).send({ delta, reason: "x" });
    assert.equal(res.status, 400, `delta ${JSON.stringify(delta)} should be rejected`);
  }

  assert.deepEqual(await counters(food._id), { stock: 10, reserved: 0, available: 10 });
});

test("stock cannot be reduced below zero", async () => {
  const admin = await tokenFor("admin");
  const food = await trackedFood(3);

  const res = await api()
    .post(`/api/inventory/${food._id}/adjust`)
    .set("Authorization", `Bearer ${admin.token}`)
    .send({ delta: -10, reason: "miscount" });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /below zero/i);
  assert.deepEqual(await counters(food._id), { stock: 3, reserved: 0, available: 3 });
});

test("invalid order quantities are still rejected before any reservation", async () => {
  const s = await tokenFor("student");
  const food = await trackedFood(10);

  for (const quantity of [0, -1, 1.5, 21, "abc"]) {
    const res = await order(s.token, {
      items: [{ food: food._id.toString(), quantity }],
    });
    assert.ok(res.status === 400 || res.status === 409, `quantity ${quantity} rejected`);
  }
  assert.deepEqual(await counters(food._id), { stock: 10, reserved: 0, available: 0 === 0 ? 10 : 10 });
});

// ============ 16. ATOMICITY

test("a failed multi-item order leaves no partial reservation or order", async () => {
  const s = await tokenFor("student");
  const good = await trackedFood(100);
  const bad = await trackedFood(1);

  const before = await Order.countDocuments({});
  const res = await order(s.token, {
    items: [
      { food: good._id.toString(), quantity: 2 },
      { food: bad._id.toString(), quantity: 5 },
    ],
  });

  assert.equal(res.status, 409);
  assert.equal(await Order.countDocuments({}), before, "no order may be persisted");
  assert.deepEqual(await counters(good._id), { stock: 100, reserved: 0, available: 100 });
  assert.deepEqual(await counters(bad._id), { stock: 1, reserved: 0, available: 1 });
  assert.equal(await Movement.countDocuments({ type: "reserve" }), 0,
    "no ledger row may claim a reservation that was rolled back");
});

// ============ 17. LEDGER

test("the ledger accurately reflects every successful operation", async () => {
  const s = await tokenFor("student");
  const admin = await tokenFor("admin");
  const food = await trackedFood(20);
  const orderId = (await order(s.token, { items: [{ food: food._id.toString(), quantity: 4 }] }))
    .body._id;

  await patchStatus(admin.token, orderId, { status: "Preparing" });
  await api()
    .post(`/api/inventory/${food._id}/adjust`)
    .set("Authorization", `Bearer ${admin.token}`)
    .send({ delta: 6, reason: "Restock" });

  const moves = await movementsFor(food._id);
  assert.deepEqual(moves.map((m) => m.type), ["reserve", "consume", "adjustment"]);

  const [reserve, consume, adjust] = moves;
  assert.equal(reserve.reservedDelta, 4);
  assert.equal(reserve.stockDelta, 0);
  assert.equal(reserve.reservedAfter, 4);
  assert.ok(reserve.order, "reserve is linked to the order");

  assert.equal(consume.stockDelta, -4);
  assert.equal(consume.reservedDelta, -4);
  assert.equal(consume.stockAfter, 16);

  assert.equal(adjust.stockDelta, 6);
  assert.equal(adjust.stockAfter, 22);
  assert.equal(adjust.reason, "Restock");
  assert.ok(adjust.actor, "manual adjustments record the actor");
  assert.equal(adjust.actorRole, "admin");

  // Reconstruct the stock from the ledger alone.
  const finalStock = moves.reduce((sum, m) => sum + m.stockDelta, 0);
  assert.equal(finalStock, 2, "ledger deltas must explain the running stock");
});

test("every ledger operation id is unique", async () => {
  const s = await tokenFor("student");
  const admin = await tokenFor("admin");
  const a = await trackedFood(20);
  const b = await trackedFood(20);

  const o1 = (await order(s.token, { items: [{ food: a._id.toString(), quantity: 2 }] })).body._id;
  const o2 = (await order(s.token, { items: [{ food: b._id.toString(), quantity: 2 }] })).body._id;

  await patchStatus(admin.token, o1, { status: "Preparing" });
  await cancel(s.token, o2);

  const ids = (await Movement.find({}).select("operationId")).map((m) => m.operationId);
  assert.equal(new Set(ids).size, ids.length, "operation ids must be unique");

  // The unique index really enforces it.
  const dup = await Movement.create({
    operationId: ids[0],
    food: a._id,
    type: "adjustment",
    quantity: 1,
    stockDelta: 1,
    reservedDelta: 0,
  }).then(() => null).catch((e) => e.code);

  assert.equal(dup, 11000, "a duplicate operation id must be rejected by the database");
});

test("an administrator can inspect movement history per item", async () => {
  const s = await tokenFor("student");
  const admin = await tokenFor("admin");
  const food = await trackedFood(10);
  const orderId = (await order(s.token, { items: [{ food: food._id.toString(), quantity: 2 }] }))
    .body._id;

  await patchStatus(admin.token, orderId, { status: "Preparing" });

  const res = await api()
    .get(`/api/inventory/${food._id}/movements`)
    .set("Authorization", `Bearer ${admin.token}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
  assert.ok(res.body[0].actor, "actor is populated");
  assert.ok(res.body[0].order, "order is populated");

  const missing = await api()
    .get("/api/inventory/0123456789abcdef01234567/movements")
    .set("Authorization", `Bearer ${admin.token}`);
  assert.equal(missing.status, 404, "a well-formed but unknown id is 404");

  const malformed = await api()
    .get("/api/inventory/not-an-object-id/movements")
    .set("Authorization", `Bearer ${admin.token}`);
  assert.equal(malformed.status, 400, "a malformed id is rejected");
});

// ============ 18. SOLD OUT / LOW STOCK

test("sold-out and low-stock conditions are reported correctly", async () => {
  const admin = await tokenFor("admin");

  const out = await trackedFood(0, { lowStockThreshold: 3 });
  const low = await trackedFood(3, { lowStockThreshold: 3 });
  const fine = await trackedFood(20, { lowStockThreshold: 3 });

  const res = await api().get("/api/inventory").set("Authorization", `Bearer ${admin.token}`);
  const byId = Object.fromEntries(res.body.map((f) => [String(f._id), f]));

  assert.equal(byId[String(out._id)].outOfStock, true);
  assert.equal(byId[String(out._id)].soldOut, true);
  assert.equal(byId[String(low._id)].outOfStock, false);
  assert.equal(byId[String(low._id)].lowStock, true, "at the threshold counts as low");
  assert.equal(byId[String(fine._id)].lowStock, false);

  const alerts = await api()
    .get("/api/inventory/low-stock")
    .set("Authorization", `Bearer ${admin.token}`);
  assert.equal(alerts.status, 200);
  assert.equal(alerts.body.counts.total, 2, "out and low are both reported");
  assert.equal(alerts.body.counts.outOfStock, 1);
  assert.equal(alerts.body.counts.low, 1);
});

test("low-stock alerts resolve once stock is restored and do not repeat", async () => {
  const admin = await tokenFor("admin");
  const food = await trackedFood(2, { lowStockThreshold: 5 });

  const first = await api()
    .get("/api/inventory/low-stock")
    .set("Authorization", `Bearer ${admin.token}`);
  assert.equal(first.body.counts.total, 1);
  assert.equal(first.body.alerts[0].lowStockAlertActive, true, "new condition alerts once");

  // Acknowledging stops it being reported as new, while still unresolved.
  await api()
    .post("/api/inventory/low-stock/ack")
    .set("Authorization", `Bearer ${admin.token}`)
    .send({ foodId: food._id });

  const acked = await api()
    .get("/api/inventory/low-stock")
    .set("Authorization", `Bearer ${admin.token}`);
  assert.equal(acked.body.counts.total, 1, "the condition is still unresolved");
  assert.equal(acked.body.alerts[0].lowStockAlertActive, false, "but it is not a NEW alert");

  // Restock above the threshold resolves it entirely.
  await api()
    .post(`/api/inventory/${food._id}/adjust`)
    .set("Authorization", `Bearer ${admin.token}`)
    .send({ delta: 20, reason: "Restock" });

  const resolved = await api()
    .get("/api/inventory/low-stock")
    .set("Authorization", `Bearer ${admin.token}`);
  assert.equal(resolved.body.counts.total, 0, "the alert resolves when stock returns");
});

test("an out-of-stock tracked item cannot be ordered", async () => {
  const s = await tokenFor("student");
  const food = await trackedFood(0);

  const res = await order(s.token, { items: [{ food: food._id.toString(), quantity: 1 }] });
  assert.equal(res.status, 409);
  assert.match(res.body.message, /sold out/i);
});

test("the inventory report filters by search, category and state", async () => {
  const admin = await tokenFor("admin");
  await trackedFood(1, { name: "Scarce Dosa", category: "Breakfast", lowStockThreshold: 5 });
  await trackedFood(50, { name: "Plenty Dosa", category: "Breakfast", lowStockThreshold: 5 });
  await trackedFood(50, { name: "Cookie", category: "Snacks", lowStockThreshold: 5 });
  await makeFood({ name: "Untracked Thing", category: "Snacks" });

  const bySearch = await api()
    .get("/api/inventory?search=dosa").set("Authorization", `Bearer ${admin.token}`);
  assert.equal(bySearch.body.length, 2);

  const byCategory = await api()
    .get("/api/inventory?category=Snacks").set("Authorization", `Bearer ${admin.token}`);
  assert.equal(byCategory.body.length, 2);

  const low = await api()
    .get("/api/inventory?state=low").set("Authorization", `Bearer ${admin.token}`);
  assert.equal(low.body.length, 1);
  assert.equal(low.body[0].name, "Scarce Dosa");

  const untracked = await api()
    .get("/api/inventory?state=untracked").set("Authorization", `Bearer ${admin.token}`);
  assert.equal(untracked.body.length, 1);
  assert.equal(untracked.body[0].name, "Untracked Thing");

  const bad = await api()
    .get("/api/inventory?state=nonsense").set("Authorization", `Bearer ${admin.token}`);
  assert.equal(bad.status, 400);
});

// ============ 19-20. COMPATIBILITY

test("existing menu endpoints and order flow are unchanged", async () => {
  const s = await tokenFor("student");
  const food = await makeFood({ name: "Plain Item", price: 25 });

  // Original response contract.
  const menu = await api().get("/api/food");
  assert.ok(Array.isArray(menu.body));
  assert.ok(menu.body.some((f) => String(f._id) === String(food._id)));

  const created = await order(s.token, { items: [{ food: food._id.toString(), quantity: 2 }] });
  assert.equal(created.status, 201);
  assert.equal(created.body.total, 50);
  assert.equal(created.body.status, "Pending");

  for (const field of ["_id", "student", "items", "total", "status", "date", "statusHistory"]) {
    assert.ok(field in created.body, `${field} must still be present`);
  }
});

test("tracked items do not change the order lifecycle or cancellation rules", async () => {
  const s = await tokenFor("student");
  const admin = await tokenFor("admin");
  const food = await trackedFood(10);
  const created = await order(s.token, { items: [{ food: food._id.toString(), quantity: 2 }] });

  // The Phase 2 rules still hold on a tracked item.
  const rejected = await patchStatus(s.token, created.body._id, { status: "Accepted" });
  assert.equal(rejected.status, 403, "students still cannot drive status");

  // A separate order for the "cancel while Accepted" case.
  const second = await order(s.token, { items: [{ food: food._id.toString(), quantity: 1 }] });
  await patchStatus(admin.token, second.body._id, { status: "Accepted" });
  const canStillCancel = await cancel(s.token, second.body._id);
  assert.equal(canStillCancel.status, 200, "students can still cancel while Accepted");

  // And one for the "too late" case.
  await patchStatus(admin.token, created.body._id, { status: "Preparing" });
  const tooLate = await cancel(s.token, created.body._id);
  assert.equal(tooLate.status, 409, "still not cancellable once preparing");
});

test("manual availability toggle remains separate from stock", async () => {
  const admin = await tokenFor("admin");
  const s = await tokenFor("student");
  const food = await trackedFood(50);

  await api()
    .post(`/api/inventory/${food._id}/availability`)
    .set("Authorization", `Bearer ${admin.token}`)
    .send({ available: false });

  const res = await order(s.token, { items: [{ food: food._id.toString(), quantity: 1 }] });
  assert.equal(res.status, 409);
  assert.match(res.body.message, /unavailable/i);
  // Stock untouched by the availability toggle.
  assert.deepEqual(await counters(food._id), { stock: 50, reserved: 0, available: 50 });
});