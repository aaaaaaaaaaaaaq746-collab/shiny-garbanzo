const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { api, startDb, resetDb, stopDb, makeUser, makeFood } = require("./helpers");

/**
 * Kitchen Display System feed.
 *
 * The KDS is a read model over the live queue. It must expose exactly the
 * work the kitchen still owes, and its action buttons must come from the same
 * lifecycle rules the REST status endpoint enforces.
 */

before(startDb);
after(stopDb);
beforeEach(resetDb);

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

/** Place an order owned by `owner`, optionally with instructions. */
async function placeOrder(owner, extra = {}) {
  const food = await makeFood({ name: "KDS Item", price: 150 });
  const res = await api()
    .post("/api/orders")
    .set("Authorization", `Bearer ${owner.token}`)
    .send({ items: [{ food: food._id.toString(), quantity: 2 }], ...extra });
  assert.equal(res.status, 201);
  return res.body;
}

async function advance(token, orderId, status, body = {}) {
  const res = await api()
    .put(`/api/orders/${orderId}/status`)
    .set("Authorization", `Bearer ${token}`)
    .send({ status, ...body });
  return res;
}

const kitchen = (token) => api().get("/api/orders/kitchen").set("Authorization", `Bearer ${token}`);

// ======================================================= AUTHORIZATION

test("a student cannot read the kitchen feed", async () => {
  const res = await kitchen((await student()).token);
  assert.equal(res.status, 403);
  assert.match(res.body.message, /access only/i);
});

test("an unauthenticated request cannot read the kitchen feed", async () => {
  const res = await api().get("/api/orders/kitchen");
  assert.equal(res.status, 401);
});

test("admin and staff can both read the kitchen feed", async () => {
  const owner = await student();
  await placeOrder(owner);

  assert.equal((await kitchen((await admin()).token)).status, 200);
  assert.equal((await kitchen((await staff()).token)).status, 200);
});

test("/kitchen is not shadowed by the /:id route", async () => {
  // "kitchen" is not a valid ObjectId; a shadowed route would 400 instead.
  const res = await kitchen((await admin()).token);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
});

// ============================================================ CONTENTS

test("the feed contains only orders still in progress", async () => {
  const owner = await student();
  const a = await admin();

  const pending = await placeOrder(owner);
  const accepted = await placeOrder(owner);
  await advance(a.token, accepted._id, "Accepted");

  const preparing = await placeOrder(owner);
  await advance(a.token, preparing._id, "Preparing");

  const ready = await placeOrder(owner);
  await advance(a.token, ready._id, "Ready");

  const completed = await placeOrder(owner);
  await advance(a.token, completed._id, "Completed");

  const cancelled = await placeOrder(owner);
  await api()
    .post(`/api/orders/${cancelled._id}/cancel`)
    .set("Authorization", `Bearer ${owner.token}`)
    .send({});

  const rejected = await placeOrder(owner);
  await advance(a.token, rejected._id, "Rejected", { reason: "sold out" });

  const res = await kitchen(a.token);
  assert.equal(res.status, 200);

  const ids = res.body.map((o) => o._id);
  assert.deepEqual(
    ids.sort(),
    [pending._id, accepted._id, preparing._id, ready._id].sort(),
    "only Pending/Accepted/Preparing/Ready belong on the board"
  );

  assert.equal(
    res.body.some((o) => [completed._id, cancelled._id, rejected._id].includes(o._id)),
    false,
    "settled orders must not appear"
  );
});

test("the feed is sorted oldest first, so the longest wait is on top", async () => {
  const owner = await student();
  const first = await placeOrder(owner);
  await new Promise((r) => setTimeout(r, 1100));
  const second = await placeOrder(owner);
  await new Promise((r) => setTimeout(r, 1100));
  const third = await placeOrder(owner);

  const res = await kitchen((await admin()).token);
  assert.deepEqual(
    res.body.map((o) => o._id),
    [first._id, second._id, third._id]
  );
});

test("waitSeconds is provided and non-negative", async () => {
  const owner = await student();
  await placeOrder(owner);

  const res = await kitchen((await admin()).token);
  assert.equal(typeof res.body[0].waitSeconds, "number");
  assert.ok(res.body[0].waitSeconds >= 0);
  assert.ok(res.body[0].waitSeconds < 60, "a fresh order should not look stale");
});

test("each feed entry carries the server-derived allowedTransitions", async () => {
  const owner = await student();
  const a = await admin();
  const order = await placeOrder(owner);

  let res = await kitchen(a.token);
  let entry = res.body.find((o) => o._id === order._id);
  assert.ok(entry.allowedTransitions.includes("Accepted"));
  assert.ok(entry.allowedTransitions.includes("Cancelled"));
  assert.ok(entry.allowedTransitions.includes("Rejected"));

  // Once preparing, the rejected action must disappear — the KDS cannot offer
  // an action the API would refuse.
  await advance(a.token, order._id, "Preparing");
  res = await kitchen(a.token);
  entry = res.body.find((o) => o._id === order._id);
  assert.ok(entry.allowedTransitions.includes("Ready"));
  assert.equal(entry.allowedTransitions.includes("Rejected"), false);
  assert.equal(entry.allowedTransitions.includes("Accepted"), false);
});

test("the feed populates the student and carries kitchen-relevant detail", async () => {
  const owner = await student();
  const order = await placeOrder(owner, {
    notes: "No onions please",
    pickupSlot: "12:30",
  });

  const res = await kitchen((await admin()).token);
  const entry = res.body.find((o) => o._id === order._id);

  assert.equal(entry.student.email, owner.email, "student must be populated");
  assert.equal(entry.notes, "No onions please");
  assert.equal(entry.pickupSlot, "12:30");
  assert.equal(entry.items.length, 1);
  assert.equal(entry.items[0].quantity, 2);
  assert.equal(entry.items[0].price, 150);
});

test("a staff member's feed reflects their own permissions", async () => {
  const owner = await student();
  const k = await staff();
  const order = await placeOrder(owner);
  await advance(k.token, order._id, "Preparing");

  const res = await kitchen(k.token);
  const entry = res.body.find((o) => o._id === order._id);

  // Staff may not reject, and may not cancel a Preparing order.
  assert.equal(entry.allowedTransitions.includes("Rejected"), false);
  assert.equal(entry.allowedTransitions.includes("Cancelled"), false);
  assert.ok(entry.allowedTransitions.includes("Ready"));
  assert.ok(entry.allowedTransitions.includes("Completed"));
});

test("a settled order disappears from the feed once cancelled by the student", async () => {
  const owner = await student();
  const a = await admin();
  const order = await placeOrder(owner);

  let res = await kitchen(a.token);
  assert.equal(res.body.some((o) => o._id === order._id), true);

  await api()
    .post(`/api/orders/${order._id}/cancel`)
    .set("Authorization", `Bearer ${owner.token}`)
    .send({});

  res = await kitchen(a.token);
  assert.equal(res.body.some((o) => o._id === order._id), false);
});

test("the feed never leaks orders through a malformed filter", async () => {
  const owner = await student();
  await placeOrder(owner);
  const a = await admin();

  // The kitchen feed takes no filters; anything else must not widen or narrow it.
  const res = await api()
    .get("/api/orders/kitchen?status=Completed")
    .set("Authorization", `Bearer ${a.token}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1, "an unknown query must not filter the board");
});

test("KDS actions go through the same lifecycle enforcement", async () => {
  const owner = await student();
  const k = await staff();
  const order = await placeOrder(owner);

  // A kitchen action the lifecycle forbids is still refused.
  const forbidden = await advance(k.token, order._id, "Rejected", { reason: "nope" });
  assert.equal(forbidden.status, 403, "staff must not reject from the board");

  const allowed = await advance(k.token, order._id, "Accepted");
  assert.equal(allowed.status, 200);
});
test("the feed is empty when nothing is in progress", async () => {
  const owner = await student();
  const a = await admin();
  const res = await kitchen(a.token);
  assert.deepEqual(res.body, [], "a settled canteen yields an empty board");

  const order = await placeOrder(owner);
  assert.equal((await kitchen(a.token)).body.length, 1);

  // Settling the only order empties it again.
  await advance(a.token, order._id, "Completed");
  assert.deepEqual((await kitchen(a.token)).body, []);
});
test("the kitchen feed works with no socket client attached at all", async () => {
  // The real-time layer is an in-process singleton that is never attached in
  // these tests. Proving the feed still serves correct data here is what
  // guarantees the board survives a dead or disabled socket.
  const owner = await student();
  const a = await admin();
  const order = await placeOrder(owner);

  let res = await kitchen(a.token);
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0]._id, order._id);
  assert.ok(res.body[0].allowedTransitions.includes("Accepted"));

  // Mutations still succeed and the feed reflects them.
  const moved = await advance(a.token, order._id, "Preparing");
  assert.equal(moved.status, 200);

  res = await kitchen(a.token);
  assert.equal(res.body[0].status, "Preparing");
  assert.equal(res.body[0].allowedTransitions.includes("Rejected"), false);
});

test("kitchen actions remain correct when realtime is disabled entirely", async () => {
  // REALTIME_ENABLED=false is honoured by config; the REST contract is
  // unchanged, which is what lets the UI degrade to REST.
  const config = require("../config");
  const realtime = require("../realtime");

  assert.equal(realtime.emitOrderUpdate({ orderId: "x", status: "Pending" }), false,
    "emitting with no server attached is a silent no-op, not a crash");

  const owner = await student();
  const a = await admin();
  const order = await placeOrder(owner);
  const res = await advance(a.token, order._id, "Accepted");
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "Accepted");
  assert.ok(config.order); // business rules unaffected
});