const { test } = require("node:test");
const assert = require("node:assert/strict");

/** Pure tests: the kitchen queue estimate. No database. */

const { estimateQueue, MIN_MS } = require("../utils/kitchenQueue");

const T0 = Date.parse("2026-10-10T04:00:00Z");
const min = (n) => n * MIN_MS;
const at = (ms) => new Date(ms).toISOString();

test("an empty queue gives no estimates", () => {
  assert.equal(estimateQueue({ now: T0, parallel: 3, orders: [] }).size, 0);
});

test("a single order is ready prep minutes after now", () => {
  const map = estimateQueue({
    now: T0,
    parallel: 3,
    orders: [{ id: "a", status: "Pending", placedAt: T0, prepMinutes: 10 }],
  });
  assert.equal(map.get("a"), T0 + min(10));
});

test("orders up to the parallel limit all start immediately", () => {
  const orders = ["a", "b", "c"].map((id, i) => ({ id, status: "Accepted", placedAt: T0 + i, prepMinutes: 10 }));
  const map = estimateQueue({ now: T0, parallel: 3, orders });
  assert.deepEqual([...map.values()], [T0 + min(10), T0 + min(10), T0 + min(10)]);
});

test("the order beyond the parallel limit waits for a working slot", () => {
  const orders = ["a", "b", "c", "d"].map((id, i) => ({ id, status: "Accepted", placedAt: T0 + i, prepMinutes: 10 }));
  const map = estimateQueue({ now: T0, parallel: 3, orders });
  assert.equal(map.get("d"), T0 + min(20), "the fourth order starts when the first slot frees at +10");
});

test("first come first served, regardless of the order the list arrives in", () => {
  const first = { id: "first", status: "Pending", placedAt: T0, prepMinutes: 10 };
  const second = { id: "second", status: "Pending", placedAt: T0 + min(1), prepMinutes: 10 };
  const map = estimateQueue({ now: T0 + min(2), parallel: 1, orders: [second, first] });
  assert.equal(map.get("first"), T0 + min(2) + min(10));
  assert.equal(map.get("second"), T0 + min(2) + min(20));
});

test("an order already cooking is ready from when it started, not from now", () => {
  const map = estimateQueue({
    now: T0 + min(5),
    parallel: 1,
    orders: [{ id: "cook", status: "Preparing", placedAt: T0, prepMinutes: 10, preparingAt: T0 }],
  });
  assert.equal(map.get("cook"), T0 + min(10), "started at T0, so ready 5 minutes from now");
});

test("a cooking order that is already overdue is ready now, not in the past", () => {
  const now = T0 + min(30);
  const map = estimateQueue({
    now,
    parallel: 1,
    orders: [{ id: "late", status: "Preparing", placedAt: T0, prepMinutes: 10, preparingAt: T0 }],
  });
  assert.equal(map.get("late"), now);
});

test("a queued order waits behind a cooking order that occupies the only working slot", () => {
  const map = estimateQueue({
    now: T0,
    parallel: 1,
    orders: [
      { id: "cook", status: "Preparing", placedAt: T0 - min(20), prepMinutes: 10, preparingAt: T0 - min(5) },
      { id: "wait", status: "Pending", placedAt: T0, prepMinutes: 10 },
    ],
  });
  assert.equal(map.get("cook"), T0 + min(5));
  assert.equal(map.get("wait"), T0 + min(15), "starts when the cooking order is ready");
});

test("Ready, Completed, Cancelled and Rejected orders are not in the queue", () => {
  const map = estimateQueue({
    now: T0,
    parallel: 3,
    orders: ["Ready", "Completed", "Cancelled", "Rejected"].map((status, i) => ({
      id: status,
      status,
      placedAt: T0 + i,
      prepMinutes: 10,
    })),
  });
  assert.equal(map.size, 0);
});

test("cancelling an order ahead moves the estimate for the orders behind it earlier", () => {
  const ahead = { id: "ahead", status: "Accepted", placedAt: T0, prepMinutes: 15 };
  const behind = { id: "behind", status: "Accepted", placedAt: T0 + 1, prepMinutes: 10 };
  const before = estimateQueue({ now: T0, parallel: 1, orders: [ahead, behind] }).get("behind");
  const after = estimateQueue({ now: T0, parallel: 1, orders: [behind] }).get("behind");
  assert.equal(before, T0 + min(25));
  assert.equal(after, T0 + min(10), "recalculated once the order ahead is gone");
  assert.ok(after < before);
});

test("the working-slot count is at least one, even when given a bad value", () => {
  const map = estimateQueue({
    now: T0,
    parallel: 0,
    orders: [
      { id: "a", status: "Pending", placedAt: T0, prepMinutes: 10 },
      { id: "b", status: "Pending", placedAt: T0 + 1, prepMinutes: 10 },
    ],
  });
  assert.equal(map.get("b"), T0 + min(20));
});

test("equal arrival times are broken by id so the result is stable", () => {
  const orders = [
    { id: "b", status: "Pending", placedAt: T0, prepMinutes: 5 },
    { id: "a", status: "Pending", placedAt: T0, prepMinutes: 5 },
  ];
  const map = estimateQueue({ now: T0, parallel: 1, orders });
  assert.equal(map.get("a"), T0 + min(5));
  assert.equal(map.get("b"), T0 + min(10));
});
