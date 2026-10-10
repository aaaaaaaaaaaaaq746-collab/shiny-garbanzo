/**
 * Form model for creating and editing a menu item (staff and admin).
 *
 * Pure: no React, no network. The text inputs hold what staff typed; these
 * helpers turn that into the exact request body the API accepts, and reject
 * bad input before a request is sent. The server validates again.
 */

export const DIETARY_CHOICES = Object.freeze([
  ["", "Not set"],
  ["veg", "Veg"],
  ["non-veg", "Non-veg"],
  ["vegan", "Vegan"],
  ["jain", "Jain"],
  ["egg", "Egg"],
]);

import { localInputToIso, isoToLocalInput } from "./mealPeriods.js";

export const MAX_ADD_ONS = 10;
export const MAX_LIST_ITEMS = 30;
export const MAX_VARIANTS = 6;
export const MAX_TAGS = 10;
const MAX_PREP_MINUTES = 240;
const MAX_ADD_ON_PRICE = 1000;
const MAX_VARIANT_PRICE = 100000;

/** Blank form for a new item. */
export function emptyFoodForm() {
  return {
    name: "",
    description: "",
    price: "",
    image: "",
    category: "",
    dietary: "",
    prepTimeMinutes: "",
    featured: false,
    ingredients: "",
    allergens: "",
    addOns: "",
    subcategory: "",
    menuPeriods: [],
    servesFrom: "",
    servesUntil: "",
    soldOutUntil: "",
    salePrice: "",
    saleEndsAt: "",
    variants: "",
    tags: "",
  };
}

/** Split a comma-separated string into trimmed, unique, non-empty entries. */
export function parseList(text) {
  const out = [];
  for (const raw of String(text || "").split(",")) {
    const item = raw.trim();
    if (item && !out.some((x) => x.toLowerCase() === item.toLowerCase())) out.push(item);
  }
  return out;
}

/**
 * Parse "Label:price; Label:price" (semicolon or new line separated). The price
 * is optional and defaults to 0. Throws an Error with a readable message.
 */
export function parseAddOns(text) {
  const entries = String(text || "")
    .split(/[;\n]/)
    .map((e) => e.trim())
    .filter(Boolean);

  if (entries.length > MAX_ADD_ONS) throw new Error(`At most ${MAX_ADD_ONS} add-ons`);

  const seen = new Set();
  return entries.map((entry) => {
    const idx = entry.lastIndexOf(":");
    const label = (idx === -1 ? entry : entry.slice(0, idx)).trim();
    const priceText = idx === -1 ? "" : entry.slice(idx + 1).trim();
    if (!label) throw new Error(`Add-on "${entry}" needs a name`);
    if (label.length > 60) throw new Error(`Add-on name "${label}" is too long`);
    if (seen.has(label.toLowerCase())) throw new Error(`Duplicate add-on "${label}"`);
    seen.add(label.toLowerCase());

    const price = priceText === "" ? 0 : Number(priceText);
    if (!Number.isFinite(price) || price < 0 || price > MAX_ADD_ON_PRICE) {
      throw new Error(`Add-on "${label}" price must be between 0 and ${MAX_ADD_ON_PRICE}`);
    }
    return { label, price: Math.round(price * 100) / 100 };
  });
}

/**
 * Parse "Half:40; Full:60" into sizes. Each size needs a name and a price.
 * Throws an Error with a readable message.
 */
export function parseVariants(text) {
  const entries = String(text || "")
    .split(/[;\n]/)
    .map((e) => e.trim())
    .filter(Boolean);
  if (entries.length > MAX_VARIANTS) throw new Error(`At most ${MAX_VARIANTS} sizes`);

  const seen = new Set();
  return entries.map((entry) => {
    const idx = entry.lastIndexOf(":");
    if (idx === -1) throw new Error(`Size "${entry}" needs a price, for example Half:40`);
    const label = entry.slice(0, idx).trim();
    if (!label) throw new Error("Every size needs a name");
    if (label.length > 30) throw new Error(`Size name "${label}" is too long`);
    if (seen.has(label.toLowerCase())) throw new Error(`Duplicate size "${label}"`);
    seen.add(label.toLowerCase());

    const price = Number(entry.slice(idx + 1).trim());
    if (!Number.isFinite(price) || price <= 0 || price > MAX_VARIANT_PRICE) {
      throw new Error(`Size "${label}" price must be greater than zero`);
    }
    return { label, price: Math.round(price * 100) / 100 };
  });
}

/** Inverse of parseVariants, for pre-filling the edit form. */
export function formatVariants(variants) {
  return (Array.isArray(variants) ? variants : []).map((v) => `${v.label}:${v.price}`).join("; ");
}

/** Inverse of parseAddOns, for pre-filling the edit form. */
export function formatAddOns(addOns) {
  return (Array.isArray(addOns) ? addOns : [])
    .map((a) => `${a.label}:${a.price ?? 0}`)
    .join("; ");
}

/** Pre-fill the form from an existing menu item. */
export function foodToForm(food) {
  return {
    name: food.name || "",
    description: food.description || "",
    price: food.price != null ? String(food.price) : "",
    image: food.image || "",
    category: food.category && food.category !== "General" ? food.category : "",
    dietary: food.dietary || "",
    prepTimeMinutes: food.prepTimeMinutes != null ? String(food.prepTimeMinutes) : "",
    featured: Boolean(food.featured),
    ingredients: Array.isArray(food.ingredients) ? food.ingredients.join(", ") : "",
    allergens: Array.isArray(food.allergens) ? food.allergens.join(", ") : "",
    addOns: formatAddOns(food.addOns),
    subcategory: food.subcategory || "",
    menuPeriods: Array.isArray(food.menuPeriods) ? [...food.menuPeriods] : [],
    servesFrom: isoToLocalInput(food.servesFrom),
    servesUntil: isoToLocalInput(food.servesUntil),
    soldOutUntil: isoToLocalInput(food.soldOutUntil),
    salePrice: food.salePrice != null ? String(food.salePrice) : "",
    saleEndsAt: isoToLocalInput(food.saleEndsAt),
    variants: formatVariants(food.variants),
    tags: Array.isArray(food.tags) ? food.tags.join(", ") : "",
  };
}

/**
 * Build the request body from the form. Throws Error with a readable message
 * on invalid input. Blank optional fields are sent as null or empty values so
 * an edit can clear them.
 */
export function formToPayload(form) {
  const name = String(form.name || "").trim();
  if (!name) throw new Error("Name is required");

  const price = Number(form.price);
  if (form.price === "" || !Number.isFinite(price) || price <= 0) {
    throw new Error("Price must be a number greater than zero");
  }

  // Blank prep time is omitted rather than sent as null: the API rejects null
  // for this field. A new item then gets the model default, and an edit keeps
  // the existing value.
  let prepTimeMinutes;
  if (String(form.prepTimeMinutes).trim() !== "") {
    prepTimeMinutes = Number(form.prepTimeMinutes);
    if (!Number.isInteger(prepTimeMinutes) || prepTimeMinutes < 0 || prepTimeMinutes > MAX_PREP_MINUTES) {
      throw new Error(`Preparation time must be a whole number of minutes from 0 to ${MAX_PREP_MINUTES}`);
    }
  }

  const ingredients = parseList(form.ingredients);
  const allergens = parseList(form.allergens);
  if (ingredients.length > MAX_LIST_ITEMS) throw new Error(`At most ${MAX_LIST_ITEMS} ingredients`);
  if (allergens.length > MAX_LIST_ITEMS) throw new Error(`At most ${MAX_LIST_ITEMS} allergens`);

  const payload = {
    name,
    description: String(form.description || "").trim(),
    price,
    image: String(form.image || "").trim() || null,
    category: String(form.category || "").trim() || "General",
    dietary: form.dietary || null,
    featured: Boolean(form.featured),
    ingredients,
    allergens,
    addOns: parseAddOns(form.addOns),
  };
  if (prepTimeMinutes !== undefined) payload.prepTimeMinutes = prepTimeMinutes;
  return payload;
}

/**
 * Menu-management fields (Phase 2): meal periods, serving window, sold-out time,
 * sale, sizes and tags. The caller merges this into formToPayload's result, so
 * an edit can also clear these fields. Throws Error on invalid input.
 */
export function formToMenuPayload(form) {
  const price = Number(form.price);
  // Sale rules, checked here so the form explains them before the server does.
  const salePriceText = String(form.salePrice ?? "").trim();
  let salePrice = null;
  if (salePriceText !== "") {
    salePrice = Number(salePriceText);
    if (!Number.isFinite(salePrice) || salePrice <= 0) throw new Error("Sale price must be greater than zero");
    if (salePrice >= price) throw new Error("Sale price must be lower than the price");
  }
  const saleEndsAt = localInputToIso(form.saleEndsAt);
  if (saleEndsAt && salePrice === null) throw new Error("Set a sale price, or clear the sale end time");

  const servesFrom = localInputToIso(form.servesFrom);
  const servesUntil = localInputToIso(form.servesUntil);
  if (servesFrom && servesUntil && new Date(servesFrom) >= new Date(servesUntil)) {
    throw new Error("Serving start must be before serving end");
  }

  const tags = parseList(form.tags);
  if (tags.length > MAX_TAGS) throw new Error(`At most ${MAX_TAGS} tags`);

  return {
    subcategory: String(form.subcategory || "").trim(),
    menuPeriods: Array.isArray(form.menuPeriods) ? [...form.menuPeriods] : [],
    servesFrom,
    servesUntil,
    soldOutUntil: localInputToIso(form.soldOutUntil),
    salePrice,
    saleEndsAt,
    variants: parseVariants(form.variants),
    tags,
  };
}
