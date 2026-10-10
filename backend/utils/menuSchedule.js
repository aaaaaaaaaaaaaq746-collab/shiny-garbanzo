/**
 * Menu scheduling and pricing rules: meal periods, scheduled availability,
 * temporary sold-out, sale prices and size variants.
 *
 * Pure: no database, no request objects. Times are compared in the canteen's
 * local time (CANTEEN_UTC_OFFSET_MINUTES), never in the server's time zone.
 *
 * Rules, in the order they are checked:
 *   1. `available === false`                      -> unavailable
 *   2. `soldOutUntil` still in the future         -> sold out for now
 *   3. outside `servesFrom` / `servesUntil`       -> not on the menu (yet/any more)
 *   4. `menuPeriods` set, and not the current one -> not served at this time of day
 *   5. stock (checked by the caller, per quantity)
 *
 * An item with no schedule, no sale and no variants behaves exactly as before.
 */

const ApiError = require("./ApiError");
const { roundMoney } = require("./validators");

const MENU_PERIOD_KEYS = Object.freeze(["breakfast", "lunch", "snacks", "dinner"]);

/** Default meal windows in canteen-local time. Overridable through config. */
const DEFAULT_MENU_PERIODS = Object.freeze({
  breakfast: Object.freeze({ from: "06:00", to: "11:00" }),
  lunch: Object.freeze({ from: "11:00", to: "15:00" }),
  snacks: Object.freeze({ from: "15:00", to: "18:00" }),
  dinner: Object.freeze({ from: "18:00", to: "22:00" }),
});

const CLOCK_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** "HH:MM" to minutes after midnight. */
function parseClock(text) {
  const m = CLOCK_RE.exec(String(text || ""));
  if (!m) throw new Error(`Invalid clock time "${text}"`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Minutes after local midnight for an instant, in the canteen's offset. */
function localMinuteOfDay(nowMs, utcOffsetMinutes) {
  const local = new Date(nowMs + utcOffsetMinutes * 60 * 1000);
  return local.getUTCHours() * 60 + local.getUTCMinutes();
}

/**
 * The meal period in force right now, or null between periods.
 * A period includes its start and excludes its end.
 */
function currentMenuPeriod(nowMs, utcOffsetMinutes, periods = DEFAULT_MENU_PERIODS) {
  const minute = localMinuteOfDay(nowMs, utcOffsetMinutes);
  for (const key of MENU_PERIOD_KEYS) {
    const window = periods[key];
    if (!window) continue;
    if (minute >= parseClock(window.from) && minute < parseClock(window.to)) return key;
  }
  return null;
}

const toMs = (value) => (value ? new Date(value).getTime() : null);

/** The item's sale price when a sale is running at `nowMs`, otherwise its base price. */
function effectiveBasePrice(food, nowMs) {
  const base = Number(food.price);
  const sale = food.salePrice === null || food.salePrice === undefined ? null : Number(food.salePrice);
  if (sale === null || !(sale < base)) return roundMoney(base);
  const endsAt = toMs(food.saleEndsAt);
  if (endsAt !== null && endsAt <= nowMs) return roundMoney(base);
  return roundMoney(sale);
}

/** Variant with this label, or null. */
function findVariant(food, label) {
  if (!label) return null;
  const list = Array.isArray(food.variants) ? food.variants : [];
  return list.find((x) => x.label === label) || null;
}

/**
 * Unit price for one cart line.
 *
 * A variant (e.g. Half, Full) carries its own price. When a sale is running,
 * the variant is discounted by the same percentage as the sale on the base
 * price, so one sale setting applies to every size.
 *
 * Throws 400 when `variantLabel` names a variant the item does not have.
 */
function effectiveUnitPrice(food, variantLabel, nowMs) {
  const base = Number(food.price);
  const basePrice = effectiveBasePrice(food, nowMs);
  if (!variantLabel) return basePrice;

  const variant = findVariant(food, variantLabel);
  if (!variant) throw ApiError.badRequest(`"${variantLabel}" is not a size for "${food.name}"`);

  if (basePrice === roundMoney(base)) return roundMoney(Number(variant.price));
  return roundMoney((Number(variant.price) * basePrice) / base);
}

const REASON_TEXT = Object.freeze({
  unavailable: "is currently unavailable",
  "sold-out-until": "is sold out for now",
  "not-yet-served": "is not on the menu yet",
  "no-longer-served": "is no longer on the menu",
  "outside-menu-period": "is not served at this time of day",
});

/**
 * Whether the item can be ordered at `nowMs`, and why not if it cannot.
 * `period` is the current meal period from currentMenuPeriod().
 */
function servingState(food, { nowMs, period = null }) {
  if (food.available === false) return { servable: false, reason: "unavailable" };

  const soldOutUntil = toMs(food.soldOutUntil);
  if (soldOutUntil !== null && soldOutUntil > nowMs) {
    return { servable: false, reason: "sold-out-until" };
  }

  const from = toMs(food.servesFrom);
  const until = toMs(food.servesUntil);
  if (from !== null && nowMs < from) return { servable: false, reason: "not-yet-served" };
  if (until !== null && nowMs >= until) return { servable: false, reason: "no-longer-served" };

  const periods = Array.isArray(food.menuPeriods) ? food.menuPeriods : [];
  if (periods.length > 0 && (!period || !periods.includes(period))) {
    return { servable: false, reason: "outside-menu-period" };
  }

  return { servable: true, reason: null };
}

/** Student-facing sentence for a non-servable item, e.g. `"Dosa" is not served at this time of day`. */
function reasonMessage(name, reason) {
  return `"${name}" ${REASON_TEXT[reason] || "cannot be ordered right now"}`;
}

/** True when the item is served in `period`, or has no meal-period restriction. */
function servedInPeriod(food, period) {
  const periods = Array.isArray(food.menuPeriods) ? food.menuPeriods : [];
  return periods.length === 0 || (period !== null && periods.includes(period));
}

module.exports = {
  DEFAULT_MENU_PERIODS,
  MENU_PERIOD_KEYS,
  parseClock,
  localMinuteOfDay,
  currentMenuPeriod,
  effectiveBasePrice,
  effectiveUnitPrice,
  findVariant,
  servingState,
  reasonMessage,
  servedInPeriod,
};
