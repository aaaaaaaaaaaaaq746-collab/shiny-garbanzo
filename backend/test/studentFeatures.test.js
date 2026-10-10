const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { api, startDb, resetDb, stopDb, makeUser, makeFood } = require("./helpers");

/*
 * DB-backed tests for the Phase 1 student experience: quote, pickup slots,
 * coupons, receipts, reviews, history filters, account changes and food
 * badges. These need MongoMemoryServer (see helpers.js). They were written in
 * a sandbox without a MongoDB binary and have NOT been executed there; the pure
 * rules they depend on are covered by the DB-free tests in this folder.
 */

before(startDb);
after(stopDb);
beforeEach(resetDb);

async function adminToken() {
  const email = `admin-${Math.random().toString(36).slice(2, 8)}@college.edu`;
  await makeUser({ name: "Root", email, password: "password123", role: "admin" });
  const res = await api().post("/api/auth/login").send({ email, password: "password123" });
  return res.body.token;
}

async function studentSession() {
  const email = `s-${Math.random().toString(36).slice(2, 10)}@college.edu`;
  await api().post("/api/auth/signup").send({ name: "Stud", email, password: "password123" });
  const res = await api().post("/api/auth/login").send({ email, password: "password123" });
  return { token: res.body.token, id: res.body.id, email };
}

const auth = (t) => ({ Authorization: `Bearer ${t}` });

// ---------------------------------------------------------------- quote

test("quote: prices the cart without writing an order or touching stock", async () => {
  const s = await studentSession();
  const food = await makeFood({
    name: "Dosa",
    price: 50,
    addOns: [{ label: "Extra chutney", price: 5 }],
  });
  const Order = require("../models/Order");
  const before = await Order.countDocuments({});

  const res = await api()
    .post("/api/orders/quote")
    .set(auth(s.token))
    .send({ items: [{ food: food._id.toString(), quantity: 2, addOns: ["Extra chutney"] }] });

  assert.equal(res.status, 200);
  assert.equal(res.body.bill.subtotal, 110);
  assert.equal(res.body.bill.total, 110);
  assert.equal(res.body.lines[0].unitPrice, 55);
  assert.equal(await Order.countDocuments({}), before, "a quote must not create an order");
});

test("quote and placement agree on the total for the same cart", async () => {
  const s = await studentSession();
  const food = await makeFood({ name: "Tea", price: 12 });
  const body = { items: [{ food: food._id.toString(), quantity: 3 }] };

  const quote = await api().post("/api/orders/quote").set(auth(s.token)).send(body);
  const placed = await api().post("/api/orders").set(auth(s.token)).send(body);

  assert.equal(placed.status, 201);
  assert.equal(quote.body.bill.total, placed.body.total);
});

test("place: add-on prices come from the menu, and a made-up add-on is refused", async () => {
  const s = await studentSession();
  const food = await makeFood({ name: "Thali", price: 80, addOns: [{ label: "Lassi", price: 20 }] });

  const ok = await api()
    .post("/api/orders")
    .set(auth(s.token))
    .send({ items: [{ food: food._id.toString(), quantity: 1, addOns: ["Lassi"], specialInstructions: "no onion" }] });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.total, 100);
  assert.equal(ok.body.items[0].addOns[0].price, 20);
  assert.equal(ok.body.items[0].specialInstructions, "no onion");

  const bad = await api()
    .post("/api/orders")
    .set(auth(s.token))
    .send({ items: [{ food: food._id.toString(), quantity: 1, addOns: ["Free cake"] }] });
  assert.equal(bad.status, 400);
});

// ---------------------------------------------------------------- slots

test("slots: returns open slots with an ISO time and a label", async () => {
  const s = await studentSession();
  const res = await api().get("/api/orders/slots").set(auth(s.token));
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.slots));
  assert.ok(res.body.slots.length > 0);
  assert.match(res.body.slots[0].at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(res.body.slots[0].label, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test("pickup: an open slot is accepted; off-grid or unlisted times are refused with 409", async () => {
  const s = await studentSession();
  const food = await makeFood({ name: "Quick", price: 10, prepTimeMinutes: 0 });
  const slots = (await api().get("/api/orders/slots").set(auth(s.token))).body.slots;
  const first = slots[0].at;

  const ok = await api()
    .post("/api/orders")
    .set(auth(s.token))
    .send({ items: [{ food: food._id.toString(), quantity: 1 }], pickupAt: first });
  assert.equal(ok.status, 201);
  assert.equal(new Date(ok.body.pickupAt).toISOString(), first);

  const offGrid = new Date(new Date(first).getTime() + 60_000).toISOString();
  const bad = await api()
    .post("/api/orders")
    .set(auth(s.token))
    .send({ items: [{ food: food._id.toString(), quantity: 1 }], pickupAt: offGrid });
  assert.equal(bad.status, 409);
});

// ---------------------------------------------------------------- coupons

test("coupons: only administrators manage them; a student is refused with 403", async () => {
  const s = await studentSession();
  const res = await api()
    .post("/api/coupons")
    .set(auth(s.token))
    .send({ code: "EVIL10", type: "percent", value: 90 });
  assert.equal(res.status, 403);
});

test("coupons: a percentage discount applies, and a limited coupon is used once", async () => {
  const admin = await adminToken();
  const created = await api()
    .post("/api/coupons")
    .set(auth(admin))
    .send({ code: "once10", type: "percent", value: 10, usageLimit: 1 });
  assert.equal(created.status, 201);
  assert.equal(created.body.code, "ONCE10", "codes are stored upper-case");

  const s = await studentSession();
  const food = await makeFood({ name: "Meal", price: 100 });
  const body = { items: [{ food: food._id.toString(), quantity: 1 }], couponCode: "ONCE10" };

  const first = await api().post("/api/orders").set(auth(s.token)).send(body);
  assert.equal(first.status, 201);
  assert.equal(first.body.discount, 10);
  assert.equal(first.body.total, 90);

  const second = await api().post("/api/orders").set(auth(s.token)).send(body);
  assert.equal(second.status, 409, "a fully used coupon must not apply twice");

  const Coupon = require("../models/Coupon");
  assert.equal((await Coupon.findOne({ code: "ONCE10" })).usedCount, 1);
});

test("coupons: an unknown code is a 400, not a silent zero discount", async () => {
  const s = await studentSession();
  const food = await makeFood({ name: "Meal", price: 100 });
  const res = await api()
    .post("/api/orders/quote")
    .set(auth(s.token))
    .send({ items: [{ food: food._id.toString(), quantity: 1 }], couponCode: "NOPE" });
  assert.equal(res.status, 400);
});

// ---------------------------------------------------------------- receipts

test("receipt: owner gets text; another student gets 403; unknown id gets 404", async () => {
  const owner = await studentSession();
  const other = await studentSession();
  const food = await makeFood({ name: "Dosa", price: 50 });
  const placed = await api()
    .post("/api/orders")
    .set(auth(owner.token))
    .send({ items: [{ food: food._id.toString(), quantity: 1 }] });

  const mine = await api().get(`/api/orders/${placed.body._id}/receipt`).set(auth(owner.token));
  assert.equal(mine.status, 200);
  assert.match(mine.headers["content-type"], /text\/plain/);
  assert.match(mine.text, /Dosa/);
  assert.match(mine.text, /Payment:\s+unpaid/);

  const theirs = await api().get(`/api/orders/${placed.body._id}/receipt`).set(auth(other.token));
  assert.equal(theirs.status, 403);

  const missing = await api().get("/api/orders/64b00000000000000000ee99/receipt").set(auth(owner.token));
  assert.equal(missing.status, 404);
});

// ---------------------------------------------------------------- reviews

async function completedOrderFor(student, food) {
  const Order = require("../models/Order");
  return Order.create({
    student: student.id,
    items: [{ food: food._id, name: food.name, price: food.price, quantity: 1 }],
    subtotal: food.price,
    total: food.price,
    status: "Completed",
    statusHistory: [{ status: "Completed", from: "Ready", by: student.id, role: "student" }],
    statusHistoryTotal: 1,
  });
}

test("reviews: a completed order is rated once; the item's average is maintained", async () => {
  const s = await studentSession();
  const food = await makeFood({ name: "Rated", price: 40 });
  const order = await completedOrderFor(s, food);

  const first = await api()
    .post("/api/reviews")
    .set(auth(s.token))
    .send({ orderId: order._id.toString(), foodId: food._id.toString(), rating: 4, comment: "  good  " });
  assert.equal(first.status, 201);
  assert.equal(first.body.comment, "good");

  const again = await api()
    .post("/api/reviews")
    .set(auth(s.token))
    .send({ orderId: order._id.toString(), foodId: food._id.toString(), rating: 5 });
  assert.equal(again.status, 409);

  const Food = require("../models/FoodItem");
  const fresh = await Food.findById(food._id);
  assert.equal(fresh.ratingCount, 1);
  assert.equal(fresh.ratingAverage, 4);

  const pub = await api().get(`/api/reviews/food/${food._id}`);
  assert.equal(pub.status, 200);
  assert.equal(pub.body.count, 1);
  assert.equal(pub.body.reviews[0].studentId, undefined, "reviews must not expose the reviewer");
});

test("reviews: another student is refused with 403, and an unfinished order with 409", async () => {
  const owner = await studentSession();
  const other = await studentSession();
  const food = await makeFood({ name: "Rated", price: 40 });
  const order = await completedOrderFor(owner, food);

  const theirs = await api()
    .post("/api/reviews")
    .set(auth(other.token))
    .send({ orderId: order._id.toString(), foodId: food._id.toString(), rating: 3 });
  assert.equal(theirs.status, 403);

  const Order = require("../models/Order");
  await Order.updateOne({ _id: order._id }, { status: "Preparing" });
  const early = await api()
    .post("/api/reviews")
    .set(auth(owner.token))
    .send({ orderId: order._id.toString(), foodId: food._id.toString(), rating: 3 });
  assert.equal(early.status, 409);
});

// ---------------------------------------------------------------- history

test("history: status and date filters narrow the student's own orders", async () => {
  const s = await studentSession();
  const food = await makeFood({ name: "Dosa", price: 50 });
  const placed = await api()
    .post("/api/orders")
    .set(auth(s.token))
    .send({ items: [{ food: food._id.toString(), quantity: 1 }] });
  await api().post(`/api/orders/${placed.body._id}/cancel`).set(auth(s.token)).send({});

  const cancelled = await api().get("/api/orders?status=Cancelled").set(auth(s.token));
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.length, 1);

  const pending = await api().get("/api/orders?status=Pending").set(auth(s.token));
  assert.equal(pending.body.length, 0);

  const bad = await api().get("/api/orders?status=Lost").set(auth(s.token));
  assert.equal(bad.status, 400);
});

// ---------------------------------------------------------------- account

test("password: wrong current password is 400; a change revokes old sessions and returns a new token", async () => {
  const s = await studentSession();

  const wrong = await api()
    .post("/api/auth/me/password")
    .set(auth(s.token))
    .send({ currentPassword: "not-the-one", newPassword: "brand-new-pass" });
  assert.equal(wrong.status, 400);

  const changed = await api()
    .post("/api/auth/me/password")
    .set(auth(s.token))
    .send({ currentPassword: "password123", newPassword: "brand-new-pass" });
  assert.equal(changed.status, 200);
  assert.ok(changed.body.token);

  const oldToken = await api().get("/api/auth/me").set(auth(s.token));
  assert.equal(oldToken.status, 401, "the previous session must stop working");

  const newToken = await api().get("/api/auth/me").set(auth(changed.body.token));
  assert.equal(newToken.status, 200);

  const relogin = await api().post("/api/auth/login").send({ email: s.email, password: "brand-new-pass" });
  assert.equal(relogin.status, 200);
});

test("profile: phone is validated and saved; it appears on /me", async () => {
  const s = await studentSession();
  const ok = await api().put("/api/auth/me").set(auth(s.token)).send({ phone: "+91 98765 43210" });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.phone, "+91 98765 43210");

  const bad = await api().put("/api/auth/me").set(auth(s.token)).send({ phone: "call me maybe" });
  assert.equal(bad.status, 400);

  const cleared = await api().put("/api/auth/me").set(auth(s.token)).send({ phone: "" });
  assert.equal(cleared.body.phone, null);
});

test("notification preferences are saved and returned", async () => {
  const s = await studentSession();
  const res = await api()
    .put("/api/auth/me")
    .set(auth(s.token))
    .send({ notificationPrefs: { promotions: true } });
  assert.equal(res.status, 200);
  assert.equal(res.body.notificationPrefs.promotions, true);
  assert.equal(res.body.notificationPrefs.orderUpdates, true);
});

// ---------------------------------------------------------------- discovery

test("menu: badges, featured flag and rating are present; unknown sort is 400", async () => {
  await makeFood({ name: "Featured One", price: 30, featured: true, ratingAverage: 4.5, ratingCount: 2 });
  const res = await api().get("/api/food");
  assert.equal(res.status, 200);
  const item = res.body.find((f) => f.name === "Featured One");
  assert.equal(item.featured, true);
  assert.equal(item.badges.featured, true);
  assert.equal(item.badges.isNew, true);
  assert.equal(item.badges.bestselling, false, "never-ordered items are not bestsellers");

  const bad = await api().get("/api/food?sort=random");
  assert.equal(bad.status, 400);
});

test("menu: /categories still resolves (not captured by /:id)", async () => {
  await makeFood({ name: "Cat", price: 10, category: "Drinks" });
  const res = await api().get("/api/food/categories");
  assert.equal(res.status, 200);
  assert.ok(res.body.includes("Drinks"));
});


/** Walk an order through the real kitchen steps so every transition is legal. */
async function driveTo(orderId, admin, statuses) {
  for (const status of statuses) {
    const res = await api().put(`/api/orders/${orderId}/status`).set(auth(admin)).send({ status });
    assert.equal(res.status, 200, `moving to ${status}`);
  }
}

// ------------------------------------------------- pickup seat capacity
// Config is changed per test and restored in `finally`. Services read the
// config at call time, so the change takes effect without a restart.

const configModule = require("../config");

async function openSlotAt(token, index = 0) {
  const res = await api().get("/api/orders/slots").set(auth(token));
  assert.equal(res.status, 200);
  return res.body.slots[index].at;
}

test("capacity: a full slot refuses the next booking with 409, and the slot list says so", async () => {
  const original = configModule.canteen.slotCapacity;
  configModule.canteen.slotCapacity = 1;
  try {
    const first = await studentSession();
    const second = await studentSession();
    const food = await makeFood({ name: "Samosa", price: 15 });
    const slot = await openSlotAt(first.token);
    const body = { items: [{ food: food._id.toString(), quantity: 1 }], pickupAt: slot };

    assert.equal((await api().post("/api/orders").set(auth(first.token)).send(body)).status, 201);

    const refused = await api().post("/api/orders").set(auth(second.token)).send(body);
    assert.equal(refused.status, 409);
    assert.match(refused.body.message, /full/);

    const quote = await api().post("/api/orders/quote").set(auth(second.token)).send(body);
    assert.equal(quote.status, 409, "the quote reports the full slot before checkout");

    const listed = await api().get("/api/orders/slots").set(auth(second.token));
    const entry = listed.body.slots.find((s) => s.at === slot);
    assert.equal(entry.seatsLeft, 0);
    assert.equal(entry.available, false);
  } finally {
    configModule.canteen.slotCapacity = original;
  }
});

test("capacity: cancelling frees the seat once; repeating the cancel does not free a second one", async () => {
  const original = configModule.canteen.slotCapacity;
  configModule.canteen.slotCapacity = 1;
  try {
    const a = await studentSession();
    const b = await studentSession();
    const c = await studentSession();
    const food = await makeFood({ name: "Idli", price: 20 });
    const slot = await openSlotAt(a.token);
    const body = { items: [{ food: food._id.toString(), quantity: 1 }], pickupAt: slot };

    const placed = await api().post("/api/orders").set(auth(a.token)).send(body);
    assert.equal(placed.status, 201);
    const orderId = placed.body._id;

    assert.equal((await api().post(`/api/orders/${orderId}/cancel`).set(auth(a.token)).send({})).status, 200);
    assert.equal((await api().post(`/api/orders/${orderId}/cancel`).set(auth(a.token)).send({})).status, 200);

    assert.equal((await api().post("/api/orders").set(auth(b.token)).send(body)).status, 201, "freed seat is bookable");
    assert.equal(
      (await api().post("/api/orders").set(auth(c.token)).send(body)).status,
      409,
      "the repeated cancel must not have released a second seat"
    );
  } finally {
    configModule.canteen.slotCapacity = original;
  }
});

test("capacity: zero means unlimited, so several bookings share a slot", async () => {
  const original = configModule.canteen.slotCapacity;
  configModule.canteen.slotCapacity = 0;
  try {
    const a = await studentSession();
    const b = await studentSession();
    const food = await makeFood({ name: "Chai", price: 10 });
    const slot = await openSlotAt(a.token);
    const body = { items: [{ food: food._id.toString(), quantity: 1 }], pickupAt: slot };
    assert.equal((await api().post("/api/orders").set(auth(a.token)).send(body)).status, 201);
    assert.equal((await api().post("/api/orders").set(auth(b.token)).send(body)).status, 201);
  } finally {
    configModule.canteen.slotCapacity = original;
  }
});

// ------------------------------------------------- live wait estimate

test("estimate: an order behind another moves earlier when the one ahead is cancelled", async () => {
  const originalParallel = configModule.kitchen.parallel;
  configModule.kitchen.parallel = 1;
  try {
    const ahead = await studentSession();
    const behind = await studentSession();
    const longDish = await makeFood({ name: "Biryani", price: 150, prepTimeMinutes: 15 });
    const quickDish = await makeFood({ name: "Lassi", price: 30, prepTimeMinutes: 10 });

    const first = await api()
      .post("/api/orders")
      .set(auth(ahead.token))
      .send({ items: [{ food: longDish._id.toString(), quantity: 1 }] });
    const second = await api()
      .post("/api/orders")
      .set(auth(behind.token))
      .send({ items: [{ food: quickDish._id.toString(), quantity: 1 }] });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);

    const queued = await api().get(`/api/orders/${second.body._id}`).set(auth(behind.token));
    const queuedAt = new Date(queued.body.estimatedReadyAt).getTime();

    assert.equal(
      (await api().post(`/api/orders/${first.body._id}/cancel`).set(auth(ahead.token)).send({})).status,
      200
    );

    const after = await api().get(`/api/orders/${second.body._id}`).set(auth(behind.token));
    const afterAt = new Date(after.body.estimatedReadyAt).getTime();
    const movedBy = queuedAt - afterAt;
    assert.ok(movedBy > 13 * 60 * 1000 && movedBy < 17 * 60 * 1000, `expected about 15 minutes earlier, got ${movedBy / 60000}`);
  } finally {
    configModule.kitchen.parallel = originalParallel;
  }
});

test("estimate: moving an order to Preparing records when cooking began", async () => {
  const s = await studentSession();
  const admin = await adminToken();
  const food = await makeFood({ name: "Upma", price: 25, prepTimeMinutes: 8 });
  const placed = await api()
    .post("/api/orders")
    .set(auth(s.token))
    .send({ items: [{ food: food._id.toString(), quantity: 1 }] });
  assert.equal(placed.status, 201);

  await driveTo(placed.body._id, admin, ["Accepted"]);
  const moved = await api()
    .put(`/api/orders/${placed.body._id}/status`)
    .set(auth(admin))
    .send({ status: "Preparing" });
  assert.equal(moved.status, 200);
  assert.ok(moved.body.preparingAt, "preparingAt is set on entering Preparing");
  const ready = new Date(moved.body.estimatedReadyAt).getTime();
  const started = new Date(moved.body.preparingAt).getTime();
  assert.ok(Math.abs(ready - (started + 8 * 60 * 1000)) < 1000, "ready = started + prep time");
});

// ------------------------------------------------- notifications

test("notifications: a status change is recorded once per transition for the student", async () => {
  const Notification = require("../models/Notification");
  const s = await studentSession();
  const admin = await adminToken();
  const food = await makeFood({ name: "Poha", price: 20 });
  const placed = await api()
    .post("/api/orders")
    .set(auth(s.token))
    .send({ items: [{ food: food._id.toString(), quantity: 1 }] });
  const id = placed.body._id;

  assert.equal((await api().put(`/api/orders/${id}/status`).set(auth(admin)).send({ status: "Accepted" })).status, 200);
  assert.equal((await api().put(`/api/orders/${id}/status`).set(auth(admin)).send({ status: "Preparing" })).status, 200);

  const rows = await Notification.find({ order: id, kind: "order_status" }).lean();
  assert.equal(rows.length, 2, "one entry per transition, none for placement");
  assert.deepEqual(rows.map((r) => r.body).sort(), [
    "Your order has been accepted and will be prepared shortly.",
    "Your order is being prepared.",
  ]);
});

test("notifications: dispatch emails only students who opted in, and skips the rest", async () => {
  const Notification = require("../models/Notification");
  const User = require("../models/User");
  const { dispatchDue } = require("../services/notifications");

  const optedIn = await studentSession();
  const notIn = await studentSession();
  await User.updateOne({ _id: optedIn.id }, { $set: { "notificationPrefs.email": true } });

  const admin = await adminToken();
  const food = await makeFood({ name: "Vada", price: 12 });
  for (const s of [optedIn, notIn]) {
    const placed = await api()
      .post("/api/orders")
      .set(auth(s.token))
      .send({ items: [{ food: food._id.toString(), quantity: 1 }] });
    await driveTo(placed.body._id, admin, ["Accepted", "Preparing", "Ready"]);
  }

  const sent = [];
  const transports = {
    emailConfigured: true,
    pushConfigured: true,
    sendEmail: async (msg) => {
      sent.push(msg.to);
    },
    sendPushOne: async () => {},
  };
  const result = await dispatchDue({ transports, limit: 50 });
  assert.ok(result.processed >= 2);
  // Three status changes (Accepted, Preparing, Ready) = three notifications for
  // the opted-in student, and none for the other student.
  assert.equal(sent.length, 3, "one email per status change for the opted-in student");
  assert.ok(sent.every((to) => to === optedIn.email), "only the opted-in student receives email");

  const rows = await Notification.find({ user: { $in: [optedIn.id, notIn.id] } }).lean();
  const skippedForNotIn = rows.filter((r) => String(r.user) === notIn.id);
  assert.ok(skippedForNotIn.every((r) => r.channels.email.state === "skipped"));
  assert.ok(rows.filter((r) => String(r.user) === optedIn.id).every((r) => r.channels.email.state === "sent"));

  const again = await dispatchDue({ transports, limit: 50 });
  assert.equal(again.processed, 0, "nothing is pending a second time");
  assert.deepEqual(sent, [optedIn.email], "no duplicate email");
});

test("notifications: a failing transport is retried, then marked failed at the limit", async () => {
  const Notification = require("../models/Notification");
  const User = require("../models/User");
  const { dispatchDue } = require("../services/notifications");

  const s = await studentSession();
  await User.updateOne({ _id: s.id }, { $set: { "notificationPrefs.email": true } });
  const admin = await adminToken();
  const food = await makeFood({ name: "Dal", price: 40 });
  const placed = await api()
    .post("/api/orders")
    .set(auth(s.token))
    .send({ items: [{ food: food._id.toString(), quantity: 1 }] });
  await driveTo(placed.body._id, admin, ["Accepted", "Preparing", "Ready"]);

  const transports = {
    emailConfigured: true,
    pushConfigured: false,
    sendEmail: async () => {
      throw new Error("SMTP unavailable");
    },
  };
  const max = configModule.notify.maxAttempts;
  for (let i = 0; i < max; i += 1) await dispatchDue({ transports, limit: 50 });

  const row = await Notification.findOne({ order: placed.body._id, kind: "order_status" }).lean();
  assert.equal(row.channels.email.state, "failed");
  assert.equal(row.channels.email.attempts, max);
  assert.equal(row.channels.email.lastError, "SMTP unavailable");
});

test("push: the key is null until configured; subscriptions are https-only, replaced by endpoint, and never shown on /me", async () => {
  const s = await studentSession();

  const key = await api().get("/api/notifications/push-key").set(auth(s.token));
  assert.equal(key.status, 200);
  assert.equal(key.body.publicKey, null, "no VAPID keys in this environment");

  const bad = await api()
    .post("/api/notifications/push-subscriptions")
    .set(auth(s.token))
    .send({ endpoint: "http://push.example.com/abc", keys: { p256dh: "k", auth: "a" } });
  assert.equal(bad.status, 400);

  const endpoint = "https://push.example.com/sub/1";
  const body = { endpoint, keys: { p256dh: "p256dh-key", auth: "auth-key" } };
  assert.equal((await api().post("/api/notifications/push-subscriptions").set(auth(s.token)).send(body)).status, 201);
  assert.equal((await api().post("/api/notifications/push-subscriptions").set(auth(s.token)).send(body)).status, 201);

  const User = require("../models/User");
  const stored = await User.findById(s.id).select("+pushSubscriptions").lean();
  assert.equal(stored.pushSubscriptions.length, 1, "the same endpoint is stored once");

  const me = await api().get("/api/auth/me").set(auth(s.token));
  assert.equal(me.body.pushSubscriptions, undefined, "subscription endpoints are not returned to the client");

  const removed = await api()
    .delete("/api/notifications/push-subscriptions")
    .query({ endpoint })
    .set(auth(s.token));
  assert.equal(removed.status, 200);
  const after = await User.findById(s.id).select("+pushSubscriptions").lean();
  assert.equal(after.pushSubscriptions.length, 0);
});

test("announcements: admin only; reach students who opted into promotions", async () => {
  const User = require("../models/User");
  const s = await studentSession();
  const other = await studentSession();
  await User.updateOne({ _id: s.id }, { $set: { "notificationPrefs.promotions": true } });

  const denied = await api()
    .post("/api/notifications/announcements")
    .set(auth(s.token))
    .send({ title: "Lunch offer", body: "Thali is 20% off today." });
  assert.equal(denied.status, 403);

  const admin = await adminToken();
  const sent = await api()
    .post("/api/notifications/announcements")
    .set(auth(admin))
    .send({ title: "Lunch offer", body: "Thali is 20% off today." });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.recipients, 1, "only the student who opted in");
  assert.notEqual(other.id, s.id);
});

test("menu: dietary is validated on create and update; a known value is stored", async () => {
  const admin = await adminToken();
  const created = await api()
    .post("/api/food")
    .set(auth(admin))
    .send({ name: "Lassi", price: 30, dietary: "keto" });
  assert.equal(created.status, 400, "an unknown dietary value is refused");
  assert.match(created.body.message, /dietary/i);

  const food = await makeFood({ name: "Dosa", price: 60 });
  const updated = await api()
    .put(`/api/food/${food._id}`)
    .set(auth(admin))
    .send({ dietary: "jain" });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.dietary, "jain");

  const badUpdate = await api()
    .put(`/api/food/${food._id}`)
    .set(auth(admin))
    .send({ dietary: "keto" });
  assert.equal(badUpdate.status, 400);
  assert.match(badUpdate.body.message, /dietary/i);
});
