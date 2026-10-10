/**
 * Pickup slot seats, enforced atomically.
 *
 * Each slot has a counter (PickupSlotCount). A seat is taken with a conditional
 * update, `count < capacity`, so two students cannot both take the last seat.
 * An order records whether it holds a seat (`pickupSeatHeld`), and a seat is
 * released only by the request that flips that flag. A cancellation therefore
 * frees exactly one seat, however many times it is retried.
 *
 * Orders written before this feature have no `pickupSeatHeld` field. They count
 * as holding a seat, and cancelling one releases it.
 */

const config = require("../config");
const Order = require("../models/Order");
const PickupSlotCount = require("../models/PickupSlotCount");
const { seatsRemaining, slotKey } = require("../utils/pickupCapacity");

const ACTIVE = { $nin: ["Cancelled", "Rejected"] };
const HOLDS_SEAT = { $ne: false };

function capacity() {
  return config.canteen.slotCapacity;
}

/** Seats already booked in a slot, counted from orders. Used to seed a new counter. */
async function countFromOrders(at) {
  return Order.countDocuments({ pickupAt: at, pickupSeatHeld: HOLDS_SEAT, status: ACTIVE });
}

async function ensureCounter(at) {
  const key = slotKey(at);
  if (await PickupSlotCount.exists({ _id: key })) return;
  const seed = await countFromOrders(new Date(at));
  try {
    await PickupSlotCount.create({ _id: key, count: seed });
  } catch (err) {
    // Another request created it first; its count is the one to use.
    if (err.code !== 11000) throw err;
  }
}

/**
 * Take one seat in a slot. Resolves true when a seat was taken, false when the
 * slot is full. With capacity 0 (unlimited) it always resolves true and writes
 * nothing.
 */
async function reserveSeat(at) {
  if (!(capacity() > 0)) return true;
  await ensureCounter(at);
  const res = await PickupSlotCount.updateOne(
    { _id: slotKey(at), count: { $lt: capacity() } },
    { $inc: { count: 1 } }
  );
  return res.modifiedCount === 1;
}

/** Give back a seat taken by `reserveSeat` for an order that never got saved. */
async function releaseUnsavedSeat(at) {
  if (!(capacity() > 0) || !at) return;
  await PickupSlotCount.updateOne({ _id: slotKey(at), count: { $gt: 0 } }, { $inc: { count: -1 } }).catch(() => {});
}

/**
 * Give back the seat an order holds, once. Safe to call on every cancel or
 * rejection: only the first call that flips `pickupSeatHeld` releases a seat.
 */
async function releaseOrderSeat(order) {
  if (!order || !order.pickupAt) return false;
  const claim = await Order.updateOne(
    { _id: order._id, pickupSeatHeld: HOLDS_SEAT },
    { $set: { pickupSeatHeld: false } }
  );
  if (claim.modifiedCount !== 1) return false;
  await releaseUnsavedSeat(order.pickupAt);
  return true;
}

/**
 * Seats left for many slots at once, as a Map from slot key to a number, or to
 * null for unlimited. A slot with no counter yet is counted from orders, the
 * same way it would be seeded.
 */
async function seatsRemainingFor(dates) {
  const cap = capacity();
  const out = new Map();
  if (!(cap > 0) || dates.length === 0) {
    for (const d of dates) out.set(slotKey(d), null);
    return out;
  }

  const keys = dates.map(slotKey);
  const counters = await PickupSlotCount.find({ _id: { $in: keys } }).lean();
  const counted = new Map(counters.map((c) => [c._id, c.count]));

  const missing = dates.filter((d) => !counted.has(slotKey(d)));
  if (missing.length) {
    const rows = await Order.aggregate([
      { $match: { pickupAt: { $in: missing }, pickupSeatHeld: HOLDS_SEAT, status: ACTIVE } },
      { $group: { _id: "$pickupAt", n: { $sum: 1 } } },
    ]);
    const byTime = new Map(rows.map((r) => [new Date(r._id).toISOString(), r.n]));
    for (const d of missing) counted.set(slotKey(d), byTime.get(slotKey(d)) || 0);
  }

  for (const key of keys) out.set(key, seatsRemaining(cap, counted.get(key) || 0));
  return out;
}

module.exports = {
  reserveSeat,
  releaseUnsavedSeat,
  releaseOrderSeat,
  seatsRemainingFor,
  capacity,
};
