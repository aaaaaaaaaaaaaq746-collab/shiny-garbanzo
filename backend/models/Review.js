const mongoose = require("mongoose");

/**
 * A student's rating of one menu item from one completed order.
 *
 * The unique (order, food) index means an item can be reviewed once per order,
 * enforced by the database even if two requests race.
 */
const ReviewSchema = new mongoose.Schema(
  {
    order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true },
    food: { type: mongoose.Schema.Types.ObjectId, ref: "FoodItem", required: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    rating: { type: Number, required: true, min: 1, max: 5, validate: Number.isInteger },
    comment: { type: String, trim: true, maxlength: 500, default: null },
  },
  { timestamps: true }
);

ReviewSchema.index({ order: 1, food: 1 }, { unique: true });
ReviewSchema.index({ food: 1, createdAt: -1 });
ReviewSchema.index({ student: 1 });

module.exports = mongoose.model("Review", ReviewSchema);
