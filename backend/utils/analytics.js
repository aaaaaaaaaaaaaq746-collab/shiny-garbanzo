/**
 * Sales analytics arithmetic. Pure: no database, no request objects.
 *
 * Days are canteen-local calendar days (CANTEEN_UTC_OFFSET_MINUTES), so
 * "today" and the weekly and monthly buckets match what staff see on the
 * counter, not what UTC says.
 *
 * Definitions used everywhere:
 *   - a SALE is any order that is not Cancelled or Rejected;
 *   - revenue is the sum of `total` over sales;
 *   - average order value is revenue divided by the number of sales;
 *   - the day an order counts toward is the day it was placed.
 */

const ApiError = require("./ApiError");

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 366;
const DEFAULT_RANGE_DAYS = 30;
const GRANULARITIES = Object.freeze(["daily", "weekly", "monthly"]);
const NOT_SALES = new Set(["Cancelled", "Rejected"]);

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/** "YYYY-MM-DD" for an instant, as seen in the canteen's zone. */
function dayKeyOf(ms, utcOffsetMinutes) {
  return new Date(ms + utcOffsetMinutes * 60 * 1000).toISOString().slice(0, 10);
}

/** Validate a "YYYY-MM-DD" string that names a real calendar day. */
function parseDayKey(text, field) {
  const m = DAY_RE.exec(String(text || ""));
  if (!m) throw ApiError.badRequest(`${field} must be a date in the form YYYY-MM-DD`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    throw ApiError.badRequest(`${field} is not a real calendar date`);
  }
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** Calendar-day arithmetic on keys (no time zone involved). */
function addDays(key, n) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Instant at which a canteen-local day starts. */
function dayStartMs(key, utcOffsetMinutes) {
  const [y, m, d] = key.split("-").map(Number);
  return Date.UTC(y, m - 1, d) - utcOffsetMinutes * 60 * 1000;
}

/**
 * Inclusive day range from query parameters. Defaults to the last 30 canteen
 * days ending today. Ranges longer than a year are refused.
 */
function resolveRange({ from, to, now, utcOffsetMinutes }) {
  const toKey = to ? parseDayKey(to, "to") : dayKeyOf(now, utcOffsetMinutes);
  const fromKey = from ? parseDayKey(from, "from") : addDays(toKey, -(DEFAULT_RANGE_DAYS - 1));
  if (fromKey > toKey) throw ApiError.badRequest("from must be on or before to");

  const spanDays = Math.round((Date.parse(`${toKey}T00:00:00Z`) - Date.parse(`${fromKey}T00:00:00Z`)) / DAY_MS) + 1;
  if (spanDays > MAX_RANGE_DAYS) {
    throw ApiError.badRequest(`The date range can be at most ${MAX_RANGE_DAYS} days`);
  }

  return {
    fromKey,
    toKey,
    startMs: dayStartMs(fromKey, utcOffsetMinutes),
    endMs: dayStartMs(addDays(toKey, 1), utcOffsetMinutes),
    spanDays,
  };
}

function parseGranularity(text) {
  const value = text === undefined || text === "" ? "daily" : String(text);
  if (!GRANULARITIES.includes(value)) {
    throw ApiError.badRequest(`granularity must be one of: ${GRANULARITIES.join(", ")}`);
  }
  return value;
}

/** Period key a day belongs to: the day itself, its Monday (ISO week), or its month. */
function periodKeyFor(dayKey, granularity) {
  if (granularity === "daily") return dayKey;
  if (granularity === "monthly") return dayKey.slice(0, 7);
  const [y, m, d] = dayKey.split("-").map(Number);
  const weekday = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // Monday = 0
  return addDays(dayKey, -weekday);
}

/**
 * Sum per-day figures into daily, weekly or monthly buckets.
 * `days` is [{ dayKey, revenue, orders }]. Result is sorted by period.
 */
function bucketRevenue(days, granularity) {
  const buckets = new Map();
  for (const day of days) {
    const key = periodKeyFor(day.dayKey, granularity);
    const b = buckets.get(key) || { period: key, revenue: 0, orders: 0 };
    b.revenue += day.revenue;
    b.orders += day.orders;
    buckets.set(key, b);
  }
  return [...buckets.values()]
    .sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : 0))
    .map((b) => ({
      period: b.period,
      revenue: round2(b.revenue),
      orders: b.orders,
      averageOrderValue: b.orders ? round2(b.revenue / b.orders) : 0,
    }));
}

/**
 * Headline figures for a set of orders. `orders` need `status`, `total` and
 * `date`. "Today" is the canteen's current day.
 */
function summarizeOrders(orders, { now, utcOffsetMinutes }) {
  const todayKey = dayKeyOf(now, utcOffsetMinutes);
  const out = {
    sales: 0,
    revenue: 0,
    averageOrderValue: 0,
    completed: 0,
    cancelled: 0,
    rejected: 0,
    todayKey,
    todaySales: 0,
    todayRevenue: 0,
    todayAverageOrderValue: 0,
  };

  for (const o of orders) {
    if (o.status === "Cancelled") out.cancelled += 1;
    if (o.status === "Rejected") out.rejected += 1;
    if (o.status === "Completed") out.completed += 1;
    if (NOT_SALES.has(o.status)) continue;

    const total = Number(o.total) || 0;
    out.sales += 1;
    out.revenue += total;
    if (dayKeyOf(new Date(o.date).getTime(), utcOffsetMinutes) === todayKey) {
      out.todaySales += 1;
      out.todayRevenue += total;
    }
  }

  out.revenue = round2(out.revenue);
  out.todayRevenue = round2(out.todayRevenue);
  out.averageOrderValue = out.sales ? round2(out.revenue / out.sales) : 0;
  out.todayAverageOrderValue = out.todaySales ? round2(out.todayRevenue / out.todaySales) : 0;
  return out;
}

/**
 * Per-item sales over sales orders, ranked. `lines` are order lines
 * [{ foodId, name, quantity, lineTotal }]. `catalog` is the whole menu
 * [{ id, name, category }], so items that sold nothing still appear in the
 * least-popular list.
 */
function rankItems(lines, catalog, limit = 5) {
  const byFood = new Map();
  for (const item of catalog) {
    byFood.set(String(item.id), { foodId: String(item.id), name: item.name, category: item.category || "", quantity: 0, revenue: 0 });
  }
  for (const line of lines) {
    const key = String(line.foodId);
    const row = byFood.get(key) || { foodId: key, name: line.name, category: "", quantity: 0, revenue: 0 };
    row.quantity += Number(line.quantity) || 0;
    row.revenue += Number(line.lineTotal) || 0;
    byFood.set(key, row);
  }

  const rows = [...byFood.values()].map((r) => ({ ...r, revenue: round2(r.revenue) }));
  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

  const popular = rows
    .filter((r) => r.quantity > 0)
    .sort((a, b) => b.quantity - a.quantity || b.revenue - a.revenue || byName(a, b))
    .slice(0, limit);

  const leastPopular = [...rows]
    .sort((a, b) => a.quantity - b.quantity || a.revenue - b.revenue || byName(a, b))
    .slice(0, limit);

  return { popular, leastPopular };
}

/** Sales counts by hour of the canteen's day: 24 numbers, index 0 = midnight. */
function peakHours(times, utcOffsetMinutes) {
  const hours = new Array(24).fill(0);
  for (const t of times) {
    const ms = new Date(t).getTime();
    if (!Number.isFinite(ms)) continue;
    const local = new Date(ms + utcOffsetMinutes * 60 * 1000);
    hours[local.getUTCHours()] += 1;
  }
  return hours;
}

module.exports = {
  GRANULARITIES,
  MAX_RANGE_DAYS,
  NOT_SALES,
  dayKeyOf,
  parseDayKey,
  addDays,
  dayStartMs,
  resolveRange,
  parseGranularity,
  periodKeyFor,
  bucketRevenue,
  summarizeOrders,
  rankItems,
  peakHours,
};
