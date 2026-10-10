/**
 * Menu filter state and the query it maps to. Pure, so it can be unit-tested.
 * Most filters go to the server; "favorites only" is applied on the client
 * because favorites are a per-student list.
 */

export const DEFAULT_FILTERS = Object.freeze({
  search: "",
  category: "",
  veg: "",
  minPrice: "",
  maxPrice: "",
  sort: "",
  available: false,
  featured: false,
  favoritesOnly: false,
  period: "",
});

export const SORT_OPTIONS = Object.freeze([
  ["", "Default"],
  ["popularity", "Most ordered"],
  ["rating", "Top rated"],
  ["price_asc", "Price: low to high"],
  ["price_desc", "Price: high to low"],
  ["name", "Name A-Z"],
  ["newest", "Newest"],
]);

/** Query parameters for GET /api/food, from the filter state. */
export function foodQueryParams(f) {
  const params = {};
  if (f.search.trim()) params.search = f.search.trim();
  if (f.category) params.category = f.category;
  if (f.veg) params.veg = f.veg;
  if (f.minPrice !== "") params.minPrice = f.minPrice;
  if (f.maxPrice !== "") params.maxPrice = f.maxPrice;
  if (f.sort) params.sort = f.sort;
  if (f.available) params.available = "true";
  if (f.featured) params.featured = "true";
  if (f.period) params.period = f.period;
  return params;
}

/** Client-side step: narrow the menu to favourites when that filter is on. */
export function applyClientFilters(foods, filters, favoriteIds) {
  if (!filters.favoritesOnly) return foods;
  const fav = new Set(favoriteIds);
  return foods.filter((f) => fav.has(f._id));
}
