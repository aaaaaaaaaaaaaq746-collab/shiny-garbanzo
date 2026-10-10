/**
 * Test harness backed by a SINGLE-NODE REPLICA SET.
 *
 * A standalone mongod rejects multi-document transactions, so Phase 4's
 * transactional path can only be exercised for real against a replica set.
 * These suites therefore run against one, which is the genuine database
 * integration -- nothing here is mocked.
 *
 * The complementary standalone harness lives in helpers.js and is used to
 * prove the non-transactional fallback is still safe.
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-not-used-anywhere-else-0123456789";
process.env.MONGO_URI = "mongodb://127.0.0.1:27017/never-used-in-tests";
process.env.RATE_LIMIT_ENABLED = "false";
process.env.CORS_ORIGINS = "http://localhost:5173";

const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const request = require("supertest");

let replSet;

const createApp = require("../app");
const app = createApp();

/** Boot a one-node replica set and connect. */
async function startDb() {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  await mongoose.connect(replSet.getUri("canteenInventoryTest"));
}

async function resetDb() {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
}

async function stopDb() {
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
}

const api = () => request(app);

async function makeUser({ name = "Test User", email, password = "password123", role = "student" }) {
  const User = require("../models/User");
  return User.create({ name, email, password, role });
}

async function makeFood(overrides = {}) {
  const Food = require("../models/FoodItem");
  return Food.create({ name: "Test Item", description: "Test food", price: 100, ...overrides });
}

/** Log in and return { token, id, email }. */
async function tokenFor(role) {
  const email = `${role}-${Math.random().toString(36).slice(2, 10)}@college.edu`;
  await makeUser({ name: role, email, password: "password123", role });
  const res = await api().post("/api/auth/login").send({ email, password: "password123" });
  return { token: res.body.token, id: res.body.id, email };
}

/** Tracked food item with a given stock level. */
async function trackedFood(stock, overrides = {}) {
  return makeFood({
    name: `Tracked ${Math.random().toString(36).slice(2, 7)}`,
    price: 100,
    trackInventory: true,
    stock,
    reserved: 0,
    lowStockThreshold: 3,
    ...overrides,
  });
}

/** Read live stock counters straight from the database. */
async function counters(foodId) {
  const Food = require("../models/FoodItem");
  const f = await Food.findById(foodId);
  return { stock: f.stock, reserved: f.reserved, available: f.availableQty };
}

module.exports = {
  app,
  api,
  startDb,
  resetDb,
  stopDb,
  makeUser,
  makeFood,
  trackedFood,
  tokenFor,
  counters,
  mongoose,
};