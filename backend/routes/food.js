const express = require("express");
const Food = require("../models/FoodItem");
const {
  authMiddleware,
  adminOrStaffMiddleware,
} = require("../middleware/authMiddleware");
const ApiError = require("../utils/ApiError");
const v = require("../utils/validators");
const inventory = require("../services/inventory");
const { UNITS } = require("../models/FoodItem");
const config = require("../config");
const { parseFoodQuery, parseDietary, badgesFor, bestsellerIdSet } = require("../utils/discovery");

const router = express.Router();

/** Fields an admin is allowed to write. Prevents mass assignment. */
const WRITABLE_FIELDS = [
  "name",
  "description",
  "price",
  "image",
  "category",
  "available",
  "dietary",
  "spicy",
  "prepTimeMinutes",
  "stock",
  "lowStockThreshold",
];

/**
 * Parse a list of short strings (ingredients, allergens) from a request body.
 * Trimmed, de-duplicated and bounded so the menu document stays small.
 */
function stringList(value, { field, max = 30, itemMax = 60 }) {
  const list = v.array(value, { field, max });
  const out = [];
  for (const raw of list) {
    if (typeof raw !== "string") throw ApiError.badRequest(`${field} must contain only text`);
    const t = raw.trim();
    if (!t) continue;
    if (t.length > itemMax) throw ApiError.badRequest(`Each ${field} entry must be at most ${itemMax} characters`);
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/** Add-on list: [{ label, price }], at most 10. Prices are validated as money. */
function addOnList(value) {
  const list = v.array(value, { field: "addOns", max: 10 });
  const seen = new Set();
  return list.map((raw, index) => {
    const a = v.object(raw, `addOns[${index}]`);
    const label = v.optionalString(a.label, { field: `addOns[${index}].label`, max: 60 });
    if (!label) throw ApiError.badRequest(`addOns[${index}].label is required`);
    if (seen.has(label.toLowerCase())) {
      throw ApiError.badRequest(`Duplicate add-on "${label}"`);
    }
    seen.add(label.toLowerCase());
    const price = a.price === undefined ? 0 : v.roundMoney(Number(a.price));
    if (!Number.isFinite(price) || price < 0 || price > 1000) {
      throw ApiError.badRequest(`addOns[${index}].price must be between 0 and 1000`);
    }
    return { label, price };
  });
}

/**
 * List menu items.
 *
 * With no query parameters this returns a plain array, exactly as before.
 * Filters: search/q, category, dietary, veg (veg|nonveg), available, minPrice,
 * maxPrice, featured. Sorts: name, name_desc, price_asc, price_desc, newest,
 * popularity, rating. Each item gains a `badges` object (featured,
 * bestselling, isNew); the rest of the document is unchanged.
 */
router.get("/", async (req, res) => {
  const { filter, sort } = parseFoodQuery(req.query);

  const foods = await Food.find(filter).sort(sort);

  // Bestsellers are ranked over the whole menu, not the filtered list, so a
  // badge means the same thing whatever the student is searching for.
  const topSellers = await Food.find({ orderCount: { $gt: 0 } }, { orderCount: 1 })
    .sort({ orderCount: -1, _id: 1 })
    .limit(config.canteen.bestsellerCount);
  const bestsellerIds = bestsellerIdSet(topSellers, config.canteen.bestsellerCount);

  const now = Date.now();
  res.json(
    foods.map((food) => {
      const plain = food.toJSON();
      plain.badges = badgesFor(plain, {
        bestsellerIds,
        now,
        newItemDays: config.canteen.newItemDays,
      });
      return plain;
    })
  );
});

/** Distinct categories, for building filter controls. */
router.get("/categories", async (req, res) => {
  const categories = await Food.distinct("category");
  res.json(categories.filter(Boolean).sort());
});

/** One menu item, with its badges. Public, like the list. */
router.get("/:id", async (req, res) => {
  const id = v.objectId(req.params.id, "food id");
  const food = await Food.findById(id);
  if (!food) throw ApiError.notFound("Food item not found");
  const top = await Food.find({ orderCount: { $gt: 0 } }, { orderCount: 1 })
    .sort({ orderCount: -1, _id: 1 })
    .limit(config.canteen.bestsellerCount);
  const plain = food.toJSON();
  plain.badges = badgesFor(plain, {
    bestsellerIds: bestsellerIdSet(top, config.canteen.bestsellerCount),
    newItemDays: config.canteen.newItemDays,
  });
  res.json(plain);
});

// Admin/staff: add food
router.post("/", authMiddleware, adminOrStaffMiddleware, async (req, res) => {
  const body = v.object(req.body);
  const isAdmin = req.user.role === "admin";

  // Inventory fields are administrator-only, matching the inventory API.
  const inventoryFields = ["trackInventory", "stock", "lowStockThreshold", "unit"];
  if (!isAdmin && inventoryFields.some((k) => body[k] !== undefined)) {
    throw ApiError.forbidden("Only administrators can set inventory fields");
  }

  const payload = {
    name: v.name(body.name, "name"),
    price: v.price(body.price),
  };
  if (body.description !== undefined) {
    payload.description = v.optionalString(body.description, {
      field: "description",
      max: 600,
    }) || "";
  }
  if (body.image !== undefined) payload.image = v.optionalUrl(body.image) || null;
  if (body.category !== undefined) {
    payload.category = v.optionalString(body.category, { field: "category", max: 60 }) || "General";
  }
  if (body.available !== undefined) payload.available = v.boolean(body.available, "available");
  if (body.dietary !== undefined) payload.dietary = parseDietary(body.dietary);
  if (body.spicy !== undefined) payload.spicy = v.boolean(body.spicy, "spicy");
  if (body.prepTimeMinutes !== undefined) {
    payload.prepTimeMinutes = v.quantity(body.prepTimeMinutes, {
      field: "prepTimeMinutes",
      min: 0,
      max: 240,
    });
  }
  if (body.featured !== undefined) payload.featured = v.boolean(body.featured, "featured");
  if (body.addOns !== undefined) payload.addOns = addOnList(body.addOns);
  if (body.ingredients !== undefined) payload.ingredients = stringList(body.ingredients, { field: "ingredients" });
  if (body.allergens !== undefined) payload.allergens = stringList(body.allergens, { field: "allergens" });

  if (isAdmin && body.lowStockThreshold !== undefined) {
    payload.lowStockThreshold = v.quantity(body.lowStockThreshold, {
      field: "lowStockThreshold",
      min: 0,
      max: 100000,
    });
  }
  if (isAdmin && body.unit !== undefined) {
    payload.unit = v.oneOf(body.unit, UNITS, "unit");
  }

  // Optional stock tracking at creation. The starting stock is recorded in the
  // inventory ledger through the same path as enabling tracking later.
  const track = body.trackInventory !== undefined ? v.boolean(body.trackInventory, "trackInventory") : false;
  let startingStock = null;
  if (track) {
    if (body.stock === undefined) {
      throw ApiError.badRequest("stock is required when trackInventory is true");
    }
    startingStock = v.quantity(body.stock, { field: "stock", min: 0, max: 1000000 });
  } else if (body.stock !== undefined) {
    throw ApiError.badRequest("stock can only be set when trackInventory is true");
  }

  const food = await Food.create(payload);

  if (track) {
    try {
      await inventory.setTracking({
        foodId: food._id,
        enabled: true,
        stock: startingStock,
        actor: req.user,
        reason: "Initial stock on creation",
      });
    } catch (err) {
      // Do not leave an item half-configured: remove it and report the cause.
      await Food.deleteOne({ _id: food._id }).catch(() => {});
      throw err;
    }
    return res.status(201).json(await Food.findById(food._id));
  }

  res.status(201).json(food);
});

// Admin/staff: update food
router.put("/:id", authMiddleware, adminOrStaffMiddleware, async (req, res) => {
  const id = v.objectId(req.params.id, "food id");
  const body = v.object(req.body);

  const food = await Food.findById(id);
  if (!food) throw ApiError.notFound("Food item not found");

  // Explicit allow-list — the original piped the raw request body straight
  // into findByIdAndUpdate, allowing any field to be overwritten.
  if (body.name !== undefined) food.name = v.name(body.name, "name");
  if (body.description !== undefined) {
    food.description = v.optionalString(body.description, {
      field: "description",
      max: 600,
    }) || "";
  }
  if (body.price !== undefined) food.price = v.price(body.price);
  if (body.image !== undefined) food.image = v.optionalUrl(body.image) || null;
  if (body.category !== undefined) {
    food.category = v.optionalString(body.category, { field: "category", max: 60 }) || "General";
  }
  if (body.available !== undefined) food.available = v.boolean(body.available, "available");
  if (body.spicy !== undefined) food.spicy = v.boolean(body.spicy, "spicy");
  if (body.prepTimeMinutes !== undefined) {
    food.prepTimeMinutes = v.quantity(body.prepTimeMinutes, {
      field: "prepTimeMinutes",
      min: 0,
      max: 240,
    });
  }
  if (body.dietary !== undefined) food.dietary = parseDietary(body.dietary);
  if (body.featured !== undefined) food.featured = v.boolean(body.featured, "featured");
  if (body.addOns !== undefined) food.addOns = addOnList(body.addOns);
  if (body.ingredients !== undefined) food.ingredients = stringList(body.ingredients, { field: "ingredients" });
  if (body.allergens !== undefined) food.allergens = stringList(body.allergens, { field: "allergens" });
  if (body.stock !== undefined) {
    // Stock levels are administrator-only. Staff can still manage the menu.
    if (req.user.role !== "admin") {
      throw ApiError.forbidden("Only administrators can change stock levels");
    }
    // A tracked item's stock moves only through the inventory service, so
    // every change is written to the movement ledger.
    if (food.trackInventory === true) {
      throw ApiError.badRequest(
        "Stock of an inventory-tracked item is changed through POST /api/inventory/:id/adjust so the change is recorded"
      );
    }
    food.stock = body.stock === null ? null : v.quantity(body.stock, { field: "stock", min: 0, max: 100000 });
  }

  await food.save();
  res.json(food);
});

// Admin/staff: delete food
router.delete("/:id", authMiddleware, adminOrStaffMiddleware, async (req, res) => {
  const id = v.objectId(req.params.id, "food id");

  const food = await Food.findById(id);
  if (!food) throw ApiError.notFound("Food item not found");

  // Deleting an item with open reservations would orphan them: the order can
  // no longer be released or consumed against this item.
  if (food.trackInventory === true && (food.reserved ?? 0) > 0) {
    throw ApiError.conflict(
      `Cannot delete "${food.name}" while ${food.reserved} unit(s) are reserved for open orders`
    );
  }

  await food.deleteOne();
  res.json({ message: "Food deleted" });
});

module.exports = router;