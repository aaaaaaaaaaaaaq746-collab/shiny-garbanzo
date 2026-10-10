const { test } = require("node:test");
const assert = require("node:assert/strict");

/**
 * Pure tests: add-on validation, line pricing, coupons, charges, bill totals
 * and pickup slots. No database. Covers the student checkout arithmetic.
 */

const pricing = require("../utils/pricing");
const slots = require("../utils/pickupSlots");

const NOW = Date.parse("2026-10-10T04:00:00Z"); // 09:30 in Asia/Kolkata
const CFG = { taxPercent: 0, packagingChargePerItem: 0 };

const dosa = {
  _id: "64b000000000000000000001",
  name: "Dosa",
  price: 50,
  trackInventory: false,
  addOns: [
    { label: "Extra chutney", price: 5 },
    { label: "Extra sambar", price: 10 },
  ],
};

// ------------------------------------------------------------ priceLine

test("priceLine: unit price includes the chosen add-ons and matches price * quantity", () => {
  const line = pricing.priceLine({ food: dosa, quantity: 2, addOnLabels: ["Extra sambar"] });
  assert.equal(line.basePrice, 50);
  assert.equal(line.addOnsTotal, 10);
  assert.equal(line.price, 60);
  assert.equal(line.lineTotal, 120);
  assert.equal(line.price * line.quantity, line.lineTotal);
});

test("priceLine: an add-on that the menu item does not define is refused", () => {
  assert.throws(
    () => pricing.priceLine({ food: dosa, quantity: 1, addOnLabels: ["Free cake"] }),
    (err) => err.statusCode === 400 && /not an option/.test(err.message)
  );
});

test("priceLine: the same add-on selected twice is counted once", () => {
  const line = pricing.priceLine({
    food: dosa,
    quantity: 1,
    addOnLabels: ["Extra chutney", "Extra chutney"],
  });
  assert.equal(line.addOns.length, 1);
  assert.equal(line.price, 55);
});

test("priceLine: uses the menu price, never a price sent by the client", () => {
  // addOnLabels carries names only; there is no field a client could use to set a price.
  const line = pricing.priceLine({ food: dosa, quantity: 1, addOnLabels: ["Extra chutney"] });
  assert.equal(line.addOns[0].price, 5);
});

test("priceLine: too many add-ons is refused", () => {
  const many = Array.from({ length: pricing.MAX_ADDONS_PER_LINE + 1 }, (_, i) => `a${i}`);
  assert.throws(() => pricing.priceLine({ food: dosa, quantity: 1, addOnLabels: many }), (e) => e.statusCode === 400);
});

test("priceLine: special instructions are trimmed, optional and length-limited", () => {
  const line = pricing.priceLine({ food: dosa, quantity: 1, specialInstructions: "  less oil  " });
  assert.equal(line.specialInstructions, "less oil");

  const none = pricing.priceLine({ food: dosa, quantity: 1 });
  assert.equal(none.specialInstructions, null);

  assert.throws(
    () => pricing.priceLine({ food: dosa, quantity: 1, specialInstructions: "x".repeat(141) }),
    (e) => e.statusCode === 400
  );
});

test("priceLine: non-array add-ons are a clean 400", () => {
  assert.throws(() => pricing.priceLine({ food: dosa, quantity: 1, addOnLabels: "Extra chutney" }), (e) => e.statusCode === 400);
});

// ------------------------------------------------------------ coupons

const percent10 = {
  code: "OFF10",
  type: "percent",
  value: 10,
  minSubtotal: 50,
  maxDiscount: 20,
  active: true,
  expiresAt: null,
  usageLimit: null,
  usedCount: 0,
};

test("applyCoupon: percent discount is capped by maxDiscount", () => {
  assert.deepEqual(pricing.applyCoupon(percent10, 100, NOW), { code: "OFF10", discount: 10 });
  assert.equal(pricing.applyCoupon(percent10, 1000, NOW).discount, 20);
});

test("applyCoupon: flat discount never exceeds the subtotal", () => {
  const flat = { ...percent10, type: "flat", value: 500, maxDiscount: null, minSubtotal: 0 };
  assert.equal(pricing.applyCoupon(flat, 120, NOW).discount, 120);
});

test("applyCoupon: refuses inactive, expired, exhausted and under-minimum coupons with a reason", () => {
  assert.throws(() => pricing.applyCoupon({ ...percent10, active: false }, 100, NOW), /no longer active/);
  assert.throws(
    () => pricing.applyCoupon({ ...percent10, expiresAt: new Date(NOW - 1000) }, 100, NOW),
    /expired/
  );
  assert.throws(
    () => pricing.applyCoupon({ ...percent10, usageLimit: 3, usedCount: 3 }, 100, NOW),
    (e) => e.statusCode === 409
  );
  assert.throws(() => pricing.applyCoupon(percent10, 40, NOW), /at least/);
  assert.throws(() => pricing.applyCoupon(null, 40, NOW), /not recognised/);
});

// ------------------------------------------------------------ bill

test("buildBill: no coupon, no charges: total equals subtotal (backward compatible)", () => {
  const line = pricing.priceLine({ food: dosa, quantity: 2 });
  const bill = pricing.buildBill({ lines: [line], now: NOW, pricing: CFG });
  assert.equal(bill.subtotal, 100);
  assert.equal(bill.discount, 0);
  assert.deepEqual(bill.charges, []);
  assert.equal(bill.total, 100);
  assert.equal(bill.itemCount, 2);
});

test("buildBill: discount then packaging then tax, with the total never negative", () => {
  const line = pricing.priceLine({ food: dosa, quantity: 2, addOnLabels: ["Extra chutney"] }); // 110
  const bill = pricing.buildBill({
    lines: [line],
    coupon: percent10,
    now: NOW,
    pricing: { taxPercent: 5, packagingChargePerItem: 2 },
  });
  assert.equal(bill.subtotal, 110);
  assert.equal(bill.discount, 11);
  assert.deepEqual(bill.charges, [
    { label: "Packaging", amount: 4 },
    { label: "Tax (5%)", amount: 4.95 },
  ]);
  assert.equal(bill.total, 107.95);
});

test("buildBill: a coupon that is refused makes the whole bill fail (no silent discount)", () => {
  const line = pricing.priceLine({ food: dosa, quantity: 1 });
  assert.throws(() => pricing.buildBill({ lines: [line], coupon: { ...percent10, active: false }, now: NOW, pricing: CFG }));
});

// ------------------------------------------------------------ pickup slots

test("generatePickupSlots: 15-minute grid in IST, open 09:00 to 18:00, two days", () => {
  const list = slots.generatePickupSlots({
    now: NOW,
    earliestMs: NOW,
    openHour: 9,
    closeHour: 18,
    slotMinutes: 15,
    utcOffsetMinutes: 330,
    days: 2,
  });
  // Today from 09:30 (first grid point at or after now) to 17:45: 34 slots.
  // Tomorrow from 09:00 to 17:45: 36 slots.
  assert.equal(list.length, 70);
  assert.equal(slots.formatSlotLabel(list[0], 330), "2026-10-10 09:30");
  assert.equal(slots.formatSlotLabel(list[list.length - 1], 330), "2026-10-11 17:45");
});

test("generatePickupSlots: respects the earliest ready time", () => {
  const earliest = slots.earliestReadyAt(NOW, 20, 5); // +25 min
  const list = slots.generatePickupSlots({
    now: NOW,
    earliestMs: earliest,
    openHour: 9,
    closeHour: 18,
    slotMinutes: 15,
    utcOffsetMinutes: 330,
    days: 1,
  });
  assert.ok(list.every((t) => t >= earliest));
  assert.equal(slots.formatSlotLabel(list[0], 330), "2026-10-10 10:00");
});

test("generatePickupSlots: after closing there is nothing today, but tomorrow is still open", () => {
  const evening = Date.parse("2026-10-10T13:00:00Z"); // 18:30 IST
  const list = slots.generatePickupSlots({
    now: evening,
    earliestMs: evening,
    openHour: 9,
    closeHour: 18,
    slotMinutes: 15,
    utcOffsetMinutes: 330,
    days: 2,
  });
  assert.equal(list.length, 36);
  assert.equal(slots.formatSlotLabel(list[0], 330), "2026-10-11 09:00");
});

test("isOpenPickupSlot: only exact grid members are accepted", () => {
  const list = slots.generatePickupSlots({
    now: NOW, earliestMs: NOW, openHour: 9, closeHour: 18, slotMinutes: 15, utcOffsetMinutes: 330, days: 1,
  });
  assert.equal(slots.isOpenPickupSlot(list[3], list), true);
  assert.equal(slots.isOpenPickupSlot(list[3] + 60_000, list), false);
  assert.equal(slots.isOpenPickupSlot(NaN, list), false);
});
