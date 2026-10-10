const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

/**
 * Food stock authorization (P1-N2, P1-N3, P1-N4). DB-backed.
 *
 *  - Staff may manage the menu but may not change stock levels (N2).
 *  - A tracked item's stock moves only through the ledger endpoint (N2).
 *  - An item with open reservations cannot be deleted (N3).
 *  - Inventory fields on create are admin-only, and starting stock is ledgered (N4).
 */

const { api, startDb, resetDb, stopDb, makeUser, makeFood } = require("./helpers");
const Food = require("../models/FoodItem");
const Movement = require("../models/InventoryMovement");

before(startDb);
after(stopDb);
beforeEach(resetDb);

let seq = 0;
async function tokenFor(role) {
  seq += 1;
  const email = `${role}-f${seq}-${Math.random().toString(36).slice(2, 8)}@college.edu`;
  await makeUser({ name: `${role} ${seq}`, email, role });
  const res = await api().post("/api/auth/login").send({ email, password: "password123" });
  assert.equal(res.status, 200);
  return res.body.token;
}

const put = (token, id, body) =>
  api().put(`/api/food/${id}`).set("Authorization", `Bearer ${token}`).send(body);
const del = (token, id) => api().delete(`/api/food/${id}`).set("Authorization", `Bearer ${token}`);
const post = (token, body) => api().post("/api/food").set("Authorization", `Bearer ${token}`).send(body);

async function trackedItem({ stock = 10, reserved = 0 } = {}) {
  return Food.create({
    name: `Tracked ${Math.random().toString(36).slice(2, 7)}`,
    price: 20,
    trackInventory: true,
    stock,
    reserved,
    lowStockThreshold: 2,
  });
}

// ------------------------------------------------------------- N2: PUT stock

test("P1-N2: staff cannot change stock on an untracked item (403, nothing written)", async () => {
  const staff = await tokenFor("staff");
  const item = await makeFood({ stock: 5 });

  const res = await put(staff, item._id, { stock: 99 });
  assert.equal(res.status, 403);
  assert.match(res.body.message, /administrators/i);

  const fresh = await Food.findById(item._id);
  assert.equal(fresh.stock, 5);
});

test("P1-N2: staff can still edit menu fields (price, name)", async () => {
  const staff = await tokenFor("staff");
  const item = await makeFood({ stock: 5 });

  const res = await put(staff, item._id, { price: 45, name: "Renamed" });
  assert.equal(res.status, 200);
  assert.equal(res.body.price, 45);
});

test("P1-N2: admin can set stock on an untracked item (legacy behaviour kept)", async () => {
  const admin = await tokenFor("admin");
  const item = await makeFood({ stock: 5 });

  const res = await put(admin, item._id, { stock: 12 });
  assert.equal(res.status, 200);
  assert.equal((await Food.findById(item._id)).stock, 12);
});

test("P1-N2: admin PUT stock on a tracked item is refused (400) and writes no ledger row", async () => {
  const admin = await tokenFor("admin");
  const item = await trackedItem({ stock: 10 });

  const res = await put(admin, item._id, { stock: 99 });
  assert.equal(res.status, 400);
  assert.match(res.body.message, /adjust/);

  assert.equal((await Food.findById(item._id)).stock, 10);
  assert.equal(await Movement.countDocuments({ food: item._id }), 0);
});

test("P1-N2: the ledger endpoint is the supported way to change a tracked item's stock", async () => {
  const admin = await tokenFor("admin");
  const item = await trackedItem({ stock: 10 });

  const res = await api()
    .post(`/api/inventory/${item._id}/adjust`)
    .set("Authorization", `Bearer ${admin}`)
    .send({ set: 15, reason: "Stock count" });
  assert.equal(res.status, 200);
  assert.equal((await Food.findById(item._id)).stock, 15);
  assert.equal(await Movement.countDocuments({ food: item._id, type: "adjustment" }), 1);
});

// --------------------------------------------------------- N3: DELETE guard

test("P1-N3: deleting an item with open reservations is refused (409) and nothing is removed", async () => {
  const admin = await tokenFor("admin");
  const item = await trackedItem({ stock: 10, reserved: 3 });

  const res = await del(admin, item._id);
  assert.equal(res.status, 409);
  assert.match(res.body.message, /reserved/);
  assert.ok(await Food.findById(item._id));
});

test("P1-N3: deleting an item with no reservations still works", async () => {
  const admin = await tokenFor("admin");
  const item = await trackedItem({ stock: 10, reserved: 0 });

  const res = await del(admin, item._id);
  assert.equal(res.status, 200);
  assert.equal(await Food.findById(item._id), null);
});

// -------------------------------------------------------- N4: POST create

test("P1-N4: staff creating an item with trackInventory is refused (403)", async () => {
  const staff = await tokenFor("staff");
  const res = await post(staff, { name: "Sneaky", price: 10, trackInventory: true, stock: 50 });
  assert.equal(res.status, 403);
  assert.equal(await Food.countDocuments({ name: "Sneaky" }), 0);
});

test("P1-N4: staff creating an item with a stock figure is refused (403)", async () => {
  const staff = await tokenFor("staff");
  const res = await post(staff, { name: "Sneaky2", price: 10, stock: 50 });
  assert.equal(res.status, 403);
});

test("P1-N4: staff can still create a plain menu item", async () => {
  const staff = await tokenFor("staff");
  const res = await post(staff, { name: "Plain Tea", price: 10 });
  assert.equal(res.status, 201);
});

test("P1-N4: admin creating a tracked item records the starting stock in the ledger", async () => {
  const admin = await tokenFor("admin");
  const res = await post(admin, {
    name: "New Samosa",
    price: 15,
    trackInventory: true,
    stock: 25,
    lowStockThreshold: 4,
    unit: "pieces",
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.trackInventory, true);
  assert.equal(res.body.stock, 25);
  assert.equal(res.body.lowStockThreshold, 4);

  const movements = await Movement.find({ food: res.body._id });
  assert.equal(movements.length, 1);
  assert.equal(movements[0].stockDelta, 25);
});

test("P1-N4: admin creating a tracked item without a starting stock is refused (400)", async () => {
  const admin = await tokenFor("admin");
  const res = await post(admin, { name: "No Stock", price: 15, trackInventory: true });
  assert.equal(res.status, 400);
  assert.equal(await Food.countDocuments({ name: "No Stock" }), 0);
});

test("P1-N4: a stock figure without trackInventory is refused (400)", async () => {
  const admin = await tokenFor("admin");
  const res = await post(admin, { name: "Loose Stock", price: 15, stock: 5 });
  assert.equal(res.status, 400);
});
