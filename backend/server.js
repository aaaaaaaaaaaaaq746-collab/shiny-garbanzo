require("dotenv").config();

const mongoose = require("mongoose");
const createApp = require("./app");
const config = require("./config");

const app = createApp();
const { attachRealtime } = require("./realtime");
const { startBackgroundJobs } = require("./services/scheduler");

async function start() {
  try {
    await mongoose.connect(config.mongoUri, {
      // Fail fast with a clear message rather than hanging for the default
      // 30s when MongoDB is unreachable.
      serverSelectionTimeoutMS: 5000,
    });
    console.log("MongoDB connected");
  } catch (err) {
    console.error("MongoDB connection failed:", err.message);
    console.error(`Tried: ${config.mongoUri}`);
    console.error("Is MongoDB running? Set MONGO_URI in backend/.env if it differs.");
    // Exit rather than serving traffic that cannot persist anything.
    process.exit(1);
  }

  const server = app.listen(config.port, () => {
    console.log(`Server running on port ${config.port} [${config.nodeEnv}]`);
  });

  // Optional notification transport. REST is unaffected if this is disabled.
  attachRealtime(server);

  // Queue estimates and notification delivery run on timers. Not started by
  // app.js, so tests that import the app get no background work.
  startBackgroundJobs();

  const shutdown = (signal) => {
    console.log(`\n${signal} received, shutting down gracefully...`);
    server.close(async () => {
      await mongoose.disconnect();
      process.exit(0);
    });
    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

start();

// Exported for tests and tooling.
module.exports = app;