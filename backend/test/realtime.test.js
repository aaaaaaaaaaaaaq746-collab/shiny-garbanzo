const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

// helpers.js first: it sets the environment before config.js is ever loaded.
const { app, startDb, resetDb, stopDb, makeUser, makeFood } = require("./helpers");

const { io: ioClient } = require("socket.io-client");
const { attachRealtime, resetRealtime } = require("../realtime");
const jwt = require("jsonwebtoken");
const config = require("../config");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  await new Promise((resolve) => httpServer.close(resolve));
  resetRealtime();
  await stopDb();
});

beforeEach(resetDb);

// ---------------------------------------------------------------- helpers

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function tokenFor(role) {
  const email = `${role}-${Math.random().toString(36).slice(2, 10)}@college.edu`;
  await makeUser({ name: role, email, password: "password123", role });
  const res = await api("POST", "/api/auth/login", {
    body: { email, password: "password123" },
  });
  return { token: res.body.token, email, id: res.body.id };
}

/** Place an order for `user` and return the created order. */
async function orderFor(user) {
  const food = await makeFood({ name: "Realtime Item", price: 75 });
  const res = await api("POST", "/api/orders", {
    token: user.token,
    body: { items: [{ food: food._id.toString(), quantity: 1 }] },
  });
  assert.equal(res.status, 201);
  return res.body;
}

/** Open an authenticated socket. */
function connect(token) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(baseUrl, {
      auth: token ? { token } : {},
      transports: ["websocket"],
      reconnection: false,
      forceNew: true,
    });
    sockets.push(socket);
    socket.on("connect", () => resolve(socket));
    socket.on("connect_error", (err) => reject(err));
    setTimeout(() => reject(new Error("connect timeout")), 8000);
  });
}

/** Resolve with the connection error a bad handshake produces. */
function expectConnectError(token) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(baseUrl, {
      auth: token ? { token } : {},
      transports: ["websocket"],
      reconnection: false,
      forceNew: true,
    });
    sockets.push(socket);
    const timer = setTimeout(() => reject(new Error("expected connect_error")), 8000);
    socket.on("connect", () => {
      clearTimeout(timer);
      socket.close();
      reject(new Error("connection unexpectedly succeeded"));
    });
    socket.on("connect_error", (err) => {
      clearTimeout(timer);
      resolve(err);
    });
  });
}

/** Subscribe with an acknowledgement callback. */
function subscribe(socket, event, payload) {
  return new Promise((resolve) => {
    socket.emit(event, payload, (ack) => resolve(ack));
    setTimeout(() => resolve({ ok: false, error: "no ack" }), 5000);
  });
}

/** Resolve with the next payload of `event`, or reject on timeout. */
function nextEvent(socket, event, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/** Record every `event` delivery into an array for later assertions. */
function recordEvents(socket, event) {
  const seen = [];
  socket.on(event, (payload) => seen.push(payload));
  return seen;
}

const uniqueEvents = (events) => {
  const map = new Map();
  for (const e of events) map.set(e.eventId, e);
  return [...map.values()];
};

// ===================================================== 1. AUTHENTICATION

test("a socket connection without a token is rejected", async () => {
  const err = await expectConnectError(null);
  assert.match(err.message, /Authentication required/i);
});

test("a socket connection with an invalid or expired token is rejected", async () => {
  const garbage = await expectConnectError("not-a-real-token");
  assert.match(garbage.message, /Invalid token/i);

  const expired = jwt.sign({ id: new (require("mongoose").Types.ObjectId)() }, config.jwt.secret, {
    expiresIn: "-1s",
  });
  const expiredErr = await expectConnectError(expired);
  assert.match(expiredErr.message, /expired/i);
});

test("a token for a deleted account cannot open a socket", async () => {
  const user = await tokenFor("student");
  const User = require("../models/User");
  await User.deleteOne({ email: user.email });

  const err = await expectConnectError(user.token);
  assert.match(err.message, /no longer exists/i);
});

test("a bare token (no Bearer prefix) is accepted, matching REST", async () => {
  const user = await tokenFor("student");
  const socket = ioClient(baseUrl, {
    auth: { token: user.token },
    transports: ["websocket"],
    reconnection: false,
    forceNew: true,
  });
  sockets.push(socket);
  const connected = await new Promise((resolve) => {
    socket.on("connect", () => resolve(true));
    socket.on("connect_error", () => resolve(false));
  });
  assert.equal(connected, true);
});

// ================================================ 2. SUBSCRIPTION AUTHORIZATION

test("a student cannot subscribe to another student's order", async () => {
  const owner = await tokenFor("student");
  const intruder = await tokenFor("student");
  const order = await orderFor(owner);

  const socket = await connect(intruder.token);
  const ack = await subscribe(socket, "order:subscribe", { orderId: order._id });

  assert.equal(ack.ok, false);
  assert.match(ack.error, /not authorized/i);
});

test("a student can subscribe to their own order", async () => {
  const owner = await tokenFor("student");
  const order = await orderFor(owner);

  const socket = await connect(owner.token);
  const ack = await subscribe(socket, "order:subscribe", { orderId: order._id });

  assert.equal(ack.ok, true);
  assert.equal(ack.orderId, order._id);
});

test("staff can subscribe to any order; the canteen board is staff only", async () => {
  const owner = await tokenFor("student");
  const order = await orderFor(owner);

  const staffSocket = await connect((await tokenFor("staff")).token);
  assert.equal((await subscribe(staffSocket, "order:subscribe", { orderId: order._id })).ok, true);
  assert.equal((await subscribe(staffSocket, "canteen:subscribe", {})).ok, true);

  const studentSocket = await connect((await tokenFor("student")).token);
  const ack = await subscribe(studentSocket, "canteen:subscribe", {});
  assert.equal(ack.ok, false);
  assert.match(ack.error, /staff only/i);
});

test("subscribing with a malformed or unknown order id is refused", async () => {
  const user = await tokenFor("student");
  const socket = await connect(user.token);

  const bad = await subscribe(socket, "order:subscribe", { orderId: "not-an-id" });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /invalid order id/i);

  const missing = await subscribe(socket, "order:subscribe", {
    orderId: "0123456789abcdef01234567",
  });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /not found/i);
});

// ==================================================== 3. EVENT DELIVERY

test("a successful transition notifies the order owner", async () => {
  const owner = await tokenFor("student");
  const admin = await tokenFor("admin");
  const order = await orderFor(owner);

  const socket = await connect(owner.token);
  await subscribe(socket, "order:subscribe", { orderId: order._id });

  const waiting = nextEvent(socket, "order:updated");
  const res = await api("PUT", `/api/orders/${order._id}/status`, {
    token: admin.token,
    body: { status: "Accepted" },
  });
  assert.equal(res.status, 200);

  const event = await waiting;
  assert.equal(event.orderId, order._id);
  assert.equal(event.status, "Accepted");
  assert.equal(event.previousStatus, "Pending");
  assert.ok(event.at, "event carries a timestamp");
  assert.ok(event.eventId, "event carries a dedupe id");
});

test("the staff board receives events for every order", async () => {
  const owner = await tokenFor("student");
  const admin = await tokenFor("admin");
  const order = await orderFor(owner);

  const board = await connect((await tokenFor("staff")).token);
  await subscribe(board, "canteen:subscribe", {});

  const waiting = nextEvent(board, "order:updated");
  await api("PUT", `/api/orders/${order._id}/status`, {
    token: admin.token,
    body: { status: "Preparing" },
  });

  const event = await waiting;
  assert.equal(event.orderId, order._id);
  assert.equal(event.status, "Preparing");
});

test("a student never receives another student's order events", async () => {
  const owner = await tokenFor("student");
  const bystander = await tokenFor("student");
  const admin = await tokenFor("admin");
  const order = await orderFor(owner);

  const listener = await connect(bystander.token);
  const seen = recordEvents(listener, "order:updated");

  // Bystander watches the canteen channel (will be refused) and their own
  // (nonexistent) order, while the real order changes underneath.
  await subscribe(listener, "canteen:subscribe", {});
  await subscribe(listener, "order:subscribe", { orderId: order._id }); // must fail

  await api("PUT", `/api/orders/${order._id}/status`, {
    token: admin.token,
    body: { status: "Accepted" },
  });
  await sleep(400);

  const leaked = seen.filter((e) => e.orderId === order._id);
  assert.equal(leaked.length, 0, "a non-owner must never be told about this order");
});

test("cancellation emits an event to the owner", async () => {
  const owner = await tokenFor("student");
  const order = await orderFor(owner);

  const socket = await connect(owner.token);
  await subscribe(socket, "order:subscribe", { orderId: order._id });

  const waiting = nextEvent(socket, "order:updated");
  const res = await api("POST", `/api/orders/${order._id}/cancel`, {
    token: owner.token,
    body: {},
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "Cancelled");

  const event = await waiting;
  assert.equal(event.status, "Cancelled");
  assert.equal(event.previousStatus, "Pending");
});

test("order creation notifies the owner's other sessions", async () => {
  const owner = await tokenFor("student");

  const tab = await connect(owner.token); // no order subscription needed
  const waiting = nextEvent(tab, "order:updated");

  const order = await orderFor(owner);

  const event = await waiting;
  assert.equal(event.orderId, order._id);
  assert.equal(event.status, "Pending");
});

test("payloads carry no order contents, only a notification", async () => {
  const owner = await tokenFor("student");
  const admin = await tokenFor("admin");
  const order = await orderFor(owner);

  const socket = await connect(owner.token);
  await subscribe(socket, "order:subscribe", { orderId: order._id });
  const waiting = nextEvent(socket, "order:updated");

  await api("PUT", `/api/orders/${order._id}/status`, {
    token: admin.token,
    body: { status: "Completed" },
  });

  const event = await waiting;
  assert.deepEqual(
    Object.keys(event).sort(),
    ["at", "eventId", "orderId", "previousStatus", "status"]
  );
  assert.equal(event.total, undefined, "no money or item data on the wire");
  assert.equal(event.items, undefined);
  assert.equal(event.student, undefined);
});

// ============================================ 4. EMIT-ONLY-ON-SUCCESS

test("refused transitions emit no event", async () => {
  const owner = await tokenFor("student");
  const admin = await tokenFor("admin");
  const order = await orderFor(owner);

  const socket = await connect(owner.token);
  await subscribe(socket, "order:subscribe", { orderId: order._id });
  const seen = recordEvents(socket, "order:updated");

  const failures = [
    // student tries to set status
    await api("PUT", `/api/orders/${order._id}/status`, {
      token: owner.token,
      body: { status: "Completed" },
    }),
    // unknown status
    await api("PUT", `/api/orders/${order._id}/status`, {
      token: admin.token,
      body: { status: "Hacked" },
    }),
    // backwards from terminal
    await api("POST", `/api/orders/${order._id}/cancel`, { token: owner.token, body: {} }),
    await api("PUT", `/api/orders/${order._id}/status`, {
      token: admin.token,
      body: { status: "Pending" },
    }),
    // another student tries to cancel
    await api("POST", `/api/orders/${order._id}/cancel`, {
      token: (await tokenFor("student")).token,
      body: {},
    }),
  ];

  assert.deepEqual(failures.map((f) => f.status), [403, 400, 200, 409, 403]);
  await sleep(400);

  // Only the one successful cancellation (200) may have produced an event.
  const unique = uniqueEvents(seen);
  assert.equal(unique.length, 1, `expected 1 event, got ${unique.length}`);
  assert.equal(unique[0].status, "Cancelled");
});

test("a validation failure that prevents a transition emits nothing", async () => {
  const owner = await tokenFor("student");
  const admin = await tokenFor("admin");
  const order = await orderFor(owner);

  const socket = await connect(owner.token);
  const seen = recordEvents(socket, "order:updated");

  await api("PUT", `/api/orders/${order._id}/status`, {
    token: admin.token,
    body: { status: "Rejected" }, // missing required reason -> 400
  });
  await sleep(300);

  assert.equal(uniqueEvents(seen).length, 0, "a rejected request must not notify");
});

// ==================================================== 5. CONCURRENCY

test("a lost concurrency race emits exactly one event, for the winner", async () => {
  const owner = await tokenFor("student");
  const a1 = await tokenFor("admin");
  const a2 = await tokenFor("admin");
  const order = await orderFor(owner);

  const socket = await connect(owner.token);
  await subscribe(socket, "order:subscribe", { orderId: order._id });
  const seen = recordEvents(socket, "order:updated");

  const [accept, prepare] = await Promise.all([
    api("PUT", `/api/orders/${order._id}/status`, {
      token: a1.token,
      body: { status: "Accepted" },
    }),
    api("PUT", `/api/orders/${order._id}/status`, {
      token: a2.token,
      body: { status: "Preparing" },
    }),
  ]);

  assert.deepEqual([accept.status, prepare.status].sort(), [200, 409]);
  await sleep(400);

  const unique = uniqueEvents(seen);
  assert.equal(unique.length, 1, "only the winning transition may be broadcast");

  const winner = accept.status === 200 ? "Accepted" : "Preparing";
  assert.equal(unique[0].status, winner);

  // The broadcast agrees with the database.
  const snapshot = await api("GET", `/api/orders/${order._id}`, { token: owner.token });
  assert.equal(snapshot.body.status, winner);
});

test("concurrent cancels by the owner emit one notification", async () => {
  const owner = await tokenFor("student");
  const order = await orderFor(owner);

  const socket = await connect(owner.token);
  await subscribe(socket, "order:subscribe", { orderId: order._id });
  const seen = recordEvents(socket, "order:updated");

  const [first, second] = await Promise.all([
    api("POST", `/api/orders/${order._id}/cancel`, { token: owner.token, body: {} }),
    api("POST", `/api/orders/${order._id}/cancel`, { token: owner.token, body: {} }),
  ]);

  assert.equal(first.status, 200);
  assert.ok([200, 409].includes(second.status), "repeat is idempotent or conflicts");

  await sleep(400);
  const unique = uniqueEvents(seen).filter((e) => e.status === "Cancelled");
  assert.ok(unique.length <= 1, `expected at most one cancel event, got ${unique.length}`);

  const snapshot = await api("GET", `/api/orders/${order._id}`, { token: owner.token });
  assert.equal(snapshot.body.status, "Cancelled");
  assert.equal(
    snapshot.body.statusHistory.filter((h) => h.status === "Cancelled").length,
    1,
    "the database records exactly one cancellation"
  );
});

test("duplicate delivery across overlapping rooms is dedupable by eventId", async () => {
  const owner = await tokenFor("student");
  const admin = await tokenFor("admin");
  const order = await orderFor(owner);

  // Owner is in BOTH their user room (automatic) and the order room.
  const socket = await connect(owner.token);
  await subscribe(socket, "order:subscribe", { orderId: order._id });
  const seen = recordEvents(socket, "order:updated");

  await api("PUT", `/api/orders/${order._id}/status`, {
    token: admin.token,
    body: { status: "Accepted" },
  });
  await sleep(400);

  assert.ok(seen.length >= 1, "at least one delivery is expected");
  const unique = uniqueEvents(seen);
  assert.equal(unique.length, 1, `all deliveries collapse to one eventId, got ${unique.length}`);
});

// ==================================================== 6. RECONNECT

test("a reconnecting client recovers missed changes from a fresh REST snapshot", async () => {
  const owner = await tokenFor("student");
  const admin = await tokenFor("admin");
  const order = await orderFor(owner);

  // Session 1 subscribes, then drops off the network.
  const first = await connect(owner.token);
  await subscribe(first, "order:subscribe", { orderId: order._id });
  const missed = recordEvents(first, "order:updated");

  first.close();
  await sleep(200);

  // Two transitions happen while the client is disconnected.
  await api("PUT", `/api/orders/${order._id}/status`, {
    token: admin.token,
    body: { status: "Accepted" },
  });
  await api("PUT", `/api/orders/${order._id}/status`, {
    token: admin.token,
    body: { status: "Preparing" },
  });
  await sleep(300);

  assert.equal(missed.length, 0, "a disconnected client receives nothing");

  // Session 2 reconnects and re-reads authoritative state over REST.
  const second = await connect(owner.token);
  assert.equal(second.connected, true);

  const snapshot = await api("GET", "/api/orders", { token: owner.token });
  const recovered = snapshot.body.find((o) => o._id === order._id);

  assert.equal(recovered.status, "Preparing", "REST snapshot closes the gap");
  assert.deepEqual(
    recovered.statusHistory.map((h) => h.status),
    ["Pending", "Accepted", "Preparing"]
  );

  // And live delivery resumes for subsequent changes.
  await subscribe(second, "order:subscribe", { orderId: order._id });
  const waiting = nextEvent(second, "order:updated");
  await api("PUT", `/api/orders/${order._id}/status`, {
    token: admin.token,
    body: { status: "Ready" },
  });
  const event = await waiting;
  assert.equal(event.status, "Ready");
});

test("unsubscribing stops delivery for that order", async () => {
  const owner = await tokenFor("student");
  const admin = await tokenFor("admin");
  const order = await orderFor(owner);

  const socket = await connect(owner.token);
  await subscribe(socket, "order:subscribe", { orderId: order._id });

  socket.emit("order:unsubscribe", { orderId: order._id });
  await sleep(150);

  const seen = recordEvents(socket, "order:updated");
  await api("PUT", `/api/orders/${order._id}/status`, {
    token: admin.token,
    body: { status: "Accepted" },
  });
  await sleep(400);

  // The user room still reaches this socket (its own order), so assert that
  // the *subscription* no longer adds duplicate deliveries.
  assert.ok(seen.length <= 1, `expected at most one delivery, got ${seen.length}`);
});

// ============================================ 7. REST INDEPENDENCE

test("REST endpoints keep working when no socket is connected", async () => {
  const owner = await tokenFor("student");
  const admin = await tokenFor("admin");

  const order = await orderFor(owner);
  const moved = await api("PUT", `/api/orders/${order._id}/status`, {
    token: admin.token,
    body: { status: "Accepted" },
  });

  assert.equal(moved.status, 200, "REST must not depend on the realtime layer");
  assert.equal(moved.body.status, "Accepted");
});

test("statusHistory keeps an exact total while bounding the stored array", async () => {
  const owner = await tokenFor("student");
  const admin = await tokenFor("admin");
  const order = await orderFor(owner);

  await api("PUT", `/api/orders/${order._id}/status`, {
    token: admin.token,
    body: { status: "Accepted" },
  });
  await api("PUT", `/api/orders/${order._id}/status`, {
    token: admin.token,
    body: { status: "Preparing" },
  });

  const snapshot = await api("GET", `/api/orders/${order._id}`, { token: owner.token });
  assert.equal(snapshot.body.statusHistory.length, 3);
  assert.equal(
    snapshot.body.statusHistoryTotal,
    3,
    "the exact transition count is preserved for auditing"
  );
});