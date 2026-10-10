import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_FILTERS, applyClientFilters, foodQueryParams } from "../../src/lib/menuFilters.js";
import { DEFAULT_HISTORY, datesInOrder, historyQueryParams } from "../../src/lib/orderHistory.js";
import { minutesUntil, waitLabel } from "../../src/lib/orderView.js";

test("foodQueryParams: default filters send no parameters (the menu is the full list)", () => {
  assert.deepEqual(foodQueryParams(DEFAULT_FILTERS), {});
});

test("foodQueryParams: trims search and maps each filter to the API parameter name", () => {
  const params = foodQueryParams({
    ...DEFAULT_FILTERS,
    search: "  dosa ",
    category: "South",
    veg: "veg",
    minPrice: "10",
    maxPrice: "0",
    sort: "rating",
    available: true,
    featured: true,
  });
  assert.deepEqual(params, {
    search: "dosa",
    category: "South",
    veg: "veg",
    minPrice: "10",
    maxPrice: "0",
    sort: "rating",
    available: "true",
    featured: "true",
  });
});

test("foodQueryParams: a price of 0 is a real bound, not an empty one", () => {
  assert.equal(foodQueryParams({ ...DEFAULT_FILTERS, maxPrice: "0" }).maxPrice, "0");
});

test("applyClientFilters: favourites-only narrows the list; otherwise it is untouched", () => {
  const foods = [{ _id: "a" }, { _id: "b" }, { _id: "c" }];
  assert.equal(applyClientFilters(foods, DEFAULT_FILTERS, ["a"]), foods);
  assert.deepEqual(
    applyClientFilters(foods, { ...DEFAULT_FILTERS, favoritesOnly: true }, ["a", "c"]).map((f) => f._id),
    ["a", "c"]
  );
});

test("historyQueryParams: empty fields are omitted so the server applies no filter", () => {
  assert.deepEqual(historyQueryParams(DEFAULT_HISTORY), {});
  assert.deepEqual(historyQueryParams({ status: "Completed", from: "2026-10-01", to: "" }), {
    status: "Completed",
    from: "2026-10-01",
  });
});

test("datesInOrder: an inverted range is flagged; a missing bound is fine", () => {
  assert.equal(datesInOrder("2026-10-01", "2026-10-10"), true);
  assert.equal(datesInOrder("2026-10-12", "2026-10-01"), false);
  assert.equal(datesInOrder("", "2026-10-01"), true);
});

test("minutesUntil and waitLabel: count down to the estimate, then say it is due", () => {
  const now = Date.parse("2026-10-10T04:05:00Z");
  const est = "2026-10-10T04:20:00.000Z";
  assert.equal(minutesUntil(est, now), 15);
  assert.equal(minutesUntil(null, now), null);
  assert.equal(waitLabel({ status: "Preparing", estimatedReadyAt: est }, now), "About 15 min left");
  assert.equal(waitLabel({ status: "Preparing", estimatedReadyAt: est }, Date.parse("2026-10-10T04:30:00Z")), "Should be ready any moment");
});

test("waitLabel: closed orders and orders without an estimate show no wait", () => {
  const now = Date.now();
  assert.equal(waitLabel({ status: "Completed", estimatedReadyAt: new Date(now + 60000).toISOString() }, now), null);
  assert.equal(waitLabel({ status: "Pending", estimatedReadyAt: null }, now), null);
});
