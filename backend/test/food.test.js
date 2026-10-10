const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { api, startDb, resetDb, stopDb, makeUser, makeFood } = require("./helpers");

before(startDb);
after(stopDb);
beforeEach(resetDb);

async function tokenFor(role) {
  const email = `${role}-${Math.random().toString(36).slice(2, 8)}@college.edu`;
  await makeUser({ name: role, email, password: "password123", role });
  const res = await api()
    .post("/api/auth/login")
    .send({ email, password: "password123" });
  return res.body.token;
}

test("GET /api/food returns a plain array with no query params (unchanged contract)", async () => {
  await makeFood({ name: "Samosa", price: 20 });
  const res = await api().get("/api/food");

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body), "must remain a bare array, not an envelope");
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].name, "Samosa");
});

test("new food items get backward-compatible defaults", async () => {
  await makeFood({ name: "Plain", price: 10 });
  const res = await api().get("/api/food");

  const item = res.body[0];
  assert.equal(item.category, "General");
  assert.equal(item.available, true);
  assert.equal(item.prepTimeMinutes, 15);
  assert.equal(item.spicy, false);
  assert.equal(item.stock, null);
});

test("food search, category filter and sort work together", async () => {
  await makeFood({ name: "Masala Dosa", price: 80, category: "Breakfast" });
  await makeFood({ name: "Veg Burger", price: 60, category: "Snacks" });
  await makeFood({ name: "Dosa Special", price: 120, category: "Breakfast" });

  const search = await api().get("/api/food?search=dosa");
  assert.equal(search.body.length, 2);

  const cat = await api().get("/api/food?category=Breakfast");
  assert.equal(cat.body.length, 2);

  const cheapFirst = await api().get("/api/food?sort=price_asc");
  assert.deepEqual(cheapFirst.body.map((f) => f.price), [60, 80, 120]);

  const expensiveFirst = await api().get("/api/food?sort=price_desc");
  assert.deepEqual(expensiveFirst.body.map((f) => f.price), [120, 80, 60]);

  const combined = await api().get("/api/food?category=Breakfast&sort=price_asc");
  assert.deepEqual(combined.body.map((f) => f.name), ["Masala Dosa", "Dosa Special"]);
});

test("an invalid sort key is rejected", async () => {
  const res = await api().get("/api/food?sort=;DROP TABLE");
  assert.equal(res.status, 400);
});

test("GET /api/food/categories lists distinct categories", async () => {
  await makeFood({ name: "A", price: 10, category: "Mains" });
  await makeFood({ name: "B", price: 10, category: "Mains" });
  await makeFood({ name: "C", price: 10, category: "Drinks" });

  const res = await api().get("/api/food/categories");
  assert.deepEqual(res.body, ["Drinks", "Mains"]);
});

test("only admin/staff can create food", async () => {
  const student = await tokenFor("student");
  const res = await api()
    .post("/api/food")
    .set("Authorization", `Bearer ${student}`)
    .send({ name: "Hack", price: 1 });

  assert.equal(res.status, 403);
});

test("an admin can create food with validation", async () => {
  const admin = await tokenFor("admin");

  const good = await api()
    .post("/api/food")
    .set("Authorization", `Bearer ${admin}`)
    .send({ name: "Poha", description: "Morning poha", price: "45.50", category: "Breakfast" });
  assert.equal(good.status, 201);
  assert.equal(good.body.price, 45.5);

  const noName = await api()
    .post("/api/food")
    .set("Authorization", `Bearer ${admin}`)
    .send({ price: 10 });
  assert.equal(noName.status, 400);

  const badPrice = await api()
    .post("/api/food")
    .set("Authorization", `Bearer ${admin}`)
    .send({ name: "Free", price: -5 });
  assert.equal(badPrice.status, 400);

  const zero = await api()
    .post("/api/food")
    .set("Authorization", `Bearer ${admin}`)
    .send({ name: "Zero", price: 0 });
  assert.equal(zero.status, 400);

  const badImage = await api()
    .post("/api/food")
    .set("Authorization", `Bearer ${admin}`)
    .send({ name: "Img", price: 10, image: "javascript:alert(1)" });
  assert.equal(badImage.status, 400);
});

test("PUT /api/food/:id ignores unknown fields instead of mass-assigning", async () => {
  const admin = await tokenFor("admin");
  const food = await makeFood({ name: "Original", price: 30 });

  const res = await api()
    .put(`/api/food/${food._id}`)
    .set("Authorization", `Bearer ${admin}`)
    .send({
      name: "Renamed",
      price: 40,
      _id: "0123456789abcdef01234567", // must be ignored
      __v: 999,
      soldOut: true,
    });

  assert.equal(res.status, 200);
  assert.equal(res.body.name, "Renamed");
  assert.equal(res.body.price, 40);
  assert.equal(res.body._id, food._id.toString(), "_id must not be overwritable");

  const stored = await mongoose.connection.collection("fooditems").findOne({ _id: food._id });
  assert.equal(stored._id.toString(), food._id.toString());
  assert.equal(stored.soldOut, undefined);
});

test("a malformed food id yields 400, not 500", async () => {
  const admin = await tokenFor("admin");
  const res = await api()
    .put("/api/food/not-an-id")
    .set("Authorization", `Bearer ${admin}`)
    .send({ price: 10 });

  assert.equal(res.status, 400);
});

test("updating a missing food returns 404", async () => {
  const admin = await tokenFor("admin");
  const res = await api()
    .put("/api/food/0123456789abcdef01234567")
    .set("Authorization", `Bearer ${admin}`)
    .send({ price: 10 });

  assert.equal(res.status, 404);
});

test("staff may manage the kitchen menu but students may not", async () => {
  const staff = await tokenFor("staff");
  const res = await api()
    .post("/api/food")
    .set("Authorization", `Bearer ${staff}`)
    .send({ name: "Kitchen Special", price: 25 });

  assert.equal(res.status, 201);
});

test("deleting food requires admin/staff and 404s when missing", async () => {
  const admin = await tokenFor("admin");
  const student = await tokenFor("student");
  const food = await makeFood({ name: "Temp", price: 10 });

  const denied = await api()
    .delete(`/api/food/${food._id}`)
    .set("Authorization", `Bearer ${student}`);
  assert.equal(denied.status, 403);

  const missing = await api()
    .delete("/api/food/0123456789abcdef01234567")
    .set("Authorization", `Bearer ${admin}`);
  assert.equal(missing.status, 404);

  const ok = await api()
    .delete(`/api/food/${food._id}`)
    .set("Authorization", `Bearer ${admin}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.message, "Food deleted");
});