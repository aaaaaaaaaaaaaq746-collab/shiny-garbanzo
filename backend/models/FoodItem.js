const mongoose = require("mongoose");
const { MENU_PERIOD_KEYS } = require("../utils/menuSchedule");

const DIETARY = ["veg", "non-veg", "vegan", "jain", "egg"];

const UNITS = ["servings", "pieces", "portions", "packs", "kg", "litres"];

const addOnSchema = new mongoose.Schema(
  {
    label: { type: String, required: true, trim: true, maxlength: 60 },
    price: { type: Number, required: true, min: 0, default: 0 },
  },
  { _id: false }
);

const foodSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 600, default: "" },
    price: {
      type: Number,
      required: true,
      min: [0.01, "Price must be greater than 0"],
      // Guard against float drift on money.
      set: (v) => (typeof v === "number" ? Math.round(v * 100) / 100 : v),
    },
    image: { type: String, trim: true, default: null },

    // ---- Menu presentation fields (Phase 1). ----
    category: { type: String, trim: true, maxlength: 60, default: "General" },
    available: { type: Boolean, default: true },
    dietary: { type: String, enum: [...DIETARY, null], default: null },
    spicy: { type: Boolean, default: false },
    prepTimeMinutes: { type: Number, min: 0, max: 240, default: 15 },
    lowStockThreshold: { type: Number, min: 0, default: 5 },

    // ---- Phase 1 student-experience fields (additive, all defaulted). ----
    // Set by an administrator to show a "Featured" badge.
    featured: { type: Boolean, default: false },
    // Optional extras a student can select, each with its own price.
    addOns: { type: [addOnSchema], default: [] },
    ingredients: { type: [String], default: [] },
    allergens: { type: [String], default: [] },
    // Units ordered over the item's lifetime. Drives bestseller and popularity.
    orderCount: { type: Number, min: 0, default: 0 },
    // Rating aggregate maintained by the review route. ratingAverage is stored
    // so the list can be sorted by rating without a join.
    ratingSum: { type: Number, min: 0, default: 0 },
    ratingCount: { type: Number, min: 0, default: 0 },
    ratingAverage: { type: Number, min: 0, max: 5, default: 0 },

    // ---------------------------------------------------------------------
    // Phase 4 inventory fields.
    //
    // BACKWARD COMPATIBILITY: every field has a safe default and
    // `trackInventory` defaults to FALSE, so documents created before Phase 4
    // keep exactly their previous behaviour. A legacy item that already had
    // `stock: 0` still behaves as sold out; a legacy item with `stock: null`
    // stays unlimited. Existing items never silently become unavailable.
    // ---------------------------------------------------------------------

    // Opt-in. Until an administrator turns this on, stock is not managed.
    trackInventory: { type: Boolean, default: false },
    // Physical stock on hand. `null` keeps the Phase 1 "unlimited" meaning.
    stock: { type: Number, min: 0, default: null },
    // Quantity committed to orders that have not been prepared yet.
    // Only meaningful when trackInventory is true.
    reserved: { type: Number, min: 0, default: 0 },
    // Display unit for counts on the admin board.
    unit: { type: String, enum: [...UNITS, null], default: "servings" },

    // Audit trail for the most recent manual change.
    lastStockAdjustmentAt: { type: Date, default: null },
    lastStockAdjustmentReason: { type: String, default: null, maxlength: 300 },
    lastStockAdjustmentBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    // When an admin last acknowledged the low-stock condition for this item.
    // Drives "new alert" vs "already seen" without re-alerting every render.
    lowStockAcknowledgedAt: { type: Date, default: null },

    // ---- Phase 2 menu management (additive, all defaulted). ----
    // Finer grouping under `category` (e.g. Beverages > Hot, Cold).
    subcategory: { type: String, trim: true, maxlength: 60, default: "" },
    // Meal periods the item is served in. Empty means all day.
    menuPeriods: { type: [{ type: String, enum: MENU_PERIOD_KEYS }], default: [] },
    // Scheduled availability window. Null means no limit on that side.
    servesFrom: { type: Date, default: null },
    servesUntil: { type: Date, default: null },
    // Temporary sold-out. The item comes back on its own after this time.
    soldOutUntil: { type: Date, default: null },
    // Discounted price, valid until saleEndsAt (null = until changed).
    salePrice: { type: Number, min: 0, default: null },
    saleEndsAt: { type: Date, default: null },
    // Size or portion options, each with its own price (e.g. Half, Full).
    variants: {
      type: [
        {
          _id: false,
          label: { type: String, required: true, trim: true, maxlength: 30 },
          price: { type: Number, required: true, min: 0.01 },
        },
      ],
      default: [],
    },
    // Free-text tags shown as badges (e.g. "spicy", "kids").
    tags: { type: [{ type: String, trim: true, maxlength: 30 }], default: [] },
  },
  { timestamps: true }
);

foodSchema.index({ name: "text", description: "text", category: "text" });
foodSchema.index({ category: 1 });
foodSchema.index({ available: 1 });
foodSchema.index({ trackInventory: 1 });
foodSchema.index({ orderCount: -1 });
foodSchema.index({ ratingAverage: -1 });

/**
 * Quantity a new order may still take.
 *
 * - Tracked items: physical stock minus what is already reserved.
 * - Legacy items with a Phase 1 `stock` value: that value acts as a simple cap
 *   (preserves the behaviour existing tests and data depend on).
 * - Otherwise: unlimited.
 */
foodSchema.methods.sellableQty = function () {
  if (this.trackInventory === true) {
    return Math.max(0, (this.stock ?? 0) - (this.reserved ?? 0));
  }
  if (this.stock !== null && this.stock !== undefined) return this.stock;
  return Infinity;
};

/** True when inventory is actually being managed for this item. */
foodSchema.virtual("inventoryTracked").get(function () {
  return this.trackInventory === true;
});

/** Available-to-sell quantity, or null when the item is not stock-managed. */
foodSchema.virtual("availableQty").get(function () {
  if (this.trackInventory !== true) return null;
  return Math.max(0, (this.stock ?? 0) - (this.reserved ?? 0));
});

/** True when the item cannot currently be ordered. */
foodSchema.virtual("soldOut").get(function () {
  if (this.available === false) return true;
  return this.sellableQty() <= 0;
});

/** At or below the configured threshold. Only meaningful when tracked. */
foodSchema.virtual("lowStock").get(function () {
  if (this.trackInventory !== true) return false;
  return this.availableQty <= this.lowStockThreshold;
});

/** True when tracked and nothing at all is left to sell. */
foodSchema.virtual("outOfStock").get(function () {
  if (this.trackInventory !== true) return false;
  return this.availableQty <= 0;
});

foodSchema.set("toJSON", { virtuals: true });
foodSchema.set("toObject", { virtuals: true });

module.exports = mongoose.model("FoodItem", foodSchema);
module.exports.DIETARY = DIETARY;
module.exports.UNITS = UNITS;