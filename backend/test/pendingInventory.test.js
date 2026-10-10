const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

/**
 * P2-R2: the inventory step after a status change is retried, not lost. DB-backed.
 *
 * A stub makes the inventory service fail exactly once, simulating an outage
 * right after the status change has committed. The test then checks that the
 * order carries a pending marker, and that the retry finishes the work once.
 */

const { api, startDb, resetDb, stopDb, makeUser } = require("./helpers");
const Food = require("../models/FoodItem");
const Order = require("../models/Order");
const Movement = require("../models/InventoryMovement");
const inventory = require("../services/inventory");

before(startDb);
after(stopDb);
beforeEach(resetDb);

let seq = 0;
async function tokenFor(role) {
  seq += 1;
  const email = `${role}-p${seq}-${Math.random().toString(36).slice(2, 8)}@college.edu`;
  await makeUser({ name: `${role} ${seq}`, email, role });
  const res = await api().post("/api/auth/login").send({ email, password: "password123" });
  assert.equal(res.status, 200);
  return res.body.token;
}

const auth = (token) => ({ Authorization: `Bearer ${token}` });

/** Make the named inventory function throw once, then behave normally. */
function failOnce(name) {
  const original = inventory[name];
  let armed = true;
  inventory[name] = async (...args) => {
    if (armed) {
      armed = false;
      throw new Error("simulated inventory outage");
    }
    return original(...args);
  };
  return () => {
    inventory[name] = original;
  };
}

async function trackedFood(stock) {
  return Food.create({
    name: `P ${Math.random().toString(36).slice(2, 7)}`,
    price: 10,
    trackInventory: true,
    stock,
    reserved: 0,
    lowStockThreshold: 0,
  });
}

async function placeOrder(student, food, quantity) {
  const res = await api()
    .post("/api/orders")
    .set(auth(student))
    .send({ items: [{ food: food._id.toString(), quantity }] });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

// ------------------------------------------- consume retried on preparation

test("P2-R2: a failed consume is recorded as pending and the retry completes it once", async () => {
  const admin = await tokenFor("admin");
  const student = await tokenFor("student");
  const food = await trackedFood(5);
  const order = await placeOrder(student, food, 2);
  assert.equal((await Food.findById(food._id)).reserved, 2);

  // Accept, then move to Preparing while the consume step is failing.
  const accepted = await api().put(`/api/orders/${order._id}/status`).set(auth(admin)).send({ status: "Accepted" });
  assert.equal(accepted.status, 200);

  const restore = failOnce("consumeOrder");
  try {
    const failed = await api()
      .put(`/api/orders/${order._id}/status`)
      .set(auth(admin))
      .send({ status: "Preparing" });
    assert.ok(failed.status >= 500, `expected a server error, got ${failed.status}`);
  } finally {
    restore();
  }

  // The status change committed, and the owed work is recorded on the order.
  const stuck = await Order.findById(order._id);
  assert.equal(stuck.status, "Preparing");
  assert.equal(stuck.inventoryPendingKind, "consume");
  assert.equal((await Food.findById(food._id)).stock, 5, "nothing consumed yet");

  // Retrying the same target completes the work and succeeds.
  const retry = await api()
    .put(`/api/orders/${order._id}/status`)
    .set(auth(admin))
    .send({ status: "Preparing" });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.status, "Preparing");

  const done = await Order.findById(order._id);
  assert.equal(done.inventoryPendingKind, null, "marker cleared after success");
  assert.equal(done.inventoryPendingReason, null);

  const fresh = await Food.findById(food._id);
  assert.equal(fresh.stock, 3, "consumed exactly once");
  assert.equal(fresh.reserved, 0);
  assert.equal(await Movement.countDocuments({ food: food._id, type: "consume" }), 1);
});

test("P2-R2: once the retry has succeeded, repeating the same target is a normal conflict again", async () => {
  const admin = await tokenFor("admin");
  const student = await tokenFor("student");
  const food = await trackedFood(5);
  const order = await placeOrder(student, food, 1);
  await api().put(`/api/orders/${order._id}/status`).set(auth(admin)).send({ status: "Accepted" });

  const restore = failOnce("consumeOrder");
  try {
    await api().put(`/api/orders/${order._id}/status`).set(auth(admin)).send({ status: "Preparing" });
  } finally {
    restore();
  }
  await api().put(`/api/orders/${order._id}/status`).set(auth(admin)).send({ status: "Preparing" });

  // No marker left, so a plain repeat of the same status is refused as before.
  const again = await api().put(`/api/orders/${order._id}/status`).set(auth(admin)).send({ status: "Preparing" });
  assert.equal(again.status, 409);
});

// ------------------------------------------- release retried on cancellation

test("P2-R2: a failed release on cancel is retried by the student's repeat cancel", async () => {
  const student = await tokenFor("student");
  const food = await trackedFood(5);
  const order = await placeOrder(student, food, 2);
  assert.equal((await Food.findById(food._id)).reserved, 2);

  const restore = failOnce("releaseOrder");
  try {
    const failed = await api().post(`/api/orders/${order._id}/cancel`).set(auth(student)).send({});
    assert.ok(failed.status >= 500, `expected a server error, got ${failed.status}`);
  } finally {
    restore();
  }

  const stuck = await Order.findById(order._id);
  assert.equal(stuck.status, "Cancelled");
  assert.equal(stuck.inventoryPendingKind, "release", "owed release is recorded");
  assert.equal((await Food.findById(food._id)).reserved, 2, "reservation still held");

  // The student retries. The repeat returns 200 and completes the release.
  const retry = await api().post(`/api/orders/${order._id}/cancel`).set(auth(student)).send({});
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.status, "Cancelled");

  const done = await Order.findById(order._id);
  assert.equal(done.inventoryPendingKind, null);
  assert.equal((await Food.findById(food._id)).reserved, 0, "reservation returned exactly once");
  assert.equal(await Movement.countDocuments({ food: food._id, type: "release" }), 1);
});

test("P2-R2: a student cannot trigger a pending step on someone else's order", async () => {
  const owner = await tokenFor("student");
  const intruder = await tokenFor("student");
  const food = await trackedFood(5);
  const order = await placeOrder(owner, food, 1);

  const res = await api().post(`/api/orders/${order._id}/cancel`).set(auth(intruder)).send({});
  assert.equal(res.status, 403);
  assert.equal((await Order.findById(order._id)).status, "Pending");
});
