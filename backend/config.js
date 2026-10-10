/**
 * Environment-driven configuration.
 *
 * SECURITY NOTE: this module previously exported hardcoded defaults
 * (`MONGO_URI` and `JWT_SECRET`) and was dead code that no file required.
 * It is now the single source of truth for runtime configuration and it
 * contains no secrets of its own.
 */

const path = require("path");
const { normalizeDeductAt } = require("./utils/inventoryPlan");
const { MENU_PERIOD_KEYS, DEFAULT_MENU_PERIODS } = require("./utils/menuSchedule");

/** "HH:MM" from env, or the fallback when unset or malformed. */
function clockEnv(name, fallback) {
  const raw = process.env[name];
  return raw && /^([01]\d|2[0-3]):[0-5]\d$/.test(raw) ? raw : fallback;
}

const WEAK_SECRETS = new Set([
  "canteensecret123",
  "secret",
  "changeme",
  "your-secret-key",
]);

/** Read an integer env var, falling back to `fallback` when unset/invalid. */
function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Read a boolean env var. Accepts "1", "true", "yes", "on". */
function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(raw).toLowerCase());
}

function readJwtSecret() {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    throw new Error(
      "JWT_SECRET is not set. Copy .env.example to .env and provide a strong random value. " +
        "Generate one with: npm run generate:secret"
    );
  }

  if (WEAK_SECRETS.has(secret)) {
    const message =
      "JWT_SECRET is set to a well-known weak value. Generate a strong secret with: npm run generate:secret";
    if (process.env.NODE_ENV === "production") {
      throw new Error(message);
    }
    // Development only: keep booting so existing local setups are not broken,
    // but make the risk unmissable.
    console.warn(`\n[security] WARNING: ${message}\n`);
  }

  return secret;
}

const nodeEnv = process.env.NODE_ENV || "development";
const isProduction = nodeEnv === "production";
const isTest = nodeEnv === "test";

const config = {
  nodeEnv,
  isProduction,
  isTest,

  port: envInt("PORT", 5000),
  mongoUri: process.env.MONGO_URI || "mongodb://127.0.0.1:27017/canteenDB",

  jwt: {
    secret: readJwtSecret(),
    expiresIn: process.env.JWT_EXPIRES_IN || "1d",
  },

  // Comma-separated origin allowlist. Defaults to the local Vite dev server.
  corsOrigins: (process.env.CORS_ORIGINS || "http://localhost:5173,http://localhost:5174")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),

  rateLimit: {
    enabled: envBool("RATE_LIMIT_ENABLED", !isTest),
    windowMs: envInt("RATE_LIMIT_WINDOW_MS", 15 * 60 * 1000),
    authMax: envInt("RATE_LIMIT_AUTH_MAX", 10),
    apiMax: envInt("RATE_LIMIT_API_MAX", 300),
  },

  // Optional Socket.IO notification layer. When disabled, REST behaves
  // identically and no transport is attached.
  realtime: {
    enabled: envBool("REALTIME_ENABLED", true),
  },

  // Business rules — configurable without a code change.
  order: {
    maxQuantityPerItem: envInt("ORDER_MAX_QUANTITY", 20),
    maxItemsPerOrder: envInt("ORDER_MAX_ITEMS", 30),
    // Phase 2: when false (default) staff/admin may skip ahead along the
    // forward path, preserving the original admin UI behaviour of jumping
    // Pending -> Preparing / Pending -> Completed. When true, every stage
    // (Pending -> Accepted -> Preparing -> Ready -> Completed) is required.
    strictLifecycle: envBool("ORDER_STRICT_LIFECYCLE", false),

    // statusHistory retention. In practice the lifecycle already bounds an
    // order to ~5 transitions because terminal states cannot be reopened, so
    // this is a defensive ceiling rather than routine pruning. When it is
    // reached the oldest entries are trimmed from the display array, but
    // `statusHistoryTotal` keeps an exact count so no auditing information is
    // silently lost.
    statusHistoryLimit: envInt("ORDER_STATUS_HISTORY_LIMIT", 100),
  },

  // Student-facing canteen settings (pickup slots, charges, menu badges).
  // Defaults keep existing behaviour: no tax, no packaging charge.
  canteen: {
    name: process.env.CANTEEN_NAME || "College Canteen",
    // Offset from UTC in minutes for slot boundaries. 330 = India (IST).
    utcOffsetMinutes: envInt("CANTEEN_UTC_OFFSET_MINUTES", 330),
    // Meal periods in canteen-local time, e.g. MENU_LUNCH_FROM=11:30.
    menuPeriods: Object.fromEntries(
      MENU_PERIOD_KEYS.map((key) => {
        const base = key.toUpperCase();
        return [
          key,
          {
            from: clockEnv(`MENU_${base}_FROM`, DEFAULT_MENU_PERIODS[key].from),
            to: clockEnv(`MENU_${base}_TO`, DEFAULT_MENU_PERIODS[key].to),
          },
        ];
      })
    ),
    openHour: envInt("CANTEEN_OPEN_HOUR", 9),
    closeHour: envInt("CANTEEN_CLOSE_HOUR", 18),
    slotMinutes: envInt("PICKUP_SLOT_MINUTES", 15),
    slotDays: envInt("PICKUP_SLOT_DAYS", 2),
    // Extra minutes added to the longest prep time before the earliest slot.
    prepBufferMinutes: envInt("PREP_BUFFER_MINUTES", 5),
    taxPercent: Number(process.env.TAX_PERCENT || 0),
    packagingChargePerItem: Number(process.env.PACKAGING_CHARGE_PER_ITEM || 0),
    bestsellerCount: envInt("BESTSELLER_COUNT", 5),
    newItemDays: envInt("NEW_ITEM_DAYS", 7),
    // Maximum orders per pickup slot. 0 means unlimited.
    slotCapacity: envInt("PICKUP_SLOT_CAPACITY", 20),
  },

  // Inventory. Stock is always reserved at placement; this sets when the
  // units are physically deducted: "preparing" (default) or "accepted".
  inventory: {
    deductAt: normalizeDeductAt(process.env.INVENTORY_DEDUCT_AT),
  },
  // Menu image uploads are stored on local disk. See routes/food.js.
  uploads: {
    // Relative paths are resolved from the backend folder.
    dir: process.env.UPLOAD_DIR ? path.resolve(__dirname, process.env.UPLOAD_DIR) : path.join(__dirname, "uploads"),
    maxBytes: Math.min(
      Math.max(envInt("UPLOAD_MAX_BYTES", 2 * 1024 * 1024), 64 * 1024),
      5 * 1024 * 1024
    ),
  },
  // Kitchen queue model used to estimate when each order will be ready.
  kitchen: {
    // How many orders the kitchen works on at the same time.
    parallel: Math.max(1, envInt("KITCHEN_PARALLEL_ORDERS", 3)),
    // How often estimates are recalculated even when no order changes, so
    // waiting times count down and reflect the queue as it moves.
    etaRefreshSeconds: envInt("KITCHEN_ETA_REFRESH_SECONDS", 60),
  },

  // Outbound notifications. Each channel stays off until it is configured
  // AND the student opts in. Nothing is sent to a real address by default.
  notify: {
    dispatchSeconds: envInt("NOTIFY_DISPATCH_SECONDS", 30),
    maxAttempts: Math.max(1, envInt("NOTIFY_MAX_ATTEMPTS", 3)),
    email: {
      host: process.env.SMTP_HOST || "",
      port: envInt("SMTP_PORT", 587),
      secure: envBool("SMTP_SECURE", false),
      user: process.env.SMTP_USER || "",
      pass: process.env.SMTP_PASS || "",
      from: process.env.SMTP_FROM || "",
    },
    push: {
      publicKey: process.env.VAPID_PUBLIC_KEY || "",
      privateKey: process.env.VAPID_PRIVATE_KEY || "",
      // web-push requires a mailto: or https: contact for the push service.
      subject: process.env.VAPID_SUBJECT || "",
    },
  },
};

module.exports = config;