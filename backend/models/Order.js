const mongoose = require("mongoose");
const lifecycle = require("../utils/orderLifecycle");

// Order statuses. The original Pending/Preparing/Completed values are
// preserved verbatim so existing documents and admin UI buttons keep working;
// Accepted and Rejected are purely additive. The full transition rules live
// in utils/orderLifecycle.js rather than here.
const ORDER_STATUSES = lifecycle.ORDER_STATUSES;

const orderItemSchema = new mongoose.Schema(
  {
    food: { type: mongoose.Schema.Types.ObjectId, ref: "FoodItem", required: true },
    // Snapshot of the product at purchase time, so historical orders stay
    // accurate even if the menu item is later renamed or repriced.
    name: { type: String, trim: true, maxlength: 120, default: "" },
    price: { type: Number, required: true, min: 0 },
    quantity: {
      type: Number,
      required: true,
      min: 1,
      max: 20,
      validate: {
        validator: Number.isInteger,
        message: "Quantity must be a whole number",
      },
    },

    // ---- Phase 4 inventory state, all defaulted so pre-Phase-4 orders ----
    // ---- remain valid and serialize with these as null/false.          ----
    // Whether this line's food item was stock-managed when the order was placed.
    inventoryTracked: { type: Boolean, default: false },
    // How much was actually committed to stock (may differ from quantity if the
    // item was not tracked at order time).
    reservedQty: { type: Number, default: null, min: 0 },
    stockReserved: { type: Boolean, default: false },
    stockConsumed: { type: Boolean, default: false },
    stockReleased: { type: Boolean, default: false },
  },
  { _id: false }
);

const OrderSchema = new mongoose.Schema({
  student: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  items: {
    type: [orderItemSchema],
    required: true,
    validate: {
      validator: (v) => Array.isArray(v) && v.length > 0,
      message: "Order must contain at least one item",
    },
  },

  // Always computed server-side from database prices.
  total: { type: Number, required: true, min: 0 },

  status: { type: String, enum: ORDER_STATUSES, default: "Pending" },
  date: { type: Date, default: Date.now },

  // ---- Additive fields, all defaulted.
  subtotal: { type: Number, default: 0, min: 0 },
  discount: { type: Number, default: 0, min: 0 },
  // Audit trail. Each successful transition appends one entry.
  //
  // `status` is the NEW status (unchanged meaning, so existing consumers keep
  // working). `from`, `role` and `reason` are additive and optional: entries
  // written before Phase 2 simply have them as null.
  statusHistory: [
    {
      _id: false,
      status: { type: String }, // new status
      from: { type: String, default: null }, // previous status
      at: { type: Date, default: Date.now },
      by: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // actor
      role: { type: String, default: null }, // actor's role at the time
      reason: { type: String, default: null, maxlength: 300 },
    },
  ],
  pickupSlot: { type: String, default: null, trim: true },
  statusHistoryTotal: { type: Number, default: 0, min: 0 },
  statusHistoryTruncated: { type: Boolean, default: false },
  paymentStatus: {
    type: String,
    enum: ["unpaid", "paid", "refunded"],
    default: "unpaid",
  },
  notes: { type: String, default: null, trim: true, maxlength: 300 },
  cancelledAt: { type: Date, default: null },
  estimatedReadyAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
});

OrderSchema.index({ student: 1, date: -1 });
OrderSchema.index({ status: 1, date: -1 });

const Order = mongoose.model("Order", OrderSchema);

module.exports = Order;
module.exports.ORDER_STATUSES = ORDER_STATUSES;