/**
 * Notification outbox and delivery.
 *
 *  - enqueueOrderNotification: called when an order changes status.
 *  - createAnnouncement: an admin message to students who opted into promotions.
 *  - dispatchDue: sends pending messages on each channel that is allowed.
 *
 * Who gets what is decided when a message is sent, from the student's current
 * preferences and the server's configuration. The rules themselves are in
 * utils/notificationPlan.js.
 *
 * Delivery is at-least-once within the retry limit and exactly-once in the
 * record: a channel is marked sent only after the transport accepted the
 * message. Running more than one server process would need a claim step; the
 * in-process guard below covers a single process.
 */

const mongoose = require("mongoose");
const config = require("../config");
const Notification = require("../models/Notification");
const User = require("../models/User");
const {
  ORDER_NOTIFY_STATUSES,
  orderMessage,
  planChannels,
  nextChannelState,
  attemptChannel,
} = require("../utils/notificationPlan");

const MAX_ANNOUNCEMENT_RECIPIENTS = 5000;

function emailConfigured() {
  return Boolean(config.notify.email.host && config.notify.email.from);
}

function pushConfigured() {
  const { publicKey, privateKey, subject } = config.notify.push;
  return Boolean(publicKey && privateKey && subject);
}

/** Real transports, built from configuration. Only called when configured. */
function defaultTransports() {
  const transports = {
    emailConfigured: emailConfigured(),
    pushConfigured: pushConfigured(),
  };

  if (transports.emailConfigured) {
    const nodemailer = require("nodemailer");
    const smtp = config.notify.email;
    const mailer = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
    });
    transports.sendEmail = (message) => mailer.sendMail({ from: smtp.from, ...message });
  }

  if (transports.pushConfigured) {
    const webpush = require("web-push");
    const push = config.notify.push;
    webpush.setVapidDetails(push.subject, push.publicKey, push.privateKey);
    transports.sendPushOne = (subscription, payload) =>
      webpush.sendNotification(subscription, JSON.stringify(payload), { TTL: 3600 });
  }

  return transports;
}

function freshChannels() {
  return { email: {}, push: {} };
}

/**
 * Record a status change for the student. Duplicate calls for the same
 * transition are ignored through the unique dedupe key.
 */
async function enqueueOrderNotification({ order, status, reason }) {
  if (!ORDER_NOTIFY_STATUSES.includes(status)) return null;
  const message = orderMessage({ status, reason });
  try {
    return await Notification.create({
      user: order.student,
      kind: "order_status",
      title: message.title,
      body: message.body,
      order: order._id,
      dedupeKey: `order:${order._id}:${order.statusHistoryTotal}`,
      channels: freshChannels(),
    });
  } catch (err) {
    if (err.code === 11000) return null;
    throw err;
  }
}

/** Message every student who opted into promotions. Returns the recipient count. */
async function createAnnouncement({ title, body }) {
  const recipients = await User.find(
    { "notificationPrefs.promotions": true, isActive: { $ne: false } },
    { _id: 1 }
  )
    .limit(MAX_ANNOUNCEMENT_RECIPIENTS)
    .lean();
  if (recipients.length === 0) return 0;

  const announcementId = new mongoose.Types.ObjectId().toString();
  await Notification.insertMany(
    recipients.map((u) => ({
      user: u._id,
      kind: "announcement",
      title,
      body,
      dedupeKey: `announcement:${announcementId}:${u._id}`,
      channels: freshChannels(),
    })),
    { ordered: false }
  );
  return recipients.length;
}

/**
 * Send push to every subscription the student has. Succeeds if at least one
 * browser accepted it. Subscriptions the push service reports as gone (404 or
 * 410) are removed so they are not tried again.
 */
async function sendPushToUser(user, payload, sendPushOne) {
  const subs = user.pushSubscriptions || [];
  let delivered = 0;
  let lastError = null;
  const gone = [];

  for (const sub of subs) {
    try {
      await sendPushOne({ endpoint: sub.endpoint, keys: sub.keys }, payload);
      delivered += 1;
    } catch (err) {
      const status = err && err.statusCode;
      if (status === 404 || status === 410) gone.push(sub.endpoint);
      lastError = err && err.message ? err.message : String(err);
    }
  }

  if (gone.length) {
    await User.updateOne(
      { _id: user._id },
      { $pull: { pushSubscriptions: { endpoint: { $in: gone } } } }
    );
  }
  if (delivered === 0) throw new Error(lastError || "No browser accepted the push");
}

/**
 * Send up to `limit` messages that still have a pending channel.
 *
 * `transports` defaults to the configured ones; tests pass fakes. Returns
 * `{ processed }`, or `{ skipped: true }` when a run is already in progress.
 */
let running = false;
async function dispatchDue({ now = Date.now(), limit = 50, transports } = {}) {
  if (running) return { skipped: true, processed: 0 };
  running = true;
  try {
    const t = transports || defaultTransports();
    const maxAttempts = config.notify.maxAttempts;
    const due = await Notification.find({
      $or: [{ "channels.email.state": "pending" }, { "channels.push.state": "pending" }],
    })
      .sort({ createdAt: 1 })
      .limit(limit);

    let processed = 0;
    for (const doc of due) {
      const user = await User.findById(doc.user).select("+pushSubscriptions").lean();
      if (!user) {
        await Notification.updateOne(
          { _id: doc._id },
          {
            $set: {
              "channels.email.state": "skipped",
              "channels.email.lastError": "Account no longer exists",
              "channels.push.state": "skipped",
              "channels.push.lastError": "Account no longer exists",
            },
          }
        );
        processed += 1;
        continue;
      }

      const prefs = {
        orderUpdates: true,
        promotions: false,
        sound: true,
        email: false,
        push: false,
        ...(user.notificationPrefs || {}),
      };
      const plan = planChannels({
        kind: doc.kind,
        prefs,
        user,
        subscriptionCount: (user.pushSubscriptions || []).length,
        emailConfigured: t.emailConfigured,
        pushConfigured: t.pushConfigured,
      });
      const payload = { title: doc.title, body: doc.body, url: "/" };

      if (doc.channels?.email?.state === "pending") {
        const outcome = await attemptChannel(plan.email, () =>
          t.sendEmail({ to: user.email, subject: doc.title, text: doc.body })
        );
        const next = nextChannelState(doc.channels.email, outcome, { maxAttempts, now });
        await Notification.updateOne({ _id: doc._id }, { $set: { "channels.email": next } });
      }

      if (doc.channels?.push?.state === "pending") {
        const outcome = await attemptChannel(plan.push, () =>
          sendPushToUser(user, payload, t.sendPushOne)
        );
        const next = nextChannelState(doc.channels.push, outcome, { maxAttempts, now });
        await Notification.updateOne({ _id: doc._id }, { $set: { "channels.push": next } });
      }

      processed += 1;
    }
    return { processed };
  } finally {
    running = false;
  }
}

module.exports = {
  enqueueOrderNotification,
  createAnnouncement,
  dispatchDue,
  emailConfigured,
  pushConfigured,
};
