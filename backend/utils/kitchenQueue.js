/**
 * Kitchen queue model: when will each active order be ready?
 *
 * Pure: no database and no clock except the `now` argument, so it can be
 * tested without MongoDB.
 *
 * Model. The kitchen works on `parallel` orders at once. Each order occupies
 * one of those working slots from the moment it starts until it is ready, and
 * it holds the slot for its own preparation time.
 *
 *   - An order already in Preparing started at `preparingAt`, so it is ready at
 *     preparingAt + prep. If that moment has passed, it is ready "now".
 *   - Pending and Accepted orders are queued first-come first-served. Each takes
 *     the working slot that frees up earliest, starts when that slot is free,
 *     and is ready prep minutes later.
 *   - Ready, Completed, Cancelled and Rejected orders are not in the queue.
 *
 * This is an estimate, not a promise. It improves on a fixed prep-time guess
 * because it accounts for orders ahead and for orders that are already cooking.
 */

const MIN_MS = 60 * 1000;

const QUEUED = new Set(["Pending", "Accepted"]);
const COOKING = new Set(["Preparing"]);

function indexOfMin(values) {
  let best = 0;
  for (let i = 1; i < values.length; i += 1) {
    if (values[i] < values[best]) best = i;
  }
  return best;
}

/**
 * @param {object} args
 * @param {number} args.now         current time, epoch ms
 * @param {number} args.parallel    orders worked on at once (>= 1)
 * @param {Array<{id: string, status: string, placedAt: number, prepMinutes: number, preparingAt?: number|null}>} args.orders
 * @returns {Map<string, number>}   id -> estimated ready time, epoch ms
 */
function estimateQueue({ now, parallel, orders }) {
  const workers = Math.max(1, Math.floor(parallel) || 1);
  const freeAt = new Array(workers).fill(now);
  const result = new Map();

  // 1. Orders already cooking occupy a working slot until they are ready.
  const cooking = orders
    .filter((o) => COOKING.has(o.status))
    .sort((a, b) => (a.preparingAt ?? now) - (b.preparingAt ?? now) || a.id.localeCompare(b.id));
  for (const order of cooking) {
    const started = order.preparingAt ?? now;
    const readyAt = Math.max(now, started + order.prepMinutes * MIN_MS);
    result.set(order.id, readyAt);
    freeAt[indexOfMin(freeAt)] = readyAt;
  }

  // 2. Queued orders, first come first served.
  const queued = orders
    .filter((o) => QUEUED.has(o.status))
    .sort((a, b) => a.placedAt - b.placedAt || a.id.localeCompare(b.id));
  for (const order of queued) {
    const slot = indexOfMin(freeAt);
    const startAt = Math.max(now, freeAt[slot]);
    const readyAt = startAt + order.prepMinutes * MIN_MS;
    result.set(order.id, readyAt);
    freeAt[slot] = readyAt;
  }

  return result;
}

module.exports = { estimateQueue, MIN_MS };
