const { test } = require("node:test");
const assert = require("node:assert/strict");

// Imported first for its env side effects: config.js reads process.env once
// at module load and throws when JWT_SECRET is missing.
require("./helpers");

const express = require("express");
const request = require("supertest");
const { makeLimiter } = require("../middleware/rateLimit");
const { errorHandler } = require("../middleware/errorHandler");

/**
 * Rate limiting is disabled globally under NODE_ENV=test so the functional
 * suites are not throttled. These tests exercise the limiter directly on a
 * throwaway app to prove the 429 behaviour is genuinely wired up.
 */
function appWithLimiter({ max, enabled = true }) {
  const app = express();
  app.use(
    makeLimiter({
      windowMs: 60 * 60 * 1000,
      max,
      message: "Too many login or signup attempts. Please try again later.",
      enabled,
    })
  );
  app.post("/api/auth/login", (req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  return app;
}

test("auth limiter returns 429 once the limit is exceeded", async () => {
  const app = appWithLimiter({ max: 3 });

  const first = await request(app).post("/api/auth/login").send({});
  const second = await request(app).post("/api/auth/login").send({});
  const third = await request(app).post("/api/auth/login").send({});
  const fourth = await request(app).post("/api/auth/login").send({});

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(third.status, 200);
  assert.equal(fourth.status, 429);
  assert.match(fourth.body.message, /too many/i);
});

test("throttled responses advertise the standard RateLimit headers", async () => {
  const app = appWithLimiter({ max: 1 });

  await request(app).post("/api/auth/login").send({});
  const blocked = await request(app).post("/api/auth/login").send({});

  assert.equal(blocked.status, 429);

  // `standardHeaders: true` emits the draft-6 style set (individual
  // headers), not the single combined "RateLimit" header from draft-7.
  assert.equal(blocked.headers["ratelimit-limit"], "1");
  assert.equal(blocked.headers["ratelimit-remaining"], "0");
  assert.ok(blocked.headers["ratelimit-policy"], "policy header expected");
  assert.ok(blocked.headers["ratelimit-reset"], "reset header expected");
  assert.ok(blocked.headers["retry-after"], "retry-after expected on a 429");

  assert.equal(blocked.headers["x-ratelimit-limit"], undefined, "legacy headers suppressed");
});

test("the limiter does not echo submitted credentials", async () => {
  const app = appWithLimiter({ max: 1 });

  await request(app).post("/api/auth/login").send({ email: "a@b.com", password: "secret123" });
  const blocked = await request(app).post("/api/auth/login").send({ email: "a@b.com", password: "secret123" });

  assert.equal(blocked.status, 429);
  assert.equal(JSON.stringify(blocked.body).includes("secret123"), false);
});

test("the limiter can be disabled programmatically", async () => {
  const app = appWithLimiter({ max: 1, enabled: false });

  for (let i = 0; i < 5; i += 1) {
    const res = await request(app).post("/api/auth/login").send({});
    assert.equal(res.status, 200);
  }
});