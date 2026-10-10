const mongoose = require("mongoose");

/**
 * Outbox of notifications for students.
 *
 * One document per message. Each channel (email, push) has its own delivery
 * state, so a failure on one channel never blocks or repeats the other.
 *
 * `dedupeKey` is unique, so creating the same message twice (a retry, or two
 * workers) cannot send it twice. The in-app realtime alert is not stored here:
 * it is delivered over Socket.IO and re-read from REST.
 */

const channelState = new mongoose.Schema(
  {
    state: {
      type: String,
      enum: ["pending", "sent", "skipped", "failed"],
      default: "pending",
    },
    attempts: { type: Number, default: 0, min: 0 },
    lastError: { type: String, default: null, maxlength: 300 },
    sentAt: { type: Date, default: null },
  },
  { _id: false }
);

const NotificationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    kind: { type: String, enum: ["order_status", "announcement"], required: true },
    title: { type: String, required: true, maxlength: 120 },
    body: { type: String, required: true, maxlength: 500 },
    order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null },
    dedupeKey: { type: String, required: true, unique: true, maxlength: 200 },
    channels: {
      email: { type: channelState, default: () => ({}) },
      push: { type: channelState, default: () => ({}) },
    },
  },
  { timestamps: true }
);

// The dispatcher looks for anything still pending on either channel.
NotificationSchema.index({ "channels.email.state": 1, "channels.push.state": 1 });

module.exports = mongoose.model("Notification", NotificationSchema);
