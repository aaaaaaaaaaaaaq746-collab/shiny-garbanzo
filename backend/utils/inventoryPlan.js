/**
 * Which stock step an order transition needs. Pure: no database.
 *
 * Stock is always reserved when the order is placed, so a second order can
 * never take the same units (see services/inventory.js). What is configurable
 * is the point where those units are physically deducted:
 *
 *   INVENTORY_DEDUCT_AT=preparing (default) - deducted when cooking starts
 *   INVENTORY_DEDUCT_AT=accepted            - deducted when the kitchen accepts
 *
 * Cancelling or rejecting returns the stock that is still held:
 *   - before deduction:           the reservation is released
 *   - after deduction, if the order was only Accepted: the units are restocked
 *   - after cooking has started:  nothing is restored automatically; an
 *                                 administrator makes a recorded adjustment
 */

const DEDUCT_POINTS = Object.freeze(["preparing", "accepted"]);

function normalizeDeductAt(value) {
  return DEDUCT_POINTS.includes(value) ? value : "preparing";
}

/** Statuses at which the physical stock has been deducted, for a deduction point. */
function consumedStatuses(deductAt) {
  const base = ["Preparing", "Ready", "Completed"];
  return new Set(normalizeDeductAt(deductAt) === "accepted" ? ["Accepted", ...base] : base);
}

/**
 * "consume", "release", "restock" or null for a transition from -> to.
 * Callers still check each line's own flags, so repeating a step is safe.
 */
function inventoryActionFor({ from, to, deductAt = "preparing" }) {
  const consumed = consumedStatuses(deductAt);
  if (consumed.has(to)) return "consume";

  if (to === "Cancelled" || to === "Rejected") {
    if (!consumed.has(from)) return "release";
    // Deducted at acceptance and cancelled straight after: put the units back.
    if (from === "Accepted") return "restock";
    // Cooking had started: stock is not restored automatically.
    return null;
  }
  return null;
}

module.exports = { DEDUCT_POINTS, normalizeDeductAt, consumedStatuses, inventoryActionFor };
