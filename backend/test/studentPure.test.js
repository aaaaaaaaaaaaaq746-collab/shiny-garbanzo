const { test } = require("node:test");
const assert = require("node:assert/strict");

/** Pure tests: receipts, review rules and order-history filters. No database. */

const { renderReceipt } = require("../utils/receipt");
const reviews = require("../utils/reviews");
const history = require("../utils/orderHistory");

const STUDENT = "64b0000000000000000000aa";
const OTHER = "64b0000000000000000000bb";
const FOOD = "64b0000000000000000000f1";

const order = {
  _id: "64b00000000000000000ee01",
  student: STUDENT,
  date: new Date("2026-10-10T04:00:00Z"),
  status: "Completed",
  items: [
    { food: FOOD, name: "Dosa", price: 60, quantity: 2, addOns: [{ label: "Extra sambar", price: 10 }], specialInstructions: "less oil" },
  ],
  subtotal: 120,
  discount: 12,
  charges: [{ label: "Packaging", amount: 4 }],
  total: 112,
  couponCode: "OFF10",
  paymentStatus: "unpaid",
};

// ------------------------------------------------------------ receipt

test("receipt: lists items, add-ons, notes, discount, charges and total", () => {
  const text = renderReceipt(order, { canteenName: "Test Canteen", utcOffsetMinutes: 330 });
  assert.match(text, /Test Canteen/);
  assert.match(text, /2 x Dosa/);
  assert.match(text, /\+ Extra sambar/);
  assert.match(text, /Note: less oil/);
  assert.match(text, /Discount/);
  assert.match(text, /-₹12\.00/);
  assert.match(text, /Packaging/);
  assert.match(text, /TOTAL\s+₹112\.00/);
  assert.match(text, /Coupon:\s+OFF10/);
});

test("receipt: states the recorded payment status and never claims a payment", () => {
  const text = renderReceipt(order, {});
  assert.match(text, /Payment:\s+unpaid/);
  assert.doesNotMatch(text, /PAID/);
});

test("receipt: shows local (IST) times when given the offset", () => {
  const text = renderReceipt(order, { utcOffsetMinutes: 330 });
  // 04:00 UTC is 09:30 IST.
  assert.match(text, /Placed:\s+2026-10-10 09:30 IST/);
});

test("receipt: an order with no discount, charges or coupon omits those lines", () => {
  const plain = { ...order, discount: 0, charges: [], couponCode: null, total: 120 };
  const text = renderReceipt(plain, {});
  assert.doesNotMatch(text, /Discount/);
  assert.doesNotMatch(text, /Coupon:/);
  assert.match(text, /TOTAL\s+₹120\.00/);
});

// ------------------------------------------------------------ reviews

test("review: owner of a completed order may review an item in it", () => {
  assert.deepEqual(
    reviews.assertCanReview({ order, studentId: STUDENT, foodId: FOOD, alreadyReviewed: false }),
    { ok: true }
  );
});

test("review: another student is refused with 403 before anything else is checked", () => {
  assert.throws(
    () => reviews.assertCanReview({ order, studentId: OTHER, foodId: FOOD, alreadyReviewed: false }),
    (e) => e.statusCode === 403
  );
});

test("review: an order that is not Completed cannot be reviewed yet (409)", () => {
  assert.throws(
    () => reviews.assertCanReview({ order: { ...order, status: "Ready" }, studentId: STUDENT, foodId: FOOD, alreadyReviewed: false }),
    (e) => e.statusCode === 409 && /Completed/.test(e.message)
  );
});

test("review: an item not in the order is a 400; a second review is a 409", () => {
  assert.throws(
    () => reviews.assertCanReview({ order, studentId: STUDENT, foodId: OTHER, alreadyReviewed: false }),
    (e) => e.statusCode === 400
  );
  assert.throws(
    () => reviews.assertCanReview({ order, studentId: STUDENT, foodId: FOOD, alreadyReviewed: true }),
    (e) => e.statusCode === 409
  );
});

test("review: rating must be a whole number 1 to 5; comments are trimmed and bounded", () => {
  assert.equal(reviews.validateRating(5), 5);
  assert.equal(reviews.validateRating("3"), 3);
  for (const bad of [0, 6, 2.5, "abc", null, undefined]) {
    assert.throws(() => reviews.validateRating(bad), (e) => e.statusCode === 400, String(bad));
  }
  assert.equal(reviews.validateComment("  tasty  "), "tasty");
  assert.equal(reviews.validateComment(""), null);
  assert.throws(() => reviews.validateComment("x".repeat(501)), (e) => e.statusCode === 400);
  assert.throws(() => reviews.validateComment(42), (e) => e.statusCode === 400);
});

// ------------------------------------------------------------ order history

test("history: no parameters means the full list, newest first, with no limit", () => {
  const opts = history.parseOrderHistoryQuery({});
  assert.deepEqual(opts, { statuses: null, from: null, to: null, limit: null });
});

test("history: status list is validated and the date range is inclusive of the whole end day", () => {
  const opts = history.parseOrderHistoryQuery({ status: "Completed, Cancelled", from: "2026-10-01", to: "2026-10-10" });
  assert.deepEqual(opts.statuses, ["Completed", "Cancelled"]);
  assert.equal(opts.from.toISOString(), "2026-10-01T00:00:00.000Z");
  assert.equal(opts.to.toISOString(), "2026-10-10T23:59:59.999Z");
});

test("history: invalid status, date, range order or limit are refused", () => {
  assert.throws(() => history.parseOrderHistoryQuery({ status: "Lost" }), (e) => e.statusCode === 400);
  assert.throws(() => history.parseOrderHistoryQuery({ from: "10/10/2026" }), (e) => e.statusCode === 400);
  assert.throws(() => history.parseOrderHistoryQuery({ from: "2026-10-12", to: "2026-10-01" }), /cannot be after/);
  assert.throws(() => history.parseOrderHistoryQuery({ limit: "0" }), (e) => e.statusCode === 400);
  assert.throws(() => history.parseOrderHistoryQuery({ limit: "501" }), (e) => e.statusCode === 400);
  assert.equal(history.parseOrderHistoryQuery({ limit: "20" }).limit, 20);
});

test("history: the filter always pins the student and adds only the requested clauses", () => {
  const filter = history.buildHistoryFilter(STUDENT, history.parseOrderHistoryQuery({ status: "Completed" }));
  assert.equal(filter.student, STUDENT);
  assert.deepEqual(filter.status, { $in: ["Completed"] });
  assert.equal(filter.date, undefined);
});
