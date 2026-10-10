const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const config = require("./config");
const User = require("./models/User");
const Order = require("./models/Order");

/**
 * Real-time notification layer.
 *
 * DESIGN RULES
 * ------------
 * 1. Sockets are a NOTIFICATION mechanism only. MongoDB and
 *    utils/orderLifecycle.js remain the single source of truth. A payload
 *    carries just { orderId, status, previousStatus, at } — never order
 *    contents — and clients re-read the authoritative state over REST.
 * 2. Every connection is authenticated with the same JWT secret as REST.
 * 3. Every subscription is authorized against the database. A student can
 *    only join rooms for their own orders.
 * 4. Events are emitted only AFTER a successful database transition; a
 *    refused or lost race emits nothing.
 * 5. If the real-time layer is unavailable, REST keeps working untouched:
 *    `emitOrderUpdate` is a no-op until a server is attached.
 */

let io = null;

const ROOM = {
  user: (userId) => `user:${userId}`,
  order: (orderId) => `order:${orderId}`,
  canteen: "canteen",
};

const isStaffRole = (role) => role === "admin" || role === "staff";

/** Pull a JWT from the handshake, accepting both supported conventions. */
function extractToken(socket) {
  const fromAuth = socket.handshake?.auth?.token;
  if (typeof fromAuth === "string" && fromAuth.trim()) {
    const parts = fromAuth.trim().split(/\s+/);
    return parts.length > 1 && parts[0].toLowerCase() === "bearer" ? parts[1] : parts[0];
  }
  const header = socket.handshake?.headers?.authorization;
  if (typeof header === "string" && header.trim()) return header.trim().split(/\s+/)[0];
  return null;
}

/**
 * Attach real-time transport to an existing HTTP server.
 * Returns the Socket.IO server, or null when disabled by configuration.
 */
function attachRealtime(httpServer) {
  if (config.realtime.enabled === false) {
    console.log("Real-time notifications disabled (REALTIME_ENABLED=false)");
    return null;
  }

  io = new Server(httpServer, {
    cors: {
      origin: config.corsOrigins,
      credentials: true,
    },
    // Fail fast rather than queueing while a client has an expired token.
    connectionStateRecovery: { maxDisconnectionDuration: 2 * 60 * 1000 },
  });

  // ---- 1. Authenticate every connection -------------------------------
  io.use(async (socket, next) => {
    const token = extractToken(socket);
    if (!token) {
      return next(new Error("Authentication required"));
    }

    let decoded;
    try {
      decoded = jwt.verify(token, config.jwt.secret);
    } catch (err) {
      return next(
        new Error(err.name === "TokenExpiredError" ? "Session expired" : "Invalid token")
      );
    }

    if (!decoded?.id || !mongoose.Types.ObjectId.isValid(String(decoded.id))) {
      return next(new Error("Invalid token"));
    }

    // Re-check the account: a token for a deleted user must not connect.
    const user = await User.findById(decoded.id);
    if (!user) return next(new Error("Account no longer exists"));
    if (user.isActive === false) return next(new Error("Account deactivated"));

    socket.data.user = {
      id: user._id.toString(),
      role: user.role,
      name: user.name,
    };
    return next();
  });

  io.on("connection", (socket) => {
    const user = socket.data.user;

    // Every socket joins its own private room, so a user with several tabs
    // sees their own order changes without subscribing.
    socket.join(ROOM.user(user.id));

    /**
     * Watch one order. Authorized against the database on every request —
     * joining a room is never inherited from a previous check.
     */
    socket.on("order:subscribe", async (payload, ack) => {
      const respond = typeof ack === "function" ? ack : () => {};
      try {
        const orderId = payload?.orderId;
        if (!mongoose.Types.ObjectId.isValid(String(orderId))) {
          return respond({ ok: false, error: "Invalid order id" });
        }

        const order = await Order.findById(orderId).select("student");
        if (!order) return respond({ ok: false, error: "Order not found" });

        const isOwner = order.student.toString() === user.id;
        if (!isOwner && !isStaffRole(user.role)) {
          // Deliberately the same message as "not found" would be, but the
          // order really may exist; authorization failure is reported plainly.
          return respond({ ok: false, error: "Not authorized to watch this order" });
        }

        socket.join(ROOM.order(orderId));
        return respond({ ok: true, orderId: String(orderId) });
      } catch (err) {
        console.error("[realtime] subscribe failed:", err.message);
        return respond({ ok: false, error: "Subscription failed" });
      }
    });

    socket.on("order:unsubscribe", (payload) => {
      const orderId = payload?.orderId;
      if (mongoose.Types.ObjectId.isValid(String(orderId))) {
        socket.leave(ROOM.order(orderId));
      }
    });

    /** The live kitchen/administrative board. Staff only. */
    socket.on("canteen:subscribe", (payload, ack) => {
      const respond = typeof ack === "function" ? ack : () => {};
      if (!isStaffRole(user.role)) {
        return respond({ ok: false, error: "Staff only" });
      }
      socket.join(ROOM.canteen);
      return respond({ ok: true });
    });

    socket.on("canteen:unsubscribe", () => socket.leave(ROOM.canteen));
  });

  console.log("Real-time notifications enabled");
  return io;
}

/**
 * Broadcast that an order changed.
 *
 * Called only after a successful, atomic transition. Carries no order
 * contents, so a socket can never be used to read another student's data —
 * recipients are already restricted by the rooms they were authorized into.
 *
 * Duplicates are possible by design (an owner subscribed to both their user
 * room and the order room); clients de-duplicate on `eventId`.
 */
function emitOrderUpdate({ orderId, studentId, status, previousStatus, at }) {
  if (!io) return false; // REST-only mode: not an error.

  const timestamp = at ? new Date(at).toISOString() : new Date().toISOString();
  const id = String(orderId);

  const event = {
    orderId: id,
    status,
    previousStatus: previousStatus || null,
    at: timestamp,
    // Stable across the duplicate deliveries, so clients can drop repeats.
    eventId: `${id}:${timestamp}:${status}`,
  };

  // The owner always hears about their own order, even from another tab.
  if (studentId) io.to(ROOM.user(String(studentId))).emit("order:updated", event);

  // Sockets explicitly watching this order (owner or authorized staff).
  io.to(ROOM.order(id)).emit("order:updated", event);

  // The live staff board.
  io.to(ROOM.canteen).emit("order:updated", event);

  return true;
}

/**
 * Broadcast that an inventory figure changed.
 *
 * Sent ONLY to the staff `canteen` room, never to student rooms, so stock
 * levels stay an administrative concern. Like order events this is advisory:
 * clients re-read through the REST endpoint.
 *
 * Returns false when no server is attached (REST-only mode).
 */
function emitInventoryUpdate({ foodId, reason, item }) {
  if (!io) return false;

  const payload = {
    foodId: String(foodId),
    reason: reason || "update",
    at: new Date().toISOString(),
  };
  // Numbers only: no cost data, no admin configuration.
  if (item && typeof item.toObject === "function") {
    const plain = item.toObject();
    payload.availableQty =
      plain.trackInventory === true
        ? Math.max(0, (plain.stock ?? 0) - (plain.reserved ?? 0))
        : null;
    payload.soldOut = plain.available === false || (payload.availableQty !== null && payload.availableQty <= 0);
  }
  payload.eventId = `inv:${payload.foodId}:${payload.at}:${payload.reason}`;

  io.to(ROOM.canteen).emit("inventory:updated", payload);
  return true;
}
function isRealtimeActive() {
  return io !== null;
}

/** Reset the module singleton. Used by tests to isolate servers. */
function resetRealtime() {
  io = null;
}

module.exports = {
  attachRealtime,
  emitOrderUpdate,
  emitInventoryUpdate,
  isRealtimeActive,
  resetRealtime,
  ROOM,
};