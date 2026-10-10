const { test } = require("node:test");
const assert = require("node:assert/strict");

/** Pure tests: menu query parsing and item badges. No database. */

const discovery = require("../utils/discovery");

test("parseFoodQuery: empty query gives no filter and the original default order", () => {
  const { filter, sort } = discovery.parseFoodQuery({});
  assert.deepEqual(filter, {});
  assert.deepEqual(sort, { createdAt: 1 });
});

test("parseFoodQuery: search matches name, description and category, escaping regex characters", () => {
  const { filter } = discovery.parseFoodQuery({ search: "a+b (spicy)" });
  assert.equal(filter.$or.length, 3);
  assert.ok(filter.$or[0].name.test("A+B (SPICY) bowl"));
  assert.ok(!filter.$or[0].name.test("aab spicy")); // the + is literal, not a quantifier
});

test("parseFoodQuery: q is accepted as an alias for search", () => {
  const { filter } = discovery.parseFoodQuery({ q: "tea" });
  assert.ok(filter.$or);
});

test("parseFoodQuery: veg and nonveg map onto dietary groups; egg counts as non-veg", () => {
  assert.deepEqual(discovery.parseFoodQuery({ veg: "veg" }).filter.dietary, { $in: ["veg", "vegan", "jain"] });
  assert.deepEqual(discovery.parseFoodQuery({ veg: "nonveg" }).filter.dietary, { $in: ["non-veg", "egg"] });
  assert.throws(() => discovery.parseFoodQuery({ veg: "maybe" }), (e) => e.statusCode === 400);
});

test("parseFoodQuery: exact dietary value is validated against the known list", () => {
  assert.equal(discovery.parseFoodQuery({ dietary: "vegan" }).filter.dietary, "vegan");
  assert.throws(() => discovery.parseFoodQuery({ dietary: "kosher" }), (e) => e.statusCode === 400);
});

test("parseFoodQuery: price range is numeric, rounded, and ordered", () => {
  const { filter } = discovery.parseFoodQuery({ minPrice: "10", maxPrice: "49.999" });
  assert.deepEqual(filter.price, { $gte: 10, $lte: 50 });
  assert.throws(() => discovery.parseFoodQuery({ minPrice: "60", maxPrice: "10" }), /cannot be greater/);
  assert.throws(() => discovery.parseFoodQuery({ minPrice: "-1" }), (e) => e.statusCode === 400);
  assert.throws(() => discovery.parseFoodQuery({ maxPrice: "abc" }), (e) => e.statusCode === 400);
});

test("parseFoodQuery: availability and featured filters", () => {
  assert.equal(discovery.parseFoodQuery({ available: "true" }).filter.available, true);
  assert.equal(discovery.parseFoodQuery({ featured: "true" }).filter.featured, true);
  assert.equal(discovery.parseFoodQuery({ featured: "false" }).filter.featured, undefined);
});

test("parseFoodQuery: every documented sort is accepted; unknown sorts are a 400", () => {
  for (const key of ["name", "name_desc", "price_asc", "price_desc", "newest", "popularity", "rating"]) {
    assert.ok(discovery.parseFoodQuery({ sort: key }).sort, key);
  }
  assert.deepEqual(discovery.parseFoodQuery({ sort: "popularity" }).sort, { orderCount: -1, name: 1 });
  assert.deepEqual(discovery.parseFoodQuery({ sort: "rating" }).sort, { ratingAverage: -1, ratingCount: -1, name: 1 });
  assert.throws(() => discovery.parseFoodQuery({ sort: "__proto__" }), (e) => e.statusCode === 400);
  assert.throws(() => discovery.parseFoodQuery({ sort: "random" }), (e) => e.statusCode === 400);
});

test("bestsellerIdSet: top N by units ordered, never including items with zero orders", () => {
  const ranked = [
    { _id: "a", orderCount: 40 },
    { _id: "b", orderCount: 25 },
    { _id: "c", orderCount: 0 },
    { _id: "d", orderCount: 3 },
  ];
  const ids = discovery.bestsellerIdSet(ranked, 5);
  assert.deepEqual([...ids], ["a", "b", "d"]);
  assert.deepEqual([...discovery.bestsellerIdSet(ranked, 1)], ["a"]);
});

test("badgesFor: new means created within the window; featured comes from the stored flag", () => {
  const now = Date.parse("2026-10-10T00:00:00Z");
  const fresh = { _id: "x", createdAt: new Date(now - 2 * 86400000), featured: true };
  const old = { _id: "y", createdAt: new Date(now - 30 * 86400000) };
  const best = new Set(["x"]);
  assert.deepEqual(discovery.badgesFor(fresh, { bestsellerIds: best, now, newItemDays: 7 }), {
    featured: true,
    bestselling: true,
    isNew: true,
  });
  assert.deepEqual(discovery.badgesFor(old, { bestsellerIds: best, now, newItemDays: 7 }), {
    featured: false,
    bestselling: false,
    isNew: false,
  });
});
