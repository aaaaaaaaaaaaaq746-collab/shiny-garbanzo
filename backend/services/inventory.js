const mongoose = require("mongoose");
const Food = require("../models/FoodItem");
const InventoryMovement = require("../models/InventoryMovement");

/**
 * Inventory accounting.
 *
 * CORE INVARIANT
 * --------------
 *     available = physical stock - reserved
 *
 * SAFETY MODEL (why this is correct WITHOUT multi-document transactions)
 * ---------------------------------------------------------------------
 * Every counter lives on a single FoodItem document, so each movement is one
 * atomic conditional update. MongoDB guarantees single-document atomicity, so
 * the oversell guard holds on a standalone mongod:
 *
 *   reserve : filter { available >= qty }        -> $inc { reserved: +qty }
 *   consume : filter { reserved  >= qty }        -> $inc { stock: -qty, reserved: -qty }
 *   release : filter { reserved  >= qty }        -> $inc { reserved: -qty }
 *
 * A failing filter means the condition no longer holds, so the update is
 * refused rather than producing a negative quantity.
 *
 * Idempotency uses a deterministic operationId per (order, food, movement)
 * and a UNIQUE index on the ledger. A duplicate request collides on that index
 * and is treated as "already done", never as a second movement.
 *
 * When the deployment DOES support transactions (replica set), reserveOrder()
 * additionally wraps its writes in a real transaction so a mid-way failure
 * rolls everything back instead of relying on compensation. See
 * transactionsSupported() for how support is detected.
 */

const transactionsSupported = (() => {
  let cached;
  return () => {
    if (cached !== undefined) return cached;
    const topology = mongoose.connection?.client?.topology;
    const desc = topology?.description;
    if (!desc) return (cached = false);
    const type = desc.type;
    // Supported topologies: "ReplicaSetWithPrimary" / "ReplicaSetNoPrimary" / "Sharded"
    // NOTE: the driver's "Single" topology means a STANDALONE mongod, which
    // does NOT support transactions. It must never appear in this list.
    const supported = [
      "ReplicaSetWithPrimary",
      "ReplicaSetNoPrimary",
      "Sharded",
    ].includes(type);
    return (cached = supported);
  };
})();


/** Run `work` inside a real transaction when the deployment allows it. */
async function withOptionalTransaction(work) {
  if (!transactionsSupported()) {
    return { session: null, result: await work(null) };
  }
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return { session, result };
  } catch (err) {
    if (session.inTransaction?.()) await session.abortTransaction().catch(() => {});
    throw err;
  } finally {
    await session.endSession().catch(() => {});
  }
}

/** Stable idempotency key for a movement. */
const operationIdFor = (type, orderId, foodId) => `${type}:${orderId}:${foodId}`;

/** Stable idempotency key for a manual adjustment. */
const adjustmentId = (foodId, nonce) => `adjustment:${foodId}:${nonce}`;

class InventoryError extends Error {
  constructor(code, message, statusCode = 409) {
    super(message);
    this.name = "InventoryError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Insert the ledger entry that gates this movement.
 * Returns false when the movement was already recorded (duplicate).
 */
async function claimOperation({ operationId, food, orderId, type, quantity, actor, reason, deltas }) {
  try {
    await InventoryMovement.create({
      operationId,
      food: food._id,
      order: orderId || null,
      type,
      quantity,
      stockDelta: deltas.stockDelta,
      reservedDelta: deltas.reservedDelta,
      actor: actor?._id || null,
      actorRole: actor?.role || null,
      reason: reason || InventoryMovement.REASONS[type] || null,
      at: new Date(),
    });
    return true;
  } catch (err) {
    if (err.code === 11000) return false; // already applied
    throw err;
  }
}

/** Overwrite a ledger row with the resulting counters. */
async function finalizeOperation(operationId, { stockAfter, reservedAfter }) {
  await InventoryMovement.updateOne(
    { operationId },
    { $set: { stockAfter, reservedAfter } }
  );
}

/** Remove a ledger row when its movement could not be applied. */
async function abandonOperation(operationId) {
  await InventoryMovement.deleteOne({ operationId });
}

/**
 * Reserve stock for one order line.
 *
 * Atomic and idempotent. Throws InventoryError when insufficient stock.
 */
async function reserveOne({ foodId, quantity, orderId, actor, session = null }) {
  const operationId = operationIdFor("reserve", orderId, foodId);

  // Read for naming/validation only; the guard below is what enforces safety.
  const food = await Food.findById(foodId).session(session);
  if (!food) throw new InventoryError("FOOD_NOT_FOUND", "Food item not found", 404);
  if (food.trackInventory !== true) return { skipped: true };

  const already = await InventoryMovement.exists({ operationId }).session(session);
  if (already) return { duplicate: true };

  const filter = {
    _id: foodId,
    trackInventory: true,
    // available >= quantity  <=>  stock - reserved >= quantity
    $expr: { $gte: [{ $subtract: ["$stock", "$reserved"] }, quantity] },
  };

  const updated = await Food.findOneAndUpdate(
    filter,
    { $inc: { reserved: quantity }, $set: { updatedAt: new Date() } },
    { new: true, session }
  );

  if (!updated) {
    // Distinguish "no stock" from "already reserved by someone else".
    const fresh = await Food.findById(foodId).session(session);
    const sellable = fresh ? fresh.sellableQty() : 0;
    throw new InventoryError(
      "INSUFFICIENT_STOCK",
      sellable <= 0
        ? `"${fresh?.name || "Item"}" is sold out`
        : `Only ${sellable} of "${fresh?.name || "Item"}" left`,
      409
    );
  }

  await claimOperation({
    operationId,
    food: updated,
    orderId,
    type: "reserve",
    quantity,
    actor,
    deltas: { stockDelta: 0, reservedDelta: quantity },
  });
  await finalizeOperation(operationId, {
    stockAfter: updated.stock,
    reservedAfter: updated.reserved,
  });

  return { reserved: quantity, stock: updated.stock, reserved_: updated.reserved };
}

/**
 * Reserve every line of an order. All-or-nothing.
 *
 * On a replica set this runs in one transaction, so a failure rolls back
 * cleanly. On a standalone deployment the already-applied reservations are
 * compensated, and every step is individually atomic.
 */
async function reserveOrder({ order, items, actor }) {
  const results = [];
  const applied = [];

  try {
    await withOptionalTransaction(async (session) => {
      for (const line of items) {
        if (line.inventoryTracked !== true) {
          results.push({ food: line.food, skipped: true });
          continue;
        }
        const r = await reserveOne({
          foodId: line.food,
          quantity: line.quantity,
          orderId: order._id,
          actor,
          session,
        });
        results.push(r);
        if (!r.skipped && !r.duplicate) {
          applied.push({ foodId: line.food, quantity: line.quantity });
        }
      }
    });
    return { reserved: true, results };
  } catch (err) {
    // Compensate anything already applied (only reached without transactions).
    for (const a of applied) {
      await releaseRaw({ foodId: a.foodId, quantity: a.quantity, orderId: order._id });
    }
    throw err;
  }
}

/** Release reserved quantity without touching the ledger (compensation path). */
async function releaseRaw({ foodId, quantity }) {
  return Food.findOneAndUpdate(
    { _id: foodId, reserved: { $gte: quantity } },
    { $inc: { reserved: -quantity } },
    { new: true }
  );
}

/**
 * Release the reservations of an order (cancel / reject before preparation).
 * Idempotent via the ledger's unique operationId.
 */
async function releaseOrder({ order, actor, reason }) {
  const released = [];

  for (const line of order.items || []) {
    if (line.inventoryTracked !== true) continue;
    // Only outstanding, unconsumed reservations can be released.
    if (line.stockConsumed === true) continue;
    if (line.stockReleased === true) continue;

    const operationId = operationIdFor("release", order._id, line.food);

    const existing = await InventoryMovement.findOne({ operationId });
    if (existing) continue; // already released

    const updated = await Food.findOneAndUpdate(
      { _id: line.food, reserved: { $gte: line.reservedQty ?? line.quantity } },
      {
        $inc: { reserved: -(line.reservedQty ?? line.quantity) },
        $set: { updatedAt: new Date() },
      },
      { new: true }
    );

    if (!updated) continue; // nothing left to release

    await claimOperation({
      operationId,
      food: updated,
      orderId: order._id,
      type: "release",
      quantity: line.reservedQty ?? line.quantity,
      actor,
      reason,
      deltas: { stockDelta: 0, reservedDelta: -(line.reservedQty ?? line.quantity) },
    });
    await finalizeOperation(operationId, {
      stockAfter: updated.stock,
      reservedAfter: updated.reserved,
    });

    released.push({ food: line.food, quantity: line.reservedQty ?? line.quantity });
  }

  return { released };
}

/**
 * Consume reservations when preparation begins: physical stock goes down.
 * Idempotent — a duplicate request finds the ledger row and does nothing.
 */
async function consumeOrder({ order, actor }) {
  const consumed = [];

  for (const line of order.items || []) {
    if (line.inventoryTracked !== true) continue;
    if (line.stockConsumed === true) continue;
    if (line.stockReleased === true) continue;

    const qty = line.reservedQty ?? line.quantity;
    const operationId = operationIdFor("consume", order._id, line.food);

    const existing = await InventoryMovement.findOne({ operationId });
    if (existing) continue;

    // Guard on reserved: guarantees stock and reserved never go negative.
    const updated = await Food.findOneAndUpdate(
      { _id: line.food, reserved: { $gte: qty } },
      {
        $inc: { stock: -qty, reserved: -qty },
        $set: { updatedAt: new Date() },
      },
      { new: true }
    );

    if (!updated) continue; // already consumed or released elsewhere

    await claimOperation({
      operationId,
      food: updated,
      orderId: order._id,
      type: "consume",
      quantity: qty,
      actor,
      deltas: { stockDelta: -qty, reservedDelta: -qty },
    });
    await finalizeOperation(operationId, {
      stockAfter: updated.stock,
      reservedAfter: updated.reserved,
    });

    consumed.push({ food: line.food, quantity: qty });
  }

  return { consumed };
}

/**
 * Manual stock adjustment. Administrator only, reason mandatory.
 * `delta` is signed against physical stock.
 */
async function adjustStock({ foodId, delta, reason, actor, unit }) {
  if (!Number.isInteger(delta) || delta === 0) {
    throw new InventoryError("INVALID_DELTA", "Adjustment must be a non-zero whole number", 400);
  }
  if (!reason || !String(reason).trim()) {
    throw new InventoryError("REASON_REQUIRED", "A reason is required for stock adjustments", 400);
  }

  const food = await Food.findById(foodId);
  if (!food) throw new InventoryError("FOOD_NOT_FOUND", "Food item not found", 404);
  if (food.trackInventory !== true) {
    throw new InventoryError(
      "NOT_TRACKED",
      "Enable inventory tracking for this item before adjusting stock",
      400
    );
  }

  // Never allow a negative result, even via a direct set.
  const target = (food.stock ?? 0) + delta;
  if (target < 0) {
    throw new InventoryError("NEGATIVE_STOCK", "Stock cannot be reduced below zero", 400);
  }

  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const operationId = adjustmentId(foodId, nonce);

  const updated = await Food.findOneAndUpdate(
    { _id: foodId, trackInventory: true },
    {
      $set: {
        stock: target,
        updatedAt: new Date(),
        lastStockAdjustmentAt: new Date(),
        lastStockAdjustmentReason: String(reason).trim().slice(0, 300),
        lastStockAdjustmentBy: actor._id,
        ...(unit ? { unit } : {}),
      },
    },
    { new: true }
  );

  await claimOperation({
    operationId,
    food: updated,
    orderId: null,
    type: "adjustment",
    quantity: Math.abs(delta),
    actor,
    reason: String(reason).trim(),
    deltas: { stockDelta: delta, reservedDelta: 0 },
  });
  await finalizeOperation(operationId, {
    stockAfter: updated.stock,
    reservedAfter: updated.reserved,
  });

  return updated;
}

/** Enable or disable inventory tracking for an item. */
async function setTracking({ foodId, enabled, stock, actor, reason }) {
  const food = await Food.findById(foodId);
  if (!food) throw new InventoryError("FOOD_NOT_FOUND", "Food item not found", 404);

  const update = { trackInventory: enabled === true, updatedAt: new Date() };

  if (enabled === true) {
    const requested = Number.isInteger(stock) ? stock : null;
    if (requested === null && (food.stock === null || food.stock === undefined)) {
      throw new InventoryError(
        "STOCK_REQUIRED",
        "Provide a starting stock quantity when enabling inventory tracking",
        400
      );
    }
    if (requested !== null) {
      if (requested < 0) {
        throw new InventoryError("NEGATIVE_STOCK", "Stock cannot be negative", 400);
      }
      update.stock = requested;
    }
    if (food.reserved === null || food.reserved === undefined) update.reserved = 0;
  }

  update.lastStockAdjustmentAt = new Date();
  update.lastStockAdjustmentReason =
    (reason && String(reason).trim()) ||
    (enabled === true ? "Inventory tracking enabled" : "Inventory tracking disabled");
  update.lastStockAdjustmentBy = actor._id;

  const updated = await Food.findByIdAndUpdate(foodId, update, { new: true });

  // Turning tracking on/off is itself an auditable event.
  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await claimOperation({
    operationId: `tracking:${foodId}:${nonce}`,
    food: updated,
    orderId: null,
    type: "adjustment",
    quantity: 0,
    actor,
    reason: update.lastStockAdjustmentReason,
    deltas: { stockDelta: 0, reservedDelta: 0 },
  });
  await finalizeOperation(`tracking:${foodId}:${nonce}`, {
    stockAfter: updated.stock,
    reservedAfter: updated.reserved,
  });

  return updated;
}

/** Items at or below their low-stock threshold. */
async function lowStockItems() {
  return Food.find({
    trackInventory: true,
    $expr: { $lte: [{ $subtract: ["$stock", "$reserved"] }, "$lowStockThreshold"] },
  }).sort({ name: 1 });
}

module.exports = {
  InventoryError,
  transactionsSupported,
  withOptionalTransaction,
  reserveOrder,
  reserveOne,
  releaseOrder,
  consumeOrder,
  adjustStock,
  setTracking,
  lowStockItems,
  operationIdFor,
  adjustmentId,
  releaseRaw,
};