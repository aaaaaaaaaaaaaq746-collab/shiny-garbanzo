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
const { resolveCart, openSlotsFor, pricingConfig } = require("../services/checkout");
const Coupon = require("../models/Coupon");
const { renderReceipt } = require("../utils/receipt");
const { parseOrderHistoryQuery, buildHistoryFilter } = require("../utils/orderHistory");
const slots = require("../utils/pickupSlots");
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

const { strictLifecycle, statusHistoryLimit } = config.order;
const canteen = config.canteen;

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
 * Inventory consequences of a status transition, for reference:
 *
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
/**
 * Which inventory work a transition needs: "consume", "release" or null.
 *
 * Moving into preparation consumes the reservation. Cancelling or rejecting
 * before preparation releases it. Cancelling from Preparing or Ready releases
 * nothing, because the food was already consumed; stock is not restored
 * automatically.
 */
function inventoryKindFor({ from, to }) {
  if (["Preparing", "Ready", "Completed"].includes(to)) return "consume";
  if (
    ["Cancelled", "Rejected"].includes(to) &&
    !["Preparing", "Ready", "Completed"].includes(from)
  ) {
    return "release";
  }
  return null;
}

/**
 * Perform one inventory step for an order, then clear its pending marker.
 *
 * Both the consume and release paths are idempotent (each line is claimed
 * first), so running this again after a failure is safe.
 */
async function runInventoryEffect({ kind, order, actor, reason }) {
  let result = { consumed: 0, released: 0 };

  if (kind === "consume") {
    const { consumed } = await inventory.consumeOrder({ order, actor });
    if (consumed.length) {
      await Order.updateOne(
        { _id: order._id },
        { $set: { "items.$[el].stockConsumed": true } },
        { arrayFilters: [{ "el.inventoryTracked": true, "el.stockConsumed": { $ne: true } }] }
      ).catch(() => {});
    }
    result = { consumed: consumed.length, released: 0 };
  } else if (kind === "release") {
    const { released } = await inventory.releaseOrder({ order, actor, reason });
    if (released.length) {
      await Order.updateOne(
        { _id: order._id },
        { $set: { "items.$[el].stockReleased": true } },
        { arrayFilters: [{ "el.inventoryTracked": true, "el.stockReleased": { $ne: true } }] }
      ).catch(() => {});
    }
    result = { consumed: 0, released: released.length };
  }

  // Clear the marker only if it is still the one we just completed. If this
  // throws, the marker stays and the next request retries the work.
  if (kind) {
    await Order.updateOne(
      { _id: order._id, inventoryPendingKind: kind },
      { $set: { inventoryPendingKind: null, inventoryPendingReason: null } }
    );
  }

  return result;
}

/**
 * Complete inventory work owed by an earlier request whose status change
 * committed but whose inventory step failed (P2-R2).
 *
 * Returns true when a pending step was found and completed. Callers that are
 * retrying a transition that already took effect can then return success.
 */
async function completePendingInventory({ order, actor }) {
  if (!order.inventoryPendingKind) return false;
  const fresh = await Order.findById(order._id);
  if (!fresh || !fresh.inventoryPendingKind) return false;
  await runInventoryEffect({
    kind: fresh.inventoryPendingKind,
    order: fresh,
    actor,
    reason: fresh.inventoryPendingReason || null,
  });
  return true;
}

/** Inventory step for a transition that has just committed. */
async function applyInventoryForTransition({ from, to, order, actor, reason }) {
  const kind = inventoryKindFor({ from, to });
  if (!kind) return { consumed: 0, released: 0 };
  return runInventoryEffect({ kind, order, actor, reason });
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
  // Inventory work this transition owes, recorded in the SAME atomic write as
  // the status change so a crash cannot leave a change without its marker.
  const pendingKind = inventoryKindFor({ from: expectedFrom, to });
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
  set.inventoryPendingKind = pendingKind;
  set.inventoryPendingReason = pendingKind ? reason || null : null;

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
function publicLine(line) {
  return {
    food: line.food,
    name: line.name,
    basePrice: line.basePrice,
    addOns: line.addOns,
    unitPrice: line.price,
    quantity: line.quantity,
    lineTotal: line.lineTotal,
    specialInstructions: line.specialInstructions,
  };
}

/**
 * Preview the bill for a cart without reserving stock or writing anything.
 *
 * Uses the same resolution as placing an order, so the total shown here is the
 * total the order is stored with.
 */
router.post("/quote", authMiddleware, async (req, res) => {
  const body = v.object(req.body);
  const { lines, bill, pickupAt, maxPrep } = await resolveCart(body);
  res.json({
    lines: lines.map(publicLine),
    bill,
    pickupAt: pickupAt ? pickupAt.toISOString() : null,
    estimatedPrepMinutes: maxPrep,
  });
});

/**
 * Place an order.
 *
 * SECURITY: the client sends only `{ food, quantity, addOns?, specialInstructions? }`
 * per line plus optional `pickupAt` and `couponCode`. Names, prices, add-on
 * prices, discounts, charges and totals are all computed here from the
 * database. Price tampering is impossible.
 */
router.post("/", authMiddleware, async (req, res) => {
  const body = v.object(req.body);
  const { lines, bill, coupon, pickupAt, maxPrep } = await resolveCart(body);

  // Claim one use of a limited coupon atomically before writing the order.
  // The conditional update means two checkouts cannot both take the last use.
  let couponClaimed = false;
  if (coupon) {
    const claim = await Coupon.updateOne(
      {
        _id: coupon._id,
        // Unlimited (null or missing usageLimit), or still below the limit.
        $expr: {
          $or: [
            { $eq: [{ $ifNull: ["$usageLimit", null] }, null] },
            { $lt: ["$usedCount", "$usageLimit"] },
          ],
        },
      },
      { $inc: { usedCount: 1 } }
    );
    if (claim.modifiedCount !== 1) {
      throw ApiError.conflict("This coupon has been fully used");
    }
    couponClaimed = true;
  }
  const releaseCoupon = () => {
    if (couponClaimed) {
      Coupon.updateOne({ _id: coupon._id }, { $inc: { usedCount: -1 } }).catch(() => {});
    }
  };

  const items = lines.map((l) => ({
    food: l.food,
    // Snapshotted from the database, never from the request.
    name: l.name,
    price: l.price,
    basePrice: l.basePrice,
    addOns: l.addOns,
    quantity: l.quantity,
    specialInstructions: l.specialInstructions,
    // Phase 4: remember whether this line participates in stock accounting.
    inventoryTracked: l.inventoryTracked,
    reservedQty: l.reservedQty,
  }));

  const now = new Date();
  let order;
  try {
    order = await Order.create({
      student: req.user._id,
      items,
      subtotal: bill.subtotal,
      discount: bill.discount,
      charges: bill.charges,
      couponCode: bill.couponCode,
      total: bill.total,
      status: STATUS.PENDING,
      statusHistory: [
        {
          status: STATUS.PENDING,
          from: null,
          at: now,
          by: req.user._id,
          role: req.user.role,
          reason: null,
        },
      ],
      statusHistoryTotal: 1,
      estimatedReadyAt: maxPrep ? new Date(Date.now() + maxPrep * 60 * 1000) : null,
      pickupAt,
      pickupSlot: v.optionalString(body.pickupSlot, { field: "pickupSlot", max: 60 }) || null,
      notes: v.optionalString(body.notes, { field: "notes", max: 300 }) || null,
    });
  } catch (err) {
    releaseCoupon();
    throw err;
  }

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
    releaseCoupon();
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

  // Popularity counter for bestseller and "most ordered" ranking.
  await Food.bulkWrite(
    items.map((i) => ({
      updateOne: { filter: { _id: i.food }, update: { $inc: { orderCount: i.quantity } } },
    })),
    { ordered: false }
  ).catch(() => {});

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

// Student: get their own orders. Optional filters: status, from, to, limit.
// With no parameters this returns the full history, as before.
router.get("/", authMiddleware, async (req, res) => {
  const opts = parseOrderHistoryQuery(req.query);
  let query = Order.find(buildHistoryFilter(req.user._id, opts)).sort({ date: -1 });
  if (opts.limit) query = query.limit(opts.limit);
  const orders = await query;
  res.json(orders.map((o) => decorate(o, req.user)));
});

/**
 * Open pickup slots.
 *
 * `foods=<id,id,...>` (optional) lets the server work out the longest prep time
 * for the cart, so the earliest slot is never earlier than the food can be
 * ready. Prep times come from the database, not from the client.
 */
router.get("/slots", authMiddleware, async (req, res) => {
  let maxPrep = 0;
  const raw = req.query.foods;
  if (raw !== undefined && raw !== "") {
    const ids = String(raw).split(",").map((x) => x.trim()).filter(Boolean);
    if (ids.length > 50) throw ApiError.badRequest("At most 50 foods can be checked at once");
    ids.forEach((id) => v.objectId(id, "foods"));
    const foods = await Food.find({ _id: { $in: ids } }, { prepTimeMinutes: 1 });
    maxPrep = foods.reduce((m, f) => Math.max(m, f.prepTimeMinutes || 0), 0);
  }
  const now = Date.now();
  const open = openSlotsFor(now, maxPrep);
  res.json({
    name: canteen.name,
    utcOffsetMinutes: canteen.utcOffsetMinutes,
    slotMinutes: canteen.slotMinutes,
    estimatedPrepMinutes: maxPrep,
    earliestReadyAt: new Date(
      slots.earliestReadyAt(now, maxPrep, canteen.prepBufferMinutes)
    ).toISOString(),
    slots: slots.describeSlots(open, canteen.utcOffsetMinutes),
  });
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
/**
 * Plain-text receipt for one order. Owner or staff only.
 *
 * The receipt reports the stored payment status. No payment or refund is
 * created by this route.
 */
router.get("/:id/receipt", authMiddleware, async (req, res) => {
  const id = v.objectId(req.params.id, "order id");
  const order = await Order.findById(id);
  if (!order) throw ApiError.notFound("Order not found");

  const isStaff = ["admin", "staff"].includes(req.user.role);
  if (!isStaff && order.student.toString() !== req.user._id.toString()) {
    throw ApiError.forbidden("You can only view receipts for your own orders");
  }

  const text = renderReceipt(order.toObject(), {
    canteenName: canteen.name,
    utcOffsetMinutes: canteen.utcOffsetMinutes,
  });
  res.type("text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `inline; filename="receipt-${order._id}.txt"`);
  res.send(text);
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

  let order = await Order.findById(id);
  if (!order) throw ApiError.notFound("Order not found");

  // Finish inventory work left pending by an earlier request before anything
  // else. If that request was this same transition, the retry succeeds.
  const reconciled = await completePendingInventory({ order, actor: req.user });
  if (reconciled) order = await Order.findById(id);
  const from = order.status;

  if (reconciled && to === from) {
    return res.json(decorate(order, req.user));
  }

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

  let order = await Order.findById(id);
  if (!order) throw ApiError.notFound("Order not found");

  // Ownership check. Students are confined to their own orders.
  if (req.user.role === "student" && String(order.student) !== String(req.user._id)) {
    throw ApiError.forbidden("You can only cancel your own orders");
  }

  // Finish inventory work left pending by an earlier request (P2-R2). A retry
  // of a cancellation whose release failed completes the release here.
  const reconciled = await completePendingInventory({ order, actor: req.user });
  if (reconciled) order = await Order.findById(id);

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