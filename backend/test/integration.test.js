const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { spawn, execFile } = require("node:child_process");
const path = require("node:path");

/**
 * End-to-end integration: boots the REAL server.js as a child process
 * against a live in-memory MongoDB and drives the full workflow over HTTP,
 * exactly as the browser does.
 */

const PORT = 5099;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, "..");
const SECRET = "integration-test-secret-0123456789abcdef";

let mongod;
let server;
let adminEmail = "e2e-admin@college.edu";
const ADMIN_PASSWORD = "admin-password-1";
const STUDENT_PASSWORD = "student-password-1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch {
      // Not up yet.
    }
    await sleep(250);
  }
  throw new Error("server did not become healthy in time");
}

/** Thin fetch wrapper that returns { status, body }. */
async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

before(async () => {
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri("canteenE2E");

  server = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(PORT),
      MONGO_URI: uri,
      JWT_SECRET: SECRET,
      RATE_LIMIT_ENABLED: "false",
      CORS_ORIGINS: BASE,
    },
    stdio: "pipe",
  });

  server.stderr.on("data", () => {}); // swallow noisy logs
  await waitForHealth();

  // Provision the admin through the documented seed path.
  await new Promise((resolve) => {
    execFile(
      process.execPath,
      ["scripts/seedAdmin.js"],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          NODE_ENV: "test",
          MONGO_URI: uri,
          JWT_SECRET: SECRET,
          ADMIN_EMAIL: adminEmail,
          ADMIN_NAME: "E2E Admin",
          ADMIN_PASSWORD: ADMIN_PASSWORD,
        },
      },
      (err) => resolve(err)
    );
  });
});

after(async () => {
  if (server && !server.killed) {
    server.kill("SIGTERM");
    await sleep(500);
    if (!server.killed) server.kill("SIGKILL");
  }
  await mongoose.disconnect().catch(() => {});
  if (mongod) await mongod.stop();
});

test("health endpoint responds", async () => {
  const res = await call("GET", "/api/health");
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "ok");
});

test("full workflow: student registers, browses, orders; admin fulfils", async () => {
  // --- student registers and signs in ---
  const studentEmail = "e2e-student@college.edu";
  const signup = await call("POST", "/api/auth/signup", {
    body: { name: "E2E Student", email: studentEmail, password: STUDENT_PASSWORD },
  });
  assert.equal(signup.status, 201);
  assert.equal(signup.body.user.role, "student");

  const login = await call("POST", "/api/auth/login", {
    body: { email: studentEmail, password: STUDENT_PASSWORD },
  });
  assert.equal(login.status, 200);
  const token = login.body.token;
  assert.ok(token);

  // --- session restoration (the endpoint that did not exist before) ---
  const me = await call("GET", "/api/auth/me", { token });
  assert.equal(me.status, 200);
  assert.equal(me.body.email, studentEmail);
  assert.equal(me.body.name, "E2E Student");

  // --- an admin cannot be created through public signup ---
  const escalation = await call("POST", "/api/auth/signup", {
    body: {
      name: "Escalator",
      email: "escalator@college.edu",
      password: STUDENT_PASSWORD,
      role: "admin",
    },
  });
  assert.equal(escalation.status, 201);
  assert.equal(escalation.body.user.role, "student");

  // --- admin signs in and publishes menu items ---
  const adminLogin = await call("POST", "/api/auth/login", {
    body: { email: adminEmail, password: ADMIN_PASSWORD },
  });
  assert.equal(adminLogin.status, 200);
  assert.equal(adminLogin.body.role, "admin");
  const adminToken = adminLogin.body.token;

  const created = await call("POST", "/api/food", {
    token: adminToken,
    body: { name: "E2E Special Thali", description: "Integration test meal", price: 199.5 },
  });
  assert.equal(created.status, 201);
  const foodId = created.body._id;

  // --- student sees the menu ---
  const menu = await call("GET", "/api/food");
  assert.equal(menu.status, 200);
  assert.ok(Array.isArray(menu.body), "menu must remain a bare array");
  assert.ok(menu.body.some((f) => f._id === foodId));

  // --- student places an order, attempting to tamper with the price ---
  const order = await call("POST", "/api/orders", {
    token,
    body: {
      items: [{ food: foodId, quantity: 2, name: "Hacked", price: 0.01 }],
      total: 0.02,
    },
  });
  assert.equal(order.status, 201);
  assert.equal(order.body.total, 399, "server must compute 2 x 199.50");
  assert.equal(order.body.items[0].name, "E2E Special Thali");
  assert.equal(order.body.status, "Pending");
  assert.ok(order.body.estimatedReadyAt, "an ETA should be provided");
  const orderId = order.body._id;

  // --- student cannot escalate to administrative endpoints ---
  assert.equal((await call("GET", "/api/orders/all", { token })).status, 403);

  // --- admin sees the order with the student populated ---
  const allOrders = await call("GET", "/api/orders/all", { token: adminToken });
  assert.equal(allOrders.status, 200);
  const seen = allOrders.body.find((o) => o._id === orderId);
  assert.ok(seen, "the order should appear in the admin list");
  assert.equal(seen.student.email, studentEmail);

  // --- admin moves it through the kitchen workflow ---
  for (const status of ["Preparing", "Completed"]) {
    const updated = await call("PUT", `/api/orders/${orderId}/status`, {
      token: adminToken,
      body: { status },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.status, status);
  }

  // --- student observes the full status history ---
  const history = await call("GET", `/api/orders/${orderId}`, { token });
  assert.equal(history.status, 200);
  assert.deepEqual(
    history.body.statusHistory.map((h) => h.status),
    ["Pending", "Preparing", "Completed"]
  );

  // --- a completed order is terminal ---
  const revert = await call("PUT", `/api/orders/${orderId}/status`, {
    token: adminToken,
    body: { status: "Pending" },
  });
  assert.equal(revert.status, 409);
});

test("a session survives a simulated page refresh and then expires cleanly", async () => {
  const email = "refresh@college.edu";
  await call("POST", "/api/auth/signup", {
    body: { name: "Refresh User", email, password: STUDENT_PASSWORD },
  });
  const login = await call("POST", "/api/auth/login", {
    body: { email, password: STUDENT_PASSWORD },
  });
  const token = login.body.token;

  // Refresh #1 and #2: the stored token is still valid.
  for (let i = 0; i < 2; i += 1) {
    const me = await call("GET", "/api/auth/me", { token });
    assert.equal(me.status, 200, "a valid token must survive a refresh");
  }

  // Expired token is rejected with a clear message, not a crash.
  const jwt = require("jsonwebtoken");
  const expired = jwt.sign({ id: new mongoose.Types.ObjectId().toString() }, SECRET, {
    expiresIn: "-1s",
  });
  const bad = await call("GET", "/api/auth/me", { token: expired });
  assert.equal(bad.status, 401);
  assert.match(bad.body.message, /expired/i);

  // Logout clears the session server-side too.
  const logout = await call("POST", "/api/auth/logout", { token });
  assert.equal(logout.status, 200);
});

test("security headers are present on real responses", async () => {
  const res = await fetch(`${BASE}/api/health`);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.equal(res.headers.get("x-powered-by"), null, "must not advertise Express");
});

test("an unknown route returns JSON 404 rather than an HTML error page", async () => {
  const res = await call("GET", "/api/nope");
  assert.equal(res.status, 404);
  assert.ok(res.body.message);
  assert.match(res.body.message, /Route not found/);
});
test("Phase 2: full lifecycle over HTTP, driven by a real server", async () => {
  const studentEmail = "lifecycle-student@college.edu";
  await call("POST", "/api/auth/signup", {
    body: { name: "Lifecycle Student", email: studentEmail, password: STUDENT_PASSWORD },
  });
  const login = await call("POST", "/api/auth/login", {
    body: { email: studentEmail, password: STUDENT_PASSWORD },
  });
  const token = login.body.token;

  const adminLogin = await call("POST", "/api/auth/login", {
    body: { email: adminEmail, password: ADMIN_PASSWORD },
  });
  const adminToken = adminLogin.body.token;

  const created = await call("POST", "/api/food", {
    token: adminToken,
    body: { name: "Lifecycle E2E Meal", price: 120 },
  });
  const foodId = created.body._id;

  // Place an order.
  const order = await call("POST", "/api/orders", {
    token,
    body: { items: [{ food: foodId, quantity: 1 }] },
  });
  assert.equal(order.status, 201);
  const orderId = order.body._id;
  assert.equal(order.body.status, "Pending");
  assert.equal(order.body.canCancel, true, "a Pending order is cancellable by its owner");

  // Walk the canonical lifecycle.
  for (const next of ["Accepted", "Preparing", "Ready", "Completed"]) {
    const res = await call("PUT", `/api/orders/${orderId}/status`, {
      token: adminToken,
      body: { status: next },
    });
    assert.equal(res.status, 200, `step to ${next} failed: ${res.body?.message}`);
  }

  const final = await call("GET", `/api/orders/${orderId}`, { token });
  assert.equal(final.body.status, "Completed");
  assert.equal(final.body.canCancel, false, "a completed order is not cancellable");
  assert.deepEqual(
    final.body.statusHistory.map((h) => h.status),
    ["Pending", "Accepted", "Preparing", "Ready", "Completed"]
  );

  // Terminal state is sealed.
  const reopen = await call("PUT", `/api/orders/${orderId}/status`, {
    token: adminToken,
    body: { status: "Pending" },
  });
  assert.equal(reopen.status, 409);
});

test("Phase 2: student cancellation and idempotency over HTTP", async () => {
  const studentEmail = "cancel-student@college.edu";
  await call("POST", "/api/auth/signup", {
    body: { name: "Cancel Student", email: studentEmail, password: STUDENT_PASSWORD },
  });
  const login = await call("POST", "/api/auth/login", {
    body: { email: studentEmail, password: STUDENT_PASSWORD },
  });
  const token = login.body.token;

  const adminLogin = await call("POST", "/api/auth/login", {
    body: { email: adminEmail, password: ADMIN_PASSWORD },
  });
  const adminToken = adminLogin.body.token;

  const food = await call("POST", "/api/food", {
    token: adminToken,
    body: { name: "Cancel E2E Meal", price: 55 },
  });

  const order = await call("POST", "/api/orders", {
    token,
    body: { items: [{ food: food.body._id, quantity: 1 }] },
  });
  const orderId = order.body._id;

  // Cancel succeeds.
  const cancelled = await call("POST", `/api/orders/${orderId}/cancel`, { token, body: {} });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, "Cancelled");
  assert.ok(cancelled.body.cancelledAt);

  // Repeating is idempotent, not an error.
  const again = await call("POST", `/api/orders/${orderId}/cancel`, { token, body: {} });
  assert.equal(again.status, 200);
  assert.equal(again.body.status, "Cancelled");

  // Only one cancellation recorded.
  assert.equal(again.body.statusHistory.filter((h) => h.status === "Cancelled").length, 1);

  // Another student cannot cancel it.
  const otherEmail = "other-student@college.edu";
  await call("POST", "/api/auth/signup", {
    body: { name: "Other", email: otherEmail, password: STUDENT_PASSWORD },
  });
  const otherLogin = await call("POST", "/api/auth/login", {
    body: { email: otherEmail, password: STUDENT_PASSWORD },
  });
  const foreign = await call("POST", `/api/orders/${orderId}/cancel`, {
    token: otherLogin.body.token,
    body: {},
  });
  assert.equal(foreign.status, 403);
});

test("Phase 2: concurrent conflicting transitions resolve to one winner", async () => {
  const studentEmail = "race-student@college.edu";
  await call("POST", "/api/auth/signup", {
    body: { name: "Race Student", email: studentEmail, password: STUDENT_PASSWORD },
  });
  const login = await call("POST", "/api/auth/login", {
    body: { email: studentEmail, password: STUDENT_PASSWORD },
  });
  const token = login.body.token;

  const adminLogin = await call("POST", "/api/auth/login", {
    body: { email: adminEmail, password: ADMIN_PASSWORD },
  });
  const adminToken = adminLogin.body.token;

  const food = await call("POST", "/api/food", {
    token: adminToken,
    body: { name: "Race E2E Meal", price: 40 },
  });

  const order = await call("POST", "/api/orders", {
    token,
    body: { items: [{ food: food.body._id, quantity: 1 }] },
  });
  const orderId = order.body._id;

  // Cancel and advance race for the same order.
  const [cancelRes, acceptRes] = await Promise.all([
    call("POST", `/api/orders/${orderId}/cancel`, { token, body: {} }),
    call("PUT", `/api/orders/${orderId}/status`, {
      token: adminToken,
      body: { status: "Accepted" },
    }),
  ]);

  // Both may legitimately succeed when they land sequentially: a cancel that
  // reads the order AFTER it became "Accepted" is a valid cancellation,
  // because students may withdraw while an order is Accepted. What must never
  // happen is a lost update or a contradictory history.
  assert.ok(
    [cancelRes.status, acceptRes.status].includes(200),
    "at least one transition must succeed"
  );

  const final = await call("GET", `/api/orders/${orderId}`, { token });
  const chain = final.body.statusHistory.map((h) => h.status);

  // The recorded chain must be a valid lifecycle walk from Pending.
  const valid = [
    ["Pending", "Cancelled"],
    ["Pending", "Accepted"],
    ["Pending", "Accepted", "Cancelled"],
  ];
  assert.ok(
    valid.some((v) => JSON.stringify(v) === JSON.stringify(chain)),
    `unexpected history chain: ${JSON.stringify(chain)}`
  );

  // No transition may be recorded twice.
  assert.equal(new Set(chain).size, chain.length, "duplicate transitions recorded");

  // The final status must match the last recorded transition.
  assert.equal(final.body.status, chain[chain.length - 1]);
});
