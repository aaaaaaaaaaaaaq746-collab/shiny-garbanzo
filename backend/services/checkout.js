/**
 * Checkout resolution shared by POST /api/orders (place) and POST
 * /api/orders/quote (preview).
 *
 * Reads the menu and coupon from the database, prices every line on the
 * server, and returns the same bill both routes show. Nothing here reserves
 * stock or writes an order: that is the caller's job, so the preview stays
 * free of side effects.
 */

const config = require("../config");
const Food = require("../models/FoodItem");
const Coupon = require("../models/Coupon");
const ApiError = require("../utils/ApiError");
const v = require("../utils/validators");
const pricing = require("../utils/pricing");
const slots = require("../utils/pickupSlots");
const menuSchedule = require("../utils/menuSchedule");

const { maxQuantityPerItem, maxItemsPerOrder } = config.order;
const canteen = config.canteen;

function pricingConfig() {
  return {
    taxPercent: canteen.taxPercent,
    packagingChargePerItem: canteen.packagingChargePerItem,
  };
}

/** Open pickup slots for a cart whose longest prep time is `maxPrep`. */
function openSlotsFor(now, maxPrep) {
  return slots.generatePickupSlots({
    now,
    earliestMs: slots.earliestReadyAt(now, maxPrep, canteen.prepBufferMinutes),
    openHour: canteen.openHour,
    closeHour: canteen.closeHour,
    slotMinutes: canteen.slotMinutes,
    utcOffsetMinutes: canteen.utcOffsetMinutes,
    days: canteen.slotDays,
  });
}

/**
 * Validate and price a cart.
 *
 * Input shape per line: { food, quantity, addOns?, specialInstructions? }.
 * Lines for the same item and the same options are merged; different add-on
 * choices stay separate lines.
 */
async function resolveCart(body, { now = Date.now() } = {}) {
  const rawItems = v.array(body.items, { field: "items", max: maxItemsPerOrder });
  if (rawItems.length === 0) throw ApiError.badRequest("Cart is empty");

  const requests = rawItems.map((raw, index) => {
    const item = v.object(raw, `items[${index}]`);
    const foodId = v.objectId(item.food, `items[${index}].food`);
    const quantity = v.quantity(item.quantity, {
      field: `items[${index}].quantity`,
      min: 1,
      max: maxQuantityPerItem,
    });
    const addOnLabels = item.addOns === undefined || item.addOns === null ? [] : item.addOns;
    // Checked here, before the labels are merged into a key below.
    if (!Array.isArray(addOnLabels)) {
      throw ApiError.badRequest(`items[${index}].addOns must be a list of add-on labels`);
    }
    if (item.variant !== undefined && item.variant !== null && typeof item.variant !== "string") {
      throw ApiError.badRequest(`items[${index}].variant must be text`);
    }
    const variantLabel =
      typeof item.variant === "string" && item.variant.trim() ? item.variant.trim().slice(0, 30) : null;
    return {
      foodId,
      quantity,
      addOnLabels,
      variantLabel,
      specialInstructions: item.specialInstructions ?? null,
    };
  });

  // Quantities for an identical (item, add-ons, instructions) combination merge.
  const merged = new Map();
  for (const r of requests) {
    const key = JSON.stringify([
      r.foodId,
      r.variantLabel,
      [...new Set(r.addOnLabels)].sort(),
      r.specialInstructions,
    ]);
    const prev = merged.get(key);
    if (prev) {
      prev.quantity += r.quantity;
      if (prev.quantity > maxQuantityPerItem) {
        throw ApiError.badRequest(`Quantity exceeds the maximum of ${maxQuantityPerItem} per item`);
      }
    } else {
      merged.set(key, { ...r });
    }
  }

  const foodIds = [...new Set([...merged.values()].map((r) => r.foodId))];
  const foods = await Food.find({ _id: { $in: foodIds } });
  if (foods.length !== foodIds.length) {
    throw ApiError.badRequest("Cart contains an item that no longer exists");
  }
  const byId = new Map(foods.map((f) => [f._id.toString(), f]));

  // Stock needed per menu item across all lines, so two lines of one item
  // cannot each pass a check that only looks at one line.
  const neededPerFood = new Map();
  for (const r of merged.values()) {
    neededPerFood.set(r.foodId, (neededPerFood.get(r.foodId) || 0) + r.quantity);
  }

  const lines = [];
  let maxPrep = 0;
  const period = menuSchedule.currentMenuPeriod(now, canteen.utcOffsetMinutes, canteen.menuPeriods);
  for (const r of merged.values()) {
    const food = byId.get(r.foodId);
    // Unavailable, sold out for now, outside its scheduled window or meal period.
    const state = menuSchedule.servingState(food, { nowMs: now, period });
    if (!state.servable) {
      throw ApiError.conflict(menuSchedule.reasonMessage(food.name, state.reason));
    }
    const hasSizes = Array.isArray(food.variants) && food.variants.length > 0;
    if (hasSizes && !r.variantLabel) {
      throw ApiError.badRequest(`Choose a size for "${food.name}"`);
    }
    const sellable = food.sellableQty();
    const needed = neededPerFood.get(r.foodId);
    if (sellable !== Infinity && sellable < needed) {
      throw ApiError.conflict(
        sellable <= 0 ? `"${food.name}" is sold out` : `Only ${sellable} of "${food.name}" left`
      );
    }
    maxPrep = Math.max(maxPrep, food.prepTimeMinutes || 0);
    lines.push(
      pricing.priceLine({
        food,
        quantity: r.quantity,
        addOnLabels: r.addOnLabels,
        specialInstructions: r.specialInstructions,
        variantLabel: r.variantLabel,
        nowMs: now,
      })
    );
  }

  let coupon = null;
  const rawCode = body.couponCode;
  if (rawCode !== undefined && rawCode !== null && String(rawCode).trim() !== "") {
    const code = String(rawCode).trim().toUpperCase();
    coupon = await Coupon.findOne({ code });
    if (!coupon) throw ApiError.badRequest("Coupon code not recognised");
  }

  const bill = pricing.buildBill({ lines, coupon, now, pricing: pricingConfig() });

  let pickupAt = null;
  if (body.pickupAt !== undefined && body.pickupAt !== null && body.pickupAt !== "") {
    const at = new Date(String(body.pickupAt));
    if (Number.isNaN(at.getTime())) throw ApiError.badRequest("pickupAt must be a valid date-time");
    const open = openSlotsFor(now, maxPrep);
    if (!slots.isOpenPickupSlot(at.getTime(), open)) {
      throw ApiError.conflict("That pickup time is not available. Choose one of the open slots.");
    }
    pickupAt = at;
  }

  return { lines, bill, coupon, pickupAt, maxPrep, foods: byId };
}

module.exports = { resolveCart, openSlotsFor, pricingConfig };
