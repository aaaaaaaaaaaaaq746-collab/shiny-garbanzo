const mongoose = require("mongoose");
const ApiError = require("./ApiError");

/**
 * Dependency-free validators.
 *
 * Every validator returns the *normalized* value so callers never touch the
 * raw user input, or throws an ApiError(400) describing the problem.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const OBJECT_ID_RE = /^[a-fA-F0-9]{24}$/;
const URL_RE = /^https?:\/\/\S+$/i;

const isPlainObject = (v) =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const EMAIL_MAX = 254;
const NAME_MAX = 80;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

function email(value, field = "email") {
  if (typeof value !== "string" || !value.trim()) {
    throw ApiError.badRequest(`${field} is required`);
  }
  const v = value.trim().toLowerCase();
  if (v.length > EMAIL_MAX) {
    throw ApiError.badRequest(`${field} is too long`);
  }
  if (!EMAIL_RE.test(v)) {
    throw ApiError.badRequest(`${field} must be a valid email address`);
  }
  return v;
}

function name(value, field = "name") {
  if (typeof value !== "string" || !value.trim()) {
    throw ApiError.badRequest(`${field} is required`);
  }
  const v = value.trim().replace(/\s+/g, " ");
  if (v.length > NAME_MAX) {
    throw ApiError.badRequest(`${field} must be at most ${NAME_MAX} characters`);
  }
  return v;
}

function password(value, field = "password") {
  if (typeof value !== "string" || !value) {
    throw ApiError.badRequest(`${field} is required`);
  }
  if (value.length < PASSWORD_MIN) {
    throw ApiError.badRequest(`${field} must be at least ${PASSWORD_MIN} characters`);
  }
  if (value.length > PASSWORD_MAX) {
    throw ApiError.badRequest(`${field} must be at most ${PASSWORD_MAX} characters`);
  }
  return value;
}

function objectId(value, field = "id") {
  if (typeof value !== "string" || !OBJECT_ID_RE.test(value.trim())) {
    throw ApiError.badRequest(`Invalid ${field}`);
  }
  const v = value.trim();
  // Cross-check against Mongoose so bad ids never reach the driver.
  if (!mongoose.Types.ObjectId.isValid(v)) {
    throw ApiError.badRequest(`Invalid ${field}`);
  }
  return v;
}

/** Price in rupees: finite number, 2dp, strictly positive, sane ceiling. */
function price(value, field = "price") {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw ApiError.badRequest(`${field} must be a number`);
  }
  if (n <= 0) {
    throw ApiError.badRequest(`${field} must be greater than 0`);
  }
  if (n > 100000) {
    throw ApiError.badRequest(`${field} is unrealistically large`);
  }
  // Reject sub-paisa precision instead of silently rounding money.
  if (Math.round(n * 100) !== n * 100) {
    throw ApiError.badRequest(`${field} must have at most 2 decimal places`);
  }
  return Math.round(n * 100) / 100;
}

/** Whole-number quantity within an inclusive range. */
function quantity(value, { field = "quantity", min = 1, max = 20 } = {}) {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw ApiError.badRequest(`${field} must be a number`);
  }
  if (!Number.isInteger(n)) {
    throw ApiError.badRequest(`${field} must be a whole number`);
  }
  if (n < min || n > max) {
    throw ApiError.badRequest(`${field} must be between ${min} and ${max}`);
  }
  return n;
}

function optionalString(value, { field, max = 500 } = {}) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw ApiError.badRequest(`${field} must be a string`);
  }
  const v = value.trim();
  if (!v) return undefined;
  if (v.length > max) {
    throw ApiError.badRequest(`${field} must be at most ${max} characters`);
  }
  return v;
}

function optionalUrl(value, { field = "image" } = {}) {
  const v = optionalString(value, { field, max: 2048 });
  if (v === undefined) return undefined;
  if (!URL_RE.test(v)) {
    throw ApiError.badRequest(`${field} must be a valid http(s) URL`);
  }
  return v;
}

function boolean(value, field = "value") {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw ApiError.badRequest(`${field} must be a boolean`);
}

function oneOf(value, allowed, field = "value") {
  if (!allowed.includes(value)) {
    throw ApiError.badRequest(
      `${field} must be one of: ${allowed.join(", ")}`
    );
  }
  return value;
}

function object(value, field = "body") {
  if (!isPlainObject(value)) {
    throw ApiError.badRequest(`${field} must be an object`);
  }
  return value;
}

function array(value, { field = "value", max = 100 } = {}) {
  if (!Array.isArray(value)) {
    throw ApiError.badRequest(`${field} must be an array`);
  }
  if (value.length > max) {
    throw ApiError.badRequest(`${field} must contain at most ${max} entries`);
  }
  return value;
}

/** Round a money value to paise to avoid float drift in totals. */
function roundMoney(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

module.exports = {
  email,
  name,
  password,
  objectId,
  price,
  quantity,
  optionalString,
  optionalUrl,
  boolean,
  oneOf,
  object,
  array,
  roundMoney,
  limits: { EMAIL_MAX, NAME_MAX, PASSWORD_MIN, PASSWORD_MAX },
};