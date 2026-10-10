/**
 * Pickup slot capacity arithmetic. Pure: no database.
 *
 * A capacity of 0 means unlimited, which is how the canteen behaved before
 * capacity existed. The database side (conditional counter updates) lives in
 * services/pickupCapacity.js.
 */

/** Seats left in a slot, or null when the slot is unlimited. */
function seatsRemaining(capacity, count) {
  if (!(capacity > 0)) return null;
  return Math.max(0, capacity - Math.max(0, count || 0));
}

/** True when a limited slot has no seats left. Unlimited slots are never full. */
function isSlotFull(capacity, count) {
  return capacity > 0 && (count || 0) >= capacity;
}

/** Stable key for a slot: its start as an ISO string. */
function slotKey(date) {
  return new Date(date).toISOString();
}

module.exports = { seatsRemaining, isSlotFull, slotKey };
