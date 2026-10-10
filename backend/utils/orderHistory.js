/**
 * Parse the order-history filters for a student's own orders.
 *
 * Pure function. Supported query parameters:
 *   status  one or more statuses, comma-separated (e.g. "Completed,Cancelled")
 *   from    ISO date (inclusive, start of the day in UTC)
 *   to      ISO date (inclusive, end of the day in UTC)
 *   limit   1..500; omitted means no limit (the full history, newest first)
 */

const ApiError = require("./ApiError");
const { ORDER_STATUSES } = require("./orderLifecycle");

// Without a limit the history is returned whole, as before. An explicit limit is
// capped so a client cannot request an unbounded page.
const MAX_LIMIT = 500;

function parseDateParam(raw, field, endOfDay) {
  if (raw === undefined || raw === "") return null;
  const text = String(raw).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw ApiError.badRequest(`${field} must be a date in YYYY-MM-DD format`);
  }
  const d = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw ApiError.badRequest(`${field} is not a valid date`);
  if (endOfDay) d.setUTCHours(23, 59, 59, 999);
  return d;
}

function parseOrderHistoryQuery(query = {}) {
  let statuses = null;
  if (query.status !== undefined && query.status !== "") {
    statuses = String(query.status)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const s of statuses) {
      if (!ORDER_STATUSES.includes(s)) {
        throw ApiError.badRequest(`status must be one of: ${ORDER_STATUSES.join(", ")}`);
      }
    }
    if (statuses.length === 0) statuses = null;
  }

  const from = parseDateParam(query.from, "from", false);
  const to = parseDateParam(query.to, "to", true);
  if (from && to && from > to) {
    throw ApiError.badRequest("from cannot be after to");
  }

  let limit = null;
  if (query.limit !== undefined && query.limit !== "") {
    const n = Number(query.limit);
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
      throw ApiError.badRequest(`limit must be a whole number from 1 to ${MAX_LIMIT}`);
    }
    limit = n;
  }

  return { statuses, from, to, limit };
}

/** Mongo filter for the student's own orders matching the parsed options. */
function buildHistoryFilter(studentId, opts) {
  const filter = { student: studentId };
  if (opts.statuses) filter.status = { $in: opts.statuses };
  if (opts.from || opts.to) {
    filter.date = {};
    if (opts.from) filter.date.$gte = opts.from;
    if (opts.to) filter.date.$lte = opts.to;
  }
  return filter;
}

module.exports = { parseOrderHistoryQuery, buildHistoryFilter, MAX_LIMIT };
