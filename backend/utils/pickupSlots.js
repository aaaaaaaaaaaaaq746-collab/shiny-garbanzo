/**
 * Pickup time slots.
 *
 * Slots sit on a fixed grid in canteen-local time (UTC offset from config,
 * default India). The grid is computed with plain arithmetic, so it does not
 * depend on the server's own timezone. Pure module: no database, no clock
 * other than the `now` argument.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

/**
 * Every pickup slot start (epoch ms) that is open for ordering.
 *
 * - Starts on `slotMinutes` boundaries in local time.
 * - Runs from `openHour` up to, but not including, `closeHour`.
 * - Covers `days` local calendar days starting today.
 * - Excludes anything before `earliestMs` (typically now + prep time).
 */
function generatePickupSlots({
  now,
  earliestMs,
  openHour,
  closeHour,
  slotMinutes,
  utcOffsetMinutes,
  days,
}) {
  if (!(slotMinutes > 0) || openHour >= closeHour) return [];

  const offsetMs = utcOffsetMinutes * MIN_MS;
  const earliest = Math.max(now, earliestMs ?? now);
  // Local midnight of today, expressed as a UTC instant.
  const localMidnightToday = Math.floor((now + offsetMs) / DAY_MS) * DAY_MS - offsetMs;

  const slots = [];
  for (let day = 0; day < days; day += 1) {
    const dayStart = localMidnightToday + day * DAY_MS;
    for (let minute = openHour * 60; minute + slotMinutes <= closeHour * 60; minute += slotMinutes) {
      const at = dayStart + minute * MIN_MS;
      if (at >= earliest) slots.push(at);
    }
  }
  return slots;
}

/** True when `atMs` is exactly one of the open slots. */
function isOpenPickupSlot(atMs, slots) {
  return Number.isFinite(atMs) && slots.includes(atMs);
}

/** Human label in canteen-local time, e.g. "2026-10-10 14:30". */
function formatSlotLabel(atMs, utcOffsetMinutes) {
  const local = new Date(atMs + utcOffsetMinutes * MIN_MS).toISOString();
  return `${local.slice(0, 10)} ${local.slice(11, 16)}`;
}

/** Slot list shaped for the API: { at (ISO), label }. */
function describeSlots(slots, utcOffsetMinutes) {
  return slots.map((at) => ({
    at: new Date(at).toISOString(),
    label: formatSlotLabel(at, utcOffsetMinutes),
  }));
}

/**
 * Earliest moment an order placed now could be ready, adding a buffer.
 * `maxPrepMinutes` is the longest preparation time in the cart.
 */
function earliestReadyAt(now, maxPrepMinutes, bufferMinutes) {
  return now + (maxPrepMinutes + bufferMinutes) * MIN_MS;
}

module.exports = {
  generatePickupSlots,
  isOpenPickupSlot,
  formatSlotLabel,
  describeSlots,
  earliestReadyAt,
};
