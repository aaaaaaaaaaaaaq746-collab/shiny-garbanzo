/**
 * Shared order-status presentation helpers.
 *
 * The lifecycle RULES are enforced server-side only; this file is purely
 * presentational so the student dashboard, admin board and kitchen display
 * cannot drift apart on labels, colours and progress.
 */

/** Canonical forward path, in order. Mirrors utils/orderLifecycle.js. */
export const FORWARD_PATH = ["Pending", "Accepted", "Preparing", "Ready", "Completed"];

export const STATUS_TONE = {
  Pending: "text-purple-700",
  Accepted: "text-indigo-600",
  Preparing: "text-yellow-600",
  Ready: "text-blue-600",
  Completed: "text-green-600",
  Cancelled: "text-red-600",
  Rejected: "text-red-700",
};

export const STATUS_BADGE = {
  Pending: "bg-purple-100 text-purple-700",
  Accepted: "bg-indigo-100 text-indigo-700",
  Preparing: "bg-yellow-100 text-yellow-700",
  Ready: "bg-blue-100 text-blue-700",
  Completed: "bg-green-100 text-green-700",
  Cancelled: "bg-red-100 text-red-700",
  Rejected: "bg-red-200 text-red-800",
};

/** Statuses where the order is still moving. */
export const ACTIVE_STATUSES = ["Pending", "Accepted", "Preparing", "Ready"];

/** Statuses after which nothing further can happen. */
export const CLOSED_STATUSES = ["Completed", "Cancelled", "Rejected"];

export function statusTone(status) {
  return STATUS_TONE[status] || "text-purple-700";
}

export function statusBadge(status) {
  return STATUS_BADGE[status] || "bg-gray-100 text-gray-700";
}

export function isActive(status) {
  return ACTIVE_STATUSES.includes(status);
}

/**
 * Outcomes that are administrative decisions and therefore require a reason.
 * Mirrors the server policy in utils/orderLifecycle.js.
 */
export function requiresReason(status) {
  return status === "Cancelled" || status === "Rejected";
}

/** Button styling per action. */
export const ACTION_STYLE = {
  Accepted: "bg-indigo-500 hover:bg-indigo-600",
  Preparing: "bg-yellow-400 hover:bg-yellow-500",
  Ready: "bg-blue-500 hover:bg-blue-600",
  Completed: "bg-green-500 hover:bg-green-600",
  Cancelled: "bg-red-500 hover:bg-red-600",
  Rejected: "bg-red-700 hover:bg-red-800",
};

/**
 * Progress steps for an order, each flagged done / current / upcoming.
 * Cancelled and Rejected collapse the timeline and are reported separately.
 */
export function buildTimeline(status) {
  if (status === "Cancelled" || status === "Rejected") {
    return { steps: [], outcome: status };
  }
  const index = FORWARD_PATH.indexOf(status);
  return {
    outcome: null,
    steps: FORWARD_PATH.map((step, i) => ({
      status: step,
      state: i < index ? "done" : i === index ? "current" : "upcoming",
    })),
  };
}

/**
 * Elapsed time since `from`, formatted for the kitchen board.
 * Returns "m:ss" under an hour, "h:mm" above it.
 */
export function formatElapsed(from, now = Date.now()) {
  if (!from) return "0:00";
  const seconds = Math.max(0, Math.floor((now - new Date(from).getTime()) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}`;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

/** Waiting-time thresholds used to colour the kitchen board. */
const LATE_SECONDS = 15 * 60;
const WARNING_SECONDS = 8 * 60;

export function waitTone(from, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - new Date(from).getTime()) / 1000));
  if (seconds >= LATE_SECONDS) return { label: "Late", className: "bg-red-600 text-white" };
  if (seconds >= WARNING_SECONDS) return { label: "Waiting", className: "bg-yellow-500 text-white" };
  return { label: "New", className: "bg-green-600 text-white" };
}