const jwt = require("jsonwebtoken");
const User = require("../models/User");
const config = require("../config");
const ApiError = require("../utils/ApiError");

/**
 * Extract a JWT from an HTTP request or a Socket.IO handshake.
 *
 * Accepts `Bearer <token>` (RFC 6750) and a bare token (what the original
 * frontend sent), so existing clients keep working. For a socket, the token
 * may come from `handshake.auth.token` or the Authorization header.
 */
function extractToken(source) {
  if (!source) return null;

  const fromAuth = source.handshake?.auth?.token;
  const candidates = [];
  if (typeof fromAuth === "string") candidates.push(fromAuth);
  const header = source.handshake ? source.handshake.headers?.authorization : source.headers?.authorization;
  if (typeof header === "string") candidates.push(header);

  for (const raw of candidates) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const [scheme, value] = trimmed.split(/\s+/);
    if (!value) return scheme; // bare token, no scheme
    if (scheme.toLowerCase() === "bearer") return value;
  }
  return null;
}

/**
 * Validate a session token and return the live user it belongs to.
 *
 * This is the single place where a token is accepted. It checks, in order:
 *   1. the signature and expiry;
 *   2. that the account still exists;
 *   3. that the account is active (`isActive !== false`);
 *   4. that the token has not been revoked: its `tv` claim must match the
 *      account's current `tokenVersion`. Tokens issued before this field
 *      existed carry no `tv`, which is treated as 0, the default for every
 *      user, so they keep working until the user logs out.
 *
 * Throws ApiError(401) for every failure. Used by REST and by Socket.IO, so
 * both transports enforce the same rules.
 */
async function resolveSessionUser(token) {
  let decoded;
  try {
    decoded = jwt.verify(token, config.jwt.secret);
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      throw ApiError.unauthorized("Session expired, please log in again");
    }
    throw ApiError.unauthorized("Invalid authentication token");
  }

  if (!decoded || !decoded.id) {
    throw ApiError.unauthorized("Invalid authentication token");
  }

  const user = await User.findById(decoded.id);
  if (!user) {
    // Valid signature but the account is gone.
    throw ApiError.unauthorized("Account no longer exists");
  }

  if (user.isActive === false) {
    throw ApiError.unauthorized("This account has been deactivated");
  }

  const tokenVersion = Number.isInteger(decoded.tv) ? decoded.tv : 0;
  if (tokenVersion !== (user.tokenVersion ?? 0)) {
    throw ApiError.unauthorized("Session has ended, please log in again");
  }

  return user;
}

/**
 * Require a valid session and attach the live user document to `req.user`.
 */
const authMiddleware = async (req, res, next) => {
  const token = extractToken(req);
  if (!token) {
    return next(ApiError.unauthorized("No authentication token provided"));
  }

  try {
    req.user = await resolveSessionUser(token);
  } catch (err) {
    return next(err);
  }
  return next();
};

/**
 * Attach `req.user` when a valid session is present, but never reject.
 * Useful for endpoints whose response varies for signed-in users.
 */
const optionalAuthMiddleware = async (req, res, next) => {
  const token = extractToken(req);
  if (!token) return next();
  try {
    req.user = await resolveSessionUser(token);
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
  resolveSessionUser,
};
