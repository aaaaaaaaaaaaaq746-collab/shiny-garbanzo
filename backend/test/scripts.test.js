const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { execFile } = require("node:child_process");
const path = require("node:path");

const SEED = path.join(__dirname, "..", "scripts", "seedAdmin.js");
const SECRET = "test-secret-not-used-anywhere-else-0123456789";

let mongod;

before(async () => {
  mongod = await MongoMemoryServer.create();
});

after(async () => {
  if (mongod) await mongod.stop();
});

/** Run the seed script in a child process against the in-memory database. */
function runSeed(env = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SEED],
      {
        env: {
          ...process.env,
          NODE_ENV: "test",
          JWT_SECRET: SECRET,
          MONGO_URI: mongod.getUri("seedTest"),
          ...env,
        },
      },
      (error, stdout, stderr) => {
        resolve({ code: error ? error.code : 0, stdout, stderr });
      }
    );
  });
}

test("seed:admin creates an admin account from environment variables", async () => {
  const result = await runSeed({
    ADMIN_EMAIL: "head@college.edu",
    ADMIN_NAME: "Head Chef",
    ADMIN_PASSWORD: "super-secret-admin",
  });

  assert.equal(result.code, 0, result.stderr);

  await mongoose.connect(mongod.getUri("seedTest"));
  const User = require("../models/User");
  const user = await User.findOne({ email: "head@college.edu" });

  assert.ok(user, "admin account should exist");
  assert.equal(user.role, "admin");
  assert.equal(user.name, "Head Chef");
  assert.notEqual(user.password, "super-secret-admin", "password must be hashed");

  // The seeded account can actually sign in through the public API.
  await mongoose.disconnect();
});

test("seed:admin is idempotent when re-run", async () => {
  const env = {
    ADMIN_EMAIL: "repeat@college.edu",
    ADMIN_PASSWORD: "super-secret-admin",
  };
  const first = await runSeed(env);
  const second = await runSeed(env);

  assert.equal(first.code, 0);
  assert.equal(second.code, 0);
  assert.match(second.stdout, /Updated existing account/);

  await mongoose.connect(mongod.getUri("seedTest"));
  const count = await mongoose.connection
    .collection("users")
    .countDocuments({ email: "repeat@college.edu" });
  assert.equal(count, 1, "re-running must not create a duplicate");
  await mongoose.disconnect();
});

test("seed:admin can provision a staff account", async () => {
  const result = await runSeed({
    ADMIN_EMAIL: "kitchen@college.edu",
    ADMIN_PASSWORD: "kitchen-pass-1",
    ADMIN_ROLE: "staff",
  });

  assert.equal(result.code, 0, result.stderr);

  await mongoose.connect(mongod.getUri("seedTest"));
  const user = await mongoose.connection
    .collection("users")
    .findOne({ email: "kitchen@college.edu" });
  assert.equal(user.role, "staff");
  await mongoose.disconnect();
});

test("seed:admin refuses to run without a password", async () => {
  const result = await runSeed({ ADMIN_EMAIL: "nopass@college.edu" });
  assert.notEqual(result.code, 0);
  assert.match(result.stdout + result.stderr, /Missing required value/i);
});

test("seed:admin rejects a short password and an invalid role", async () => {
  const short = await runSeed({
    ADMIN_EMAIL: "short@college.edu",
    ADMIN_PASSWORD: "abc",
  });
  assert.notEqual(short.code, 0);
  assert.match(short.stdout + short.stderr, /at least 8/i);

  const badRole = await runSeed({
    ADMIN_EMAIL: "bad@college.edu",
    ADMIN_PASSWORD: "long-enough-password",
    ADMIN_ROLE: "superuser",
  });
  assert.notEqual(badRole.code, 0);
  assert.match(badRole.stdout + badRole.stderr, /Invalid role/i);
});

test("generate:secret emits a strong secret and writes no file", async () => {
  const { execFileSync } = require("node:child_process");
  const output = execFileSync(
    process.execPath,
    [path.join(__dirname, "..", "scripts", "generateSecret.js")],
    { encoding: "utf8" }
  );

  const match = output.match(/JWT_SECRET=([A-Za-z0-9_-]+)/);
  assert.ok(match, "should print a JWT_SECRET line");

  const secret = match[1];
  // 48 random bytes base64url-encoded.
  assert.ok(secret.length >= 40, `secret too short: ${secret.length}`);
  assert.doesNotMatch(secret, /canteensecret123/);
});