/**
 * Sales analytics and CSV export (Phase 2 section 5). Administrators only.
 *
 * All figures are computed by utils/analytics.js from order documents in the
 * requested range. Refunds are reported from the stored payment status only;
 * this system does not process payments, so it never creates a refund.
 */

const express = require("express");
const Order = require("../models/Order");
const Food = require("../models/FoodItem");
const config = require("../config");
const { authMiddleware, adminMiddleware } = require("../middleware/authMiddleware");
const ApiError = require("../utils/ApiError");
const analytics = require("../utils/analytics");
const { toCsv } = require("../utils/csv");

const router = express.Router();
router.use(authMiddleware, adminMiddleware);

const utcOffset = () => config.canteen.utcOffsetMinutes;

function rangeFrom(query) {
  return analytics.resolveRange({
    from: query.from,
    to: query.to,
    now: Date.now(),
    utcOffsetMinutes: utcOffset(),
  });
}

/** Orders placed in the range. Only the fields analytics needs; no student identity. */
async function loadOrders(range) {
  return Order.find({ date: { $gte: new Date(range.startMs), $lt: new Date(range.endMs) } })
    .select("date status total paymentStatus priority items")
    .lean();
}

/** What is recorded about refunds. Nothing here creates or infers a refund. */
function refundSummary(orders) {
  const recorded = { count: 0, amount: 0 };
  const awaitingManual = { count: 0, amount: 0 };
  for (const o of orders) {
    const total = Number(o.total) || 0;
    if (o.paymentStatus === "refunded") {
      recorded.count += 1;
      recorded.amount += total;
    }
    // Cancelled or rejected after payment was recorded: someone must refund it
    // by hand. This system has no payment gateway, so it is only flagged here.
    if (analytics.NOT_SALES.has(o.status) && o.paymentStatus === "paid") {
      awaitingManual.count += 1;
      awaitingManual.amount += total;
    }
  }
  return {
    recorded: { count: recorded.count, amount: Math.round(recorded.amount * 100) / 100 },
    awaitingManualRefund: {
      count: awaitingManual.count,
      amount: Math.round(awaitingManual.amount * 100) / 100,
    },
    note: "Refunds are reported from the recorded payment status only. No refund is created by this system.",
  };
}

/** Sales lines: one per order line of every sale in the range. */
function saleLines(orders) {
  const lines = [];
  for (const o of orders) {
    if (analytics.NOT_SALES.has(o.status)) continue;
    for (const item of o.items || []) {
      lines.push({
        foodId: item.food,
        name: item.name,
        quantity: item.quantity,
        lineTotal: (Number(item.price) || 0) * (Number(item.quantity) || 0),
      });
    }
  }
  return lines;
}

/** One figure per canteen day in the range, zeros included, so the chart has no gaps. */
function dailyTotals(orders, range) {
  const byDay = new Map();
  for (const o of orders) {
    if (analytics.NOT_SALES.has(o.status)) continue;
    const key = analytics.dayKeyOf(new Date(o.date).getTime(), utcOffset());
    const d = byDay.get(key) || { dayKey: key, revenue: 0, orders: 0 };
    d.revenue += Number(o.total) || 0;
    d.orders += 1;
    byDay.set(key, d);
  }
  const days = [];
  for (let key = range.fromKey; key <= range.toKey; key = analytics.addDays(key, 1)) {
    days.push(byDay.get(key) || { dayKey: key, revenue: 0, orders: 0 });
  }
  return days;
}

router.get("/summary", async (req, res) => {
  const range = rangeFrom(req.query);
  const orders = await loadOrders(range);
  res.json({
    range: { from: range.fromKey, to: range.toKey, days: range.spanDays },
    ...analytics.summarizeOrders(orders, { now: Date.now(), utcOffsetMinutes: utcOffset() }),
    refunds: refundSummary(orders),
  });
});

router.get("/revenue", async (req, res) => {
  const range = rangeFrom(req.query);
  const granularity = analytics.parseGranularity(req.query.granularity);
  const orders = await loadOrders(range);
  res.json({
    range: { from: range.fromKey, to: range.toKey },
    granularity,
    buckets: analytics.bucketRevenue(dailyTotals(orders, range), granularity),
  });
});

router.get("/items", async (req, res) => {
  const range = rangeFrom(req.query);
  const limit = Math.min(Math.max(Number(req.query.limit) || 5, 1), 50);
  const [orders, foods] = await Promise.all([
    loadOrders(range),
    Food.find({}, { name: 1, category: 1 }).lean(),
  ]);
  const catalog = foods.map((f) => ({ id: f._id, name: f.name, category: f.category }));
  res.json({
    range: { from: range.fromKey, to: range.toKey },
    ...analytics.rankItems(saleLines(orders), catalog, limit),
  });
});

router.get("/peak-hours", async (req, res) => {
  const range = rangeFrom(req.query);
  const orders = await loadOrders(range);
  const sales = orders.filter((o) => !analytics.NOT_SALES.has(o.status));
  const hours = analytics.peakHours(
    sales.map((o) => o.date),
    utcOffset()
  );
  res.json({
    range: { from: range.fromKey, to: range.toKey },
    hours: hours.map((count, hour) => ({ hour, sales: count })),
  });
});

router.get("/refunds", async (req, res) => {
  const range = rangeFrom(req.query);
  const orders = await loadOrders(range);
  res.json({ range: { from: range.fromKey, to: range.toKey }, ...refundSummary(orders) });
});

/**
 * CSV download. type=orders (one row per order, no student identity) or
 * type=items (one row per menu item). Opens in Excel and Google Sheets.
 */
router.get("/export.csv", async (req, res) => {
  const range = rangeFrom(req.query);
  const type = req.query.type === undefined ? "orders" : String(req.query.type);
  if (!["orders", "items"].includes(type)) throw ApiError.badRequest("type must be orders or items");

  const orders = await loadOrders(range);
  let csv;
  if (type === "orders") {
    csv = toCsv(
      [
        { key: "orderId", label: "Order ID" },
        { key: "placedAt", label: "Placed at (UTC)" },
        { key: "status", label: "Status" },
        { key: "priority", label: "Priority" },
        { key: "lines", label: "Lines" },
        { key: "total", label: "Total" },
        { key: "paymentStatus", label: "Payment status" },
      ],
      orders.map((o) => ({
        orderId: String(o._id),
        placedAt: new Date(o.date).toISOString(),
        status: o.status,
        priority: o.priority || "normal",
        lines: (o.items || []).length,
        total: Number(o.total) || 0,
        paymentStatus: o.paymentStatus || "unpaid",
      }))
    );
  } else {
    const rows = [];
    const byName = new Map();
    for (const line of saleLines(orders)) {
      const key = String(line.foodId);
      const row = byName.get(key) || { item: line.name, quantity: 0, revenue: 0 };
      row.quantity += line.quantity;
      row.revenue += line.lineTotal;
      byName.set(key, row);
    }
    for (const row of byName.values()) rows.push({ ...row, revenue: Math.round(row.revenue * 100) / 100 });
    rows.sort((a, b) => b.quantity - a.quantity || (a.item < b.item ? -1 : 1));
    csv = toCsv(
      [
        { key: "item", label: "Item" },
        { key: "quantity", label: "Quantity sold" },
        { key: "revenue", label: "Revenue" },
      ],
      rows
    );
  }

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="sales-${type}-${range.fromKey}-to-${range.toKey}.csv"`
  );
  res.send(csv);
});

module.exports = router;
