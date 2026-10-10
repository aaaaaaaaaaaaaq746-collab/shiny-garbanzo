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
 * EVERY COUNTER CHANGE IS CLAIMED FIRST (Phase 2, fix P2-R1)
 * ----------------------------------------------------------
 * Each movement (reserve, release, consume, adjustment, tracking) follows the
 * same order:
 *
 *   1. CLAIM   insert the ledger row. Its `operationId` is unique, so at most
 *              one caller can create it. A duplicate gets E11000 and does
 *              nothing further.
 *   2. APPLY   change the FoodItem counters with a conditional update that
 *              re-checks the guard (e.g. reserved >= quantity).
 *   3. FINALIZE write the resulting counters onto the ledger row.
 *
 * If the guard fails in step 2, the claim is removed (abandon) and the
 * movement is reported as refused. Previously the counters were changed
 * before the claim, so two concurrent callers could both change the counters
 * and only one ledger row survived.
 *
 * TRANSACTIONS
 * ------------
 * On a replica set, reserveOrder() runs all of its claims and counter changes
 * inside one transaction, passing the session to every write, so an abort
 * rolls the ledger back together with the counters. On a standalone server
 * each step is individually atomic, and reserveOrder() compensates the lines
 * it already applied.
 *
 * KNOWN LIMITATION (standalone only)
 * ----------------------------------
 * A process crash between step 1 and step 2 leaves a claim with no counter
 * change. The movement is then never applied, and retries will see it as
 * already done. This is the safe direction (no double application), but it
 * can under-apply. On a replica set the two steps are one transaction, so the
 * window does not exist. Recovery tooling is recorded in PLAN.md.
 */

/**
 * Whether the connected deployment supports multi-document transactions.
 *
 * Read on every call and never cached: called before the connection is
 * established it returns false for that call only, rather than fixing the
 * answer for the life of the process.
 */
function transactionsSupported() {
  const desc = mongoose.connection?.client?.topology?.description;
  if (!desc) return false;
  // The driver's "Single" topology is a STANDALONE mongod, which does not
  // support transactions, so it is deliberately absent from this list.
  return ["ReplicaSetWithPrimary", "ReplicaSetNoPrimary", "Sharded"].includes(desc.type);
}

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
 * STEP 1 — claim a movement by inserting its ledger row.
 *
 * Returns true when this caller created the row (and therefore owns the
 * movement), false when the movement was already claimed. Pass `session` so
 * the claim is rolled back together with the surrounding transaction.
 */
async function claimOperation({
  operationId,
  foodId,
  orderId = null,
  type,
  quantity,
  actor,
  reason,
  deltas,
  session = null,
}) {
  try {
    // A replay must not write at all: a duplicate insert inside a transaction
    // aborts that transaction, and the retry loop then runs until it times out.
    const existing = session
      ? await InventoryMovement.exists({ operationId }).session(session)
      : await InventoryMovement.exists({ operationId });
    if (existing) return false;

    await InventoryMovement.create(
      [
        {
          operationId,
          food: foodId,
          order: orderId || null,
          type,
          quantity,
          stockDelta: deltas.stockDelta,
          reservedDelta: deltas.reservedDelta,
          stockAfter: null,
          reservedAfter: null,
          actor: actor?._id || null,
          actorRole: actor?.role || null,
          reason: reason || InventoryMovement.REASONS[type] || null,
          at: new Date(),
        },
      ],
      session ? { session } : {}
    );
    return true;
  } catch (err) {
    if (err.code === 11000) return false; // already claimed
    throw err;
  }
}

/** Record the resulting counters on a claimed ledger row. */
async function finalizeOperation(operationId, { stockAfter, reservedAfter }, session = null) {
  await InventoryMovement.updateOne(
    { operationId },
    { $set: { stockAfter, reservedAfter } },
    session ? { session } : {}
  );
}

/** Remove a claim whose counter change was refused (nothing was applied). */
async function abandonOperation(operationId, session = null) {
  await InventoryMovement.deleteOne({ operationId }, session ? { session } : {});
}

/**
 * Reserve stock for one order line.
 *
 * Claim first, so a duplicate request cannot change the counters twice.
 * Throws InventoryError when there is insufficient stock.
 */
async function reserveOne({ foodId, quantity, orderId, actor, session = null }) {
  const operationId = operationIdFor("reserve", orderId, foodId);

  // Read for naming/validation only; the guard below is what enforces safety.
  const food = await Food.findById(foodId).session(session);
  if (!food) throw new InventoryError("FOOD_NOT_FOUND", "Food item not found", 404);
  if (food.trackInventory !== true) return { skipped: true };

  const claimed = await claimOperation({
    operationId,
    foodId,
    orderId,
    type: "reserve",
    quantity,
    actor,
    deltas: { stockDelta: 0, reservedDelta: quantity },
    session,
  });
  if (!claimed) return { duplicate: true };

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
    await abandonOperation(operationId, session);
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

  await finalizeOperation(
    operationId,
    { stockAfter: updated.stock, reservedAfter: updated.reserved },
    session
  );

  return { reserved: quantity, stock: updated.stock, reservedAfter: updated.reserved };
}

/**
 * Reserve every line of an order. All-or-nothing.
 *
 * On a replica set this runs in one transaction, so a failure rolls back
 * cleanly. On a standalone deployment the already-applied reservations are
 * compensated, and every step is individually atomic.
 */
async function reserveOrder({ order, items, actor }) {
  // Lines applied so far. Only used on the standalone (non-transactional) path,
  // where each step is already committed and must be compensated by hand.
  let applied = [];

  try {
    const { result } = await withOptionalTransaction(async (session) => {
      // A transaction may re-run this callback after a transient error, so
      // every attempt starts from an empty list.
      applied = [];
      const results = [];
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
      return results;
    });
    return { reserved: true, results: result };
  } catch (err) {
    // With a transaction, the abort already rolled back every line. Compensating
    // here would release stock that was never held, so only the standalone path
    // compensates. Each compensation also withdraws its claim, so the ledger
    // keeps matching the counters.
    if (!transactionsSupported()) {
      for (const a of applied) {
        await releaseRaw({ foodId: a.foodId, quantity: a.quantity });
        await abandonOperation(operationIdFor("reserve", order._id, a.foodId)).catch(() => {});
      }
    }
    throw err;
  }
}

/** Release reserved quantity without a ledger entry (compensation path only). */
async function releaseRaw({ foodId, quantity }) {
  return Food.findOneAndUpdate(
    { _id: foodId, reserved: { $gte: quantity } },
    { $inc: { reserved: -quantity } },
    { new: true }
  );
}

/**
 * Release the reservations of an order (cancel / reject before preparation).
 * Idempotent: each line is claimed before its reservation is returned.
 */
async function releaseOrder({ order, actor, reason }) {
  const released = [];

  for (const line of order.items || []) {
    if (line.inventoryTracked !== true) continue;
    // Only outstanding, unconsumed reservations can be released.
    if (line.stockConsumed === true) continue;
    if (line.stockReleased === true) continue;

    const qty = line.reservedQty ?? line.quantity;
    const operationId = operationIdFor("release", order._id, line.food);

    const claimed = await claimOperation({
      operationId,
      foodId: line.food,
      orderId: order._id,
      type: "release",
      quantity: qty,
      actor,
      reason,
      deltas: { stockDelta: 0, reservedDelta: -qty },
    });
    if (!claimed) continue; // already released (or being released)

    const updated = await Food.findOneAndUpdate(
      { _id: line.food, reserved: { $gte: qty } },
      { $inc: { reserved: -qty }, $set: { updatedAt: new Date() } },
      { new: true }
    );

    if (!updated) {
      // Nothing left to release for this line; withdraw the claim.
      await abandonOperation(operationId);
      continue;
    }

    await finalizeOperation(operationId, {
      stockAfter: updated.stock,
      reservedAfter: updated.reserved,
    });

    released.push({ food: line.food, quantity: qty });
  }

  return { released };
}

/**
 * Consume reservations when preparation begins: physical stock goes down.
 * Idempotent: each line is claimed before the counters change.
 */
async function consumeOrder({ order, actor }) {
  const consumed = [];

  for (const line of order.items || []) {
    if (line.inventoryTracked !== true) continue;
    if (line.stockConsumed === true) continue;
    if (line.stockReleased === true) continue;

    const qty = line.reservedQty ?? line.quantity;
    const operationId = operationIdFor("consume", order._id, line.food);

    const claimed = await claimOperation({
      operationId,
      foodId: line.food,
      orderId: order._id,
      type: "consume",
      quantity: qty,
      actor,
      deltas: { stockDelta: -qty, reservedDelta: -qty },
    });
    if (!claimed) continue;

    // Guard on reserved: guarantees stock and reserved never go negative.
    const updated = await Food.findOneAndUpdate(
      { _id: line.food, reserved: { $gte: qty } },
      {
        $inc: { stock: -qty, reserved: -qty },
        $set: { updatedAt: new Date() },
      },
      { new: true }
    );

    if (!updated) {
      await abandonOperation(operationId);
      continue;
    }

    await finalizeOperation(operationId, {
      stockAfter: updated.stock,
      reservedAfter: updated.reserved,
    });

    consumed.push({ food: line.food, quantity: qty });
  }

  return { consumed };
}

/**
 * Return physical stock for an order that was cancelled or rejected after its
 * units had been deducted. This only happens when INVENTORY_DEDUCT_AT=accepted
 * and the order was cancelled straight from Accepted. Idempotent per line.
 */
async function restockOrder({ order, actor, reason }) {
  const restocked = [];

  for (const line of order.items || []) {
    if (line.inventoryTracked !== true) continue;
    if (line.stockConsumed !== true) continue; // nothing was deducted
    if (line.stockRestocked === true) continue;

    const qty = line.reservedQty ?? line.quantity;
    const operationId = operationIdFor("restock", order._id, line.food);

    const claimed = await claimOperation({
      operationId,
      foodId: line.food,
      orderId: order._id,
      type: "restock",
      quantity: qty,
      actor,
      reason,
      deltas: { stockDelta: qty, reservedDelta: 0 },
    });
    if (!claimed) continue; // already restocked

    const updated = await Food.findOneAndUpdate(
      { _id: line.food },
      { $inc: { stock: qty }, $set: { updatedAt: new Date() } },
      { new: true }
    );

    if (!updated) {
      await abandonOperation(operationId);
      continue;
    }

    await finalizeOperation(operationId, {
      stockAfter: updated.stock,
      reservedAfter: updated.reserved,
    });

    restocked.push({ food: line.food, quantity: qty });
  }

  return { restocked };
}

/**
 * Manual stock adjustment. Administrator only, reason mandatory.
 *
 * Either `delta` (signed change) or `setTo` (absolute target) is given.
 * The change is applied only if stock still equals the value it was computed
 * from, so two concurrent adjustments can never both be computed from the
 * same starting point. The loser receives 409 and nothing is applied.
 */
async function adjustStock({ foodId, delta, setTo, reason, actor, unit }) {
  const isSet = setTo !== undefined && setTo !== null;
  if (!isSet && (!Number.isInteger(delta) || delta === 0)) {
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

  const observed = food.stock ?? null; // value this calculation is based on
  const current = observed ?? 0;
  const actualDelta = isSet ? setTo - current : delta;
  if (actualDelta === 0) {
    throw new InventoryError("NO_CHANGE", "Stock is already at that value", 400);
  }

  // Never allow a negative result, even via a direct set.
  const target = current + actualDelta;
  if (target < 0) {
    throw new InventoryError("NEGATIVE_STOCK", "Stock cannot be reduced below zero", 400);
  }

  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const operationId = adjustmentId(foodId, nonce);
  const cleanReason = String(reason).trim();

  // Claim first, then apply only if stock is unchanged since we read it.
  await claimOperation({
    operationId,
    foodId,
    orderId: null,
    type: "adjustment",
    quantity: Math.abs(actualDelta),
    actor,
    reason: cleanReason,
    deltas: { stockDelta: actualDelta, reservedDelta: 0 },
  });

  const updated = await Food.findOneAndUpdate(
    { _id: foodId, trackInventory: true, stock: observed },
    {
      $set: {
        stock: target,
        updatedAt: new Date(),
        lastStockAdjustmentAt: new Date(),
        lastStockAdjustmentReason: cleanReason.slice(0, 300),
        lastStockAdjustmentBy: actor._id,
        ...(unit ? { unit } : {}),
      },
    },
    { new: true }
  );

  if (!updated) {
    await abandonOperation(operationId);
    throw new InventoryError(
      "CONCURRENT_UPDATE",
      "Stock changed while this adjustment was being saved. Reload and try again.",
      409
    );
  }

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
  const previousStock = food.stock ?? 0;
  let newStock = food.stock ?? null;

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
      newStock = requested;
    }
    if (food.reserved === null || food.reserved === undefined) update.reserved = 0;
  }

  update.lastStockAdjustmentAt = new Date();
  update.lastStockAdjustmentReason =
    (reason && String(reason).trim()) ||
    (enabled === true ? "Inventory tracking enabled" : "Inventory tracking disabled");
  update.lastStockAdjustmentBy = actor._id;

  // Every change to physical stock must be explained by the ledger, so the
  // movement records the difference between the old and new stock figures.
  const stockDelta = enabled === true && newStock !== null ? newStock - previousStock : 0;

  const operationId = `tracking:${foodId}:${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  await claimOperation({
    operationId,
    foodId,
    orderId: null,
    type: "adjustment",
    quantity: Math.abs(stockDelta),
    actor,
    reason: update.lastStockAdjustmentReason,
    deltas: { stockDelta, reservedDelta: 0 },
  });

  const updated = await Food.findByIdAndUpdate(foodId, update, { new: true });

  await finalizeOperation(operationId, {
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
  restockOrder,
  adjustStock,
  setTracking,
  lowStockItems,
  operationIdFor,
  adjustmentId,
  releaseRaw,
};
