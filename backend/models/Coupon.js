const mongoose = require("mongoose");

/**
 * Discount codes (Phase 1 student experience).
 *
 * `usedCount` is incremented with a conditional atomic update when an order
 * claims the coupon, so a limited coupon cannot be over-used by concurrent
 * checkouts.
 */
const CouponSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      minlength: 3,
      maxlength: 40,
    },
    type: { type: String, enum: ["percent", "flat"], required: true },
    value: { type: Number, required: true, min: 0 },
    minSubtotal: { type: Number, min: 0, default: 0 },
    // Upper bound for percentage coupons. Null means no cap.
    maxDiscount: { type: Number, min: 0, default: null },
    active: { type: Boolean, default: true },
    expiresAt: { type: Date, default: null },
    // Total number of successful redemptions allowed. Null means unlimited.
    usageLimit: { type: Number, min: 1, default: null },
    usedCount: { type: Number, min: 0, default: 0 },
  },
  { timestamps: true }
);

CouponSchema.pre("validate", function () {
  if (this.type === "percent" && this.value > 100) {
    this.invalidate("value", "A percentage coupon cannot exceed 100");
  }
});

module.exports = mongoose.model("Coupon", CouponSchema);
