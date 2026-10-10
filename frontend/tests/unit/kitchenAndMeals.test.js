import { test } from "node:test";
import assert from "node:assert/strict";
import { sortKitchenQueue, compareKitchenOrders } from "../../src/lib/kitchenSort.js";
import {
  localInputToIso,
  isoToLocalInput,
  servingSummary,
  MEAL_PERIOD_LABEL,
} from "../../src/lib/mealPeriods.js";

const order = (id, extra = {}) => ({
  _id: id,
  priority: "normal",
  date: "2026-10-10T08:00:00.000Z",
  pickupAt: null,
  estimatedReadyAt: null,
  ...extra,
});

test("rush orders come before normal orders, whatever their due time", () => {
  const sorted = sortKitchenQueue([
    order("a", { estimatedReadyAt: "2026-10-10T08:05:00.000Z" }),
    order("b", { priority: "rush", estimatedReadyAt: "2026-10-10T09:00:00.000Z" }),
  ]);
  assert.deepEqual(sorted.map((o) => o._id), ["b", "a"]);
});

test("within a priority, the order due soonest comes first", () => {
  const sorted = sortKitchenQueue([
    order("late", { pickupAt: "2026-10-10T12:00:00.000Z" }),
    order("soon", { estimatedReadyAt: "2026-10-10T08:30:00.000Z" }),
    order("pickup", { pickupAt: "2026-10-10T10:00:00.000Z" }),
  ]);
  assert.deepEqual(sorted.map((o) => o._id), ["soon", "pickup", "late"]);
});

test("pickup time takes precedence over estimated ready time for due order", () => {
  const a = order("a", { pickupAt: "2026-10-10T09:00:00.000Z", estimatedReadyAt: "2026-10-10T07:00:00.000Z" });
  const b = order("b", { estimatedReadyAt: "2026-10-10T08:00:00.000Z" });
  // a is due at 09:00 (pickup), b at 08:00 (ready): b first.
  assert.deepEqual(sortKitchenQueue([a, b]).map((o) => o._id), ["b", "a"]);
});

test("ties fall back to placement time, then id", () => {
  const sorted = sortKitchenQueue([
    order("c", { date: "2026-10-10T08:02:00.000Z" }),
    order("b", { date: "2026-10-10T08:01:00.000Z" }),
    order("a", { date: "2026-10-10T08:01:00.000Z" }),
  ]);
  assert.deepEqual(sorted.map((o) => o._id), ["a", "b", "c"]);
});

test("sortKitchenQueue does not change its input", () => {
  const input = [order("b"), order("a", { priority: "rush" })];
  const copy = input.map((o) => o._id);
  sortKitchenQueue(input);
  assert.deepEqual(input.map((o) => o._id), copy);
});

test("an unknown priority is treated as normal", () => {
  const sorted = sortKitchenQueue([order("weird", { priority: "urgent??" }), order("rush", { priority: "rush" })]);
  assert.deepEqual(sorted.map((o) => o._id), ["rush", "weird"]);
  // Missing priority ranks as normal; equal due times fall back to id order.
  assert.ok(compareKitchenOrders(order("x", { priority: undefined }), order("y")) < 0);
});

test("local input converts to an ISO instant and back to the same wall time", () => {
  const text = "2026-10-10T09:30";
  const iso = localInputToIso(text);
  assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/);
  // Round trip is zone-independent: the same local wall time comes back.
  assert.equal(isoToLocalInput(iso), text);
});

test("empty or invalid local input", () => {
  assert.equal(localInputToIso(""), null);
  assert.equal(localInputToIso("   "), null);
  assert.throws(() => localInputToIso("not a date"), /valid date/);
  assert.equal(isoToLocalInput(null), "");
  assert.equal(isoToLocalInput("garbage"), "");
});

test("serving summary: all day when no periods or window", () => {
  assert.equal(servingSummary({}), "All day");
  assert.equal(servingSummary({ menuPeriods: [] }), "All day");
});

test("serving summary lists meal periods with their labels", () => {
  assert.equal(servingSummary({ menuPeriods: ["breakfast", "snacks"] }), "Breakfast, Snacks");
  assert.equal(MEAL_PERIOD_LABEL.dinner, "Dinner");
});

test("serving summary shows an open-ended window", () => {
  const from = localInputToIso("2026-10-10T11:00");
  const text = servingSummary({ menuPeriods: ["lunch"], servesFrom: from });
  assert.equal(text, `Lunch · ${isoToLocalInput(from).replace("T", " ")} to open-ended`);
});
