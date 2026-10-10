/**
 * Recalculate estimated ready times for every order still in the kitchen.
 *
 * Called after each change to the queue (placement, status change,
 * cancellation) and on a timer, so waiting times follow the kitchen as it
 * moves. Only orders whose estimate moved by more than a minute are written
 * and announced, so the realtime feed is not flooded.
 */

const config = require("../config");
const Order = require("../models/Order");
const { estimateQueue } = require("../utils/kitchenQueue");
const { emitOrderUpdate } = require("../realtime");

const ACTIVE = ["Pending", "Accepted", "Preparing"];
const MOVED_BY_MS = 60 * 1000;
const DEFAULT_PREP_MINUTES = 15;

/**
 * Returns how many orders had their estimate updated.
 * `now` is injectable for tests.
 */
async function refreshEstimates(now = Date.now()) {
  const docs = await Order.find(
    { status: { $in: ACTIVE } },
    { status: 1, date: 1, prepMinutes: 1, preparingAt: 1, estimatedReadyAt: 1, student: 1 }
  ).lean();

  if (docs.length === 0) return 0;

  const estimates = estimateQueue({
    now,
    parallel: config.kitchen.parallel,
    orders: docs.map((d) => ({
      id: String(d._id),
      status: d.status,
      placedAt: new Date(d.date).getTime(),
      prepMinutes: d.prepMinutes ?? DEFAULT_PREP_MINUTES,
      preparingAt: d.preparingAt ? new Date(d.preparingAt).getTime() : null,
    })),
  });

  const ops = [];
  const changed = [];
  for (const doc of docs) {
    const readyAt = estimates.get(String(doc._id));
    if (readyAt === undefined) continue;
    const previous = doc.estimatedReadyAt ? new Date(doc.estimatedReadyAt).getTime() : null;
    if (previous !== null && Math.abs(previous - readyAt) < MOVED_BY_MS) continue;

    ops.push({
      updateOne: {
        filter: { _id: doc._id },
        update: {
          $set: { estimatedReadyAt: new Date(readyAt), estimateUpdatedAt: new Date(now) },
        },
      },
    });
    changed.push(doc);
  }

  if (ops.length) await Order.bulkWrite(ops, { ordered: false });

  // Same status before and after: this announces a new estimate, not a change
  // of status. Students' dashboards re-read the order when they hear it.
  for (const doc of changed) {
    emitOrderUpdate({
      orderId: doc._id,
      studentId: doc.student,
      status: doc.status,
      previousStatus: doc.status,
      at: new Date(now),
    });
  }

  return changed.length;
}

module.exports = { refreshEstimates };
