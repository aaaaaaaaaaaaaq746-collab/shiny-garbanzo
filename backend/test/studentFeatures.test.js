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
