const express = require("express");
const config = require("../config");
const User = require("../models/User");
const {
  authMiddleware,
  adminMiddleware,
} = require("../middleware/authMiddleware");
const ApiError = require("../utils/ApiError");
const v = require("../utils/validators");
const { createAnnouncement, pushConfigured } = require("../services/notifications");

const router = express.Router();

const MAX_SUBSCRIPTIONS = 5;

/** A push endpoint must be an https URL and is stored as given. */
function parseEndpoint(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 2048) throw ApiError.badRequest("endpoint is required (max 2048 characters)");
  let url;
  try {
    url = new URL(text);
  } catch {
    throw ApiError.badRequest("endpoint must be a valid URL");
  }
  if (url.protocol !== "https:") throw ApiError.badRequest("endpoint must use https");
  return text;
}

/** The public VAPID key the browser needs to subscribe. Null when push is not configured. */
router.get("/push-key", authMiddleware, (req, res) => {
  res.json({ publicKey: pushConfigured() ? config.notify.push.publicKey : null });
});

/**
 * Save a browser's push subscription for the signed-in student. Subscribing
 * from the same endpoint again replaces the old entry. At most
 * MAX_SUBSCRIPTIONS are kept; the oldest is dropped first.
 */
router.post("/push-subscriptions", authMiddleware, async (req, res) => {
  const body = v.object(req.body);
  const endpoint = parseEndpoint(body.endpoint);
  const keys = v.object(body.keys, "keys");
  const p256dh = v.optionalString(keys.p256dh, { field: "keys.p256dh", max: 200 });
  const auth = v.optionalString(keys.auth, { field: "keys.auth", max: 200 });
  if (!p256dh || !auth) throw ApiError.badRequest("keys.p256dh and keys.auth are required");

  await User.updateOne({ _id: req.user._id }, { $pull: { pushSubscriptions: { endpoint } } });
  await User.updateOne(
    { _id: req.user._id },
    {
      $push: {
        pushSubscriptions: {
          $each: [{ endpoint, keys: { p256dh, auth }, createdAt: new Date() }],
          $slice: -MAX_SUBSCRIPTIONS,
        },
      },
    }
  );
  res.status(201).json({ subscribed: true });
});

/** Remove this browser's subscription. Unknown endpoints are not an error. */
router.delete("/push-subscriptions", authMiddleware, async (req, res) => {
  const endpoint = parseEndpoint(req.query.endpoint);
  await User.updateOne({ _id: req.user._id }, { $pull: { pushSubscriptions: { endpoint } } });
  res.json({ subscribed: false });
});

/**
 * Admin announcement to students who opted into promotions. Each recipient
 * gets their own outbox entry, delivered by email and/or push if they have
 * turned those on.
 */
router.post("/announcements", authMiddleware, adminMiddleware, async (req, res) => {
  const body = v.object(req.body);
  const title = v.optionalString(body.title, { field: "title", max: 120 });
  const text = v.optionalString(body.body, { field: "body", max: 500 });
  if (!title) throw ApiError.badRequest("title is required");
  if (!text) throw ApiError.badRequest("body is required");

  const recipients = await createAnnouncement({ title, body: text });
  res.status(201).json({ recipients });
});

module.exports = router;
