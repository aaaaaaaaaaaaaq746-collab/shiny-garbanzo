/**
 * Menu discovery: query parsing and presentation badges.
 *
 * Pure module (no database access) so it can be unit-tested without MongoDB.
 * The route layer runs the query and supplies the bestseller ranking.
 */

const ApiError = require("./ApiError");
const v = require("./validators");

/** Dietary values that count as vegetarian for the Veg / Non-veg filter. */
const VEG_VALUES = ["veg", "vegan", "jain"];
/** Dietary values that count as non-vegetarian. Egg is grouped here. */
const NON_VEG_VALUES = ["non-veg", "egg"];

const SORT_MAP = {
  name: { name: 1 },
  name_desc: { name: -1 },
  price_asc: { price: 1 },
  price_desc: { price: -1 },
  newest: { createdAt: -1 },
  popularity: { orderCount: -1, name: 1 },
  rating: { ratingAverage: -1, ratingCount: -1, name: 1 },
};

const DIETARY = ["veg", "non-veg", "vegan", "jain", "egg"];

/**
 * Turn request query parameters into a Mongo filter and sort.
 *
 * Supported: search (name/description/category), category, dietary (exact),
 * veg (veg|nonveg), available (boolean), minPrice, maxPrice, featured (true),
 * sort (see SORT_MAP). Unknown sort keys are a 400, never silently ignored.
 */
function parseFoodQuery(query = {}) {
  const filter = {};

  const search = v.optionalString(query.search ?? query.q, { field: "search", max: 100 });
  if (search) {
    const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ name: rx }, { description: rx }, { category: rx }];
  }

  const category = v.optionalString(query.category, { field: "category", max: 60 });
  if (category) filter.category = category;

  if (query.dietary !== undefined && query.dietary !== "") {
    filter.dietary = v.oneOf(String(query.dietary), DIETARY, "dietary");
  }

  if (query.veg !== undefined && query.veg !== "") {
    const choice = v.oneOf(String(query.veg), ["veg", "nonveg"], "veg");
    filter.dietary = { $in: choice === "veg" ? VEG_VALUES : NON_VEG_VALUES };
  }

  if (query.available !== undefined && query.available !== "") {
    filter.available = v.boolean(query.available, "available");
  }

  const minPrice = parseMoneyParam(query.minPrice, "minPrice");
  const maxPrice = parseMoneyParam(query.maxPrice, "maxPrice");
  if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) {
    throw ApiError.badRequest("minPrice cannot be greater than maxPrice");
  }
  if (minPrice !== null || maxPrice !== null) {
    filter.price = {};
    if (minPrice !== null) filter.price.$gte = minPrice;
    if (maxPrice !== null) filter.price.$lte = maxPrice;
  }

  if (query.featured !== undefined && query.featured !== "") {
    if (v.boolean(query.featured, "featured")) filter.featured = true;
  }

  let sort = { createdAt: 1 };
  if (query.sort !== undefined && query.sort !== "") {
    const key = String(query.sort);
    if (!Object.prototype.hasOwnProperty.call(SORT_MAP, key)) {
      throw ApiError.badRequest(`sort must be one of: ${Object.keys(SORT_MAP).join(", ")}`);
    }
    sort = SORT_MAP[key];
  }

  return { filter, sort };
}

function parseMoneyParam(raw, field) {
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 100000) {
    throw ApiError.badRequest(`${field} must be a number between 0 and 100000`);
  }
  return Math.round(n * 100) / 100;
}

/**
 * Badges for one menu item.
 *
 * - featured: set by an administrator (stored flag).
 * - bestselling: among the top `bestsellerCount` items by units ordered
 *   (ranking supplied by the caller, computed over the whole menu, not the
 *   filtered list). Items never ordered are not bestsellers.
 * - isNew: created within `newItemDays`.
 */
function badgesFor(food, { bestsellerIds, now = Date.now(), newItemDays = 7 }) {
  const id = String(food._id ?? food.id);
  const created = food.createdAt ? new Date(food.createdAt).getTime() : 0;
  const ageMs = now - created;
  return {
    featured: food.featured === true,
    bestselling: bestsellerIds.has(id),
    isNew: created > 0 && ageMs >= 0 && ageMs <= newItemDays * 24 * 60 * 60 * 1000,
  };
}

/** Ids of the top-N items by units ordered, excluding items never ordered. */
function bestsellerIdSet(rankedFoods, count) {
  const ids = new Set();
  for (const food of rankedFoods) {
    if (ids.size >= count) break;
    if ((food.orderCount ?? 0) > 0) ids.add(String(food._id));
  }
  return ids;
}

/**
 * Validate a dietary value on a write. null or "" clears it; any value outside
 * the known list is a 400 (the schema would otherwise reject it with a 500-class
 * validation error). `undefined` means "not supplied" and is returned as-is.
 */
function parseDietary(value) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  return v.oneOf(String(value), DIETARY, "dietary");
}

module.exports = {
  parseFoodQuery,
  parseDietary,
  badgesFor,
  bestsellerIdSet,
  SORT_MAP,
  VEG_VALUES,
  NON_VEG_VALUES,
  DIETARY,
};
