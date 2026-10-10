/**
 * End-to-end harness: boots a real backend (with the real-time layer) against
 * a throwaway in-memory MongoDB and seeds deterministic accounts and menu
 * items for the Playwright smoke tests.
 *
 * Run directly (Playwright manages it via playwright.config.js):
 *   node e2e/server.cjs
 */
const path = require("node:path");

const BACKEND = path.join(__dirname, "..", "..", "backend");

process.env.NODE_ENV = "development";
process.env.PORT = "5000";
process.env.JWT_SECRET = "e2e-harness-secret-0123456789abcdefghij";
process.env.MONGO_URI = "mongodb://127.0.0.1:27017/e2ePlaceholder";
process.env.RATE_LIMIT_ENABLED = "false";
process.env.REALTIME_ENABLED = "true";
// The Playwright preview server runs on 4173.
process.env.CORS_ORIGINS = [
  "http://localhost:4173",
  "http://127.0.0.1:4173",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
].join(",");

const http = require("node:http");
const { createRequire } = require("node:module");

// Backend dependencies live in backend/node_modules, not here.
const backendRequire = createRequire(path.join(BACKEND, "package.json"));
const mongoose = backendRequire("mongoose");
const { MongoMemoryServer } = backendRequire("mongodb-memory-server");

const createApp = require(path.join(BACKEND, "app.js"));
const { attachRealtime } = require(path.join(BACKEND, "realtime.js"));
const User = require(path.join(BACKEND, "models/User.js"));
const Food = require(path.join(BACKEND, "models/FoodItem.js"));

const ACCOUNTS = {
  student: { name: "E2E Student", email: "e2e.student@college.edu", password: "studentpass123" },
  admin: { name: "E2E Admin", email: "e2e.admin@college.edu", password: "adminpass123" },
  other: { name: "E2E Other", email: "e2e.other@college.edu", password: "otherpass123" },
  kitchen: { name: "E2E Kitchen", email: "e2e.kitchen@college.edu", password: "kitchenpass123" },
};

const MENU = [
  { name: "Masala Dosa", description: "Crisp dosa with potato filling", price: 80, category: "Breakfast" },
  { name: "Paneer Tikka", description: "Grilled paneer skewers", price: 220, category: "Snacks" },
  { name: "Filter Coffee", description: "South Indian filter coffee", price: 20, category: "Drinks" },
];

(async () => {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("canteenE2E"));
  console.log("[e2e] in-memory MongoDB ready");

  for (const [role, account] of Object.entries(ACCOUNTS)) {
    await User.create({ ...account, role: role === "kitchen" ? "staff" : role === "admin" ? "admin" : "student" });
  }
  console.log("[e2e] seeded accounts");

  await Food.insertMany(
    MENU.map((f) => ({ ...f, available: true, prepTimeMinutes: 15 }))
  );
  console.log("[e2e] seeded menu");

  const app = createApp();
  const server = http.createServer(app);
  attachRealtime(server);

  await new Promise((resolve) => server.listen(5000, "127.0.0.1", resolve));
  console.log("[e2e] backend listening on http://127.0.0.1:5000 (realtime enabled)");

  const shutdown = async () => {
    server.close();
    await mongoose.disconnect().catch(() => {});
    await mongod.stop();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
})().catch((err) => {
  console.error("[e2e] failed to start:", err);
  process.exit(1);
});