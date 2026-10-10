const express = require("express");
const cors = require("cors");
const config = require("./config");
const { apiLimiter } = require("./middleware/rateLimit");
const { notFoundHandler, errorHandler } = require("./middleware/errorHandler");

const authRoutes = require("./routes/auth");
const foodRoutes = require("./routes/food");
const orderRoutes = require("./routes/order");
const inventoryRoutes = require("./routes/inventory");
const reviewRoutes = require("./routes/reviews");
const couponRoutes = require("./routes/coupons");
const notificationRoutes = require("./routes/notifications");

/**
 * Build the Express application.
 *
 * Separated from server.js so tests can mount the app without opening a
 * listening socket. `npm start` behaviour is unchanged.
 */
function createApp() {
  const app = express();

  // Behind a proxy this makes req.ip (and therefore rate limiting) correct.
  app.set("trust proxy", 1);

  // --- Security headers (no extra dependency) ---
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-DNS-Prefetch-Control", "off");
    res.removeHeader("X-Powered-By");
    next();
  });

  // --- CORS: explicit allow-list instead of `cors()` open to everything ---
  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin, curl and native apps send no Origin header.
        if (!origin) return callback(null, true);
        if (config.corsOrigins.includes(origin)) return callback(null, true);
        return callback(new Error(`Origin ${origin} is not allowed by CORS`));
      },
      credentials: true,
    })
  );

  app.use(express.json({ limit: "100kb" }));
  app.use(express.urlencoded({ extended: true, limit: "100kb" }));

  // --- Routes ---
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", uptime: process.uptime() });
  });

  app.use("/api", apiLimiter);
  app.use("/api/auth", authRoutes);
  app.use("/api/food", foodRoutes);
  app.use("/api/orders", orderRoutes);
  app.use("/api/inventory", inventoryRoutes);
  app.use("/api/reviews", reviewRoutes);
  app.use("/api/coupons", couponRoutes);
  app.use("/api/notifications", notificationRoutes);

  // --- Centralized fallbacks (must be registered last) ---
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = createApp;