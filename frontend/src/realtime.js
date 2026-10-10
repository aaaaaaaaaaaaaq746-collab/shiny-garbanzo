import { io } from "socket.io-client";
import { getToken } from "./api";

/**
 * Real-time notification client.
 *
 * Sockets are a NOTIFICATION channel only. On every notification the caller
 * re-reads authoritative state over REST, so a dropped frame, a duplicate or a
 * missed event during a reconnect can never leave the UI showing something the
 * database does not say.
 *
 * The connection is optional: if it fails, every REST call still works and
 * `onStatus` reports the state so the UI can show an indicator.
 */
export function createRealtimeClient({
  onOrderChanged,
  onInventoryChanged,
  onStatusChange,
  subscribeToOrder,
  subscribeToCanteen,
} = {}) {
  const token = getToken();
  let socket = null;
  let canteenActive = false;
  const subscribed = new Set();

  // Events already applied, keyed by the server's stable eventId. Collapses
  // the duplicate deliveries produced when a socket sits in both the user room
  // and an order room.
  const seenEvents = new Map();
  const SEEN_MAX = 200;

  const setStatus = (status, detail) => {
    if (typeof onStatusChange === "function") onStatusChange(status, detail);
  };

  if (!token) {
    setStatus("unauthenticated");
    return { connect: () => {}, close: () => {}, subscribeToOrder: () => {}, isConnected: () => false };
  }

  socket = io(import.meta.env.VITE_SOCKET_URL || import.meta.env.VITE_API_URL || "http://localhost:5000", {
    auth: { token },
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 8000,
    // Detect a dropped connection promptly so the UI can resync rather than
    // sitting on stale data for the default 25s ping interval.
    pingInterval: 4000,
    pingTimeout: 4000,
  });

  socket.on("connect", () => {
    setStatus("connected");
    // Re-join whatever this view was watching. Rooms are per-socket, so a
    // reconnect must explicitly restore them.
    for (const orderId of subscribed) {
      socket.emit("order:subscribe", { orderId }, () => {});
    }
    if (canteenActive) socket.emit("canteen:subscribe", {}, () => {});
  });

  socket.on("disconnect", (reason) => {
    setStatus("disconnected", reason);
  });

  socket.on("connect_error", (err) => {
    // Do not surface this as a page error: REST remains fully usable.
    setStatus("error", err?.message);
  });

  socket.on("order:updated", (event) => {
    if (!event?.eventId) return;
    if (seenEvents.has(event.eventId)) return; // duplicate delivery

    seenEvents.set(event.eventId, Date.now());
    if (seenEvents.size > SEEN_MAX) {
      const oldest = seenEvents.keys().next().value;
      seenEvents.delete(oldest);
    }

    // Notification only — the caller refetches from REST.
    if (typeof onOrderChanged === "function") onOrderChanged(event);
  });

  /**
   * Inventory notifications. Staff-only in practice: the server only emits
   * these to the staff room. Advisory, exactly like order events -- the caller
   * re-reads through the inventory REST endpoints.
   */
  socket.on("inventory:updated", (event) => {
    if (!event?.eventId) return;
    if (seenEvents.has(event.eventId)) return; // duplicate delivery

    seenEvents.set(event.eventId, Date.now());
    if (seenEvents.size > SEEN_MAX) {
      const oldest = seenEvents.keys().next().value;
      seenEvents.delete(oldest);
    }
    if (typeof onInventoryChanged === "function") onInventoryChanged(event);
  });
  // Reconnect recovery: the caller performs a full snapshot refresh.
  socket.io.on("reconnect", () => setStatus("reconnected"));

  return {
    subscribeToOrder(orderId) {
      if (!orderId || !socket) return;
      subscribed.add(orderId);
      socket.emit("order:subscribe", { orderId }, (ack) => {
        if (!ack?.ok) subscribed.delete(orderId);
      });
      if (typeof subscribeToOrder === "function") subscribeToOrder(orderId);
    },

    unsubscribeFromOrder(orderId) {
      subscribed.delete(orderId);
      if (socket) socket.emit("order:unsubscribe", { orderId });
    },

    subscribeToCanteen() {
      canteenActive = true;
      if (socket) socket.emit("canteen:subscribe", {}, (ack) => {
        if (!ack?.ok) canteenActive = false;
      });
      if (typeof subscribeToCanteen === "function") subscribeToCanteen();
    },

    isConnected: () => Boolean(socket?.connected),

    close() {
      if (!socket) return;
      socket.close();
      socket = null;
      subscribed.clear();
      canteenActive = false;
    },
  };
}