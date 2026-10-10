/**
 * Shared test bootstrap.
 *
 * Environment is configured BEFORE the app is required, because config.js
 * reads process.env once at module load. Tests run against a throwaway
 * in-memory MongoDB; the real canteenDB is never touched.
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-not-used-anywhere-else-0123456789";
process.env.MONGO_URI = "mongodb://127.0.0.1:27017/never-used-in-tests";
process.env.RATE_LIMIT_ENABLED = "false";
process.env.CORS_ORIGINS = "http://localhost:5173";

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

let mongod;

const createApp = require("../app");
const app = createApp();

/** Boot an in-memory database and connect Mongoose to it. */
async function startDb() {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("canteenTest"));
}

/** Drop all collections so each suite starts clean. */
async function resetDb() {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
}

async function stopDb() {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
}

const api = () => request(app);

/** Create a user directly in the database (bypasses HTTP signup). */
async function makeUser({ name = "Test User", email, password = "password123", role = "student" }) {
  const User = require("../models/User");
  return User.create({ name, email, password, role });
}

/** Register + log in over HTTP, returning the token and user payload. */
async function registerAndLogin(overrides = {}) {
  const creds = {
    name: "Test Student",
    email: `student-${Math.random().toString(36).slice(2, 10)}@college.edu`,
    password: "password123",
    ...overrides,
  };
  await api().post("/api/auth/signup").send(creds);
  const res = await api().post("/api/auth/login").send({
    email: creds.email,
    password: creds.password,
  });
  return { token: res.body.token, ...res.body, credentials: creds };
}

/** Create a food item directly, bypassing admin HTTP routes. */
async function makeFood(overrides = {}) {
  const Food = require("../models/FoodItem");
  return Food.create({
    name: "Test Item",
    description: "Delicious test food",
    price: 100,
    ...overrides,
  });
}

module.exports = {
  app,
  api,
  startDb,
  resetDb,
  stopDb,
  makeUser,
  makeFood,
  registerAndLogin,
};