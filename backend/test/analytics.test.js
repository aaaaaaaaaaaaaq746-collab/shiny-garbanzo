const { test } = require("node:test");
const assert = require("node:assert/strict");

/** Pure tests: analytics arithmetic and date ranges. No database. */

const a = require("../utils/analytics");

const IST = 330;
const NOW = Date.parse("2026-10-10T06:00:00Z"); // 11:30 IST on 2026-10-10

test("the default range is the last 30 canteen days ending today", () => {
  const r = a.resolveRange({ now: NOW, utcOffsetMinutes: IST });
  assert.equal(r.toKey, "2026-10-10");
  assert.equal(r.fromKey, "2026-09-11");
  assert.equal(r.spanDays, 30);
});

test("the day boundary follows the canteen zone, not UTC", () => {
  // 20:00 UTC on 9 Oct is already 10 Oct in India.
  assert.equal(a.dayKeyOf(Date.parse("2026-10-09T20:00:00Z"), IST), "2026-10-10");
  assert.equal(a.dayKeyOf(Date.parse("2026-10-09T20:00:00Z"), 0), "2026-10-09");
});

test("explicit from and to are inclusive, and the day window starts at local midnight", () => {
  const r = a.resolveRange({ from: "2026-10-01", to: "2026-10-03", now: NOW, utcOffsetMinutes: IST });
  assert.equal(r.startMs, Date.parse("2026-09-30T18:30:00Z"));
  assert.equal(r.endMs, Date.parse("2026-10-03T18:30:00Z"));
});

test("invalid and impossible dates are refused with a 400", () => {
  for (const bad of ["2026-13-01", "2026-02-30", "10/10/2026", "", "yesterday"]) {
    assert.throws(
      () => a.parseDayKey(bad, "from"),
      (e) => e.statusCode === 400,
      `expected ${bad} to be refused`
    );
  }
  assert.equal(a.parseDayKey("2028-02-29", "from"), "2028-02-29", "leap day is real");
});

test("from after to, and ranges over a year, are refused", () => {
  assert.throws(() => a.resolveRange({ from: "2026-10-05", to: "2026-10-01", now: NOW, utcOffsetMinutes: IST }), /on or before/);
  assert.throws(() => a.resolveRange({ from: "2025-01-01", to: "2026-10-01", now: NOW, utcOffsetMinutes: IST }), /at most/);
});

test("granularity is one of daily, weekly, monthly", () => {
  assert.equal(a.parseGranularity(undefined), "daily");
  assert.equal(a.parseGranularity("weekly"), "weekly");
  assert.throws(() => a.parseGranularity("hourly"), (e) => e.statusCode === 400);
});

test("weekly buckets start on Monday and monthly buckets on the 1st", () => {
  // 2026-10-10 is a Saturday, so its week starts on Monday 2026-10-05.
  assert.equal(a.periodKeyFor("2026-10-10", "weekly"), "2026-10-05");
  assert.equal(a.periodKeyFor("2026-10-05", "weekly"), "2026-10-05");
  assert.equal(a.periodKeyFor("2026-10-10", "monthly"), "2026-10");
  assert.equal(a.periodKeyFor("2026-10-10", "daily"), "2026-10-10");
});

test("bucketRevenue sums days into periods and computes average order value", () => {
  const days = [
    { dayKey: "2026-10-05", revenue: 100, orders: 2 },
    { dayKey: "2026-10-10", revenue: 50, orders: 1 },
    { dayKey: "2026-10-11", revenue: 0, orders: 0 },
  ];
  assert.deepEqual(a.bucketRevenue(days, "weekly"), [
    { period: "2026-10-05", revenue: 150, orders: 3, averageOrderValue: 50 },
  ]);
  assert.equal(a.bucketRevenue(days, "daily").length, 3);
});

test("summarizeOrders counts sales as everything that is not cancelled or rejected", () => {
  const orders = [
    { status: "Completed", total: 100, date: NOW },
    { status: "Pending", total: 50, date: NOW },
    { status: "Cancelled", total: 999, date: NOW },
    { status: "Rejected", total: 999, date: NOW },
  ];
  const s = a.summarizeOrders(orders, { now: NOW, utcOffsetMinutes: IST });
  assert.equal(s.sales, 2);
  assert.equal(s.revenue, 150);
  assert.equal(s.averageOrderValue, 75);
  assert.equal(s.completed, 1);
  assert.equal(s.cancelled, 1);
  assert.equal(s.rejected, 1);
});

test("summarizeOrders reports today's figures separately", () => {
  const orders = [
    { status: "Completed", total: 100, date: NOW },
    { status: "Completed", total: 40, date: Date.parse("2026-10-01T06:00:00Z") },
  ];
  const s = a.summarizeOrders(orders, { now: NOW, utcOffsetMinutes: IST });
  assert.equal(s.todaySales, 1);
  assert.equal(s.todayRevenue, 100);
  assert.equal(s.revenue, 140);
});

test("summarizeOrders reports no refunds and creates no refund figure", () => {
  const s = a.summarizeOrders([{ status: "Cancelled", total: 100, date: NOW }], { now: NOW, utcOffsetMinutes: IST });
  assert.equal(Object.keys(s).some((k) => /refund/i.test(k)), false);
});

test("rankItems ranks sold items and includes unsold menu items in least-popular", () => {
  const lines = [
    { foodId: "1", name: "Dosa", quantity: 5, lineTotal: 250 },
    { foodId: "1", name: "Dosa", quantity: 2, lineTotal: 100 },
    { foodId: "2", name: "Tea", quantity: 1, lineTotal: 10 },
  ];
  const catalog = [
    { id: "1", name: "Dosa", category: "Meals" },
    { id: "2", name: "Tea", category: "Drinks" },
    { id: "3", name: "Samosa", category: "Snacks" },
  ];
  const r = a.rankItems(lines, catalog, 2);
  assert.deepEqual(r.popular.map((x) => [x.name, x.quantity]), [["Dosa", 7], ["Tea", 1]]);
  assert.equal(r.popular.every((x) => x.quantity > 0), true);
  assert.equal(r.leastPopular[0].name, "Samosa", "an unsold item is the least popular");
  assert.equal(r.leastPopular[0].quantity, 0);
});

test("peakHours counts sales by canteen-local hour", () => {
  const hours = a.peakHours(
    [Date.parse("2026-10-10T04:00:00Z"), Date.parse("2026-10-10T04:10:00Z"), Date.parse("2026-10-10T12:00:00Z")],
    IST
  );
  assert.equal(hours.length, 24);
  assert.equal(hours[9], 2, "09:30 and 09:00 IST");
  assert.equal(hours[17], 1, "17:30 IST");
  assert.equal(hours.reduce((x, y) => x + y, 0), 3);
});
