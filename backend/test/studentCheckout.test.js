// Test-only secret so config.js loads without a .env file (same value as helpers.js).
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-not-used-anywhere-else-0123456789";
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

/**
 * DB-free tests for the checkout resolution service (services/checkout.js).
 *
 * The Food and Coupon model reads are replaced with in-memory stubs for the
 * duration of each test and restored afterwards. This exercises the real
 * cart rules (merging, stock, add-ons, coupons, pickup slots) without MongoDB.
 */

const Food = require("../models/FoodItem");
const Coupon = require("../models/Coupon");
const checkout = require("../services/checkout");
const { ObjectId } = require("mongoose").Types;

const NOW = Date.parse("2026-10-10T04:00:00Z"); // 09:30 IST, inside opening hours

function food(overrides = {}) {
  const doc = {
    _id: new ObjectId(),
    name: "Dosa",
    price: 50,
    available: true,
    trackInventory: false,
    prepTimeMinutes: 10,
    addOns: [{ label: "Extra chutney", price: 5 }],
    ...overrides,
  };
  doc.sellableQty = () => (doc.trackInventory ? Math.max(0, (doc.stock ?? 0) - (doc.reserved ?? 0)) : Infinity);
  return doc;
}

let originals;
let foods;
let coupons;

beforeEach(() => {
  originals = { find: Food.find, findOne: Coupon.findOne };
  foods = [];
  coupons = new Map();
  Food.find = async (filter) => {
    const ids = filter._id.$in.map(String);
    return foods.filter((f) => ids.includes(String(f._id)));
  };
  Coupon.findOne = async (filter) => coupons.get(filter.code) ?? null;
});

afterEach(() => {
  Food.find = originals.find;
  Coupon.findOne = originals.findOne;
});

const cart = (items, extra = {}) => ({ items, ...extra });

test("resolveCart: prices from the menu, never from the request, and totals the cart", async () => {
  const dosa = food();
  foods = [dosa];
  const out = await checkout.resolveCart(
    cart([{ food: String(dosa._id), quantity: 2, addOns: ["Extra chutney"] }]),
    { now: NOW }
  );
  assert.equal(out.bill.subtotal, 110);
  assert.equal(out.bill.total, 110);
  assert.equal(out.lines[0].addOns[0].price, 5);
});

test("resolveCart: identical lines merge; different add-on choices stay separate", async () => {
  const dosa = food();
  foods = [dosa];
  const id = String(dosa._id);
  const out = await checkout.resolveCart(
    cart([
      { food: id, quantity: 1 },
      { food: id, quantity: 2 },
      { food: id, quantity: 1, addOns: ["Extra chutney"] },
    ]),
    { now: NOW }
  );
  assert.equal(out.lines.length, 2);
  assert.equal(out.lines[0].quantity, 3);
  assert.equal(out.bill.itemCount, 4);
});

test("resolveCart: merged quantity over the per-item maximum is refused", async () => {
  const dosa = food();
  foods = [dosa];
  const id = String(dosa._id);
  await assert.rejects(
    () => checkout.resolveCart(cart([{ food: id, quantity: 15 }, { food: id, quantity: 10 }]), { now: NOW }),
    (e) => e.statusCode === 400
  );
});

test("resolveCart: sold-out and unavailable items are refused with 409", async () => {
  const soldOut = food({ name: "Thali", trackInventory: true, stock: 2, reserved: 2 });
  const off = food({ name: "Shake", available: false });
  foods = [soldOut, off];
  await assert.rejects(
    () => checkout.resolveCart(cart([{ food: String(soldOut._id), quantity: 1 }]), { now: NOW }),
    (e) => e.statusCode === 409 && /sold out/.test(e.message)
  );
  await assert.rejects(
    () => checkout.resolveCart(cart([{ food: String(off._id), quantity: 1 }]), { now: NOW }),
    (e) => e.statusCode === 409 && /unavailable/.test(e.message)
  );
});

test("resolveCart: two lines of one tracked item must fit stock together", async () => {
  const thali = food({ name: "Thali", trackInventory: true, stock: 3, reserved: 0, price: 80 });
  foods = [thali];
  const id = String(thali._id);
  // Same item, different add-on choice: each line alone fits, together they do not.
  thali.addOns = [{ label: "Lassi", price: 20 }];
  await assert.rejects(
    () => checkout.resolveCart(cart([{ food: id, quantity: 2 }, { food: id, quantity: 2, addOns: ["Lassi"] }]), { now: NOW }),
    (e) => e.statusCode === 409 && /Only 3/.test(e.message)
  );
});

test("resolveCart: a coupon discounts the bill and reports its code", async () => {
  const dosa = food({ price: 100 });
  foods = [dosa];
  coupons.set("OFF10", {
    code: "OFF10", type: "percent", value: 10, minSubtotal: 50, maxDiscount: 20,
    active: true, expiresAt: null, usageLimit: null, usedCount: 0,
  });
  const out = await checkout.resolveCart(
    cart([{ food: String(dosa._id), quantity: 1 }], { couponCode: " off10 " }),
    { now: NOW }
  );
  assert.equal(out.bill.discount, 10);
  assert.equal(out.bill.couponCode, "OFF10");
  assert.equal(out.bill.total, 90);
});

test("resolveCart: an unknown coupon is a 400, not a silent zero discount", async () => {
  const dosa = food();
  foods = [dosa];
  await assert.rejects(
    () => checkout.resolveCart(cart([{ food: String(dosa._id), quantity: 1 }], { couponCode: "NOPE" }), { now: NOW }),
    (e) => e.statusCode === 400 && /not recognised/.test(e.message)
  );
});

test("resolveCart: a pickup time on an open slot is accepted and returned as a Date", async () => {
  const dosa = food({ prepTimeMinutes: 10 });
  foods = [dosa];
  // Earliest ready = now + 10 + 5 min buffer = 09:45 IST. 10:00 IST is an open slot.
  const at = "2026-10-10T04:30:00.000Z";
  const out = await checkout.resolveCart(
    cart([{ food: String(dosa._id), quantity: 1 }], { pickupAt: at }),
    { now: NOW }
  );
  assert.equal(out.pickupAt.toISOString(), at);
});

test("resolveCart: a pickup time off the grid, too early, or after closing is a 409", async () => {
  const dosa = food({ prepTimeMinutes: 10 });
  foods = [dosa];
  const base = cart([{ food: String(dosa._id), quantity: 1 }]);
  const off = { ...base, pickupAt: "2026-10-10T04:31:00.000Z" };     // not on the 15-min grid
  const early = { ...base, pickupAt: "2026-10-10T04:00:00.000Z" };   // before earliest ready
  const late = { ...base, pickupAt: "2026-10-10T12:30:00.000Z" };    // 18:00 IST, closed
  for (const body of [off, early, late]) {
    await assert.rejects(() => checkout.resolveCart(body, { now: NOW }), (e) => e.statusCode === 409);
  }
});

test("resolveCart: no pickup time means as soon as ready (existing behaviour)", async () => {
  const dosa = food();
  foods = [dosa];
  const out = await checkout.resolveCart(cart([{ food: String(dosa._id), quantity: 1 }]), { now: NOW });
  assert.equal(out.pickupAt, null);
});

test("resolveCart: an empty cart and a missing food are refused", async () => {
  await assert.rejects(() => checkout.resolveCart(cart([]), { now: NOW }), (e) => e.statusCode === 400);
  foods = [];
  await assert.rejects(
    () => checkout.resolveCart(cart([{ food: String(new ObjectId()), quantity: 1 }]), { now: NOW }),
    (e) => e.statusCode === 400 && /no longer exists/.test(e.message)
  );
});

test("resolveCart: a non-list add-ons value is a 400, not a server error", async () => {
  const dosa = food();
  foods = [dosa];
  for (const bad of [5, "Extra chutney", { label: "Extra chutney" }]) {
    await assert.rejects(
      () => checkout.resolveCart(cart([{ food: String(dosa._id), quantity: 1, addOns: bad }]), { now: NOW }),
      (e) => e.statusCode === 400,
      `addOns=${JSON.stringify(bad)}`
    );
  }
});
