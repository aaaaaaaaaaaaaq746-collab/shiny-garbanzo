import React, { useEffect, useState, useCallback, useRef } from "react";
import { motion } from "framer-motion";
import { FaCheck, FaSpinner, FaTimes, FaSignOutAlt, FaFire } from "react-icons/fa";
import api from "../api";
import OrderTimeline from "./OrderTimeline";
import { createRealtimeClient } from "../realtime";
import { formatElapsed, waitTone, statusBadge, requiresReason, ACTION_STYLE } from "../orderStatus";
import { sortKitchenQueue } from "../lib/kitchenSort";

/**
 * Kitchen Display System.
 *
 * A staff-facing view of the live queue. It deliberately has NO status logic of
 * its own: every action button comes from the server's `allowedTransitions`,
 * which is produced by the same lifecycle module the REST endpoint enforces.
 * The board can therefore never offer an action the API would reject.
 */
export default function KitchenDisplay({ name, onLogout, onBack }) {
  const [orders, setOrders] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [liveStatus, setLiveStatus] = useState("connecting");
  // Ticks every second so elapsed waiting times advance live.
  const [now, setNow] = useState(() => Date.now());
  const [highlighted, setHighlighted] = useState(() => new Set());

  const seenOrderIds = useRef(new Set());

  const refreshAll = useCallback(async () => {
    try {
      const res = await api.get("/orders/kitchen");
      const incoming = res.data || [];

      // Flag genuinely new orders so the board can call them out once.
      setHighlighted((prev) => {
        const next = new Set(prev);
        for (const o of incoming) {
          if (!seenOrderIds.current.has(o._id)) next.add(o._id);
        }
        return next;
      });
      for (const o of incoming) seenOrderIds.current.add(o._id);

      setOrders(incoming);
    } catch (err) {
      setError(err.message || "Could not load the kitchen queue");
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshOrder = useCallback(async (orderId) => {
    try {
      const fresh = await api.get(`/orders/${orderId}`);
      setOrders((prev) => {
        const exists = prev.some((o) => o._id === orderId);
        // Settled orders leave the live queue.
        if (["Completed", "Cancelled", "Rejected"].includes(fresh.data.status)) {
          return prev.filter((o) => o._id !== orderId);
        }
        return exists
          ? prev.map((o) => (o._id === orderId ? fresh.data : o))
          : [fresh.data, ...prev];
      });
    } catch {
      /* a full refresh will reconcile */
    }
  }, []);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  // Live waiting-time clock.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Real-time updates; the canteen room receives every order change.
  useEffect(() => {
    let wasDisconnected = false;
    const client = createRealtimeClient({
      onStatusChange: (status) => {
        setLiveStatus(status);
        if (status === "disconnected" || status === "error") wasDisconnected = true;
        if ((status === "connected" || status === "reconnected") && wasDisconnected) {
          wasDisconnected = false;
          refreshAll();
        }
      },
      onOrderChanged: (event) => refreshOrder(event.orderId),
    });
    client.subscribeToCanteen();
    return () => client.close();
  }, [refreshOrder, refreshAll]);

  const updateStatus = async (orderId, status) => {
    setError("");

    let reason;
    if (requiresReason(status)) {
      const entered = window.prompt(`Reason for marking this order "${status}" (required):`, "");
      if (entered === null) return;
      if (!entered.trim()) {
        setError(`A reason is required to mark an order "${status}".`);
        return;
      }
      reason = entered.trim();
    }

    try {
      const res = await api.put(`/orders/${orderId}/status`, { status, reason });
      setHighlighted((prev) => {
        const next = new Set(prev);
        next.delete(orderId);
        return next;
      });
      if (["Completed", "Cancelled", "Rejected"].includes(res.data.status)) {
        setOrders((prev) => prev.filter((o) => o._id !== orderId));
      } else {
        setOrders((prev) => prev.map((o) => (o._id === orderId ? res.data : o)));
      }
    } catch (err) {
      setError(err.message || "Failed to update order");
      // Re-read so the board reflects the server after a conflict.
      try {
        const fresh = await api.get(`/orders/${orderId}`);
        setOrders((prev) => prev.map((o) => (o._id === orderId ? fresh.data : o)));
      } catch {
        /* error already surfaced */
      }
    }
  };

  /**
   * Mark an open order rush or normal. Not a status change. The server re-sorts
   * the queue, so the board is re-read afterwards.
   */
  const setPriority = async (orderId, priority) => {
    setError("");
    try {
      await api.put(`/orders/${orderId}/priority`, { priority });
      await refreshAll();
    } catch (err) {
      setError(err.message || "Could not change priority");
    }
  };

  const counts = orders.reduce((acc, o) => {
    acc[o.status] = (acc[o.status] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="p-6 bg-gradient-to-br from-purple-200 via-blue-100 to-green-200 min-h-screen">
      <div className="flex justify-between items-center mb-4 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-3xl font-extrabold text-purple-800 flex items-center">
            <FaFire className="mr-2 text-orange-500" /> Kitchen Display
          </h1>
          <span
            className={`inline-flex items-center gap-2 text-xs px-3 py-1 rounded-full bg-white/80 shadow ${
              liveStatus === "connected" ? "text-green-700" : "text-gray-500"
            }`}
            data-testid="kitchen-live"
          >
            <span
              className={`w-2 h-2 rounded-full ${
                liveStatus === "connected" ? "bg-green-500" : "bg-gray-400"
              }`}
            />
            {liveStatus === "connected" ? "Live" : "Offline"}
          </span>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={refreshAll}
            className="bg-white text-purple-700 hover:bg-purple-50 px-4 py-2 rounded-full shadow font-semibold"
          >
            Refresh
          </button>
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              data-testid="kitchen-back"
              className="bg-white text-purple-700 hover:bg-purple-50 px-4 py-2 rounded-full shadow font-semibold"
            >
              Dashboard
            </button>
          )}
          <button
            type="button"
            onClick={onLogout}
            className="flex items-center bg-white text-purple-700 hover:bg-purple-50 px-4 py-2 rounded-full shadow font-semibold"
          >
            <FaSignOutAlt className="mr-2" /> Logout
          </button>
        </div>
      </div>

      <p className="text-center text-sm text-gray-600 mb-4">
        Signed in as {name}
      </p>

      {error && (
        <p role="alert" className="max-w-3xl mx-auto mb-4 text-center text-sm text-red-600 bg-red-50 border border-red-200 rounded p-2">
          {error}
        </p>
      )}

      {/* Queue summary */}
      <div className="flex justify-center gap-3 flex-wrap mb-6" data-testid="kitchen-counts">
        {["Pending", "Accepted", "Preparing", "Ready"].map((s) => (
          <div key={s} className="bg-white rounded-2xl shadow px-5 py-2 text-center">
            <div className="text-xs text-gray-500">{s}</div>
            <div className="text-xl font-bold text-purple-700">{counts[s] || 0}</div>
          </div>
        ))}
      </div>

      <h2 className="text-2xl font-bold mb-4 text-gray-800">
        Live Queue ({orders.length})
      </h2>

      {loading ? (
        <p className="text-gray-500">Loading the queue...</p>
      ) : orders.length === 0 ? (
        <p className="text-gray-600 bg-white rounded-3xl shadow p-8 text-center">
          No orders waiting. New orders appear here automatically.
        </p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-5">
          {sortKitchenQueue(orders).map((order) => {
            const elapsed = formatElapsed(order.date, now);
            const tone = waitTone(order.date, now);
            const isNew = highlighted.has(order._id);

            return (
              <motion.div
                key={order._id}
                layout
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                data-testid="kitchen-order"
                data-order-id={order._id}
                className={`bg-white rounded-3xl shadow-2xl p-5 flex flex-col ${
                  isNew ? "ring-4 ring-orange-400" : ""
                }`}
              >
                <div className="flex justify-between items-start gap-2 mb-3">
                  <div>
                    {order.priority === "rush" && (
                      <span
                        data-testid="kitchen-rush"
                        className="inline-block mb-1 px-2 py-0.5 rounded-full bg-red-600 text-white text-xs font-bold tracking-wide"
                      >
                        RUSH
                      </span>
                    )}
                    <p className="font-bold text-purple-700 text-sm break-all">
                      {order._id}
                    </p>
                    <p className="text-xs text-gray-500">
                      {order.student?.name || "Unknown"}
                      {order.student?.email ? ` · ${order.student.email}` : ""}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <span
                      className={`inline-block px-3 py-1 rounded-full text-sm font-mono font-bold ${tone.className}`}
                      data-testid="kitchen-wait"
                      title="Waiting time"
                    >
                      {elapsed}
                    </span>
                    <p className="text-[10px] uppercase tracking-wide text-gray-500 mt-1">
                      {tone.label}
                    </p>
                  </div>
                </div>

                <span
                  className={`self-start text-xs font-semibold px-3 py-1 rounded-full mb-3 ${statusBadge(order.status)}`}
                  data-testid="kitchen-order-status"
                >
                  {order.status}
                </span>

                <OrderTimeline status={order.status} className="mb-4" />

                <ul className="space-y-1 mb-3 flex-1">
                  {(order.items || []).map((item, i) => (
                    <li
                      key={`${item.food}-${i}`}
                      className="flex justify-between text-sm text-gray-700"
                      data-testid="kitchen-item"
                    >
                      <span>
                        <span className="font-bold text-purple-700 mr-2">
                          {item.quantity}×
                        </span>
                        {item.name}
                      </span>
                      <span className="text-gray-400">₹{item.price * item.quantity}</span>
                    </li>
                  ))}
                </ul>

                <div className="flex justify-between items-center text-sm mb-3">
                  <span className="text-gray-500">Pickup</span>
                  <span className="font-semibold text-gray-700">
                    {order.pickupSlot || "Any"}
                  </span>
                </div>

                {/* Special instructions */}
                {order.notes && (
                  <div
                    className="bg-yellow-50 border border-yellow-300 text-yellow-900 rounded-xl p-3 text-sm mb-3"
                    data-testid="kitchen-notes"
                  >
                    <span className="font-bold block text-xs uppercase tracking-wide mb-1">
                      Special instructions
                    </span>
                    {order.notes}
                  </div>
                )}

                {/* Actions come straight from the server's lifecycle rules. */}
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    data-testid="kitchen-priority"
                    aria-pressed={order.priority === "rush"}
                    onClick={() => setPriority(order._id, order.priority === "rush" ? "normal" : "rush")}
                    className={`px-3 py-2 rounded-full text-sm font-semibold shadow ${
                      order.priority === "rush"
                        ? "bg-red-100 text-red-700 hover:bg-red-200"
                        : "bg-white text-gray-700 hover:bg-gray-100 border border-gray-300"
                    }`}
                  >
                    {order.priority === "rush" ? "Clear rush" : "Mark rush"}
                  </button>
                  {(order.allowedTransitions || []).map((next) => (
                    <button
                      key={next}
                      type="button"
                      data-testid={`kitchen-action-${next}`}
                      onClick={() => updateStatus(order._id, next)}
                      className={`flex items-center text-white font-bold py-1 px-3 rounded-full shadow-md text-sm ${
                        ACTION_STYLE[next] || "bg-purple-500"
                      }`}
                    >
                      {next === "Completed" && <FaCheck className="mr-1" />}
                      {next === "Preparing" && <FaSpinner className="mr-1 animate-spin" />}
                      {(next === "Cancelled" || next === "Rejected") && (
                        <FaTimes className="mr-1" />
                      )}
                      {next}
                    </button>
                  ))}
                </div>
              </motion.div>
            );
          })}
        </div>
      )}
    </div>
  );
}