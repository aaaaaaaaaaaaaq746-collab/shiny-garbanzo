const { test } = require("node:test");
const assert = require("node:assert/strict");

/** Pure tests: meal periods, sale prices, variants, scheduled availability. No database. */

const ms = require("../utils/menuSchedule");

const IST = 330;
const at = (iso) => Date.parse(iso);
const food = (over = {}) => ({ name: "Dosa", price: 100, available: true, variants: [], menuPeriods: [], ...over });

test("parseClock reads HH:MM and rejects anything else", () => {
  assert.equal(ms.parseClock("06:00"), 360);
  assert.equal(ms.parseClock("23:59"), 1439);
  assert.throws(() => ms.parseClock("24:00"));
  assert.throws(() => ms.parseClock("9:00"));
});

test("currentMenuPeriod uses the canteen's local clock, not UTC", () => {
  // 04:00 UTC is 09:30 IST: breakfast.
  assert.equal(ms.currentMenuPeriod(at("2026-10-10T04:00:00Z"), IST), "breakfast");
  // 12:00 UTC is 17:30 IST: snacks.
  assert.equal(ms.currentMenuPeriod(at("2026-10-10T12:00:00Z"), IST), "snacks");
});

test("a meal period includes its start and excludes its end", () => {
  // 11:00 IST exactly starts lunch; 11:00 is the end of breakfast.
  assert.equal(ms.currentMenuPeriod(at("2026-10-10T05:30:00Z"), IST), "lunch");
  assert.equal(ms.currentMenuPeriod(at("2026-10-10T05:29:00Z"), IST), "breakfast");
});

test("between configured periods there is no period", () => {
  const periods = { lunch: { from: "11:00", to: "12:00" } };
  assert.equal(ms.currentMenuPeriod(at("2026-10-10T07:00:00Z"), IST, periods), null); // 12:30 IST
});

test("an item with no schedule, sale or variants is servable as before", () => {
  const r = ms.servingState(food(), { nowMs: at("2026-10-10T04:00:00Z"), period: "breakfast" });
  assert.deepEqual(r, { servable: true, reason: null });
});

test("unavailable, sold out until, not yet served and no longer served are refused with a reason", () => {
  const now = at("2026-10-10T04:00:00Z");
  assert.equal(ms.servingState(food({ available: false }), { nowMs: now }).reason, "unavailable");
  assert.equal(
    ms.servingState(food({ soldOutUntil: new Date(now + 60000) }), { nowMs: now }).reason,
    "sold-out-until"
  );
  assert.equal(
    ms.servingState(food({ soldOutUntil: new Date(now - 60000) }), { nowMs: now }).servable,
    true,
    "a sold-out flag in the past has expired"
  );
  assert.equal(ms.servingState(food({ servesFrom: new Date(now + 1) }), { nowMs: now }).reason, "not-yet-served");
  assert.equal(ms.servingState(food({ servesUntil: new Date(now) }), { nowMs: now }).reason, "no-longer-served");
});

test("meal-period restriction refuses items outside their periods", () => {
  const lunchOnly = food({ menuPeriods: ["lunch"] });
  const now = at("2026-10-10T04:00:00Z"); // breakfast
  assert.deepEqual(ms.servingState(lunchOnly, { nowMs: now, period: "breakfast" }), {
    servable: false,
    reason: "outside-menu-period",
  });
  assert.equal(ms.servingState(lunchOnly, { nowMs: now, period: "lunch" }).servable, true);
  assert.equal(ms.servingState(lunchOnly, { nowMs: now, period: null }).servable, false);
});

test("reasonMessage keeps the words the student sees stable", () => {
  assert.equal(ms.reasonMessage("Dosa", "unavailable"), '"Dosa" is currently unavailable');
  assert.equal(ms.reasonMessage("Dosa", "unknown-code"), '"Dosa" cannot be ordered right now');
});

test("a sale price applies while it runs and ends at saleEndsAt", () => {
  const now = at("2026-10-10T04:00:00Z");
  const onSale = food({ price: 100, salePrice: 80, saleEndsAt: new Date(now + 3600e3) });
  assert.equal(ms.effectiveBasePrice(onSale, now), 80);
  const over = food({ price: 100, salePrice: 80, saleEndsAt: new Date(now - 1) });
  assert.equal(ms.effectiveBasePrice(over, now), 100);
});

test("a sale price that is not lower than the base is ignored", () => {
  assert.equal(ms.effectiveBasePrice(food({ price: 100, salePrice: 120 }), 0), 100);
  assert.equal(ms.effectiveBasePrice(food({ price: 100, salePrice: 100 }), 0), 100);
});

test("a variant uses its own price when there is no sale", () => {
  const f = food({ price: 60, variants: [{ label: "Half", price: 40 }, { label: "Full", price: 60 }] });
  assert.equal(ms.effectiveUnitPrice(f, "Half", 0), 40);
  assert.equal(ms.effectiveUnitPrice(f, "Full", 0), 60);
});

test("a running sale discounts variants by the same ratio as the base", () => {
  const now = at("2026-10-10T04:00:00Z");
  // Base 100 on sale at 80 (20% off). Full 100 -> 80, Half 50 -> 40.
  const f = food({
    price: 100,
    salePrice: 80,
    saleEndsAt: new Date(now + 3600e3),
    variants: [{ label: "Half", price: 50 }, { label: "Full", price: 100 }],
  });
  assert.equal(ms.effectiveUnitPrice(f, "Full", now), 80);
  assert.equal(ms.effectiveUnitPrice(f, "Half", now), 40);
});

test("an unknown size is refused with a 400", () => {
  const f = food({ variants: [{ label: "Full", price: 60 }] });
  assert.throws(
    () => ms.effectiveUnitPrice(f, "Jumbo", 0),
    (e) => e.statusCode === 400 && /not a size/.test(e.message)
  );
});

test("a size is ignored when the item has no variants and none was asked for", () => {
  assert.equal(ms.effectiveUnitPrice(food({ price: 30 }), null, 0), 30);
});

test("servedInPeriod reflects the menuPeriods list", () => {
  assert.equal(ms.servedInPeriod(food(), "dinner"), true);
  assert.equal(ms.servedInPeriod(food({ menuPeriods: ["breakfast"] }), "dinner"), false);
});
