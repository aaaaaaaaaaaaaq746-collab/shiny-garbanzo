const express = require("express");
const mongoose = require("mongoose");
const Food = require("../models/FoodItem");
const InventoryMovement = require("../models/InventoryMovement");
const {
  authMiddleware,
  adminMiddleware,
} = require("../middleware/authMiddleware");
const { emitInventoryUpdate } = require("../realtime");
const inventory = require("../services/inventory");
const ApiError = require("../utils/ApiError");
const v = require("../utils/validators");

/**
 * Inventory management API.
 *
 * ADMINISTRATOR ONLY. The existing permission model lets `staff` manage the
 * menu, but stock levels and adjustments are deliberately restricted to
 * administrators. This is enforced here on the backend, not by hiding buttons.
 */

const router = express.Router();

/** Translate service errors into the project's standard HTTP responses. */
function rethrow(err) {
  if (err instanceof inventory.InventoryError) {
    throw new ApiError(err.statusCode, err.message);
  }
  throw err;
}

/**
 * Inventory overview for every menu item, including untracked ones.
 * Supports search, category and stock-state filtering.
 */
router.get("/", authMiddleware, adminMiddleware, async (req, res) => {
  const query = {};

  const search = v.optionalString(req.query.search, { field: "search", max: 100 });
  if (search) {
    const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    query.$or = [{ name: rx }, { category: rx }];
  }
  if (req.query.category) {
    query.category = v.optionalString(req.query.category, { field: "category", max: 60 });
  }

  const state = req.query.state;
  if (state) {
    if (!["tracked", "untracked", "low", "out", "ok"].includes(state)) {
      throw ApiError.badRequest("state must be one of: tracked, untracked, low, out, ok");
    }
    if (state === "tracked") query.trackInventory = true;
    if (state === "untracked") query.trackInventory = false;
    if (state === "low" || state === "out") {
      query.trackInventory = true;
      query.$expr = {
        [state === "out" ? "$lte" : "$lte"]: [
          { $subtract: ["$stock", "$reserved"] },
          state === "out" ? 0 : "$lowStockThreshold",
        ],
      };
    }
    if (state === "ok") {
      query.trackInventory = true;
      query.$expr = {
        $gt: [{ $subtract: ["$stock", "$reserved"] }, "$lowStockThreshold"],
      };
    }
  }

  const items = await Food.find(query).sort({ name: 1 });

  const payload = items.map((f) => {
    const plain = typeof f.toObject === "function" ? f.toObject() : f;
    const available = f.trackInventory ? Math.max(0, (f.stock ?? 0) - (f.reserved ?? 0)) : null;
    plain.availableQty = available;
    plain.lowStock = f.trackInventory ? available <= f.lowStockThreshold : false;
    plain.outOfStock = f.trackInventory ? available <= 0 : false;
    // Unacknowledged low/out conditions surface as a "new" alert exactly once.
    // Active = never acknowledged, OR acknowledged before the last change.
    plain.lowStockAlertActive =
      f.trackInventory &&
      available <= f.lowStockThreshold &&
      (!f.lowStockAcknowledgedAt ||
        (!!f.lastStockAdjustmentAt && f.lastStockAdjustmentAt > f.lowStockAcknowledgedAt));
    return plain;
  });

  res.json(payload);
});

/** Low-stock and out-of-stock alerts. */
router.get("/low-stock", authMiddleware, adminMiddleware, async (req, res) => {
  const items = await inventory.lowStockItems();
  const payload = items.map((f) => {
    const plain = f.toObject();
    const available = Math.max(0, (f.stock ?? 0) - (f.reserved ?? 0));
    plain.availableQty = available;
    plain.outOfStock = available <= 0;
    // Active = never acknowledged, OR acknowledged before the last change.
    plain.lowStockAlertActive =
      !f.lowStockAcknowledgedAt ||
      (!!f.lastStockAdjustmentAt && f.lastStockAdjustmentAt > f.lowStockAcknowledgedAt);
    return plain;
  });
  res.json({
    alerts: payload,
    counts: {
      total: payload.length,
      outOfStock: payload.filter((p) => p.outOfStock).length,
      low: payload.filter((p) => !p.outOfStock).length,
      unacknowledged: payload.filter((p) => p.lowStockAlertActive).length,
    },
  });
});

/** Acknowledge the current low-stock condition for one or all items. */
router.post("/low-stock/ack", authMiddleware, adminMiddleware, async (req, res) => {
  const body = req.body ? v.object(req.body) : {};
  const filter = { trackInventory: true };

  if (body.foodId) {
    filter._id = v.objectId(body.foodId, "foodId");
  }

  await Food.updateMany(filter, { $set: { lowStockAcknowledgedAt: new Date() } });
  res.json({ acknowledged: true });
});

/** Movement ledger for a single food item. */
router.get("/:foodId/movements", authMiddleware, adminMiddleware, async (req, res) => {
  const foodId = v.objectId(req.params.foodId, "food id");

  const food = await Food.findById(foodId);
  if (!food) throw ApiError.notFound("Food item not found");

  const limit = v.quantity(req.query.limit || 100, { field: "limit", min: 1, max: 500 });

  const movements = await InventoryMovement.find({ food: foodId })
    .sort({ at: -1 })
    .limit(limit)
    .populate("actor", "name email role")
    .populate("order", "status date");

  res.json(movements);
});

/** Enable or disable inventory tracking for an item. */
router.post("/:foodId/tracking", authMiddleware, adminMiddleware, async (req, res) => {
  const foodId = v.objectId(req.params.foodId, "food id");
  const body = v.object(req.body);

  if (typeof body.enabled !== "boolean") {
    throw ApiError.badRequest("enabled must be a boolean");
  }
  let stock;
  if (body.enabled === true && body.stock !== undefined) {
    stock = v.quantity(body.stock, { field: "stock", min: 0, max: 1_000_000 });
  }

  let updated;
  try {
    updated = await inventory.setTracking({
      foodId,
      enabled: body.enabled,
      stock,
      actor: req.user,
      reason: v.optionalString(body.reason, { field: "reason", max: 300 }),
    });
  } catch (err) {
    rethrow(err);
  }

  emitInventoryUpdate({ foodId, reason: "tracking", item: updated });
  res.json(updated);
});

/** Manual stock adjustment. Reason is mandatory. */
router.post("/:foodId/adjust", authMiddleware, adminMiddleware, async (req, res) => {
  const foodId = v.objectId(req.params.foodId, "food id");
  const body = v.object(req.body);

  // Must be a signed whole number; 0 is rejected by the service.
  let delta;
  if (body.set !== undefined) {
    const target = v.quantity(body.set, { field: "set", min: 0, max: 1_000_000 });
    const food = await Food.findById(foodId);
    if (!food) throw ApiError.notFound("Food item not found");
    delta = target - (food.stock ?? 0);
    if (delta === 0) throw ApiError.badRequest("Stock is already at that value");
  } else {
    if (body.delta === undefined) throw ApiError.badRequest("delta or set is required");
    if (typeof body.delta !== "number" || !Number.isInteger(body.delta)) {
      throw ApiError.badRequest("delta must be a whole number");
    }
    delta = body.delta;
  }

  const reason = v.optionalString(body.reason, { field: "reason", max: 300 });
  if (!reason) throw ApiError.badRequest("A reason is required for stock adjustments");

  let updated;
  try {
    updated = await inventory.adjustStock({
      foodId,
      delta,
      reason,
      actor: req.user,
      unit: v.optionalString(body.unit, { field: "unit", max: 20 }),
    });
  } catch (err) {
    rethrow(err);
  }

  emitInventoryUpdate({ foodId, reason: "adjustment", item: updated });
  res.json(updated);
});

/** Manual sold-out / availability toggle (separate from stock levels). */
router.post("/:foodId/availability", authMiddleware, adminMiddleware, async (req, res) => {
  const foodId = v.objectId(req.params.foodId, "food id");
  const body = v.object(req.body);

  if (typeof body.available !== "boolean") {
    throw ApiError.badRequest("available must be a boolean");
  }

  const updated = await Food.findByIdAndUpdate(
    foodId,
    { $set: { available: body.available, updatedAt: new Date() } },
    { new: true }
  );
  if (!updated) throw ApiError.notFound("Food item not found");

  emitInventoryUpdate({ foodId, reason: "availability", item: updated });
  res.json(updated);
});

module.exports = router;