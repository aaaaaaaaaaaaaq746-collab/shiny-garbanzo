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

const SORT_MAP = {
  name: { name: 1 },
  name_desc: { name: -1 },
  price_asc: { price: 1 },
  price_desc: { price: -1 },
  newest: { createdAt: -1 },
};

/**
 * List menu items.
 *
 * With no query parameters this returns a plain array, exactly as the original
 * route did, so existing consumers are unaffected. Supplying `search`,
 * `category`, `sort`, `available` or `dietary` filters server-side.
 */
router.get("/", async (req, res) => {
  const query = {};

  const search = v.optionalString(req.query.search, { field: "search", max: 100 });
  if (search) {
    const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    query.$or = [{ name: rx }, { description: rx }, { category: rx }];
  }

  if (req.query.category) {
    query.category = v.optionalString(req.query.category, { field: "category", max: 60 });
  }
  if (req.query.dietary) {
    query.dietary = req.query.dietary;
  }
  if (req.query.available !== undefined) {
    query.available = v.boolean(req.query.available, "available");
  }

  let sort = { createdAt: 1 };
  if (req.query.sort) {
    const key = String(req.query.sort);
    if (!SORT_MAP[key]) {
      throw ApiError.badRequest(
        `sort must be one of: ${Object.keys(SORT_MAP).join(", ")}`
      );
    }
    sort = SORT_MAP[key];
  }

  const foods = await Food.find(query).sort(sort);
  res.json(foods);
});

/** Distinct categories, for building filter controls. */
router.get("/categories", async (req, res) => {
  const categories = await Food.distinct("category");
  res.json(categories.filter(Boolean).sort());
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
  if (body.dietary !== undefined) payload.dietary = body.dietary;
  if (body.spicy !== undefined) payload.spicy = v.boolean(body.spicy, "spicy");
  if (body.prepTimeMinutes !== undefined) {
    payload.prepTimeMinutes = v.quantity(body.prepTimeMinutes, {
      field: "prepTimeMinutes",
      min: 0,
      max: 240,
    });
  }

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