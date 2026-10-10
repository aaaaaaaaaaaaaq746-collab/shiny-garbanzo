const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

/**
 * DB-backed session rules (P1-N1, P1-N13, P1-N7).
 *
 * Requires MongoDB (see README "Running the backend tests"). Covers real HTTP
 * logout, a deactivated account, a legacy token, and the same rules on the
 * Socket.IO handshake.
 */

const { app, api, startDb, resetDb, stopDb, makeUser } = require("./helpers");
const { attachRealtime, resetRealtime } = require("../realtime");
const { io: ioClient } = require("socket.io-client");
const jwt = require("jsonwebtoken");
const config = require("../config");
const User = require("../models/User");

let httpServer;
let baseUrl;
const sockets = [];

before(async () => {
  await startDb();
  httpServer = http.createServer(app);
  attachRealtime(httpServer);
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

after(async () => {
  sockets.forEach((s) => s.close());
  // If startDb() failed (e.g. MongoDB could not be started), httpServer is unset.
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  resetRealtime();
  await stopDb();
});

beforeEach(resetDb);

let seq = 0;
async function account(role = "student") {
  seq += 1;
  const email = `${role}-s${seq}-${Math.random().toString(36).slice(2, 8)}@college.edu`;
  const user = await makeUser({ name: `${role} ${seq}`, email, role });
  return { user, email };
}

async function login(email) {
  const res = await api().post("/api/auth/login").send({ email, password: "password123" });
  assert.equal(res.status, 200, `login failed: ${JSON.stringify(res.body)}`);
  return res.body.token;
}

const whoAmI = (token) => api().get("/api/orders").set("Authorization", `Bearer ${token}`);

/** Connect a Socket.IO client and resolve with the connect outcome. */
function connectSocket(token) {
  return new Promise((resolve) => {
    const socket = ioClient(baseUrl, {
      auth: { token },
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
    });
    sockets.push(socket);
    socket.on("connect", () => resolve({ ok: true, socket }));
    socket.on("connect_error", (err) => resolve({ ok: false, message: err.message }));
  });
}

// ------------------------------------------------------------ logout (N13)

test("P1-N13: logout revokes the token that was used to call it", async () => {
  const { email } = await account("student");
  const token = await login(email);
  assert.equal((await whoAmI(token)).status, 200);

  const out = await api().post("/api/auth/logout").set("Authorization", `Bearer ${token}`);
  assert.equal(out.status, 200);

  const after = await whoAmI(token);
  assert.equal(after.status, 401);
  assert.match(after.body.message, /Session has ended/);
});

test("P1-N13: logout revokes every earlier session for the account, not just one", async () => {
  const { email } = await account("student");
  const laptop = await login(email);
  const phone = await login(email);

  await api().post("/api/auth/logout").set("Authorization", `Bearer ${laptop}`);

  assert.equal((await whoAmI(laptop)).status, 401);
  assert.equal((await whoAmI(phone)).status, 401);
});

test("P1-N13: logging in again after logout issues a working token", async () => {
  const { email } = await account("student");
  const first = await login(email);
  await api().post("/api/auth/logout").set("Authorization", `Bearer ${first}`);

  const second = await login(email);
  assert.equal((await whoAmI(second)).status, 200);
  assert.equal((await whoAmI(first)).status, 401);
});

test("P1-N13: the tokenVersion field defaults to 0 for new accounts", async () => {
  const { user } = await account("student");
  const fresh = await User.findById(user._id);
  assert.equal(fresh.tokenVersion, 0);
});

test("legacy token without a tv claim keeps working until the account logs out", async () => {
  const { user } = await account("student");
  const legacy = jwt.sign({ id: user._id.toString() }, config.jwt.secret, { expiresIn: "1h" });
  assert.equal((await whoAmI(legacy)).status, 200);

  await api().post("/api/auth/logout").set("Authorization", `Bearer ${await login(user.email)}`);
  assert.equal((await whoAmI(legacy)).status, 401);
});

// ----------------------------------------------------- deactivation (N1)

test("P1-N1: a deactivated account loses access immediately, with a valid token", async () => {
  const { user, email } = await account("student");
  const token = await login(email);
  assert.equal((await whoAmI(token)).status, 200);

  await User.updateOne({ _id: user._id }, { $set: { isActive: false } });

  const res = await whoAmI(token);
  assert.equal(res.status, 401);
  assert.equal(res.body.message, "This account has been deactivated");
});

test("P1-N1: an admin who is deactivated is refused on admin routes too", async () => {
  const { user, email } = await account("admin");
  const token = await login(email);
  await User.updateOne({ _id: user._id }, { $set: { isActive: false } });

  const res = await api().get("/api/inventory").set("Authorization", `Bearer ${token}`);
  assert.equal(res.status, 401);
});

// ------------------------------------------------- socket handshake (N7)

test("socket: a valid token connects", async () => {
  const { email } = await account("student");
  const result = await connectSocket(await login(email));
  assert.equal(result.ok, true);
});

test("socket: a deactivated account is refused at the handshake", async () => {
  const { user, email } = await account("student");
  const token = await login(email);
  await User.updateOne({ _id: user._id }, { $set: { isActive: false } });

  const result = await connectSocket(token);
  assert.equal(result.ok, false);
  assert.match(result.message, /deactivated/i);
});

test("socket: a revoked (logged-out) token is refused at the handshake", async () => {
  const { email } = await account("student");
  const token = await login(email);
  await api().post("/api/auth/logout").set("Authorization", `Bearer ${token}`);

  const result = await connectSocket(token);
  assert.equal(result.ok, false);
  assert.match(result.message, /ended/i);
});

test("socket: a bearer-prefixed handshake token is accepted (shared extractToken)", async () => {
  const { email } = await account("student");
  const token = await login(email);
  const result = await connectSocket(`Bearer ${token}`);
  assert.equal(result.ok, true);
});
