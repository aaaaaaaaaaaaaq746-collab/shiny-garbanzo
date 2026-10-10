/**
 * Notification rules: which messages exist, which channels a message may use,
 * and how a channel's delivery state changes. Pure: no database, no network.
 * The dispatcher (services/notifications.js) supplies the I/O.
 */

/** Order statuses that a student is told about. Pending is not announced. */
const ORDER_NOTIFY_STATUSES = Object.freeze([
  "Accepted",
  "Preparing",
  "Ready",
  "Completed",
  "Cancelled",
  "Rejected",
]);

const STATUS_TEXT = Object.freeze({
  Accepted: "Your order has been accepted and will be prepared shortly.",
  Preparing: "Your order is being prepared.",
  Ready: "Your order is ready for pickup.",
  Completed: "Your order is complete. Enjoy your meal!",
  Cancelled: "Your order was cancelled.",
  Rejected: "Your order was rejected by the canteen.",
});

/** Message for an order status change. `reason` is shown only for cancel/reject. */
function orderMessage({ status, reason }) {
  let body = STATUS_TEXT[status] || `Your order is now ${status}.`;
  if ((status === "Cancelled" || status === "Rejected") && reason) {
    body += ` Reason: ${reason}`;
  }
  return { title: "Order update", body: body.slice(0, 500), url: "/" };
}

/**
 * Which channels may carry a message, and why not when they may not.
 *
 * Order updates follow `orderUpdates`. Announcements follow `promotions`.
 * Email and push are opt-in and also need server configuration and a
 * destination (an address, or at least one browser subscription).
 */
function planChannels({ kind, prefs, user, subscriptionCount, emailConfigured, pushConfigured }) {
  const allowed = kind === "announcement" ? prefs.promotions === true : prefs.orderUpdates !== false;
  const kindName = kind === "announcement" ? "promotions" : "order updates";

  let email;
  if (!allowed) email = { run: false, reason: `Not subscribed to ${kindName}` };
  else if (!prefs.email) email = { run: false, reason: "Email is turned off" };
  else if (!user || !user.email) email = { run: false, reason: "No email address on file" };
  else if (!emailConfigured) email = { run: false, reason: "Email is not configured on the server" };
  else email = { run: true, reason: null };

  let push;
  if (!allowed) push = { run: false, reason: `Not subscribed to ${kindName}` };
  else if (!prefs.push) push = { run: false, reason: "Browser notifications are turned off" };
  else if (!(subscriptionCount > 0)) push = { run: false, reason: "No browser is subscribed" };
  else if (!pushConfigured) push = { run: false, reason: "Push is not configured on the server" };
  else push = { run: true, reason: null };

  return { email, push };
}

/**
 * The next stored state for one channel, given the outcome of one attempt.
 *
 *  - ok: sent, final.
 *  - skip: the channel is not allowed for this student or server, final.
 *  - error: retried until `maxAttempts`, then failed, final.
 */
function nextChannelState(current, outcome, { maxAttempts, now }) {
  const attempts = (current?.attempts || 0) + 1;
  if (outcome.ok) {
    return { state: "sent", attempts, lastError: null, sentAt: now };
  }
  if (outcome.skip) {
    return { state: "skipped", attempts: current?.attempts || 0, lastError: outcome.skip, sentAt: null };
  }
  const message = String(outcome.error || "delivery failed").slice(0, 300);
  return {
    state: attempts >= maxAttempts ? "failed" : "pending",
    attempts,
    lastError: message,
    sentAt: null,
  };
}

/**
 * Run one channel: skip when the plan says so, otherwise call `send()` and
 * report the outcome. `send` throws on failure.
 */
async function attemptChannel(plan, send) {
  if (!plan.run) return { skip: plan.reason };
  try {
    await send();
    return { ok: true };
  } catch (err) {
    return { error: err && err.message ? err.message : String(err) };
  }
}

module.exports = {
  ORDER_NOTIFY_STATUSES,
  orderMessage,
  planChannels,
  nextChannelState,
  attemptChannel,
};
