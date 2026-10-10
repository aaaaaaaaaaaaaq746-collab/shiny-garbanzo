const express = require("express");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const config = require("../config");
const { authMiddleware } = require("../middleware/authMiddleware");
const { authLimiter } = require("../middleware/rateLimit");
const ApiError = require("../utils/ApiError");
const v = require("../utils/validators");

const router = express.Router();

/** Sign a session token for a user document. */
function issueToken(user) {
  return jwt.sign(
    { id: user._id.toString(), tv: user.tokenVersion ?? 0 },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn }
  );
}

// Signup — PUBLIC.
//
// SECURITY: the request body's `role` is deliberately ignored. The original
// implementation passed it straight to User.create(), letting any anonymous
// caller register as an administrator. Administrators are provisioned through
// `npm run seed:admin`, never through the public endpoint.
router.post("/signup", authLimiter, async (req, res) => {
  const body = v.object(req.body);

  const name = v.name(body.name);
  const email = v.email(body.email);
  const password = v.password(body.password);

  // `role` is not read from the body under any circumstances.
  const user = await User.create({ name, email, password, role: "student" });

  // NOTE: the request body is never logged — it contains the plaintext password.
  console.log(`[auth] student registered: ${email}`);

  res.status(201).json({
    message: "User registered successfully",
    user: user.toPublicJSON(),
  });
});

// Login
router.post("/login", authLimiter, async (req, res) => {
  const body = v.object(req.body);
  const email = v.email(body.email);

  // Only presence is enforced here, not minimum length. Accounts created
  // before validation existed may hold short passwords, and applying the
  // signup length rule at login would lock those users out.
  if (typeof body.password !== "string" || !body.password) {
    throw ApiError.badRequest("password is required");
  }

  const user = await User.findOne({ email }).select("+password");

  // A single generic message for both branches prevents user enumeration.
  const invalid = ApiError.unauthorized("Invalid email or password");
  if (!user) throw invalid;

  const isMatch = await user.comparePassword(body.password);
  if (!isMatch) throw invalid;

  if (user.isActive === false) {
    throw ApiError.forbidden("This account has been deactivated");
  }

  // Contract preserved: { token, role, name }. `id`/`email` are additive.
  res.json({
    token: issueToken(user),
    role: user.role,
    name: user.name,
    id: user._id.toString(),
    email: user.email,
  });
});

/**
 * Current authenticated user.
 *
 * The frontend has always called this to restore a session on page load, but
 * the route did not exist — the 404 triggered a `catch` that wiped the stored
 * token, logging everyone out on every refresh.
 */
router.get("/me", authMiddleware, async (req, res) => {
  res.json(req.user.toPublicJSON());
});

// Update the signed-in user's own profile (never their role).
router.put("/me", authMiddleware, async (req, res) => {
  const body = v.object(req.body);
  const user = req.user;

  if (body.name !== undefined) user.name = v.name(body.name);
  if (body.notificationPrefs !== undefined) {
    const prefs = v.object(body.notificationPrefs, "notificationPrefs");
    for (const key of ["orderUpdates", "promotions", "sound"]) {
      if (prefs[key] !== undefined) {
        user.notificationPrefs[key] = v.boolean(prefs[key], key);
      }
    }
  }

  await user.save();
  res.json(user.toPublicJSON());
});

// Favorites (add/remove/toggle) — additive, used by Phase 3.
router.get("/me/favorites", authMiddleware, async (req, res) => {
  const user = await User.findById(req.user._id).populate("favorites");
  res.json(user.favorites || []);
});

router.post("/me/favorites/:foodId", authMiddleware, async (req, res) => {
  const foodId = v.objectId(req.params.foodId, "foodId");
  const Food = require("../models/FoodItem");
  const food = await Food.findById(foodId);
  if (!food) throw ApiError.notFound("Food item not found");

  const user = await User.findById(req.user._id);
  const already = user.favorites.some((id) => id.toString() === foodId);
  if (!already) user.favorites.push(foodId);
  await user.save();

  res.status(already ? 200 : 201).json({ favorited: true, foodId });
});

router.delete("/me/favorites/:foodId", authMiddleware, async (req, res) => {
  const foodId = v.objectId(req.params.foodId, "foodId");
  const user = await User.findById(req.user._id);
  user.favorites = user.favorites.filter((id) => id.toString() !== foodId);
  await user.save();
  res.json({ favorited: false, foodId });
});

/**
 * Logout.
 *
 * Revocation: the account's tokenVersion is incremented, so every token issued
 * before this call (on any device) stops working. Clients should also discard
 * their stored token. A new login issues a token for the new version.
 */
router.post("/logout", authMiddleware, async (req, res) => {
  // Revoke every token issued before now for this account by bumping the
  // version their `tv` claim is checked against. Atomic single-document update.
  await User.updateOne({ _id: req.user._id }, { $inc: { tokenVersion: 1 } });
  res.json({ message: "Logged out", tokenDiscardedAt: new Date().toISOString() });
});

module.exports = router;