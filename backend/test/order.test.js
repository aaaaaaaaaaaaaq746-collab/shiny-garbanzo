const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { api, startDb, resetDb, stopDb, makeUser, makeFood } = require("./helpers");

before(startDb);
after(stopDb);
beforeEach(resetDb);

/** Log in as an admin (created directly, since signup cannot make admins). */
async function adminToken() {
  const email = `admin-${Math.random().toString(36).slice(2, 8)}@college.edu`;
  await makeUser({ name: "Root Admin", email, password: "password123", role: "admin" });
  const res = await api()
    .post("/api/auth/login")
    .send({ email, password: "password123" });
  return res.body.token;
}

/**
 * Register and log in a *distinct* student each time.
 * Returning the email alongside lets a test assert on a specific account.
 */
async function studentToken() {
  const email = `s-${Math.random().toString(36).slice(2, 8)}@college.edu`;
  await api()
    .post("/api/auth/signup")
    .send({ name: "Stud", email, password: "password123" });
  const res = await api()
    .post("/api/auth/login")
    .send({ email, password: "password123" });
  return res.body.token;
}

// ---------------------------------------------------------------- pricing

test("order total is computed from database prices, not the client", async () => {
  const token = await studentToken();
  const food = await makeFood({ name: "Paneer Tikka", price: 250 });

  const res = await api()
    .post("/api/orders")
    .set("Authorization", `Bearer ${token}`)
    .send({
      items: [{ food: food._id.toString(), quantity: 2 }],
      // Attacker claims it costs 1 rupee and totals 1.
      total: 1,
    });

  assert.equal(res.status, 201);
  assert.equal(res.body.total, 500, "total must come from the database price");
  assert.equal(res.body.items[0].price, 250);
  assert.equal(res.body.items[0].name, "Paneer Tikka");
});

test("client-supplied item name and price are ignored", async () => {
  const token = await studentToken();
  const food = await makeFood({ name: "Real Name", price: 100 });

  const res = await api()
    .post("/api/orders")
    .set("Authorization", `Bearer ${token}`)
    .send({
      items: [
        {
          food: food._id.toString(),
          quantity: 1,
          name: "Free Unlimited Money",
          price: 0,
        },
      ],
      total: 0,
    });

  assert.equal(res.status, 201);
  assert.equal(res.body.items[0].name, "Real Name", "name must be snapshotted from the DB");
  assert.equal(res.body.items[0].price, 100);
  assert.equal(res.body.total, 100);
});

test("a negative total in the request cannot create a negative order", async () => {
  const token = await studentToken();
  const food = await makeFood({ price: 100 });

  const res = await api()
    .post("/api/orders")
    .set("Authorization", `Bearer ${token}`)
    .send({
      items: [{ food: food._id.toString(), quantity: 2 }],
      total: -9999,
    });

  assert.equal(res.status, 201);
  assert.equal(res.body.total, 200);
  assert.ok(res.body.total > 0, "stored total must never be negative");
});

test("totals are exact for fractional prices (no float drift)", async () => {
  const token = await studentToken();
  const a = await makeFood({ name: "Tea", price: 12.5 });
  const b = await makeFood({ name: "Samosa", price: 7.25 });

  const res = await api()
    .post("/api/orders")
    .set("Authorization", `Bearer ${token}`)
    .send({
      items: [
        { food: a._id.toString(), quantity: 3 },
        { food: b._id.toString(), quantity: 3 },
      ],
    });

  assert.equal(res.status, 201);
  // 3*12.5 + 3*7.25 = 37.5 + 21.75 = 59.25 exactly
  assert.equal(res.body.total, 59.25);
});

// ------------------------------------------------------------- validation

test("rejects invalid quantities: zero, negative, fractional, huge and non-numeric", async () => {
  const token = await studentToken();
  const food = await makeFood({ price: 100 });

  const bad = [0, -1, -100, 1.5, 21, 99999, "abc", null, NaN];
  for (const quantity of bad) {
    const res = await api()
      .post("/api/orders")
      .set("Authorization", `Bearer ${token}`)
      .send({ items: [{ food: food._id.toString(), quantity }] });

    assert.equal(res.status, 400, `quantity ${quantity} should be rejected`);
  }
});

test("rejects an empty cart, a non-array cart, and a malformed food id", async () => {
  const token = await studentToken();

  const empty = await api()
    .post("/api/orders")
    .set("Authorization", `Bearer ${token}`)
    .send({ items: [] });
  assert.equal(empty.status, 400);

  const notArray = await api()
    .post("/api/orders")
    .set("Authorization", `Bearer ${token}`)
    .send({ items: "pizza" });
  assert.equal(notArray.status, 400);

  const badId = await api()
    .post("/api/orders")
    .set("Authorization", `Bearer ${token}`)
    .send({ items: [{ food: "not-an-object-id", quantity: 1 }] });
  assert.equal(badId.status, 400);

  const noItems = await api()
    .post("/api/orders")
    .set("Authorization", `Bearer ${token}`)
    .send({});
  assert.equal(noItems.status, 400);
});

test("rejects an order referencing a food item that does not exist", async () => {
  const token = await studentToken();
  const res = await api()
    .post("/api/orders")
    .set("Authorization", `Bearer ${token}`)
    .send({
      items: [{ food: "0123456789abcdef01234567", quantity: 1 }],
    });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /no longer exists/i);
});

test("duplicate lines for the same item are merged, not double-counted", async () => {
  const token = await studentToken();
  const food = await makeFood({ name: "Roll", price: 50 });

  const res = await api()
    .post("/api/orders")
    .set("Authorization", `Bearer ${token}`)
    .send({
      items: [
        { food: food._id.toString(), quantity: 1 },
        { food: food._id.toString(), quantity: 2 },
      ],
    });

  assert.equal(res.status, 201);
  assert.equal(res.body.items.length, 1, "duplicate lines should collapse");
  assert.equal(res.body.items[0].quantity, 3);
  assert.equal(res.body.total, 150);
});

test("splitting duplicates cannot smuggle past the per-item quantity cap", async () => {
  const token = await studentToken();
  const food = await makeFood({ price: 10 });

  // 15 + 15 = 30 > ORDER_MAX_QUANTITY (20)
  const res = await api()
    .post("/api/orders")
    .set("Authorization", `Bearer ${token}`)
    .send({
      items: [
        { food: food._id.toString(), quantity: 15 },
        { food: food._id.toString(), quantity: 15 },
      ],
    });

  assert.equal(res.status, 400, "merged quantity must respect the cap");
});

test("cannot order an item that is marked unavailable or sold out", async () => {
  const token = await studentToken();
  const unavailable = await makeFood({ name: "Gone", price: 10, available: false });
  const soldOut = await makeFood({ name: "Sold Out", price: 10, stock: 0 });

  const a = await api()
    .post("/api/orders")
    .set("Authorization", `Bearer ${token}`)
    .send({ items: [{ food: unavailable._id.toString(), quantity: 1 }] });
  assert.equal(a.status, 409);
  assert.match(a.body.message, /unavailable/i);

  const b = await api()
    .post("/api/orders")
    .set("Authorization", `Bearer ${token}`)
    .send({ items: [{ food: soldOut._id.toString(), quantity: 1 }] });
  assert.equal(b.status, 409);
});

test("ordering requires authentication", async () => {
  const food = await makeFood({ price: 10 });
  const res = await api()
    .post("/api/orders")
    .send({ items: [{ food: food._id.toString(), quantity: 1 }] });

  assert.equal(res.status, 401);
});

// ------------------------------------------------------- authorization

test("a student cannot read all orders", async () => {
  const token = await studentToken();
  const res = await api().get("/api/orders/all").set("Authorization", `Bearer ${token}`);
  assert.equal(res.status, 403);
});

test("a student cannot update order status", async () => {
  const student = await studentToken();
  const admin = await adminToken();
  const food = await makeFood({ price: 10 });

  const created = await api()
    .post("/api/orders")
    .set("Authorization", `Bearer ${student}`)
    .send({ items: [{ food: food._id.toString(), quantity: 1 }] });

  const res = await api()
    .put(`/api/orders/${created.body._id}/status`)
    .set("Authorization", `Bearer ${student}`)
    .send({ status: "Completed" });

  assert.equal(res.status, 403);
});

test("an admin cannot update an order status they are not allowed to name", async () => {
  const admin = await adminToken();
  const student = await studentToken();
  const food = await makeFood({ price: 10 });

  const created = await api()
    .post("/api/orders")
    .set("Authorization", `Bearer ${student}`)
    .send({ items: [{ food: food._id.toString(), quantity: 1 }] });

  const bad = await api()
    .put(`/api/orders/${created.body._id}/status`)
    .set("Authorization", `Bearer ${admin}`)
    .send({ status: "Hacked" });
  assert.equal(bad.status, 400);

  const missing = await api()
    .put(`/api/orders/${created.body._id}/status`)
    .set("Authorization", `Bearer ${admin}`)
    .send({});
  assert.equal(missing.status, 400);
});

test("a completed order is terminal and cannot be reverted", async () => {
  const admin = await adminToken();
  const student = await studentToken();
  const food = await makeFood({ price: 10 });

  const created = await api()
    .post("/api/orders")
    .set("Authorization", `Bearer ${student}`)
    .send({ items: [{ food: food._id.toString(), quantity: 1 }] });

  const done = await api()
    .put(`/api/orders/${created.body._id}/status`)
    .set("Authorization", `Bearer ${admin}`)
    .send({ status: "Completed" });
  assert.equal(done.status, 200);
  assert.equal(done.body.status, "Completed");

  const revert = await api()
    .put(`/api/orders/${created.body._id}/status`)
    .set("Authorization", `Bearer ${admin}`)
    .send({ status: "Pending" });
  assert.equal(revert.status, 409);
});

test("status updates are recorded in statusHistory", async () => {
  const admin = await adminToken();
  const student = await studentToken();
  const food = await makeFood({ price: 10 });

  const created = await api()
    .post("/api/orders")
    .set("Authorization", `Bearer ${student}`)
    .send({ items: [{ food: food._id.toString(), quantity: 1 }] });

  assert.equal(created.body.statusHistory.length, 1, "creation is recorded");

  await api()
    .put(`/api/orders/${created.body._id}/status`)
    .set("Authorization", `Bearer ${admin}`)
    .send({ status: "Preparing" });

  const res = await api()
    .get(`/api/orders/${created.body._id}`)
    .set("Authorization", `Bearer ${student}`);

  const statuses = res.body.statusHistory.map((h) => h.status);
  assert.deepEqual(statuses, ["Pending", "Preparing"]);
});

test("a student cannot view another student's order", async () => {
  const owner = await studentToken();
  const food = await makeFood({ price: 10 });

  const created = await api()
    .post("/api/orders")
    .set("Authorization", `Bearer ${owner}`)
    .send({ items: [{ food: food._id.toString(), quantity: 1 }] });

  const other = await studentToken();
  const res = await api()
    .get(`/api/orders/${created.body._id}`)
    .set("Authorization", `Bearer ${other}`);

  assert.equal(res.status, 403);
});

test("students only ever see their own orders in the list", async () => {
  const a = await studentToken();
  const b = await studentToken();
  const food = await makeFood({ price: 10 });

  await api()
    .post("/api/orders")
    .set("Authorization", `Bearer ${a}`)
    .send({ items: [{ food: food._id.toString(), quantity: 1 }] });

  const res = await api().get("/api/orders").set("Authorization", `Bearer ${b}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 0, "must not leak other students' orders");
});

test("concurrent orders from the same user each get a correct total", async () => {
  const token = await studentToken();
  const food = await makeFood({ price: 33.33 });

  const payload = { items: [{ food: food._id.toString(), quantity: 3 }] };
  const responses = await Promise.all(
    Array.from({ length: 5 }, () =>
      api().post("/api/orders").set("Authorization", `Bearer ${token}`).send(payload)
    )
  );

  for (const res of responses) {
    assert.equal(res.status, 201);
    assert.equal(res.body.total, 99.99, "each concurrent order totals independently");
  }

  const stored = await mongoose.connection.collection("orders").find({}).toArray();
  assert.equal(stored.length, 5);
});

test("malformed JSON returns 400 instead of a crash", async () => {
  const res = await api()
    .post("/api/auth/signup")
    .set("Content-Type", "application/json")
    .send('{"name": "broken",,,}');

  assert.equal(res.status, 400);
});

test("unknown routes return a JSON 404", async () => {
  const res = await api().get("/api/does-not-exist");
  assert.equal(res.status, 404);
  assert.ok(res.body.message);
});