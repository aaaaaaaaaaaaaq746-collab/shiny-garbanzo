/**
 * Analytics panel helpers. Pure.
 *
 * Dates are the browser's calendar days. The canteen runs on India time and
 * the admin is in India, so the browser's day is the canteen's day in practice.
 * The server re-checks every range it receives.
 */

export const MAX_RANGE_DAYS = 366;
export const DEFAULT_RANGE_DAYS = 30;

/** "YYYY-MM-DD" for a local calendar day. */
export function localDayKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Calendar-day arithmetic on keys, without time zones. */
export function addDaysToKey(key, n) {
  const [y, m, d] = key.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + n * 86400000);
  return t.toISOString().slice(0, 10);
}

/** The last 30 days including today, as the initial range. */
export function defaultRange(now = new Date()) {
  const to = localDayKey(now);
  return { from: addDaysToKey(to, -(DEFAULT_RANGE_DAYS - 1)), to };
}

/** A message when the range cannot be requested, or null when it is fine. */
export function rangeProblem({ from, to }) {
  if (!from || !to) return "Choose both a start and an end date";
  if (from > to) return "The start date must be on or before the end date";
  const span = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
  if (span > MAX_RANGE_DAYS) return `The range can be at most ${MAX_RANGE_DAYS} days`;
  return null;
}

/** Bar widths as percentages of the largest value. Zero stays zero. */
export function barPercents(values) {
  const max = Math.max(0, ...values.map((v) => Number(v) || 0));
  return values.map((v) => (max > 0 ? Math.round(((Number(v) || 0) / max) * 100) : 0));
}

/** "09:00" label for an hour of the day. */
export function hourLabel(hour) {
  return `${String(hour).padStart(2, "0")}:00`;
}
