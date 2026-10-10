import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addToCart,
  buildCheckoutPayload,
  changeQuantity,
  clearCart,
  formatMoney,
  foodIdsInCart,
  lineKeyFor,
  linesFromOrder,
  mergeIntoCart,
  parseStoredCart,
  previewTotals,
  quantityOfFood,
  removeLine,
  MAX_QTY_PER_LINE,
} from "../../src/lib/cart.js";

const dosa = { _id: "f1", name: "Dosa", price: 50, addOns: [{ label: "Extra chutney", price: 5 }] };
const tea = { _id: "f2", name: "Tea", price: 10 };

test("lineKeyFor: order of add-ons does not change the line identity", () => {
  assert.equal(lineKeyFor("f1", ["B", "A"], ""), lineKeyFor("f1", ["A", "B"], ""));
  assert.notEqual(lineKeyFor("f1", ["A"], ""), lineKeyFor("f1", ["A"], "no onion"));
});

test("addToCart: adds a new line, then merges the same item with the same options", () => {
  let cart = addToCart([], dosa).cart;
  cart = addToCart(cart, dosa).cart;
  assert.equal(cart.length, 1);
  assert.equal(cart[0].quantity, 2);
});

test("addToCart: different add-on choices become separate lines of the same item", () => {
  let cart = addToCart([], dosa).cart;
  cart = addToCart(cart, dosa, { addOns: [{ label: "Extra chutney", price: 5 }] }).cart;
  assert.equal(cart.length, 2);
  assert.equal(quantityOfFood(cart, "f1"), 2);
});

test("addToCart: the advisory stock ceiling counts the item across all its lines", () => {
  const scarce = { ...dosa, availableQty: 2 };
  let cart = addToCart([], scarce).cart;
  // A different option set is a different line, but it still draws on the same stock.
  const second = addToCart(cart, scarce, { addOns: [{ label: "Extra chutney", price: 5 }], quantity: 2 });
  assert.match(second.error, /Only 2/);
  assert.equal(second.cart, cart, "cart is returned unchanged on error");
});

test("addToCart: per-line maximum is enforced", () => {
  const { cart: full } = addToCart([], tea, { quantity: MAX_QTY_PER_LINE });
  const over = addToCart(full, tea);
  assert.match(over.error, /at most/);
  assert.equal(over.cart[0].quantity, MAX_QTY_PER_LINE);
});

test("changeQuantity: a line reaching zero is removed", () => {
  let cart = addToCart([], tea).cart;
  cart = changeQuantity(cart, cart[0].lineKey, -1);
  assert.deepEqual(cart, []);
});

test("changeQuantity: does not exceed the per-line maximum", () => {
  let cart = addToCart([], tea, { quantity: MAX_QTY_PER_LINE - 1 }).cart;
  cart = changeQuantity(cart, cart[0].lineKey, 5);
  assert.equal(cart[0].quantity, MAX_QTY_PER_LINE);
});

test("removeLine and clearCart", () => {
  let cart = addToCart([], dosa).cart;
  cart = addToCart(cart, tea).cart;
  cart = removeLine(cart, cart[0].lineKey);
  assert.equal(cart.length, 1);
  assert.deepEqual(clearCart(), []);
});

test("previewTotals: includes add-on prices per unit", () => {
  const chutney = [{ label: "Extra chutney", price: 5 }];
  let cart = addToCart([], dosa, { addOns: chutney, quantity: 2 }).cart;
  cart = addToCart(cart, tea).cart;
  // (50 + 5) x 2 for the dosa, plus 10 for the tea.
  assert.deepEqual(previewTotals(cart), { subtotal: 120, itemCount: 3 });
});

test("buildCheckoutPayload: sends ids, quantities, labels and notes, never prices", () => {
  let cart = addToCart([], dosa, {
    addOns: [{ label: "Extra chutney", price: 999 }],
    specialInstructions: "  less oil ",
  }).cart;
  const body = buildCheckoutPayload(cart, { pickupAt: "2026-10-10T05:00:00.000Z", couponCode: "OFF10" });
  assert.deepEqual(body, {
    items: [{ food: "f1", quantity: 1, addOns: ["Extra chutney"], specialInstructions: "less oil" }],
    pickupAt: "2026-10-10T05:00:00.000Z",
    couponCode: "OFF10",
  });
  assert.equal(JSON.stringify(body).includes("999"), false);
});

test("buildCheckoutPayload: plain lines carry only food and quantity", () => {
  const cart = addToCart([], tea).cart;
  assert.deepEqual(buildCheckoutPayload(cart), { items: [{ food: "f2", quantity: 1 }] });
});

test("parseStoredCart: upgrades an old cart without lineKey or add-ons", () => {
  const old = JSON.stringify([{ _id: "f1", name: "Dosa", price: 50, quantity: 2, available: true, stock: null }]);
  const cart = parseStoredCart(old);
  assert.equal(cart.length, 1);
  assert.equal(cart[0].quantity, 2);
  assert.deepEqual(cart[0].addOns, []);
  assert.ok(cart[0].lineKey);
});

test("parseStoredCart: drops malformed entries and survives bad JSON", () => {
  assert.deepEqual(parseStoredCart("{not json"), []);
  assert.deepEqual(parseStoredCart(JSON.stringify({ a: 1 })), []);
  const cart = parseStoredCart(JSON.stringify([null, { name: "x" }, { _id: "f2", name: "Tea", price: 10, quantity: 999 }]));
  assert.equal(cart.length, 1);
  assert.equal(cart[0].quantity, MAX_QTY_PER_LINE);
});

test("parseStoredCart: merges duplicate lines written by an older build", () => {
  const raw = JSON.stringify([
    { _id: "f2", name: "Tea", price: 10, quantity: 1 },
    { _id: "f2", name: "Tea", price: 10, quantity: 2 },
  ]);
  const cart = parseStoredCart(raw);
  assert.equal(cart.length, 1);
  assert.equal(cart[0].quantity, 3);
});

test("linesFromOrder + mergeIntoCart: reorder keeps options and merges with the cart", () => {
  const order = {
    items: [
      { food: "f1", name: "Dosa", price: 55, basePrice: 50, quantity: 2, addOns: [{ label: "Extra chutney", price: 5 }] },
      { food: { _id: "f2" }, name: "Tea", price: 10, quantity: 1, addOns: [] },
    ],
  };
  const lines = linesFromOrder(order);
  assert.equal(lines[0].price, 50, "base price is used so add-ons are not double counted");
  const cart = mergeIntoCart(addToCart([], tea).cart, lines);
  assert.equal(quantityOfFood(cart, "f2"), 2, "tea from the cart and the reorder merge into one line");
  assert.equal(cart.length, 2);
});

test("foodIdsInCart: distinct and sorted", () => {
  let cart = addToCart([], tea).cart;
  cart = addToCart(cart, dosa).cart;
  cart = addToCart(cart, tea, { specialInstructions: "extra hot" }).cart;
  assert.deepEqual(foodIdsInCart(cart), ["f1", "f2"]);
});

test("formatMoney: whole rupees print without decimals", () => {
  assert.equal(formatMoney(120), "₹120");
  assert.equal(formatMoney(4.95), "₹4.95");
  assert.equal(formatMoney(undefined), "₹0");
});
