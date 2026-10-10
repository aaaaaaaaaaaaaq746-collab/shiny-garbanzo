/**
 * Server-side pricing: add-ons, coupons, charges and the itemized bill.
 *
 * Pure functions (no database). The quote endpoint and order placement both
 * call buildBill(), so the total a student sees before checkout is the total
 * the order is stored with. Every price comes from the menu item document;
 * nothing the client sends is trusted for money.
 */

const ApiError = require("./ApiError");
const v = require("./validators");
const { effectiveUnitPrice } = require("./menuSchedule");

const MAX_ADDONS_PER_LINE = 10;
const MAX_INSTRUCTIONS_LENGTH = 140;

/**
 * Validate one cart line against its menu item and price it.
 *
 * `addOnLabels` must each match an add-on defined on the menu item. Prices are
 * taken from the menu item, never from the request.
 */
function priceLine({
  food,
  quantity,
  addOnLabels = [],
  specialInstructions = null,
  variantLabel = null,
  nowMs = Date.now(),
}) {
  const definedAddOns = Array.isArray(food.addOns) ? food.addOns : [];

  if (!Array.isArray(addOnLabels)) {
    throw ApiError.badRequest("addOns must be a list of add-on labels");
  }
  if (addOnLabels.length > MAX_ADDONS_PER_LINE) {
    throw ApiError.badRequest(`At most ${MAX_ADDONS_PER_LINE} add-ons per item`);
  }

  const seen = new Set();
  const addOns = [];
  for (const raw of addOnLabels) {
    const label = typeof raw === "string" ? raw.trim() : "";
    if (!label) throw ApiError.badRequest("Each add-on must be a non-empty label");
    if (seen.has(label)) continue; // selecting the same add-on twice is a no-op
    seen.add(label);

    const match = definedAddOns.find((a) => a.label === label);
    if (!match) {
      throw ApiError.badRequest(`"${label}" is not an option for "${food.name}"`);
    }
    addOns.push({ label: match.label, price: v.roundMoney(match.price) });
  }

  const instructions = specialInstructions === null || specialInstructions === undefined
    ? null
    : String(specialInstructions).trim();
  if (instructions && instructions.length > MAX_INSTRUCTIONS_LENGTH) {
    throw ApiError.badRequest(
      `specialInstructions must be at most ${MAX_INSTRUCTIONS_LENGTH} characters`
    );
  }

  // The base price is the item's price, or its sale price while a sale runs,
  // or the chosen size's price. See utils/menuSchedule.js.
  const basePrice = effectiveUnitPrice(food, variantLabel, nowMs);
  const addOnsTotal = v.roundMoney(addOns.reduce((sum, a) => sum + a.price, 0));
  const unitPrice = v.roundMoney(basePrice + addOnsTotal);

  return {
    food: food._id,
    name: food.name,
    variant: variantLabel || null,
    basePrice,
    addOns,
    addOnsTotal,
    // Unit price including add-ons. Keeps `price * quantity` equal to the line
    // total, which the existing order views already rely on.
    price: unitPrice,
    quantity,
    lineTotal: v.roundMoney(unitPrice * quantity),
    specialInstructions: instructions || null,
    inventoryTracked: food.trackInventory === true,
    reservedQty: food.trackInventory === true ? quantity : null,
  };
}

/**
 * Work out the discount a coupon gives on `subtotal`, or refuse it with a
 * clear message. Usage limits are enforced atomically by the caller; this
 * checks the rules that can be decided from the document alone.
 */
function applyCoupon(coupon, subtotal, now = Date.now()) {
  if (!coupon) throw ApiError.badRequest("Coupon code not recognised");
  if (coupon.active === false) throw ApiError.badRequest("This coupon is no longer active");
  if (coupon.expiresAt && new Date(coupon.expiresAt).getTime() < now) {
    throw ApiError.badRequest("This coupon has expired");
  }
  if (coupon.usageLimit !== null && coupon.usageLimit !== undefined &&
      (coupon.usedCount ?? 0) >= coupon.usageLimit) {
    throw ApiError.conflict("This coupon has been fully used");
  }
  if (subtotal < (coupon.minSubtotal ?? 0)) {
    throw ApiError.badRequest(
      `This coupon needs an order of at least ₹${coupon.minSubtotal}`
    );
  }

  let discount;
  if (coupon.type === "percent") {
    discount = (subtotal * coupon.value) / 100;
    if (coupon.maxDiscount !== null && coupon.maxDiscount !== undefined) {
      discount = Math.min(discount, coupon.maxDiscount);
    }
  } else {
    discount = coupon.value;
  }
  discount = v.roundMoney(Math.min(Math.max(discount, 0), subtotal));
  return { code: coupon.code, discount };
}

/**
 * Charges that apply on top of the discounted subtotal: packaging per item and
 * tax on the discounted amount. Both default to zero.
 */
function computeCharges({ taxableAmount, itemCount, pricing }) {
  const charges = [];
  if (pricing.packagingChargePerItem > 0 && itemCount > 0) {
    charges.push({
      label: "Packaging",
      amount: v.roundMoney(pricing.packagingChargePerItem * itemCount),
    });
  }
  if (pricing.taxPercent > 0 && taxableAmount > 0) {
    charges.push({
      label: `Tax (${pricing.taxPercent}%)`,
      amount: v.roundMoney((taxableAmount * pricing.taxPercent) / 100),
    });
  }
  return charges;
}

/**
 * Build the full itemized bill.
 *
 * `lines` are results of priceLine(). Returns subtotal, discount, charges and
 * the total the student pays. The total is never negative.
 */
function buildBill({ lines, coupon = null, now = Date.now(), pricing }) {
  const subtotal = v.roundMoney(lines.reduce((sum, l) => sum + l.lineTotal, 0));
  const itemCount = lines.reduce((sum, l) => sum + l.quantity, 0);

  let discount = 0;
  let couponCode = null;
  if (coupon) {
    const applied = applyCoupon(coupon, subtotal, now);
    discount = applied.discount;
    couponCode = applied.code;
  }

  const taxableAmount = v.roundMoney(subtotal - discount);
  const charges = computeCharges({ taxableAmount, itemCount, pricing });
  const chargesTotal = v.roundMoney(charges.reduce((sum, c) => sum + c.amount, 0));
  const total = v.roundMoney(Math.max(0, taxableAmount + chargesTotal));

  return { subtotal, discount, couponCode, charges, total, itemCount };
}

module.exports = {
  priceLine,
  applyCoupon,
  computeCharges,
  buildBill,
  MAX_ADDONS_PER_LINE,
  MAX_INSTRUCTIONS_LENGTH,
};
