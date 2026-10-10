const ApiError = require("./ApiError");

// Kitchen accounts may move an order through these statuses and no others.
const KITCHEN_TARGETS = new Set(["Accepted", "Preparing", "Ready"]);

/**
 * Centralized order lifecycle.
 *
 * Canonical forward path:
 *
 *   Pending -> Accepted -> Preparing -> Ready -> Completed
 *
 * Alternative terminal outcomes: Cancelled, Rejected.
 *
 * BACKWARD COMPATIBILITY
 * ----------------------
 * The original admin UI moves orders straight from `Pending` to `Preparing`
 * and to `Completed`. Those jumps are preserved for staff/admin by default
 * (skip-ahead) so existing workflow and API consumers keep working. Set
 * ORDER_STRICT_LIFECYCLE=true to require each adjacent step instead.
 *
 * Students never skip ahead: they may only cancel their own eligible order.
 */

const STATUS = {
  PENDING: "Pending",
  ACCEPTED: "Accepted",
  PREPARING: "Preparing",
  READY: "Ready",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  REJECTED: "Rejected",
};

const ORDER_STATUSES = [
  STATUS.PENDING,
  STATUS.ACCEPTED,
  STATUS.PREPARING,
  STATUS.READY,
  STATUS.COMPLETED,
  STATUS.CANCELLED,
  STATUS.REJECTED,
];

/** Ordering used to reason about "forward" movement. */
const FORWARD_PATH = [
  STATUS.PENDING,
  STATUS.ACCEPTED,
  STATUS.PREPARING,
  STATUS.READY,
  STATUS.COMPLETED,
];

/** States that can never be left. */
const TERMINAL_STATUSES = new Set([
  STATUS.COMPLETED,
  STATUS.CANCELLED,
  STATUS.REJECTED,
]);

const isTerminal = (status) => TERMINAL_STATUSES.has(status);
const isForward = (from, to) => {
  const a = FORWARD_PATH.indexOf(from);
  const b = FORWARD_PATH.indexOf(to);
  return a !== -1 && b !== -1 && b > a;
};
const isAdjacent = (from, to) =>
  FORWARD_PATH.indexOf(to) === FORWARD_PATH.indexOf(from) + 1;

/**
 * Which states a role may cancel FROM.
 *
 * Students (and staff) may only withdraw before cooking starts.
 * Admins get the explicit exception the specification allows: they may cancel
 * a Preparing or Ready order too (customer no-shows, kitchen failures).
 */
const CANCELLABLE_BY = {
  student: new Set([STATUS.PENDING, STATUS.ACCEPTED]),
  staff: new Set([STATUS.PENDING, STATUS.ACCEPTED]),
  admin: new Set([
    STATUS.PENDING,
    STATUS.ACCEPTED,
    STATUS.PREPARING,
    STATUS.READY,
  ]),
  kitchen: new Set(),
};

/** Only an administrator may reject, and only before cooking starts. */
const REJECTABLE_BY = {
  student: new Set(),
  staff: new Set(),
  admin: new Set([STATUS.PENDING, STATUS.ACCEPTED]),
  kitchen: new Set(),
};

/** Reasons are mandatory for these roles performing these outcomes. */
const REASON_REQUIRED = {
  cancelled: new Set(["admin", "staff"]),
  rejected: new Set(["admin"]),
};

const MAX_REASON_LENGTH = 300;

function mayAdvance(role) {
  return role === "admin" || role === "staff" || role === "kitchen";
}

/**
 * Decide whether `role` may move an order from `from` to `to`.
 *
 * Returns `{ allowed: true }` or `{ allowed: false, code, message }` where
 * `code` is the HTTP status the caller should surface.
 */
function checkTransition({ from, to, role, strict = false }) {
  if (!ORDER_STATUSES.includes(to)) {
    return { allowed: false, code: 400, message: `Unknown status "${to}"` };
  }

  if (!ORDER_STATUSES.includes(from)) {
    return {
      allowed: false,
      code: 409,
      message: `Order is in an unrecognized state "${from}" and cannot be updated`,
    };
  }

  if (from === to) {
    return {
      allowed: false,
      code: 409,
      message: `Order is already ${from}`,
    };
  }

  // Terminal states are never reopened through ordinary requests.
  if (isTerminal(from)) {
    return {
      allowed: false,
      code: 409,
      message: `Order is already ${from} and can no longer change status`,
    };
  }

  // Kitchen accounts run the queue. They never complete, cancel or reject.
  if (role === "kitchen" && !KITCHEN_TARGETS.has(to)) {
    return {
      allowed: false,
      code: 403,
      message: "Kitchen staff can accept and advance orders, but cannot complete, cancel or reject them",
    };
  }

  if (!mayAdvance(role) && to !== STATUS.CANCELLED) {
    return {
      allowed: false,
      code: 403,
      message: "You are not allowed to change this order's status",
    };
  }

  if (to === STATUS.CANCELLED) {
    const allowed = CANCELLABLE_BY[role] || new Set();
    if (!allowed.has(from)) {
      return {
        allowed: false,
        code: 409,
        message:
          role === "admin"
            ? `An order cannot be cancelled once it is ${from}`
            : `This order can no longer be cancelled because it is ${from}`,
      };
    }
    return { allowed: true };
  }

  if (to === STATUS.REJECTED) {
    const allowed = REJECTABLE_BY[role] || new Set();
    if (!allowed.has(from)) {
      if (!allowed.size) {
        return {
          allowed: false,
          code: 403,
          message: "Only an administrator can reject an order",
        };
      }
      return {
        allowed: false,
        code: 409,
        message: `An order cannot be rejected once it is ${from}`,
      };
    }
    return { allowed: true };
  }

  // Any other target must lie on the forward path.
  if (!isForward(from, to)) {
    return {
      allowed: false,
      code: 409,
      message: `Cannot move an order backwards from ${from} to ${to}`,
    };
  }

  if (strict && !isAdjacent(from, to)) {
    return {
      allowed: false,
      code: 409,
      message: `Order must pass through each stage: ${from} cannot go directly to ${to}`,
    };
  }

  return { allowed: true };
}

/** Throw an ApiError when the transition is not permitted. */
function assertTransition(options) {
  const result = checkTransition(options);
  if (!result.allowed) {
    throw new ApiError(result.code, result.message);
  }
  return true;
}

/** Whether a reason must accompany this outcome for this role. */
function requiresReason({ to, role }) {
  // Only the two "bad outcome" transitions ever require an explanation.
  if (to === STATUS.CANCELLED) return REASON_REQUIRED.cancelled.has(role);
  if (to === STATUS.REJECTED) return REASON_REQUIRED.rejected.has(role);
  return false;
}

/**
 * Statuses this role may move the given order to right now.
 * Drives the admin UI so the rules are not duplicated in the frontend.
 */
function allowedTransitions({ from, role, strict = false }) {
  return ORDER_STATUSES.filter((to) =>
    checkTransition({ from, to, role, strict }).allowed
  );
}

/**
 * Whether the given viewer may cancel this order right now.
 * Drives the student "Cancel Order" button.
 */
function canCancel({ order, user }) {
  const allowed = CANCELLABLE_BY[user?.role] || new Set();
  if (!allowed.has(order.status)) return false;
  // Students may only cancel their own order.
  if (user?.role === "student") {
    return String(order.student?._id || order.student) === String(user._id);
  }
  return true;
}

module.exports = {
  STATUS,
  ORDER_STATUSES,
  FORWARD_PATH,
  TERMINAL_STATUSES,
  MAX_REASON_LENGTH,
  isTerminal,
  isForward,
  isAdjacent,
  checkTransition,
  assertTransition,
  requiresReason,
  allowedTransitions,
  canCancel,
  CANCELLABLE_BY,
  REJECTABLE_BY,
};