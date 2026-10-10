const { test } = require("node:test");
const assert = require("node:assert/strict");

/** Pure tests: notification messages, channel rules and retry state. No database, no network. */

const plan = require("../utils/notificationPlan");
const pickup = require("../utils/pickupCapacity");

const NOW = Date.parse("2026-10-10T04:00:00Z");
const student = { email: "asha@college.edu" };
const on = { orderUpdates: true, promotions: false, sound: true, email: true, push: true };

function channels(overrides = {}) {
  return plan.planChannels({
    kind: "order_status",
    prefs: { ...on, ...(overrides.prefs || {}) },
    user: overrides.user === undefined ? student : overrides.user,
    subscriptionCount: overrides.subs === undefined ? 1 : overrides.subs,
    emailConfigured: overrides.emailConfigured === undefined ? true : overrides.emailConfigured,
    pushConfigured: overrides.pushConfigured === undefined ? true : overrides.pushConfigured,
  });
}

test("order messages use student wording and never announce Pending", () => {
  assert.equal(plan.orderMessage({ status: "Ready" }).body, "Your order is ready for pickup.");
  assert.equal(plan.orderMessage({ status: "Preparing" }).body, "Your order is being prepared.");
  assert.equal(plan.orderMessage({ status: "Ready" }).title, "Order update");
  assert.ok(!plan.ORDER_NOTIFY_STATUSES.includes("Pending"));
});

test("a cancellation or rejection shows its reason; other statuses do not", () => {
  assert.match(plan.orderMessage({ status: "Cancelled", reason: "Out of paneer" }).body, /Reason: Out of paneer$/);
  assert.match(plan.orderMessage({ status: "Rejected", reason: "Kitchen closed" }).body, /Reason: Kitchen closed$/);
  assert.doesNotMatch(plan.orderMessage({ status: "Ready", reason: "ignored" }).body, /Reason/);
});

test("a message body is capped at 500 characters", () => {
  const long = "x".repeat(900);
  assert.ok(plan.orderMessage({ status: "Cancelled", reason: long }).body.length <= 500);
});

test("with default preferences, email and push are both off", () => {
  const p = channels({ prefs: { email: false, push: false } });
  assert.equal(p.email.run, false);
  assert.equal(p.email.reason, "Email is turned off");
  assert.equal(p.push.run, false);
  assert.equal(p.push.reason, "Browser notifications are turned off");
});

test("email runs only when opted in, configured, and an address is on file", () => {
  assert.equal(channels().email.run, true);
  assert.match(channels({ emailConfigured: false }).email.reason, /not configured/);
  assert.match(channels({ user: { email: "" } }).email.reason, /No email address/);
});

test("push runs only when opted in, configured, and a browser is subscribed", () => {
  assert.equal(channels().push.run, true);
  assert.match(channels({ subs: 0 }).push.reason, /No browser/);
  assert.match(channels({ pushConfigured: false }).push.reason, /not configured/);
});

test("order updates are gated by orderUpdates and announcements by promotions", () => {
  const orderOff = channels({ prefs: { orderUpdates: false } });
  assert.match(orderOff.email.reason, /order updates/);
  assert.equal(orderOff.push.run, false);

  const announcement = (prefs) =>
    plan.planChannels({
      kind: "announcement",
      prefs: { ...on, ...prefs },
      user: student,
      subscriptionCount: 1,
      emailConfigured: true,
      pushConfigured: true,
    });
  assert.equal(announcement({ promotions: false }).email.run, false);
  assert.equal(announcement({ promotions: true }).email.run, true);
  assert.match(announcement({ promotions: false }).email.reason, /promotions/);
});

test("a sent channel is final", () => {
  const next = plan.nextChannelState({ state: "pending", attempts: 0 }, { ok: true }, { maxAttempts: 3, now: NOW });
  assert.deepEqual(next, { state: "sent", attempts: 1, lastError: null, sentAt: NOW });
});

test("a skipped channel is final and records why", () => {
  const next = plan.nextChannelState({ state: "pending", attempts: 0 }, { skip: "Email is turned off" }, {
    maxAttempts: 3,
    now: NOW,
  });
  assert.equal(next.state, "skipped");
  assert.equal(next.lastError, "Email is turned off");
  assert.equal(next.attempts, 0, "a skip is not a delivery attempt");
});

test("a failed attempt stays pending until the retry limit, then becomes failed", () => {
  let state = { state: "pending", attempts: 0 };
  const boom = { error: "SMTP timeout" };
  state = plan.nextChannelState(state, boom, { maxAttempts: 3, now: NOW });
  assert.equal(state.state, "pending");
  assert.equal(state.attempts, 1);
  state = plan.nextChannelState(state, boom, { maxAttempts: 3, now: NOW });
  assert.equal(state.state, "pending");
  state = plan.nextChannelState(state, boom, { maxAttempts: 3, now: NOW });
  assert.equal(state.state, "failed");
  assert.equal(state.attempts, 3);
  assert.equal(state.lastError, "SMTP timeout");
});

test("error text stored on a channel is capped at 300 characters", () => {
  const next = plan.nextChannelState({ attempts: 0 }, { error: "e".repeat(999) }, { maxAttempts: 9, now: NOW });
  assert.equal(next.lastError.length, 300);
});

test("attemptChannel skips without calling the transport when the plan says no", async () => {
  let called = false;
  const outcome = await plan.attemptChannel({ run: false, reason: "off" }, async () => {
    called = true;
  });
  assert.deepEqual(outcome, { skip: "off" });
  assert.equal(called, false);
});

test("attemptChannel reports success and failure from the transport", async () => {
  assert.deepEqual(await plan.attemptChannel({ run: true }, async () => {}), { ok: true });
  const failed = await plan.attemptChannel({ run: true }, async () => {
    throw new Error("connection refused");
  });
  assert.deepEqual(failed, { error: "connection refused" });
});

test("a seat count of zero means unlimited, and never full", () => {
  assert.equal(pickup.seatsRemaining(0, 999), null);
  assert.equal(pickup.isSlotFull(0, 999), false);
});

test("seats left and full are computed against the capacity", () => {
  assert.equal(pickup.seatsRemaining(20, 5), 15);
  assert.equal(pickup.seatsRemaining(20, 20), 0);
  assert.equal(pickup.seatsRemaining(20, 25), 0, "over-booked slots report zero, not negative");
  assert.equal(pickup.isSlotFull(20, 19), false);
  assert.equal(pickup.isSlotFull(20, 20), true);
});

test("slot keys are the ISO start time, so the same slot always maps to the same key", () => {
  assert.equal(pickup.slotKey(new Date("2026-10-10T04:30:00Z")), "2026-10-10T04:30:00.000Z");
  assert.equal(pickup.slotKey("2026-10-10T04:30:00.000Z"), "2026-10-10T04:30:00.000Z");
});
