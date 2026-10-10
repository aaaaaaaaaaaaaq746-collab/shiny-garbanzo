const mongoose = require("mongoose");
const config = require("../config");
const ApiError = require("../utils/ApiError");

/** 404 handler for unmatched routes. */
function notFoundHandler(req, res, next) {
  next(new ApiError(404, `Route not found: ${req.method} ${req.originalUrl}`));
}

/**
 * Map driver/ODM errors onto correct HTTP status codes.
 *
 * Returning raw `err.message` to clients is what previously leaked internal
 * index names; only a curated message is sent in production.
 */
function normalizeError(err) {
  // Already an intentional API error — trust its status.
  if (err instanceof ApiError) return err;

  if (err instanceof mongoose.Error.ValidationError) {
    const details = Object.fromEntries(
      Object.entries(err.errors).map(([field, e]) => [field, e.message])
    );
    return ApiError.badRequest("Validation failed", details);
  }

  if (err instanceof mongoose.Error.CastError) {
    return ApiError.badRequest(`Invalid value for field "${err.path}"`);
  }

  // Duplicate key (e.g. signup with an email that already exists).
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || "field";
    const friendly =
      field === "email"
        ? "An account with this email already exists"
        : `Duplicate value for "${field}"`;
    return ApiError.conflict(friendly);
  }

  if (err.type === "entity.parse.failed") {
    return ApiError.badRequest("Malformed JSON in request body");
  }

  if (err.type === "entity.too.large") {
    return new ApiError(413, "Request body too large");
  }

  // Unknown server fault.
  const wrapped = new ApiError(500, "Internal server error");
  wrapped.originalError = err;
  return wrapped;
}

/**
 * Centralized error handler.
 *
 * Express 5 forwards rejected promises from async handlers here, so route
 * code no longer needs its own try/catch for status mapping.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const apiError = normalizeError(err);

  // Never leak internals in production; always log server-side.
  if (apiError.statusCode >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl}`, err.originalError || err);
  }

  const body = { message: apiError.message };
  if (apiError.details && !config.isProduction) {
    body.details = apiError.details;
  }

  res.status(apiError.statusCode).json(body);
}

module.exports = { notFoundHandler, errorHandler, normalizeError };