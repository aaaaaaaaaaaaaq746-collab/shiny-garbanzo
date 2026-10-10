const { test } = require("node:test");
const assert = require("node:assert/strict");

/** Pure tests: which stock step each transition needs, for each deduction point. No database. */

const plan = require("../utils/inventoryPlan");

test("unknown deduction points fall back to preparing", () => {
  assert.equal(plan.normalizeDeductAt("accepted"), "accepted");
  assert.equal(plan.normalizeDeductAt("preparing"), "preparing");
  assert.equal(plan.normalizeDeductAt("ready"), "preparing");
  assert.equal(plan.normalizeDeductAt(undefined), "preparing");
});

test("default deduction at Preparing: cooking start consumes", () => {
  assert.equal(plan.inventoryActionFor({ from: "Accepted", to: "Preparing" }), "consume");
  assert.equal(plan.inventoryActionFor({ from: "Preparing", to: "Ready" }), "consume");
  assert.equal(plan.inventoryActionFor({ from: "Ready", to: "Completed" }), "consume");
});

test("default deduction: cancelling before cooking releases the reservation, never restocks", () => {
  assert.equal(plan.inventoryActionFor({ from: "Pending", to: "Cancelled" }), "release");
  assert.equal(plan.inventoryActionFor({ from: "Accepted", to: "Cancelled" }), "release");
  assert.equal(plan.inventoryActionFor({ from: "Pending", to: "Rejected" }), "release");
});

test("default deduction: cancelling after cooking starts restores nothing automatically", () => {
  assert.equal(plan.inventoryActionFor({ from: "Preparing", to: "Cancelled" }), null);
  assert.equal(plan.inventoryActionFor({ from: "Ready", to: "Cancelled" }), null);
});

test("deduct at accepted: accepting consumes, and cancelling straight after restocks", () => {
  const d = "accepted";
  assert.equal(plan.inventoryActionFor({ from: "Pending", to: "Accepted", deductAt: d }), "consume");
  assert.equal(plan.inventoryActionFor({ from: "Accepted", to: "Cancelled", deductAt: d }), "restock");
  assert.equal(plan.inventoryActionFor({ from: "Accepted", to: "Rejected", deductAt: d }), "restock");
});

test("deduct at accepted: a pending cancel still releases, since nothing was deducted", () => {
  assert.equal(plan.inventoryActionFor({ from: "Pending", to: "Cancelled", deductAt: "accepted" }), "release");
});

test("deduct at accepted: cancelling after cooking starts restores nothing automatically", () => {
  assert.equal(plan.inventoryActionFor({ from: "Preparing", to: "Cancelled", deductAt: "accepted" }), null);
});

test("transitions that move nothing for stock return null", () => {
  assert.equal(plan.inventoryActionFor({ from: "Pending", to: "Accepted" }), null);
});
