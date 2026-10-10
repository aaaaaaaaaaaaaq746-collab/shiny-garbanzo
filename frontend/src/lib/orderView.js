import { isActive } from "../orderStatus.js";

/** Minutes until the estimated ready time, or null when there is no estimate. */
export function minutesUntil(iso, now) {
  if (!iso) return null;
  const diff = new Date(iso).getTime() - now;
  return Math.round(diff / 60000);
}

/** Wait wording for an active order. Null for closed orders or no estimate. */
export function waitLabel(order, now) {
  if (!isActive(order.status)) return null;
  const mins = minutesUntil(order.estimatedReadyAt, now);
  if (mins === null) return null;
  if (mins > 0) return `About ${mins} min left`;
  return "Should be ready any moment";
}
