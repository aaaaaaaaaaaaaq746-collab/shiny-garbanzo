/**
 * Rules for rating a menu item after an order.
 *
 * Pure functions. The route loads the order and the existing review, then asks
 * these functions whether the review may be stored.
 */

const ApiError = require("./ApiError");

const MAX_COMMENT = 500;

function validateRating(value) {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (!Number.isInteger(n) || n < 1 || n > 5) {
    throw ApiError.badRequest("rating must be a whole number from 1 to 5");
  }
  return n;
}

function validateComment(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw ApiError.badRequest("comment must be text");
  const trimmed = value.trim();
  if (trimmed.length > MAX_COMMENT) {
    throw ApiError.badRequest(`comment must be at most ${MAX_COMMENT} characters`);
  }
  return trimmed || null;
}

/**
 * Decide whether `studentId` may review `foodId` on `order`.
 *
 * Returns { ok: true } or throws ApiError with the HTTP status the caller
 * should see. Order matters: ownership is checked before anything is revealed.
 */
function assertCanReview({ order, studentId, foodId, alreadyReviewed }) {
  if (!order) throw ApiError.notFound("Order not found");
  if (String(order.student) !== String(studentId)) {
    throw ApiError.forbidden("You can only review items from your own orders");
  }
  if (order.status !== "Completed") {
    throw ApiError.conflict("You can review items once the order is Completed");
  }
  const inOrder = (order.items || []).some((i) => String(i.food) === String(foodId));
  if (!inOrder) {
    throw ApiError.badRequest("That item is not part of this order");
  }
  if (alreadyReviewed) {
    throw ApiError.conflict("You have already reviewed this item for this order");
  }
  return { ok: true };
}

module.exports = { validateRating, validateComment, assertCanReview, MAX_COMMENT };
