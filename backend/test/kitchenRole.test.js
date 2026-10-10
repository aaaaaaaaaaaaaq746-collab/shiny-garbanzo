const { test } = require("node:test");
const assert = require("node:assert/strict");

/** Pure tests: the kitchen role's permissions and the kitchen route guard. No database. */

const { checkTransition, allowedTransitions, canCancel, STATUS } = require("../utils/orderLifecycle");
const { kitchenAccessMiddleware } = require("../middleware/authMiddleware");
const ApiError = require("../utils/ApiError");

test("kitchen can accept, start and mark ready", () => {
  assert.equal(checkTransition({ from: "Pending", to: "Accepted", role: "kitchen" }).allowed, true);
  assert.equal(checkTransition({ from: "Accepted", to: "Preparing", role: "kitchen" }).allowed, true);
  assert.equal(checkTransition({ from: "Preparing", to: "Ready", role: "kitchen" }).allowed, true);
});

test("kitchen cannot complete, cancel or reject, and is told why with a 403", () => {
  for (const [from, to] of [
    ["Ready", "Completed"],
    ["Pending", "Cancelled"],
    ["Accepted", "Cancelled"],
    ["Pending", "Rejected"],
    ["Accepted", "Rejected"],
  ]) {
    const r = checkTransition({ from, to, role: "kitchen" });
    assert.equal(r.allowed, false, `${from} -> ${to}`);
    assert.equal(r.code, 403, `${from} -> ${to}`);
    assert.match(r.message, /cannot complete, cancel or reject/);
  }
});

test("kitchen cannot reopen a terminal order", () => {
  assert.equal(checkTransition({ from: STATUS.CANCELLED, to: "Accepted", role: "kitchen" }).allowed, false);
});

test("allowedTransitions offers kitchen only the kitchen steps", () => {
  assert.deepEqual(allowedTransitions({ from: "Pending", role: "kitchen" }).sort(), ["Accepted", "Preparing", "Ready"]);
  assert.deepEqual(allowedTransitions({ from: "Preparing", role: "kitchen" }), ["Ready"]);
  assert.deepEqual(allowedTransitions({ from: "Ready", role: "kitchen" }), []);
});

test("canCancel is false for kitchen on every status", () => {
  for (const status of ["Pending", "Accepted", "Preparing", "Ready"]) {
    assert.equal(canCancel({ order: { status, student: "x" }, user: { role: "kitchen", _id: "k" } }), false, status);
  }
});

test("kitchenAccessMiddleware admits kitchen, staff and admin, and refuses students and anonymous callers", () => {
  const run = (user) => {
    let received;
    kitchenAccessMiddleware({ user }, {}, (err) => {
      received = err;
    });
    return received;
  };
  assert.equal(run({ role: "kitchen" }), undefined);
  assert.equal(run({ role: "staff" }), undefined);
  assert.equal(run({ role: "admin" }), undefined);

  const forbidden = run({ role: "student" });
  assert.ok(forbidden instanceof ApiError);
  assert.equal(forbidden.statusCode, 403);

  const anonymous = run(undefined);
  assert.ok(anonymous instanceof ApiError);
  assert.equal(anonymous.statusCode, 401);
});
