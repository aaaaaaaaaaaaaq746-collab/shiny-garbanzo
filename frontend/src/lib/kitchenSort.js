/**
 * Kitchen queue order, as shown on the kitchen display. Pure.
 *
 * The same rule as backend/utils/kitchenPriority.js: rush orders first, then
 * the order due soonest (pickup time, else estimated ready time), then placement
 * time, then id. The server sorts the initial load; the client re-applies this
 * after a live update so a changed order lands in the right place at once.
 */

const RANK = { rush: 0, normal: 1 };

function dueMs(order) {
  for (const value of [order.pickupAt, order.estimatedReadyAt]) {
    if (value) {
      const t = new Date(value).getTime();
      if (Number.isFinite(t)) return t;
    }
  }
  return new Date(order.date).getTime() || 0;
}

export function compareKitchenOrders(a, b) {
  const ra = RANK[a.priority] ?? RANK.normal;
  const rb = RANK[b.priority] ?? RANK.normal;
  if (ra !== rb) return ra - rb;

  const da = dueMs(a);
  const db = dueMs(b);
  if (da !== db) return da - db;

  const pa = new Date(a.date).getTime() || 0;
  const pb = new Date(b.date).getTime() || 0;
  if (pa !== pb) return pa - pb;

  const ia = String(a._id ?? "");
  const ib = String(b._id ?? "");
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

/** A sorted copy of the queue. The input is not changed. */
export function sortKitchenQueue(orders) {
  return [...orders].sort(compareKitchenOrders);
}
