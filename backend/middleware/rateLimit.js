const rateLimit = require("express-rate-limit");
const config = require("../config");

/**
 * Write the IETF `RateLimit-*` headers for a throttled request.
 *
 * express-rate-limit emits these automatically for allowed requests, but a
 * custom `handler` replaces its default response path, so they must be set
 * explicitly here — otherwise throttled clients get a 429 with no limit
 * information to back off against.
 */
function setRateLimitHeaders(req, res, { max, windowMs }) {
  const info = req.rateLimit || {};

  if (info.limit !== undefined) {
    res.setHeader("RateLimit-Limit", info.limit);
    res.setHeader("RateLimit-Remaining", Math.max(0, info.remaining ?? 0));
  } else {
    res.setHeader("RateLimit-Limit", max);
    res.setHeader("RateLimit-Remaining", 0);
  }

  const resetTime = info.resetTime instanceof Date ? info.resetTime : new Date(Date.now() + windowMs);
  const resetSeconds = Math.max(0, Math.ceil((resetTime.getTime() - Date.now()) / 1000));
  res.setHeader("RateLimit-Reset", resetSeconds);
  res.setHeader("RateLimit-Policy", `${max};w=${Math.ceil(windowMs / 1000)}`);
}

/**
 * Rate limiters.
 *
 * `standardHeaders: true` emits the IETF `RateLimit-*` headers;
 * `legacyHeaders: false` suppresses the old X-RateLimit-* set.
 *
 * Disabled by default under NODE_ENV=test so functional suites are not
 * throttled; the limiter itself is unit-tested directly in
 * test/rateLimit.test.js.
 */
function makeLimiter({ windowMs, max, message, enabled }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => !enabled,
    message: {
      message: message || "Too many requests, please try again later.",
    },
    // Log a throttled request without ever logging submitted credentials.
    handler: (req, res) => {
      const scope = message?.startsWith("Too many login") ? "auth" : "request";
      console.warn(`[rate-limit] throttled ${scope} from ${req.ip}`);
      setRateLimitHeaders(req, res, { max, windowMs });
      res.status(429).json({
        message: message || "Too many requests, please try again later.",
      });
    },
  });
}

/** Stricter limiter for credential endpoints. */
const authLimiter = makeLimiter({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.authMax,
  message: "Too many login or signup attempts. Please try again later.",
  enabled: config.rateLimit.enabled,
});

/** Looser limiter applied to the rest of the API. */
const apiLimiter = makeLimiter({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.apiMax,
  enabled: config.rateLimit.enabled,
});

module.exports = { authLimiter, apiLimiter, makeLimiter, setRateLimitHeaders };