/**
 * Meal-period and schedule helpers for the menu forms. Pure.
 *
 * The browser's datetime-local inputs are local time. The API takes ISO
 * instants, so these convert in both directions.
 */

export const MEAL_PERIOD_CHOICES = Object.freeze([
  ["breakfast", "Breakfast"],
  ["lunch", "Lunch"],
  ["snacks", "Snacks"],
  ["dinner", "Dinner"],
]);

export const MEAL_PERIOD_LABEL = Object.freeze(Object.fromEntries(MEAL_PERIOD_CHOICES));

/** "2026-10-10T09:30" (local) to an ISO instant. Empty gives null. */
export function localInputToIso(text) {
  const s = String(text ?? "").trim();
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error("Enter a valid date and time");
  return d.toISOString();
}

/** ISO instant to a datetime-local value in the browser's zone. */
export function isoToLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Plain-language summary of when an item is served, for the menu list. */
export function servingSummary(food) {
  const parts = [];
  const periods = Array.isArray(food.menuPeriods) ? food.menuPeriods : [];
  parts.push(periods.length ? periods.map((p) => MEAL_PERIOD_LABEL[p] || p).join(", ") : "All day");
  if (food.servesFrom || food.servesUntil) {
    const from = food.servesFrom ? isoToLocalInput(food.servesFrom).replace("T", " ") : "any time";
    const until = food.servesUntil ? isoToLocalInput(food.servesUntil).replace("T", " ") : "open-ended";
    parts.push(`${from} to ${until}`);
  }
  return parts.join(" · ");
}
