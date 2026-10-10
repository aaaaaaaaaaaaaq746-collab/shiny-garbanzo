/**
 * Staff and kitchen accounts (Phase 2 section 7). Administrators only.
 *
 * Roles are changed through one route with a conditional update, so two
 * administrators cannot both act on a stale role. Changes take effect on the
 * next request, because the session user is reloaded every time (see
 * middleware/authMiddleware.js).
 */

const express = require("express");
const User = require("../models/User");
const { authMiddleware, adminMiddleware } = require("../middleware/authMiddleware");
const ApiError = require("../utils/ApiError");
const v = require("../utils/validators");

const router = express.Router();
const ROLES = User.ROLES;

// Every route here is for administrators. Password hashes are never selected.
router.use(authMiddleware, adminMiddleware);

function publicUser(u) {
  return {
    id: u._id,
    name: u.name,
    email: u.email,
    role: u.role,
    isActive: u.isActive !== false,
    createdAt: u.createdAt,
  };
}

/** Escape user text before it goes into a regular expression. */
const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Accounts managed here. Students are not listed: their personal details are
// not exposed through this route.
const STAFF_ROLES = ROLES.filter((r) => r !== "student");

/** Staff-type accounts, optionally filtered by role or a name/email search. */
router.get("/", async (req, res) => {
  const filter = { role: { $in: STAFF_ROLES } };
  if (req.query.role !== undefined && req.query.role !== "") {
    filter.role = v.oneOf(String(req.query.role), STAFF_ROLES, "role");
  }
  const q = v.optionalString(req.query.q, { field: "q", max: 100 });
  if (q) {
    const rx = new RegExp(escapeRx(q), "i");
    filter.$or = [{ name: rx }, { email: rx }];
  }
  const users = await User.find(filter).sort({ role: 1, name: 1 }).limit(500).lean();
  res.json(users.map(publicUser));
});

/**
 * Create a staff, kitchen or admin account. Students still register themselves.
 * The password is hashed by the User model's save hook.
 */
router.post("/", async (req, res) => {
  const body = v.object(req.body);
  const role = v.oneOf(body.role, STAFF_ROLES, "role");
  const user = new User({
    name: v.name(body.name),
    email: v.email(body.email),
    password: v.password(body.password),
    role,
  });
  await user.save();
  res.status(201).json(publicUser(user));
});

/**
 * Change an account's role.
 *
 * The update succeeds only if the account still has the role it was read
 * with, so a concurrent change is reported as 409 rather than overwritten.
 * An administrator cannot remove their own admin role, and the last active
 * administrator cannot be demoted.
 */
router.put("/:id/role", async (req, res) => {
  const id = v.objectId(req.params.id, "user id");
  const body = v.object(req.body);
  const role = v.oneOf(body.role, ROLES, "role");

  const target = await User.findById(id).lean();
  if (!target) throw ApiError.notFound("User not found");
  if (target.role === role) return res.json(publicUser(target));

  if (String(target._id) === String(req.user._id) && target.role === "admin") {
    throw ApiError.conflict("You cannot remove your own administrator role");
  }
  if (target.role === "admin" && role !== "admin") {
    const activeAdmins = await User.countDocuments({ role: "admin", isActive: { $ne: false } });
    if (activeAdmins <= 1) {
      throw ApiError.conflict("At least one active administrator is required");
    }
  }

  const updated = await User.findOneAndUpdate(
    { _id: id, role: target.role },
    { $set: { role } },
    { new: true }
  );
  if (!updated) {
    throw ApiError.conflict("This account was changed by someone else. Reload and try again.");
  }
  res.json(publicUser(updated));
});

/**
 * Activate or deactivate an account. A deactivated account is refused on its
 * next request. An administrator cannot deactivate themselves.
 */
router.put("/:id/active", async (req, res) => {
  const id = v.objectId(req.params.id, "user id");
  const body = v.object(req.body);
  const isActive = v.boolean(body.isActive, "isActive");

  if (!isActive && String(id) === String(req.user._id)) {
    throw ApiError.conflict("You cannot deactivate your own account");
  }
  const updated = await User.findByIdAndUpdate(id, { $set: { isActive } }, { new: true });
  if (!updated) throw ApiError.notFound("User not found");
  res.json(publicUser(updated));
});

module.exports = router;
