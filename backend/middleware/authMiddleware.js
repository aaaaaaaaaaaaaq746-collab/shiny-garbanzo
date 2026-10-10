const jwt = require("jsonwebtoken");
const User = require("../models/User");
const config = require("../config");
const ApiError = require("../utils/ApiError");

/**
 * Extract a JWT from the Authorization header.
 *
 * Accepts both `Bearer <token>` (the RFC 6750 standard) and a bare token
 * (which the original frontend sent) so existing clients keep working.
 */
function extractToken(req) {
  const header = req.headers.authorization;
  if (!header || typeof header !== "string") return null;

  const trimmed = header.trim();
  if (!trimmed) return null;

  const [scheme, value] = trimmed.split(/\s+/);
  if (!value) return scheme; // bare token, no scheme
  if (scheme.toLowerCase() === "bearer") return value;
  return null;
}

/**
 * Require a valid JWT and attach the live user document to `req.user`.
 *
 * A token that verifies but whose user no longer exists is a 401, not a
 * downstream crash — previously this left `req.user` null and caused a
 * TypeError/500 in the admin middleware.
 */
const authMiddleware = async (req, res, next) => {
  const token = extractToken(req);
  if (!token) {
    return next(ApiError.unauthorized("No authentication token provided"));
  }

  let decoded;
  try {
    decoded = jwt.verify(token, config.jwt.secret);
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return next(ApiError.unauthorized("Session expired, please log in again"));
    }
    return next(ApiError.unauthorized("Invalid authentication token"));
  }

  if (!decoded || !decoded.id) {
    return next(ApiError.unauthorized("Invalid authentication token"));
  }

  const user = await User.findById(decoded.id);
  if (!user) {
    // Valid signature but the account is gone.
    return next(ApiError.unauthorized("Account no longer exists"));
  }

  req.user = user;
  return next();
};

/**
 * Attach `req.user` when a valid token is present, but never reject.
 * Useful for endpoints whose response varies for signed-in users.
 */
const optionalAuthMiddleware = async (req, res, next) => {
  const token = extractToken(req);
  if (!token) return next();
  try {
    const decoded = jwt.verify(token, config.jwt.secret);
    if (decoded?.id) {
      const user = await User.findById(decoded.id);
      if (user) req.user = user;
    }
  } catch {
    // An unusable token is simply treated as anonymous here.
  }
  return next();
};

/** Administrative access only. */
const adminMiddleware = (req, res, next) => {
  if (!req.user) return next(ApiError.unauthorized());
  if (req.user.role !== "admin") {
    return next(ApiError.forbidden("Admins only"));
  }
  return next();
};

/** Order-management desk (kitchen staff + admins). Admins always pass. */
const staffMiddleware = (req, res, next) => {
  if (!req.user) return next(ApiError.unauthorized());
  if (!["admin", "staff"].includes(req.user.role)) {
    return next(ApiError.forbidden("Staff only"));
  }
  return next();
};

/** Full administrative or kitchen access. */
const adminOrStaffMiddleware = (req, res, next) => {
  if (!req.user) return next(ApiError.unauthorized());
  if (!["admin", "staff"].includes(req.user.role)) {
    return next(ApiError.forbidden("Staff only"));
  }
  return next();
};

module.exports = {
  authMiddleware,
  optionalAuthMiddleware,
  adminMiddleware,
  staffMiddleware,
  adminOrStaffMiddleware,
  extractToken,
};