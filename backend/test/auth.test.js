const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { api, startDb, resetDb, stopDb, makeUser } = require("./helpers");

before(startDb);
after(stopDb);
beforeEach(resetDb);

test("signup creates a student and ignores a client-supplied role", async () => {
  const res = await api()
    .post("/api/auth/signup")
    .send({
      name: "Eve",
      email: "eve@college.edu",
      password: "password123",
      role: "admin", // attacker-controlled
    });

  assert.equal(res.status, 201);
  assert.equal(res.body.user.role, "student");

  // Confirm at the database level, not just in the response.
  const stored = await mongoose.connection
    .collection("users")
    .findOne({ email: "eve@college.edu" });
  assert.equal(stored.role, "student");
});

test("signup cannot escalate via any privileged role value", async () => {
  const roles = ["admin", "staff", "Admin", "ADMIN", "superuser"];
  for (const [i, role] of roles.entries()) {
    const res = await api()
      .post("/api/auth/signup")
      .send({
        name: "Mallory",
        // Index keeps the addresses unique: "admin" and "Admin" would
        // otherwise collide once the email is lowercased.
        email: `mallory-${i}-${role.toLowerCase()}@college.edu`,
        password: "password123",
        role,
      });
    assert.equal(res.status, 201, `signup with role "${role}" failed`);
    assert.equal(res.body.user.role, "student", `role "${role}" was not ignored`);
  }
});

test("signup never returns or stores the password in plaintext", async () => {
  const res = await api()
    .post("/api/auth/signup")
    .send({ name: "Safe", email: "safe@college.edu", password: "password123" });

  assert.equal(res.status, 201);
  assert.equal(res.body.password, undefined);
  assert.equal(res.body.user.password, undefined);

  const raw = await mongoose.connection.collection("users").findOne({ email: "safe@college.edu" });
  assert.notEqual(raw.password, "password123");
  assert.match(raw.password, /^\$2[aby]\$/); // bcrypt hash
});

test("signup rejects a duplicate email with 409, not 500", async () => {
  const payload = { name: "Dup", email: "dup@college.edu", password: "password123" };
  const first = await api().post("/api/auth/signup").send(payload);
  assert.equal(first.status, 201);

  const second = await api().post("/api/auth/signup").send(payload);
  assert.equal(second.status, 409);
  assert.match(second.body.message, /already exists/i);
});

test("signup validates email, password length and name", async () => {
  const cases = [
    [{ name: "A", email: "not-an-email", password: "password123" }, /valid email/i],
    [{ name: "A", email: "b@college.edu", password: "short" }, /at least 8/i],
    [{ name: "", email: "c@college.edu", password: "password123" }, /name is required/i],
    [{ name: "A", email: "d@college.edu", password: "password123x".repeat(200) }, /at most 128/i],
  ];

  for (const [payload, matcher] of cases) {
    const res = await api().post("/api/auth/signup").send(payload);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(payload)}`);
    if (matcher) assert.match(res.body.message, matcher);
  }
});

test("login returns the original { token, role, name } contract", async () => {
  await makeUser({ name: "Ada", email: "ada@college.edu", password: "password123" });

  const res = await api()
    .post("/api/auth/login")
    .send({ email: "ada@college.edu", password: "password123" });

  assert.equal(res.status, 200);
  assert.ok(res.body.token, "token must be present");
  assert.equal(res.body.role, "student");
  assert.equal(res.body.name, "Ada");
});

test("login is case-insensitive on email", async () => {
  await makeUser({ name: "Case", email: "case@college.edu", password: "password123" });
  const res = await api()
    .post("/api/auth/login")
    .send({ email: "CASE@College.EDU", password: "password123" });

  assert.equal(res.status, 200);
  assert.ok(res.body.token);
});

test("login with a wrong password and a wrong email give the same 401", async () => {
  await makeUser({ name: "Twin", email: "twin@college.edu", password: "password123" });

  const wrongPass = await api()
    .post("/api/auth/login")
    .send({ email: "twin@college.edu", password: "wrongpassword" });
  const noUser = await api()
    .post("/api/auth/login")
    .send({ email: "ghost@college.edu", password: "password123" });

  assert.equal(wrongPass.status, 401);
  assert.equal(noUser.status, 401);
  // Identical messages prevent user enumeration.
  assert.equal(wrongPass.body.message, noUser.body.message);
});

test("GET /api/auth/me returns the current user", async () => {
  await makeUser({ name: "Mia", email: "mia@college.edu", password: "password123", role: "admin" });
  const login = await api()
    .post("/api/auth/login")
    .send({ email: "mia@college.edu", password: "password123" });

  const res = await api()
    .get("/api/auth/me")
    .set("Authorization", `Bearer ${login.body.token}`);

  // This route did not exist before; session restoration silently failed.
  assert.equal(res.status, 200);
  assert.equal(res.body.name, "Mia");
  assert.equal(res.body.email, "mia@college.edu");
  assert.equal(res.body.role, "admin");
  assert.ok(res.body.id);
});

test("GET /api/auth/me accepts a bare token for backward compatibility", async () => {
  await makeUser({ name: "Bare", email: "bare@college.edu", password: "password123" });
  const login = await api()
    .post("/api/auth/login")
    .send({ email: "bare@college.edu", password: "password123" });

  const res = await api()
    .get("/api/auth/me")
    .set("Authorization", login.body.token); // no "Bearer" prefix

  assert.equal(res.status, 200);
  assert.equal(res.body.email, "bare@college.edu");
});

test("GET /api/auth/me rejects missing, invalid and foreign-scheme tokens", async () => {
  const noToken = await api().get("/api/auth/me");
  assert.equal(noToken.status, 401);

  const garbage = await api().get("/api/auth/me").set("Authorization", "Bearer nonsense");
  assert.equal(garbage.status, 401);

  const wrongScheme = await api().get("/api/auth/me").set("Authorization", "Basic abc123");
  assert.equal(wrongScheme.status, 401);
});

test("GET /api/auth/me 401s when the account has been deleted", async () => {
  const user = await makeUser({ name: "Ghost", email: "ghost2@college.edu", password: "password123" });
  const login = await api()
    .post("/api/auth/login")
    .send({ email: "ghost2@college.edu", password: "password123" });

  // Token is still cryptographically valid, but the user is gone.
  await mongoose.connection.collection("users").deleteOne({ _id: user._id });

  const res = await api()
    .get("/api/auth/me")
    .set("Authorization", `Bearer ${login.body.token}`);

  assert.equal(res.status, 401);
  assert.match(res.body.message, /no longer exists/i);
});

test("an expired token returns a clear 401 rather than a 500", async () => {
  const jwt = require("jsonwebtoken");
  const config = require("../config");
  const user = await makeUser({ email: "expired@college.edu" });

  const expired = jwt.sign({ id: user._id.toString() }, config.jwt.secret, {
    expiresIn: "-1s",
  });

  const res = await api().get("/api/auth/me").set("Authorization", `Bearer ${expired}`);
  assert.equal(res.status, 401);
  assert.match(res.body.message, /expired/i);
});

test("PUT /api/auth/me cannot change the caller's role", async () => {
  const { token } = await (async () => {
    await makeUser({ name: "Sneaky", email: "sneaky@college.edu", password: "password123" });
    const login = await api()
      .post("/api/auth/login")
      .send({ email: "sneaky@college.edu", password: "password123" });
    return { token: login.body.token };
  })();

  const res = await api()
    .put("/api/auth/me")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: "Still Student", role: "admin", email: "hacker@evil.com" });

  assert.equal(res.status, 200);

  const stored = await mongoose.connection.collection("users").findOne({ email: "sneaky@college.edu" });
  assert.equal(stored.role, "student", "role must not be escalatable");
  assert.equal(stored.email, "sneaky@college.edu", "email must not change here");
});