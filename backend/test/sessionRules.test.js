const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");

/**
 * Session rules without a database (P1-N1, P1-N13, P1-N7).
 *
 * `User.findById` is stubbed, so these tests run anywhere. The DB-backed
 * counterpart (real HTTP, real logout, real sockets) is sessionRevocation.test.js.
 */

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-not-used-anywhere-else-0123456789";
process.env.MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/never-used-in-tests";

const jwt = require("jsonwebtoken");
const config = require("../config");
const User = require("../models/User");
const ApiError = require("../utils/ApiError");
const {
  authMiddleware,
  optionalAuthMiddleware,
  extractToken,
  resolveSessionUser,
} = require("../middleware/authMiddleware");

const originalFindById = User.findById;
afterEach(() => {
  User.findById = originalFindById;
});

/** Make User.findById resolve to `doc` (or null) without touching the DB. */
function stubUser(doc) {
  User.findById = async () => doc;
}

const liveUser = (overrides = {}) => ({
  _id: "64b000000000000000000001",
  role: "student",
  isActive: true,
  tokenVersion: 0,
  ...overrides,
});

const sign = (payload, options = {}) =>
  jwt.sign({ id: "64b000000000000000000001", ...payload }, config.jwt.secret, {
    expiresIn: "1h",
    ...options,
  });

/** Run the Express middleware and capture what it passed to next(). */
function runMiddleware(mw, headers = {}) {
  return new Promise((resolve) => {
    const req = { headers };
    mw(req, {}, (err) => resolve({ err, req }));
  });
}

// ------------------------------------------------------------ extractToken

test("extractToken: accepts Bearer and bare tokens, rejects other schemes", () => {
  assert.equal(extractToken({ headers: { authorization: "Bearer abc" } }), "abc");
  assert.equal(extractToken({ headers: { authorization: "bearer abc" } }), "abc");
  assert.equal(extractToken({ headers: { authorization: "abc" } }), "abc");
  assert.equal(extractToken({ headers: { authorization: "Basic abc" } }), null);
  assert.equal(extractToken({ headers: {} }), null);
  assert.equal(extractToken({ headers: { authorization: "   " } }), null);
});

test("extractToken: reads a socket handshake (auth.token first, then header)", () => {
  assert.equal(
    extractToken({ handshake: { auth: { token: "Bearer xyz" }, headers: {} } }),
    "xyz"
  );
  assert.equal(
    extractToken({ handshake: { auth: {}, headers: { authorization: "Bearer q" } } }),
    "q"
  );
  assert.equal(extractToken({ handshake: { auth: {}, headers: {} } }), null);
});

// ------------------------------------------------------- resolveSessionUser

test("a valid token for a live, active, current-version user is accepted", async () => {
  stubUser(liveUser());
  const user = await resolveSessionUser(sign({ tv: 0 }));
  assert.equal(user.role, "student");
});

test("a legacy token with no tv claim is accepted while tokenVersion is 0", async () => {
  // Tokens issued before tokenVersion existed carry no `tv` claim.
  stubUser(liveUser());
  const user = await resolveSessionUser(sign({}));
  assert.ok(user);
});

test("P1-N1: a deactivated account is rejected with 401 even with a valid token", async () => {
  stubUser(liveUser({ isActive: false }));
  await assert.rejects(resolveSessionUser(sign({ tv: 0 })), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.statusCode, 401);
    assert.equal(err.message, "This account has been deactivated");
    return true;
  });
});

test("P1-N13: a token whose tv no longer matches the account is rejected", async () => {
  // Simulates logout (tokenVersion bumped 0 -> 1) on another device.
  stubUser(liveUser({ tokenVersion: 1 }));
  await assert.rejects(resolveSessionUser(sign({ tv: 0 })), (err) => {
    assert.equal(err.statusCode, 401);
    assert.match(err.message, /Session has ended/);
    return true;
  });
});

test("P1-N13: a legacy token (no tv) is rejected once the account has logged out", async () => {
  stubUser(liveUser({ tokenVersion: 1 }));
  await assert.rejects(resolveSessionUser(sign({})), (err) => err.statusCode === 401);
});

test("a token for a deleted account is rejected with 401", async () => {
  stubUser(null);
  await assert.rejects(resolveSessionUser(sign({ tv: 0 })), (err) => {
    assert.equal(err.statusCode, 401);
    assert.match(err.message, /no longer exists/);
    return true;
  });
});

test("an expired token is rejected with a clear 401", async () => {
  stubUser(liveUser());
  const expired = jwt.sign({ id: "64b000000000000000000001", tv: 0, exp: 1 }, config.jwt.secret);
  await assert.rejects(resolveSessionUser(expired), (err) => {
    assert.equal(err.statusCode, 401);
    assert.match(err.message, /expired/i);
    return true;
  });
});

test("a token signed with the wrong secret is rejected with 401", async () => {
  stubUser(liveUser());
  const forged = jwt.sign({ id: "64b000000000000000000001", tv: 0 }, "not-the-secret");
  await assert.rejects(resolveSessionUser(forged), (err) => {
    assert.equal(err.statusCode, 401);
    assert.match(err.message, /Invalid/);
    return true;
  });
});

// ------------------------------------------------------------- middleware

test("authMiddleware: no token gives 401 and does not call the DB", async () => {
  let called = false;
  User.findById = async () => {
    called = true;
    return null;
  };
  const { err } = await runMiddleware(authMiddleware, {});
  assert.equal(err.statusCode, 401);
  assert.equal(called, false);
});

test("authMiddleware: attaches the live user document on success", async () => {
  stubUser(liveUser({ role: "admin" }));
  const { err, req } = await runMiddleware(authMiddleware, {
    authorization: `Bearer ${sign({ tv: 0 })}`,
  });
  assert.equal(err, undefined);
  assert.equal(req.user.role, "admin");
});

test("authMiddleware: a deactivated account is refused (P1-N1)", async () => {
  stubUser(liveUser({ isActive: false }));
  const { err } = await runMiddleware(authMiddleware, {
    authorization: `Bearer ${sign({ tv: 0 })}`,
  });
  assert.equal(err.statusCode, 401);
  assert.equal(err.message, "This account has been deactivated");
});

test("optionalAuthMiddleware: a deactivated account is treated as anonymous, not as a user", async () => {
  stubUser(liveUser({ isActive: false }));
  const { err, req } = await runMiddleware(optionalAuthMiddleware, {
    authorization: `Bearer ${sign({ tv: 0 })}`,
  });
  assert.equal(err, undefined);
  assert.equal(req.user, undefined);
});
