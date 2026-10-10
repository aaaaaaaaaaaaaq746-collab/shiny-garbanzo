const express = require("express");
const Order = require("../models/Order");
const Food = require("../models/FoodItem");
const config = require("../config");
const {
  authMiddleware,
  adminOrStaffMiddleware,
} = require("../middleware/authMiddleware");
const ApiError = require("../utils/ApiError");
const v = require("../utils/validators");
const { emitOrderUpdate } = require("../realtime");
const inventory = require("../services/inventory");
const {
  STATUS,
  ORDER_STATUSES,
  assertTransition,
  requiresReason,
  allowedTransitions,
  canCancel,
  MAX_REASON_LENGTH,
} = require("../utils/orderLifecycle");

const router = express.Router();

const { maxQuantityPerItem, maxItemsPerOrder, strictLifecycle, statusHistoryLimit } =
  config.order;

// Statuses shown on the kitchen display: everything still in progress.
const KITCHEN_STATUSES = ["Pending", "Accepted", "Preparing", "Ready"];

/** Validate the optional reason and enforce it where policy demands one. */
function parseReason(body, { required, what }) {
  const reason = v.optionalString(body.reason, {
    field: "reason",
    max: MAX_REASON_LENGTH,
  });
  if (required && !reason) {
    throw ApiError.badRequest(`A ${what} reason is required`);
  }
  return reason || null;
}

/**
 * Apply the inventory consequences of a completed status transition.
 *
 * Rules (Phase 4):
 *  - Moving to Cancelled/Rejected from Pending/Accepted releases the
 *    outstanding reservation.
 *  - Cancelling from Preparing/Ready does NOT restore stock: the food has
 *    already been consumed. Recovering it requires a separate, authorised
 *    manual adjustment by an administrator.
 *  - Moving to Preparing, Ready or Completed consumes the reservation. Because
 *    skip-ahead transitions are allowed, entering Ready or Completed directly
 *    still consumes exactly once.
 *
 * Every step is idempotent via the ledger's unique operationId, so repeated
 * requests or duplicate real-time events cannot double-apply.
 */
async function applyInventoryForTransition({ from, to, order, actor, reason }) {
  const startsPreparation = ["Preparing", "Ready", "Completed"].includes(to);
  const endsBeforePreparation =
    ["Cancelled", "Rejected"].includes(to) && !["Preparing", "Ready", "Completed"].includes(from);

  if (startsPreparation) {
    const { consumed } = await inventory.consumeOrder({ order, actor });
    if (consumed.length) {
      await Order.updateOne(
        { _id: order._id },
        { $set: { "items.$[el].stockConsumed": true } },
        { arrayFilters: [{ "el.inventoryTracked": true, "el.stockConsumed": { $ne: true } }] }
      ).catch(() => {});
    }
    return { consumed: consumed.length, released: 0 };
  }

  if (endsBeforePreparation) {
    const { released } = await inventory.releaseOrder({ order, actor, reason });
    if (released.length) {
      await Order.updateOne(
        { _id: order._id },
        { $set: { "items.$[el].stockReleased": true } },
        { arrayFilters: [{ "el.inventoryTracked": true, "el.stockReleased": { $ne: true } }] }
      ).catch(() => {});
    }
    return { consumed: 0, released: released.length };
  }

  return { consumed: 0, released: 0 };
}
/**
 * Apply a transition atomically.
 *
 * The expected current status is part of the query filter, so the state is
 * verified as part of the mutation rather than merely read beforehand. If a
 * concurrent request wins the race this returns null and the caller reports a
 * conflict — the winning transition is preserved, never overwritten.
 *
 * The status change and its audit entry are written in the same atomic
 * operation, so a failed request can never leave a misleading successful
 * transition record behind.
 */
async function applyTransition({ orderId, expectedFrom, to, actor, reason }) {
  const entry = {
    status: to, // new status
    from: expectedFrom, // previous status
    at: new Date(),
    by: actor._id,
    role: actor.role,
    reason: reason || null,
  };

  const set = { status: to };
  if (to === STATUS.CANCELLED) set.cancelledAt = new Date();
  if (to === STATUS.COMPLETED) set.completedAt = new Date();

  // Retention: bound the in-document history to the most recent N entries in
  // the SAME atomic update (`$slice`), while `$inc` keeps an exact total so
  // nothing is silently discarded from the record. The lifecycle already caps
  // a normal order at ~5 transitions, so this only engages defensively.
  const updated = await Order.findOneAndUpdate(
    { _id: orderId, status: expectedFrom }, // <-- conditional guard
    {
      $set: set,
      $push: {
        statusHistory: { $each: [entry], $slice: -statusHistoryLimit },
      },
      $inc: { statusHistoryTotal: 1 },
    },
    { new: true }
  );

  if (!updated) {
    // Either a concurrent writer won, or the order was removed.
    const current = await Order.findById(orderId);
    if (!current) throw ApiError.notFound("Order not found");
    throw ApiError.conflict(
      `Order changed to ${current.status} before this update could be applied`
    );
  }

  return updated;
}

/**
 * Attach viewer-relative capabilities so the UI does not duplicate the
 * lifecycle rules. Both fields are additive.
 */
function decorate(order, user) {
  const plain = typeof order.toObject === "function" ? order.toObject() : order;

  plain.canCancel = canCancel({ order: plain, user });

  if (user && (user.role === "admin" || user.role === "staff")) {
    plain.allowedTransitions = allowedTransitions({
      from: plain.status,
      role: user.role,
      strict: strictLifecycle,
    });
  }

  return plain;
}

/**
 * Place an order.
 *
 * SECURITY: the client sends only `{ food, quantity }` per line. Names,
 * prices, subtotal and total are all computed here from the database, so
 * price tampering is impossible. The original implementation trusted the
 * submitted `total` and per-item `price` outright.
 */
router.post("/", authMiddleware, async (req, res) => {
  const body = v.object(req.body);

  const rawItems = v.array(body.items, { field: "items", max: maxItemsPerOrder });
  if (rawItems.length === 0) throw ApiError.badRequest("Cart is empty");

  // Validate every line first, then collapse duplicates.
  const requested = new Map();
  rawItems.forEach((raw, index) => {
    const item = v.object(raw, `items[${index}]`);
    const foodId = v.objectId(item.food, `items[${index}].food`);
    const qty = v.quantity(item.quantity, {
      field: `items[${index}].quantity`,
      min: 1,
      max: maxQuantityPerItem,
    });

    const next = (requested.get(foodId) || 0) + qty;
    if (next > maxQuantityPerItem) {
      throw ApiError.badRequest(
        `items[${index}].quantity exceeds the maximum of ${maxQuantityPerItem} per item`
      );
    }
    requested.set(foodId, next);
  });

  const foodIds = [...requested.keys()];
  const foods = await Food.find({ _id: { $in: foodIds } });

  // Detect ids that do not exist without leaking which one.
  if (foods.length !== foodIds.length) {
    throw ApiError.badRequest("Cart contains an item that no longer exists");
  }

  const byId = new Map(foods.map((f) => [f._id.toString(), f]));

  const items = [];
  let subtotal = 0;
  let maxPrep = 0;

  for (const [foodId, qty] of requested) {
    const food = byId.get(foodId);

    if (food.available === false) {
      throw ApiError.conflict(`"${food.name}" is currently unavailable`);
    }

    // Single source of truth for "can still be sold".
    //   tracked items : available = stock - reserved
    //   legacy items  : the Phase 1 `stock` value, or unlimited when null
    const sellable = food.sellableQty();
    if (sellable !== Infinity && sellable < qty) {
      throw ApiError.conflict(
        sellable <= 0
          ? `"${food.name}" is sold out`
          : `Only ${sellable} of "${food.name}" left`
      );
    }

    const unitPrice = v.roundMoney(food.price);
    subtotal = v.roundMoney(subtotal + unitPrice * qty);
    maxPrep = Math.max(maxPrep, food.prepTimeMinutes || 0);

    items.push({
      food: food._id,
      // Snapshotted from the database, never from the request.
      name: food.name,
      price: unitPrice,
      quantity: qty,
      // Phase 4: remember whether this line participates in stock accounting.
      inventoryTracked: food.trackInventory === true,
      reservedQty: food.trackInventory === true ? qty : null,
    });
  }

  const total = v.roundMoney(subtotal);

  const order = await Order.create({
    student: req.user._id,
    items,
    subtotal,
    discount: 0,
    total,
    status: STATUS.PENDING,
    statusHistory: [
      {
        status: STATUS.PENDING,
        from: null,
        at: new Date(),
        by: req.user._id,
        role: req.user.role,
        reason: null,
      },
    ],
    statusHistoryTotal: 1,
    estimatedReadyAt: maxPrep ? new Date(Date.now() + maxPrep * 60 * 1000) : null,
    pickupSlot: v.optionalString(body.pickupSlot, { field: "pickupSlot", max: 60 }) || null,
    notes: v.optionalString(body.notes, { field: "notes", max: 300 }) || null,
  });

  // ---------------------------------------------------------------------
  // Phase 4: commit stock BEFORE acknowledging the order.
  //
  // All-or-nothing. If any tracked line cannot be reserved, the reservations
  // already applied are compensated inside reserveOrder and the partially
  // created order is removed, so the student never sees a half-placed order.
  // ---------------------------------------------------------------------
  try {
    await inventory.reserveOrder({ order, items, actor: req.user });
  } catch (err) {
    // Compensating delete: the order was never acknowledged to the client.
    await Order.deleteOne({ _id: order._id }).catch(() => {});
    if (err instanceof inventory.InventoryError) {
      throw ApiError.conflict(err.message);
    }
    throw err;
  }

  // Record that the reservation happened, for auditing and clarity.
  if (items.some((i) => i.inventoryTracked)) {
    await Order.updateOne(
      { _id: order._id },
      { $set: { "items.$[el].stockReserved": true } },
      { arrayFilters: [{ "el.inventoryTracked": true }] }
    ).catch(() => {});
  }

  const fresh = await Order.findById(order._id);
  const response = decorate(fresh || order, req.user);

  // Emitted only after the document was actually persisted. A no-op when the
  // real-time layer is disabled.
  emitOrderUpdate({
    orderId: order._id,
    studentId: order.student,
    status: order.status,
    previousStatus: null,
    at: order.statusHistory[0].at,
  });

  res.status(201).json(response);
});

// Admin/staff: get all orders
router.get("/all", authMiddleware, adminOrStaffMiddleware, async (req, res) => {
  const query = {};
  if (req.query.status) {
    query.status = v.oneOf(req.query.status, ORDER_STATUSES, "status");
  }
  const orders = await Order.find(query)
    .sort({ date: -1 })
    .populate("student", "name email");
  res.json(orders.map((o) => decorate(o, req.user)));
});

// Student: get their own orders
router.get("/", authMiddleware, async (req, res) => {
  const orders = await Order.find({ student: req.user._id }).sort({ date: -1 });
  res.json(orders.map((o) => decorate(o, req.user)));
});

/**
 * Kitchen display feed (staff only).
 *
 * Returns the live queue only — orders still moving through the kitchen —
 * oldest first, because waiting time is the number the kitchen actually cares
 * about. Settled orders are excluded so this stays small as history grows.
 *
 * `allowedTransitions` comes from the same lifecycle module the REST status
 * endpoint uses, so the KDS can never offer an action the API would reject.
 */
router.get("/kitchen", authMiddleware, adminOrStaffMiddleware, async (req, res) => {
  const orders = await Order.find({ status: { $in: KITCHEN_STATUSES } })
    .sort({ date: 1 }) // oldest first = longest waiting at the top
    .populate("student", "name email");

  const now = Date.now();
  const feed = orders.map((o) => {
    const plain = decorate(o, req.user);
    // Baseline wait so the first paint is accurate before the client ticks.
    plain.waitSeconds = Math.max(0, Math.round((now - new Date(o.date).getTime()) / 1000));
    return plain;
  });

  res.json(feed);
});
// Single order — only the owner or staff may read it.
router.get("/:id", authMiddleware, async (req, res) => {
  const id = v.objectId(req.params.id, "order id");
  const order = await Order.findById(id).populate("student", "name email");
  if (!order) throw ApiError.notFound("Order not found");

  const isStaff = ["admin", "staff"].includes(req.user.role);
  if (!isStaff && order.student._id?.toString() !== req.user._id.toString()) {
    throw ApiError.forbidden("You can only view your own orders");
  }
  res.json(decorate(order, req.user));
});

/**
 * Update order status (admin/staff).
 *
 * Arbitrary status assignment is impossible: the requested status is checked
 * against the centralized lifecycle map for the actor's role, and the state is
 * re-verified atomically inside the update itself.
 */
router.put("/:id/status", authMiddleware, adminOrStaffMiddleware, async (req, res) => {
  const id = v.objectId(req.params.id, "order id");
  const body = v.object(req.body);

  const to = v.oneOf(body.status, ORDER_STATUSES, "status");

  const order = await Order.findById(id);
  if (!order) throw ApiError.notFound("Order not found");

  const from = order.status;

  // Throws 403 for an unauthorised role, 409 for an illegal transition.
  assertTransition({ from, to, role: req.user.role, strict: strictLifecycle });

  const reasonRequired = requiresReason({ to, role: req.user.role });
  const reason = parseReason(body, {
    required: reasonRequired,
    what: to === STATUS.REJECTED ? "rejection" : "cancellation",
  });

  const updated = await applyTransition({
    orderId: id,
    expectedFrom: from,
    to,
    actor: req.user,
    reason,
  });

  // Stock moves only after the status change committed.
  const inventoryResult = await applyInventoryForTransition({
    from,
    to,
    order: updated,
    actor: req.user,
    reason,
  });

  // Only after the atomic write succeeded. A refused transition throws above
  // and therefore never reaches this line.
  emitOrderUpdate({
    orderId: updated._id,
    studentId: updated.student,
    status: updated.status,
    previousStatus: from,
    at: updated.statusHistory[updated.statusHistory.length - 1]?.at,
  });

  res.json(decorate(updated, req.user));
});

/**
 * Cancel an order.
 *
 * A student may cancel only their OWN order, and only while it is still
 * Pending or Accepted — once preparation begins the request is refused.
 * An administrator may additionally cancel a Preparing or Ready order; that is
 * the explicit exception to the "no cancellation after prep" rule.
 *
 * Repeating the request on an already-cancelled order succeeds idempotently.
 */
router.post("/:id/cancel", authMiddleware, async (req, res) => {
  const id = v.objectId(req.params.id, "order id");
  const body = req.body ? v.object(req.body) : {};

  const order = await Order.findById(id);
  if (!order) throw ApiError.notFound("Order not found");

  // Ownership check. Students are confined to their own orders.
  if (req.user.role === "student" && String(order.student) !== String(req.user._id)) {
    throw ApiError.forbidden("You can only cancel your own orders");
  }

  const from = order.status;

  // Idempotent: a repeat cancellation of your own cancelled order is fine.
  if (from === STATUS.CANCELLED) {
    return res.json(decorate(order, req.user));
  }

  assertTransition({
    from,
    to: STATUS.CANCELLED,
    role: req.user.role,
    strict: strictLifecycle,
  });

  const reasonRequired = requiresReason({ to: STATUS.CANCELLED, role: req.user.role });
  const reason = parseReason(body, {
    required: reasonRequired,
    what: "cancellation",
  });

  const updated = await applyTransition({
    orderId: id,
    expectedFrom: from,
    to: STATUS.CANCELLED,
    actor: req.user,
    reason,
  });

  const inventoryResult = await applyInventoryForTransition({
    from,
    to: STATUS.CANCELLED,
    order: updated,
    actor: req.user,
    reason,
  });

  emitOrderUpdate({
    orderId: updated._id,
    studentId: updated.student,
    status: updated.status,
    previousStatus: from,
    at: updated.statusHistory[updated.statusHistory.length - 1]?.at,
  });

  res.json(decorate(updated, req.user));
});

module.exports = router;