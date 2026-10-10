const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { api, startDb, resetDb, stopDb, makeUser, makeFood } = require("./helpers");
const lifecycle = require("../utils/orderLifecycle");

const { STATUS } = lifecycle;

before(startDb);
after(stopDb);
beforeEach(resetDb);

/** A brand-new account of the given role, plus a logged-in token. */
async function tokenFor(role) {
  const email = `${role}-${Math.random().toString(36).slice(2, 10)}@college.edu`;
  await makeUser({ name: role, email, password: "password123", role });
  const res = await api()
    .post("/api/auth/login")
    .send({ email, password: "password123" });
  return { token: res.body.token, id: res.body.id, email };
}

const admin = () => tokenFor("admin");
const staff = () => tokenFor("staff");
const student = () => tokenFor("student");

/** Place a one-item order and return the created order. */
async function placeOrder(token) {
  const food = await makeFood({ name: "Lifecycle Item", price: 100 });
  const res = await api()
    .post("/api/orders")
    .set("Authorization", `Bearer ${token}`)
    .send({ items: [{ food: food._id.toString(), quantity: 1 }] });
  assert.equal(res.status, 201);
  return res.body;
}

/** Create an order and drive it to `status` with the given token. */
async function orderAtStatus(token, status) {
  const order = await placeOrder(token);
  // A fresh order is already Pending; transitioning to the same status is a
  // 409 by design, so short-circuit that case.
  if (order.status === status) return order;
  const res = await api()
    .put(`/api/orders/${order._id}/status`)
    .set("Authorization", `Bearer ${token}`)
    .send({ status });
  assert.equal(res.status, 200, `could not drive order to ${status}: ${res.body?.message}`);
  return res.body;
}

/**
 * An order owned by `owner`, advanced to `status` by `driver`.
 * Keeps ownership and the transition actor distinct so authorization is
 * genuinely exercised.
 */
async function ownedOrderAtStatus(owner, driver, status) {
  const order = await placeOrder(owner.token);
  if (order.status === status) return order;
  const res = await transition(driver.token, order._id, { status });
  assert.equal(res.status, 200, `could not drive order to ${status}: ${res.body?.message}`);
  return { ...order, status: res.body.status };
}

const transition = (token, id, body) =>
  api().put(`/api/orders/${id}/status`).set("Authorization", `Bearer ${token}`).send(body);

const cancel = (token, id, body = {}) =>
  api().post(`/api/orders/${id}/cancel`).set("Authorization", `Bearer ${token}`).send(body);

// ============================================================ 1. PERMITTED

test("every forward lifecycle transition is permitted for staff", async () => {
  const cases = [
    ["Pending", "Accepted"],
    ["Accepted", "Preparing"],
    ["Preparing", "Ready"],
    ["Ready", "Completed"],
  ];

  for (const [from, to] of cases) {
    const k = await staff();
    const order = await orderAtStatus(k.token, from);
    const res = await transition(k.token, order._id, { status: to });

    assert.equal(res.status, 200, `${from} -> ${to} should be permitted`);
    assert.equal(res.body.status, to);
    if (to === "Completed") assert.ok(res.body.completedAt, "completedAt stamped");
  }
});

test("skip-ahead transitions preserve the original admin workflow", async () => {
  // The pre-Phase-2 admin UI jumped straight from Pending to these states.
  const cases = [
    ["Pending", "Preparing"],
    ["Pending", "Completed"],
    ["Preparing", "Completed"],
    ["Accepted", "Ready"],
    ["Pending", "Ready"],
  ];

  for (const [from, to] of cases) {
    const a = await admin();
    const order = await orderAtStatus(a.token, from);
    const res = await transition(a.token, order._id, { status: to });
    assert.equal(res.status, 200, `${from} -> ${to} must stay permitted`);
    assert.equal(res.body.status, to);
  }
});

test("a Preparing order can be moved to Ready and then Completed", async () => {
  const k = await staff();
  const order = await orderAtStatus(k.token, "Preparing");

  const ready = await transition(k.token, order._id, { status: "Ready" });
  assert.equal(ready.status, 200);
  assert.equal(ready.body.status, "Ready");

  const done = await transition(k.token, order._id, { status: "Completed" });
  assert.equal(done.status, 200);
  assert.equal(done.body.status, "Completed");
  assert.ok(done.body.completedAt, "completedAt is stamped on completion");
});

test("an admin may reject a Pending or Accepted order with a reason", async () => {
  const a = await admin();

  const pending = await placeOrder(a.token);
  const rejected = await transition(a.token, pending._id, {
    status: "Rejected",
    reason: "Item sold out",
  });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.status, "Rejected");

  const accepted = await orderAtStatus(a.token, "Accepted");
  const rejected2 = await transition(a.token, accepted._id, {
    status: "Rejected",
    reason: "Duplicate order",
  });
  assert.equal(rejected2.status, 200);
  assert.equal(rejected2.body.status, "Rejected");
});

// ============================================================ 2. FORBIDDEN

test("terminal states cannot be reopened through ordinary requests", async () => {
  const a = await admin();

  const build = {
    Completed: async () => (await orderAtStatus(a.token, "Completed"))._id,
    Cancelled: async () =>
      (await transition(a.token, (await placeOrder(a.token))._id, {
        status: "Cancelled",
        reason: "test",
      })).body._id,
    Rejected: async () =>
      (await transition(a.token, (await placeOrder(a.token))._id, {
        status: "Rejected",
        reason: "test",
      })).body._id,
  };

  for (const terminal of ["Completed", "Cancelled", "Rejected"]) {
    const id = await build[terminal]();

    for (const target of ["Pending", "Accepted", "Preparing", "Ready", "Completed"]) {
      if (target === terminal) continue; // same-status is a separate rule
      const res = await transition(a.token, id, { status: target });
      assert.equal(res.status, 409, `${terminal} -> ${target} must be refused`);
      assert.match(res.body.message, /can no longer change status/i);
    }
  }
});

test("backwards transitions are rejected", async () => {
  const a = await admin();

  const backwards = [
    ["Ready", "Preparing"],
    ["Ready", "Accepted"],
    ["Ready", "Pending"],
    ["Preparing", "Accepted"],
    ["Preparing", "Pending"],
    ["Accepted", "Pending"],
  ];

  for (const [from, to] of backwards) {
    const order = await orderAtStatus(a.token, from);
    const res = await transition(a.token, order._id, { status: to });
    assert.equal(res.status, 409, `${from} -> ${to} must be refused`);
  }
});

test("an order cannot transition to its current status", async () => {
  const k = await staff();
  const order = await orderAtStatus(k.token, "Preparing");

  const res = await transition(k.token, order._id, { status: "Preparing" });
  assert.equal(res.status, 409);
  assert.match(res.body.message, /already Preparing/i);
});

test("an admin cannot reject once preparation has started", async () => {
  const a = await admin();
  const order = await orderAtStatus(a.token, "Preparing");

  const res = await transition(a.token, order._id, {
    status: "Rejected",
    reason: "too late",
  });
  assert.equal(res.status, 409);
  assert.match(res.body.message, /cannot be rejected once it is Preparing/i);
});

// ================================================== 3. STUDENT CANCELLATION

test("a student can cancel their own Pending order", async () => {
  const s = await student();
  const order = await placeOrder(s.token);

  const res = await cancel(s.token, order._id);

  assert.equal(res.status, 200);
  assert.equal(res.body.status, "Cancelled");
  assert.ok(res.body.cancelledAt, "cancelledAt is stamped");
});

test("a student can cancel their own Accepted order", async () => {
  const s = await student();
  const a = await admin();
  const order = await ownedOrderAtStatus(s, a, "Accepted");

  const res = await cancel(s.token, order._id);

  assert.equal(res.status, 200);
  assert.equal(res.body.status, "Cancelled");
});

test("cancellation is idempotent for the same owner", async () => {
  const s = await student();
  const order = await placeOrder(s.token);

  const first = await cancel(s.token, order._id);
  assert.equal(first.status, 200);

  const second = await cancel(s.token, order._id);
  assert.equal(second.status, 200, "repeating the request must not error");
  assert.equal(second.body.status, "Cancelled");

  const cancellations = second.body.statusHistory.filter((h) => h.status === "Cancelled");
  assert.equal(cancellations.length, 1, "only one cancellation is recorded");
});

// ========================================== 4. CANCELLING ANOTHER'S ORDER

test("a student cannot cancel another student's order", async () => {
  const owner = await student();
  const intruder = await student();
  const order = await placeOrder(owner.token);

  const res = await cancel(intruder.token, order._id);

  assert.equal(res.status, 403);
  assert.match(res.body.message, /only cancel your own/i);

  const check = await api()
    .get(`/api/orders/${order._id}`)
    .set("Authorization", `Bearer ${owner.token}`);
  assert.equal(check.body.status, "Pending", "order must be untouched");
});

test("staff may cancel another user's order, but must give a reason", async () => {
  const owner = await student();
  const order = await placeOrder(owner.token);
  const k = await staff();

  // Staff cancellation is administrative, so a reason is mandatory.
  const noReason = await cancel(k.token, order._id);
  assert.equal(noReason.status, 400);
  assert.match(noReason.body.message, /cancellation reason is required/i);

  const res = await cancel(k.token, order._id, { reason: "Student requested by phone" });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "Cancelled");
  assert.equal(res.body.statusHistory[1].role, "staff");
});

// ======================================== 5. CANCELLATION AFTER PREP STARTS

test("a student cannot cancel once preparation has begun", async () => {
  const s = await student();
  const a = await admin();
  const order = await ownedOrderAtStatus(s, a, "Preparing");

  const res = await cancel(s.token, order._id);

  assert.equal(res.status, 409);
  assert.match(res.body.message, /no longer be cancelled/i);

  const check = await api()
    .get(`/api/orders/${order._id}`)
    .set("Authorization", `Bearer ${s.token}`);
  assert.equal(check.body.status, "Preparing", "status must be unchanged");
});

test("an admin may cancel a Preparing order as the explicit exception", async () => {
  const a = await admin();
  const order = await orderAtStatus(a.token, "Preparing");

  const res = await transition(a.token, order._id, {
    status: "Cancelled",
    reason: "Customer no-show",
  });

  assert.equal(res.status, 200, "the documented admin exception must work");
  assert.equal(res.body.status, "Cancelled");
});

test("staff may not cancel a Preparing order even though admin can", async () => {
  const k = await staff();
  const order = await orderAtStatus(k.token, "Preparing");

  const res = await transition(k.token, order._id, {
    status: "Cancelled",
    reason: "no-show",
  });

  assert.equal(res.status, 409);
});

// ================================ 6. CANCELLING SETTLED / CLOSED ORDERS

test("a student cannot cancel completed or rejected orders", async () => {
  const s = await student();
  const a = await admin();

  const completed = await ownedOrderAtStatus(s, a, "Completed");
  const rejected = (
    await transition(a.token, (await placeOrder(s.token))._id, {
      status: "Rejected",
      reason: "sold out",
    })
  ).body;

  for (const order of [completed, rejected]) {
    const res = await cancel(s.token, order._id);
    assert.equal(res.status, 409, `cancelling a ${order.status} order must be refused`);
    assert.match(res.body.message, /can no longer change status/i);
  }
});

test("cancelling an already-cancelled order stays idempotent rather than erroring", async () => {
  const s = await student();
  const order = await placeOrder(s.token);

  const first = await cancel(s.token, order._id);
  assert.equal(first.status, 200);

  // Documented behaviour: repeating the request is a no-op success.
  const second = await cancel(s.token, order._id);
  assert.equal(second.status, 200);
  assert.equal(second.body.status, "Cancelled");
});

// ============================================ 7. UNAUTHORIZED OPERATIONS

test("a student cannot set order status directly", async () => {
  const s = await student();
  const order = await placeOrder(s.token);

  for (const target of ["Accepted", "Preparing", "Completed", "Cancelled", "Rejected"]) {
    const res = await transition(s.token, order._id, { status: target });
    assert.equal(res.status, 403, `student must not set ${target}`);
  }
});

test("staff cannot reject an order", async () => {
  const k = await staff();
  const order = await placeOrder(k.token);

  const res = await transition(k.token, order._id, {
    status: "Rejected",
    reason: "not my call",
  });

  assert.equal(res.status, 403);
  assert.match(res.body.message, /only an administrator/i);
});

test("an unauthenticated request cannot change an order", async () => {
  const a = await admin();
  const order = await placeOrder(a.token);

  const res = await api().put(`/api/orders/${order._id}/status`).send({ status: "Completed" });
  assert.equal(res.status, 401);

  const cancelRes = await api().post(`/api/orders/${order._id}/cancel`).send({});
  assert.equal(cancelRes.status, 401);
});

test("rejection and administrative cancellation require a reason", async () => {
  const a = await admin();

  const noReasonReject = await transition(a.token, (await placeOrder(a.token))._id, {
    status: "Rejected",
  });
  assert.equal(noReasonReject.status, 400);
  assert.match(noReasonReject.body.message, /rejection reason is required/i);

  const noReasonCancel = await transition(a.token, (await placeOrder(a.token))._id, {
    status: "Cancelled",
  });
  assert.equal(noReasonCancel.status, 400);
  assert.match(noReasonCancel.body.message, /cancellation reason is required/i);

  const blankReason = await transition(a.token, (await placeOrder(a.token))._id, {
    status: "Rejected",
    reason: "   ",
  });
  assert.equal(blankReason.status, 400);

  const overlong = await transition(a.token, (await placeOrder(a.token))._id, {
    status: "Rejected",
    reason: "x".repeat(500),
  });
  assert.equal(overlong.status, 400);
});

test("a student may cancel without supplying a reason", async () => {
  const s = await student();
  const order = await placeOrder(s.token);
  const res = await cancel(s.token, order._id);
  assert.equal(res.status, 200);
});

// ================================================ 8. INVALID INPUT HANDLING

test("malformed ids that reach the route are rejected with 400", async () => {
  const a = await admin();
  const s = await student();

  // Well-formed URL segment, invalid ObjectId.
  for (const badId of ["not-an-id", "123", "zzzzzzzzzzzzzzzzzzzzzzzz", "0123456789abcdef0123456g"]) {
    assert.equal(
      (await transition(a.token, badId, { status: "Completed" })).status,
      400,
      `status on "${badId}"`
    );
    assert.equal((await cancel(s.token, badId)).status, 400, `cancel on "${badId}"`);
  }
});

test("malformed status payloads are rejected with 400", async () => {
  const a = await admin();
  const order = await placeOrder(a.token);

  for (const body of [{}, { status: "Hacked" }, { status: 123 }, { status: "pending" }, { status: null }]) {
    const res = await transition(a.token, order._id, body);
    assert.equal(res.status, 400, `body ${JSON.stringify(body)} must be rejected`);
  }
});

test("a missing order returns 404 for both status and cancel", async () => {
  const a = await admin();
  const missing = "0123456789abcdef01234567";

  assert.equal((await transition(a.token, missing, { status: "Completed" })).status, 404);
  assert.equal((await cancel(a.token, missing)).status, 404);
});

// =================================================== 9. CONCURRENCY SAFETY

test("two conflicting transitions racing from the same state: exactly one wins", async () => {
  const s = await student();
  const a1 = await admin();
  const a2 = await admin();
  const order = await placeOrder(s.token);

  const [accept, prepare] = await Promise.all([
    transition(a1.token, order._id, { status: "Accepted" }),
    transition(a2.token, order._id, { status: "Preparing" }),
  ]);

  assert.deepEqual([accept.status, prepare.status].sort(), [200, 409],
    "exactly one must win, the other conflicts");

  const final = await api()
    .get(`/api/orders/${order._id}`)
    .set("Authorization", `Bearer ${s.token}`);

  const winner = accept.status === 200 ? "Accepted" : "Preparing";
  assert.equal(final.body.status, winner, "the winning transition must be preserved");

  assert.equal(final.body.statusHistory.length, 2, "the loser must leave no audit entry");
  assert.equal(final.body.statusHistory[1].status, winner);
  assert.equal(final.body.statusHistory[1].from, "Pending");
});

test("two identical concurrent transitions: one wins, no duplicate audit entries", async () => {
  const s = await student();
  const a1 = await admin();
  const a2 = await admin();
  const order = await placeOrder(s.token);

  const [x, y] = await Promise.all([
    transition(a1.token, order._id, { status: "Preparing" }),
    transition(a2.token, order._id, { status: "Preparing" }),
  ]);

  assert.deepEqual([x.status, y.status].sort(), [200, 409]);

  const final = await api()
    .get(`/api/orders/${order._id}`)
    .set("Authorization", `Bearer ${s.token}`);
  assert.equal(final.body.status, "Preparing");
  assert.equal(final.body.statusHistory.length, 2, "must not record the transition twice");
});

test("a losing conflict response names the current state", async () => {
  const s = await student();
  const a1 = await admin();
  const a2 = await admin();
  const order = await placeOrder(s.token);

  const [, loser] = await Promise.all([
    transition(a1.token, order._id, { status: "Accepted" }),
    transition(a2.token, order._id, { status: "Preparing" }),
  ]);

  assert.equal(loser.status, 409);
  assert.match(loser.body.message, /changed to Accepted/i);
});

test("a concurrent cancel racing a status change cannot corrupt the record", async () => {
  const s = await student();
  const a = await admin();
  const order = await placeOrder(s.token);

  const [cancelRes, prepareRes] = await Promise.all([
    cancel(s.token, order._id),
    transition(a.token, order._id, { status: "Preparing" }),
  ]);

  // Both may legitimately succeed only if ordering is coherent; otherwise one
  // must conflict. Either way the history must tell a single consistent story.
  const final = await api()
    .get(`/api/orders/${order._id}`)
    .set("Authorization", `Bearer ${s.token}`);

  const statuses = final.body.statusHistory.map((h) => h.status);
  assert.equal(statuses[0], "Pending");
  assert.equal(statuses.length, 2, "exactly one further transition may be recorded");

  // Whatever won, the recorded chain must be internally consistent.
  assert.equal(final.body.statusHistory[1].from, "Pending");
  assert.ok(
    [cancelRes.status, prepareRes.status].includes(409) ||
      [cancelRes.status, prepareRes.status].includes(200)
  );
});

// ========================================================== 10. AUDIT TRAIL

test("each successful transition records from, to, actor, role, time and reason", async () => {
  const s = await student();
  const a = await admin();
  const order = await placeOrder(s.token);

  await transition(a.token, order._id, { status: "Accepted" });
  await transition(a.token, order._id, {
    status: "Rejected",
    reason: "Ingredient shortage",
  });

  const res = await api()
    .get(`/api/orders/${order._id}`)
    .set("Authorization", `Bearer ${s.token}`);

  const history = res.body.statusHistory;
  assert.equal(history.length, 3);

  const [creation, accepted, rejected] = history;

  assert.equal(creation.status, "Pending");
  assert.equal(creation.from, null);
  assert.equal(creation.role, "student");

  assert.equal(accepted.status, "Accepted");
  assert.equal(accepted.from, "Pending");
  assert.equal(accepted.by, a.id);
  assert.equal(accepted.role, "admin");
  assert.ok(accepted.at, "timestamp recorded");

  assert.equal(rejected.status, "Rejected");
  assert.equal(rejected.from, "Accepted");
  assert.equal(rejected.role, "admin");
  assert.equal(rejected.reason, "Ingredient shortage");
});

test("a student cancellation records the student as the actor", async () => {
  const s = await student();
  const order = await placeOrder(s.token);

  const res = await cancel(s.token, order._id);
  const entry = res.body.statusHistory[1];

  assert.equal(entry.status, "Cancelled");
  assert.equal(entry.from, "Pending");
  assert.equal(entry.by, s.id);
  assert.equal(entry.role, "student");
});

test("failed transitions never create audit entries", async () => {
  const s = await student();
  const a = await admin();
  const order = await ownedOrderAtStatus(s, a, "Completed");

  const read = async () =>
    (await api()
      .get(`/api/orders/${order._id}`)
      .set("Authorization", `Bearer ${s.token}`)).body.statusHistory.length;

  const before = await read();

  await transition(a.token, order._id, { status: "Pending" }); // 409 terminal
  await transition(s.token, order._id, { status: "Completed" }); // 403 student
  await transition(a.token, order._id, { status: "Rejected" }); // 409 terminal
  await transition(a.token, order._id, { status: "Hacked" }); // 400 unknown

  assert.equal(await read(), before, "no audit entries may be added by refused requests");
});

// ======================================================= 11. COMPATIBILITY

test("legacy pre-Phase-2 order documents still load and remain usable", async () => {
  const s = await student();
  const a = await admin();

  // A document shaped exactly like the original Order schema: no subtotal, and
  // history entries carrying only status/at/by.
  const studentDoc = await mongoose.connection
    .collection("users")
    .findOne({ email: s.email });

  const legacyId = new mongoose.Types.ObjectId();
  await mongoose.connection.collection("orders").insertOne({
    _id: legacyId,
    student: studentDoc._id,
    items: [
      { food: new mongoose.Types.ObjectId(), name: "Legacy Item", price: 50, quantity: 2 },
    ],
    total: 100,
    status: "Pending",
    date: new Date(),
    statusHistory: [{ status: "Pending", at: new Date(), by: studentDoc._id }],
  });

  const mine = await api().get("/api/orders").set("Authorization", `Bearer ${s.token}`);
  assert.equal(mine.status, 200);
  const legacy = mine.body.find((o) => String(o._id) === String(legacyId));
  assert.ok(legacy, "legacy order must still be listed");
  assert.equal(legacy.total, 100);
  assert.equal(legacy.items[0].name, "Legacy Item");

  // An entry without from/role/reason must serialize with nulls.
  assert.equal(legacy.statusHistory[0].status, "Pending");
  assert.equal(legacy.statusHistory[0].from, null);
  assert.equal(legacy.statusHistory[0].role, null);

  // Still advanceable through the new lifecycle.
  const advanced = await transition(a.token, legacyId, { status: "Preparing" });
  assert.equal(advanced.status, 200);
  assert.equal(advanced.body.status, "Preparing");
});

test("existing response fields and status filter remain backward compatible", async () => {
  const s = await student();
  const a = await admin();
  const order = await placeOrder(s.token);

  const single = await api()
    .get(`/api/orders/${order._id}`)
    .set("Authorization", `Bearer ${s.token}`);

  // Fields the Phase 1 contract guaranteed.
  for (const field of ["_id", "student", "items", "total", "status", "date", "statusHistory"]) {
    assert.ok(field in single.body, `field "${field}" must still be present`);
  }
  assert.equal(single.body.items[0].price, 100);

  // New additive fields.
  assert.equal(single.body.canCancel, true, "a Pending order is cancellable by its owner");

  const staffView = await api()
    .get(`/api/orders/${order._id}`)
    .set("Authorization", `Bearer ${a.token}`);
  assert.ok(Array.isArray(staffView.body.allowedTransitions));
  assert.ok(staffView.body.allowedTransitions.includes("Accepted"));

  // The old status filter still works for every original value...
  for (const status of ["Pending", "Preparing", "Completed"]) {
    const filtered = await api()
      .get(`/api/orders/all?status=${status}`)
      .set("Authorization", `Bearer ${a.token}`);
    assert.equal(filtered.status, 200, `filter ${status} must still work`);
  }

  // ...and for the newly added values.
  for (const status of ["Accepted", "Rejected"]) {
    const filtered = await api()
      .get(`/api/orders/all?status=${status}`)
      .set("Authorization", `Bearer ${a.token}`);
    assert.equal(filtered.status, 200, `filter ${status} must work`);
  }
});

test("a terminal order reports canCancel false", async () => {
  const s = await student();
  const a = await admin();
  const order = await ownedOrderAtStatus(s, a, "Completed");

  const res = await api()
    .get(`/api/orders/${order._id}`)
    .set("Authorization", `Bearer ${s.token}`);
  assert.equal(res.body.canCancel, false);
});

test("the lifecycle map is the single source of truth for allowed transitions", async () => {
  const a = await admin();

  const reported = lifecycle.allowedTransitions({ from: "Pending", role: "admin" });
  assert.ok(reported.includes("Accepted"));
  assert.ok(reported.includes("Preparing"));

  // Everything the map advertises as allowed must actually succeed.
  const order = await placeOrder(a.token);
  const first = reported[0];
  const res = await transition(a.token, order._id, { status: first });
  assert.equal(res.status, 200, `"${first}" was advertised but rejected`);
});

test("strict lifecycle mode requires each adjacent stage", () => {
  // Unit-level check of the rule the ORDER_STRICT_LIFECYCLE flag toggles.
  assert.equal(
    lifecycle.checkTransition({ from: "Pending", to: "Preparing", role: "admin" }).allowed,
    true
  );
  assert.equal(
    lifecycle.checkTransition({
      from: "Pending",
      to: "Preparing",
      role: "admin",
      strict: true,
    }).allowed,
    false,
    "strict mode must forbid skipping Accepted"
  );
  assert.equal(
    lifecycle.checkTransition({
      from: "Accepted",
      to: "Preparing",
      role: "admin",
      strict: true,
    }).allowed,
    true
  );
});

test("the canonical lifecycle is walkable end to end", async () => {
  const k = await staff();
  let order = await placeOrder(k.token);

  for (const next of ["Accepted", "Preparing", "Ready", "Completed"]) {
    const res = await transition(k.token, order._id, { status: next });
    assert.equal(res.status, 200, `step to ${next} failed: ${res.body?.message}`);
    order = res.body;
  }

  const chain = order.statusHistory.map((h) => `${h.from || "∅"}->${h.status}`);
  assert.deepEqual(chain, ["∅->Pending", "Pending->Accepted", "Accepted->Preparing", "Preparing->Ready", "Ready->Completed"]);
});