/**
 * Order-history filter state and its query parameters for GET /api/orders.
 * Pure, so the mapping can be unit-tested.
 */

export const HISTORY_STATUSES = [
  "Pending",
  "Accepted",
  "Preparing",
  "Ready",
  "Completed",
  "Cancelled",
  "Rejected",
];

export const DEFAULT_HISTORY = Object.freeze({ status: "", from: "", to: "" });

/** Empty fields are left out so the server applies no filter for them. */
export function historyQueryParams(f) {
  const params = {};
  if (f.status) params.status = f.status;
  if (f.from) params.from = f.from;
  if (f.to) params.to = f.to;
  return params;
}

/** True when the two dates are in order (or either is unset). */
export function datesInOrder(from, to) {
  if (!from || !to) return true;
  return from <= to;
}
