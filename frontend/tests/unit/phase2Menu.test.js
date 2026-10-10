import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyFoodForm, formToMenuPayload, foodToForm, parseVariants, formatVariants } from "../../src/lib/foodForm.js";
import { addToCart, buildCheckoutPayload, lineKeyFor, linesFromOrder, parseStoredCart } from "../../src/lib/cart.js";
import { sortKitchenQueue } from "../../src/lib/kitchenSort.js";
import { servingSummary, isoToLocalInput, localInputToIso } from "../../src/lib/mealPeriods.js";
import { foodQueryParams, DEFAULT_FILTERS } from "../../src/lib/menuFilters.js";

const base = () => ({ ...emptyFoodForm(), name: "Dosa", price: "60" });

test("sizes parse as Label:price pairs and round-trip", () => {
  const sizes = parseVariants("Half:40; Full:60");
  assert.deepEqual(sizes, [
    { label: "Half", price: 40 },
    { label: "Full", price: 60 },
  ]);
  assert.equal(formatVariants(sizes), "Half:40; Full:60");
});

test("a size without a price, a duplicate size and a zero price are refused", () => {
  assert.throws(() => parseVariants("Half"), /needs a price/);
  assert.throws(() => parseVariants("Full:60; full:70"), /Duplicate size/);
  assert.throws(() => parseVariants("Half:0"), /greater than zero/);
});

test("a sale price must be lower than the base price", () => {
  assert.throws(() => formToMenuPayload({ ...base(), salePrice: "60" }), /lower than the price/);
  assert.throws(() => formToMenuPayload({ ...base(), salePrice: "-5" }), /greater than zero/);
  const ok = formToMenuPayload({ ...base(), salePrice: "50" });
  assert.equal(ok.salePrice, 50);
});

test("a sale end time needs a sale price", () => {
  assert.throws(
    () => formToMenuPayload({ ...base(), saleEndsAt: "2026-10-10T18:00" }),
    /Set a sale price/
  );
});

test("a serving window must start before it ends", () => {
  assert.throws(
    () =>
      formToMenuPayload({
        ...base(),
        servesFrom: "2026-10-10T18:00",
        servesUntil: "2026-10-10T09:00",
      }),
    /start must be before/
  );
});

test("the payload sends meal periods, sizes and tags, and clears empty schedule fields", () => {
  const payload = formToMenuPayload({
    ...base(),
    menuPeriods: ["lunch", "dinner"],
    variants: "Half:35; Full:60",
    tags: "spicy, kids",
  });
  assert.deepEqual(payload.menuPeriods, ["lunch", "dinner"]);
  assert.deepEqual(payload.variants, [
    { label: "Half", price: 35 },
    { label: "Full", price: 60 },
  ]);
  assert.deepEqual(payload.tags, ["spicy", "kids"]);
  assert.equal(payload.soldOutUntil, null);
  assert.equal(payload.servesFrom, null);
  assert.equal(payload.salePrice, null);
});

test("an existing item pre-fills the form and converts its schedule to local input", () => {
  const iso = "2026-10-10T04:00:00.000Z";
  const form = foodToForm({
    name: "Tea",
    price: 20,
    salePrice: 15,
    saleEndsAt: iso,
    variants: [{ label: "Small", price: 10 }],
    tags: ["hot"],
    menuPeriods: ["breakfast"],
    soldOutUntil: null,
  });
  assert.equal(form.salePrice, "15");
  assert.equal(form.variants, "Small:10");
  assert.equal(form.tags, "hot");
  assert.deepEqual(form.menuPeriods, ["breakfast"]);
  assert.equal(form.soldOutUntil, "");
  assert.equal(localInputToIso(form.saleEndsAt), iso);
  assert.equal(isoToLocalInput(null), "");
});

test("a size is a separate cart line from the plain item", () => {
  const food = { _id: "f1", name: "Dosa", price: 60, availableQty: undefined };
  const plain = addToCart([], food).cart;
  const half = addToCart(plain, food, { variant: "Half", variantPrice: 40 }).cart;
  assert.equal(half.length, 2);
  assert.equal(half[1].variant, "Half");
  assert.equal(half[1].price, 40);
  assert.equal(half[0].variant, null);
});

test("adding the same size twice merges into one line", () => {
  const food = { _id: "f1", name: "Dosa", price: 60 };
  const once = addToCart([], food, { variant: "Full", variantPrice: 60 }).cart;
  const twice = addToCart(once, food, { variant: "Full", variantPrice: 60 }).cart;
  assert.equal(twice.length, 1);
  assert.equal(twice[0].quantity, 2);
});

test("lines without a size keep the key an older cart stored", () => {
  assert.equal(lineKeyFor("f1", [], ""), JSON.stringify(["f1", [], ""]));
  assert.notEqual(lineKeyFor("f1", [], "", "Half"), lineKeyFor("f1", [], ""));
});

test("checkout sends the size, never a price", () => {
  const cart = [
    { _id: "f1", quantity: 2, addOns: [], specialInstructions: "", variant: "Half", price: 40, lineKey: "k" },
  ];
  const payload = buildCheckoutPayload(cart);
  assert.deepEqual(payload.items, [{ food: "f1", quantity: 2, variant: "Half" }]);
});

test("a stored cart from before sizes existed still loads", () => {
  const lines = parseStoredCart(JSON.stringify([{ _id: "f1", name: "Tea", price: 20, quantity: 1 }]));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].variant, null);
});

test("a reorder keeps the original size", () => {
  const lines = linesFromOrder({
    items: [{ food: "f1", name: "Dosa", basePrice: 40, price: 40, quantity: 1, variant: "Half", addOns: [] }],
  });
  assert.equal(lines[0].variant, "Half");
  assert.equal(lines[0].price, 40);
});

test("the kitchen queue shows rush first, then the order due soonest", () => {
  const q = sortKitchenQueue([
    { _id: "late", priority: "normal", date: "2026-10-10T04:00:00Z", pickupAt: "2026-10-10T07:00:00Z" },
    { _id: "rush", priority: "rush", date: "2026-10-10T04:10:00Z", pickupAt: "2026-10-10T09:00:00Z" },
    { _id: "early", priority: "normal", date: "2026-10-10T04:05:00Z", pickupAt: "2026-10-10T05:00:00Z" },
  ]);
  assert.deepEqual(q.map((o) => o._id), ["rush", "early", "late"]);
});

test("the kitchen sort does not change its input", () => {
  const input = [{ _id: "b" }, { _id: "a", priority: "rush" }];
  sortKitchenQueue(input);
  assert.deepEqual(input.map((o) => o._id), ["b", "a"]);
});

test("servingSummary says all day, or names the periods and window", () => {
  assert.equal(servingSummary({}), "All day");
  assert.equal(servingSummary({ menuPeriods: ["breakfast", "snacks"] }), "Breakfast, Snacks");
});

test("the period filter reaches the query string only when set", () => {
  assert.equal(foodQueryParams(DEFAULT_FILTERS).period, undefined);
  assert.equal(foodQueryParams({ ...DEFAULT_FILTERS, period: "lunch" }).period, "lunch");
});
