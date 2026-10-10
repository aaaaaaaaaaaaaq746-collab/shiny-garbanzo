/**
 * Kitchen queue ordering. Pure.
 *
 * Rush orders come first. Within a priority band the order that is due
 * soonest comes first, where "due" is the pickup time for a scheduled order
 * or the estimated ready time for an "as soon as ready" order. Ties fall back
 * to placement time, then to id, so every screen shows the same sequence.
 */

const PRIORITY_RANK = Object.freeze({ rush: 0, normal: 1 });

function dueMs(order) {
  const pickup = order.pickupAt ? new Date(order.pickupAt).getTime() : null;
  if (pickup !== null && Number.isFinite(pickup)) return pickup;
  const ready = order.estimatedReadyAt ? new Date(order.estimatedReadyAt).getTime() : null;
  if (ready !== null && Number.isFinite(ready)) return ready;
  return new Date(order.date).getTime() || 0;
}

function compareKitchenOrders(a, b) {
  const ra = PRIORITY_RANK[a.priority] ?? PRIORITY_RANK.normal;
  const rb = PRIORITY_RANK[b.priority] ?? PRIORITY_RANK.normal;
  if (ra !== rb) return ra - rb;

  const da = dueMs(a);
  const db = dueMs(b);
  if (da !== db) return da - db;

  const pa = new Date(a.date).getTime() || 0;
  const pb = new Date(b.date).getTime() || 0;
  if (pa !== pb) return pa - pb;

  const ia = String(a._id ?? a.id ?? "");
  const ib = String(b._id ?? b.id ?? "");
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

/** A sorted copy of the queue. The input array is not changed. */
function sortKitchenQueue(orders) {
  return [...orders].sort(compareKitchenOrders);
}

module.exports = { PRIORITY_RANK, dueMs, compareKitchenOrders, sortKitchenQueue };
