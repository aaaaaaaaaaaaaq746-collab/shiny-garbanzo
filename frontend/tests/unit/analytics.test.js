import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultRange, rangeProblem, barPercents, addDaysToKey, localDayKey, hourLabel } from "../../src/lib/analytics.js";

test("the default range is the last 30 days ending today", () => {
  const r = defaultRange(new Date(2026, 9, 10, 11, 30)); // local 10 Oct 2026
  assert.deepEqual(r, { from: "2026-09-11", to: "2026-10-10" });
});

test("day keys and day arithmetic do not depend on the time of day", () => {
  assert.equal(localDayKey(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
  assert.equal(addDaysToKey("2026-03-01", -1), "2026-02-28");
});

test("a missing, reversed or over-long range is explained", () => {
  assert.match(rangeProblem({ from: "", to: "2026-10-10" }), /both/);
  assert.match(rangeProblem({ from: "2026-10-10", to: "2026-10-01" }), /on or before/);
  assert.match(rangeProblem({ from: "2025-01-01", to: "2026-10-10" }), /at most 366/);
  assert.equal(rangeProblem({ from: "2026-10-01", to: "2026-10-10" }), null);
});

test("bar widths scale to the largest value and zero stays zero", () => {
  assert.deepEqual(barPercents([0, 5, 10]), [0, 50, 100]);
  assert.deepEqual(barPercents([0, 0]), [0, 0]);
});

test("hour labels are two digits", () => {
  assert.equal(hourLabel(9), "09:00");
});
