const mongoose = require("mongoose");

/**
 * Inventory Movement Ledger.
 *
 * Append-only record of every stock movement. The unique `operationId` is the
 * idempotency gate: a retried request, a repeated cancellation or a duplicate
 * real-time event cannot create a second movement, because the duplicate key
 * is rejected by the database rather than by application timing.
 *
 * No quantity is ever changed without a corresponding ledger entry.
 */

const MOVEMENT_TYPES = [
  "reserve", // order placed: quantity committed
  "release", // order cancelled/rejected before prep: commitment returned
  "consume", // preparation started: physical stock decremented
  "adjustment", // manual admin correction
];

const REASONS = {
  reserve: "Order placed",
  release: "Order cancelled or rejected",
  consume: "Preparation started",
};

const movementSchema = new mongoose.Schema(
  {
    // Idempotency key. Unique across the whole collection.
    operationId: { type: String, required: true, unique: true, immutable: true },

    food: { type: mongoose.Schema.Types.ObjectId, ref: "FoodItem", required: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null },

    type: { type: String, enum: MOVEMENT_TYPES, required: true },

    // Signed effect on each counter, so the ledger fully explains the numbers.
    quantity: { type: Number, required: true },
    stockDelta: { type: Number, required: true, default: 0 },
    reservedDelta: { type: Number, required: true, default: 0 },

    // Resulting counters, for auditing without re-deriving history.
    stockAfter: { type: Number, default: null },
    reservedAfter: { type: Number, default: null },

    actor: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    actorRole: { type: String, default: null },
    reason: { type: String, default: null, maxlength: 300 },

    at: { type: Date, default: Date.now, immutable: true },
  },
  { timestamps: false }
);

// Common admin query: history for one item, newest first.
movementSchema.index({ food: 1, at: -1 });
movementSchema.index({ order: 1, at: -1 });
movementSchema.index({ type: 1, at: -1 });

const InventoryMovement = mongoose.model("InventoryMovement", movementSchema);

module.exports = InventoryMovement;
module.exports.MOVEMENT_TYPES = MOVEMENT_TYPES;
module.exports.REASONS = REASONS;