const { test } = require("node:test");
const assert = require("node:assert/strict");

/** Pure tests: kitchen queue ordering. No database. */

const { sortKitchenQueue, dueMs } = require("../utils/kitchenPriority");

const t = (iso) => new Date(iso).toISOString();
const order = (id, over = {}) => ({
  _id: id,
  priority: "normal",
  date: t("2026-10-10T04:00:00Z"),
  pickupAt: null,
  estimatedReadyAt: null,
  ...over,
});
const ids = (list) => list.map((o) => o._id);

test("rush orders come before normal orders, whatever their due time", () => {
  const q = [
    order("a", { pickupAt: t("2026-10-10T05:00:00Z") }),
    order("b", { priority: "rush", pickupAt: t("2026-10-10T06:00:00Z") }),
  ];
  assert.deepEqual(ids(sortKitchenQueue(q)), ["b", "a"]);
});

test("within a band, the earliest due time goes first", () => {
  const q = [
    order("late", { pickupAt: t("2026-10-10T07:00:00Z") }),
    order("early", { pickupAt: t("2026-10-10T05:00:00Z") }),
  ];
  assert.deepEqual(ids(sortKitchenQueue(q)), ["early", "late"]);
});

test("a pickup time takes precedence over the estimated ready time", () => {
  assert.equal(dueMs(order("x", { pickupAt: t("2026-10-10T05:00:00Z"), estimatedReadyAt: t("2026-10-10T09:00:00Z") })), Date.parse("2026-10-10T05:00:00Z"));
  assert.equal(dueMs(order("y", { estimatedReadyAt: t("2026-10-10T09:00:00Z") })), Date.parse("2026-10-10T09:00:00Z"));
});

test("orders with no due time fall back to placement time", () => {
  const q = [order("new", { date: t("2026-10-10T04:30:00Z") }), order("old", { date: t("2026-10-10T04:00:00Z") })];
  assert.deepEqual(ids(sortKitchenQueue(q)), ["old", "new"]);
});

test("ties are broken by id, so every screen shows the same order", () => {
  const q = [order("b"), order("a")];
  assert.deepEqual(ids(sortKitchenQueue(q)), ["a", "b"]);
});

test("an unknown priority is treated as normal", () => {
  const q = [order("odd", { priority: undefined, pickupAt: t("2026-10-10T05:00:00Z") }), order("rush", { priority: "rush", pickupAt: t("2026-10-10T09:00:00Z") })];
  assert.deepEqual(ids(sortKitchenQueue(q)), ["rush", "odd"]);
});

test("sortKitchenQueue does not change its input", () => {
  const q = [order("b", { priority: "rush" }), order("a")];
  const before = ids(q).join(",");
  sortKitchenQueue(q);
  assert.equal(ids(q).join(","), before);
});
