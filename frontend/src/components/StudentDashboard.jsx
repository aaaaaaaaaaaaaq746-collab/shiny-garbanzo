import React, { useEffect, useState, useCallback } from "react";
import { motion } from "framer-motion";
import { FaShoppingCart, FaTrashAlt, FaHeart, FaSignOutAlt } from "react-icons/fa";
import api from "../api";
import { statusTone, isActive } from "../orderStatus";
import OrderTimeline from "./OrderTimeline";
import { createRealtimeClient } from "../realtime";

const CART_KEY = "canteen_cart";

// Food Card Component with motion
function FoodCard({ food, addToCart, isFavorite, onToggleFavorite, inCart = 0 }) {
  const soldOut = food.available === false || (food.stock !== null && food.stock <= 0);

  // Stock-tracked items publish `availableQty` (physical stock minus what
  // is already reserved). It is advisory: the server revalidates on checkout.
  const tracked = typeof food.availableQty === "number";
  const available = tracked ? food.availableQty : Infinity;
  const remaining = available - inCart;
  const exhausted = !soldOut && remaining <= 0;
  return (
    <motion.div
      whileHover={soldOut ? undefined : { scale: 1.05, rotate: 2 }}
      whileTap={soldOut ? undefined : { scale: 0.95 }}
      data-testid="food-card"
      data-food-name={food.name}
      className="bg-white rounded-3xl shadow-2xl p-4 w-64 m-3 flex flex-col items-center transform perspective-1000"
    >
      <div className="relative w-full">
        <img
          src={food.image || "/placeholder-food.svg"}
          alt={food.name}
          loading="lazy"
          className="rounded-xl w-full h-40 object-cover mb-3 shadow-inner"
        />
        <button
          type="button"
          onClick={() => onToggleFavorite(food._id)}
          aria-label={isFavorite ? `Remove ${food.name} from favorites` : `Add ${food.name} to favorites`}
          aria-pressed={isFavorite}
          className={`absolute top-2 right-2 p-2 rounded-full shadow ${
            isFavorite ? "text-red-500 bg-white" : "text-gray-400 bg-white/90"
          }`}
        >
          <FaHeart />
        </button>
      </div>

      <h3 className="font-extrabold text-lg text-purple-700">{food.name}</h3>
      <p className="text-sm text-gray-500 mb-2 text-center">{food.description}</p>

      <div className="flex flex-wrap justify-center gap-1 mb-2 text-xs">
        {food.category && (
          <span className="px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">{food.category}</span>
        )}
        {food.dietary && (
          <span className="px-2 py-0.5 rounded-full bg-green-100 text-green-700">{food.dietary}</span>
        )}
        {food.spicy && (
          <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-700">spicy</span>
        )}
        {food.prepTimeMinutes != null && (
          <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
            {food.prepTimeMinutes} min
          </span>
        )}
      </div>

      <p className="text-xl font-bold mb-2 text-green-600">₹{food.price}</p>

      {tracked && !soldOut && (
        <p
          className={`text-xs font-semibold mb-2 ${
            exhausted
              ? "text-red-600"
              : remaining <= (food.lowStockThreshold ?? 0)
              ? "text-yellow-600"
              : "text-green-600"
          }`}
          data-testid={`availability-${food._id}`}
        >
          {exhausted
            ? "No more available"
            : `${remaining} ${food.unit || "left"} available`}
        </p>
      )}

      {soldOut || exhausted ? (
        <p className="text-sm font-semibold text-red-500 mb-2" data-testid="sold-out">
          {soldOut ? "Sold out" : "None left"}
        </p>
      ) : (
        <motion.button
          whileHover={{ scale: 1.1 }}
          type="button"
          className="flex items-center bg-purple-500 hover:bg-purple-600 text-white font-bold py-1 px-4 rounded-full shadow-lg"
          onClick={() => addToCart(food)}
          data-testid="add-to-cart"
        >
          <FaShoppingCart className="mr-2" /> Add to Cart
        </motion.button>
      )}
    </motion.div>
  );
}

export default function StudentDashboard({ name, onLogout }) {
  const [foods, setFoods] = useState([]);
  const [cart, setCart] = useState(() => {
    // Restore a previously persisted cart.
    try {
      const raw = localStorage.getItem(CART_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });
  const [orders, setOrders] = useState([]);
  const [favorites, setFavorites] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [liveStatus, setLiveStatus] = useState("connecting");
  // Orders that just became Ready, surfaced as a pickup notification.
  const [readyAlerts, setReadyAlerts] = useState([]);

  // Persist the cart whenever it changes.
  useEffect(() => {
    try {
      localStorage.setItem(CART_KEY, JSON.stringify(cart));
    } catch {
      // Storage may be unavailable (private mode); cart still works in-memory.
    }
  }, [cart]);

  useEffect(() => {
  /** Re-read the menu. Also used when an inventory change arrives. */
  const refreshFoods = useCallback(async () => {
    try {
      const res = await api.get("/food");
      setFoods(res.data || []);
    } catch (err) {
      setError(err.message || "Could not load the menu");
    }
  }, []);

    let cancelled = false;

    const fetchOrders = async () => {
      try {
        const res = await api.get("/orders");
        if (!cancelled) setOrders(res.data || []);
      } catch (err) {
        if (!cancelled) setError(err.message || "Could not load your orders");
      }
    };

    const fetchFavorites = async () => {
      try {
        const res = await api.get("/auth/me/favorites");
        if (!cancelled) setFavorites((res.data || []).map((f) => f._id));
      } catch {
        // Favorites are non-essential; ignore failures silently.
      }
    };

    Promise.all([refreshFoods(), fetchOrders(), fetchFavorites()]).finally(() => {
      if (!cancelled) setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, []);
  /**
   * Re-read a single order from the authoritative REST endpoint.
   *
   * Real-time messages are only a nudge to do this, so a dropped or duplicated
   * event can never leave stale data on screen.
   */
  const refreshOrder = useCallback(async (orderId) => {
    try {
      const res = await api.get(`/orders/${orderId}`);
      setOrders((prev) => prev.map((o) => (o._id === orderId ? res.data : o)));
    } catch {
      // The order may have been removed; a later full refresh will reconcile.
    }
  }, []);

  /** Full snapshot refresh � used on reconnect to recover missed events. */
  const refreshOrders = useCallback(async () => {
    try {
      const res = await api.get("/orders");
      setOrders(res.data || []);
    } catch (err) {
      setError(err.message || "Could not load your orders");
    }
  }, []);


  // Real-time notifications. Sockets are advisory only: every message nudges a
  // REST re-read, and any reconnect triggers a full snapshot refresh so events
  // missed while offline are recovered. If the socket cannot connect, the
  // dashboard keeps working entirely over REST.
  useEffect(() => {
    let wasDisconnected = false;

    const client = createRealtimeClient({
      onStatusChange: (status) => {
        setLiveStatus(status);
        if (status === "disconnected" || status === "error") {
          wasDisconnected = true;
        }
        // Coming back: re-read everything so nothing missed stays stale.
        if ((status === "connected" || status === "reconnected") && wasDisconnected) {
          wasDisconnected = false;
          refreshOrders();
        }
      },
      // A stock change alters what is orderable; re-read the menu.
      onInventoryChanged: () => refreshFoods(),
      onOrderChanged: (event) => {
        // A transition into "Ready" is a pickup moment worth calling out.
        if (event.status === "Ready" && event.previousStatus !== "Ready") {
          setReadyAlerts((prev) =>
            prev.some((a) => a.orderId === event.orderId)
              ? prev
              : [...prev, { orderId: event.orderId, at: event.at }]
          );
        }
        refreshOrder(event.orderId);
      },
    });

    return () => client.close();
  }, [refreshOrder, refreshOrders, refreshFoods]);
  const addToCart = useCallback((food) => {
    // Client-side guard for a friendly message; the server is authoritative.
    if (typeof food.availableQty === "number") {
      const held = cart.find((i) => i._id === food._id)?.quantity ?? 0;
      if (held + 1 > food.availableQty) {
        setError(`Only ${food.availableQty} of "${food.name}" available.`);
        return;
      }
    }
    setCart((prev) => {
      const exists = prev.find((item) => item._id === food._id);
      if (exists) {
        return prev.map((item) =>
          item._id === food._id ? { ...item, quantity: item.quantity + 1 } : item
        );
      }
      return [...prev, { ...food, quantity: 1 }];
    });
  }, []);

  const changeQuantity = useCallback((id, delta) => {
    setCart((prev) =>
      prev
        .map((item) =>
          item._id === id
            ? { ...item, quantity: item.quantity + delta }
            : item
        )
        // Drop the line once its quantity reaches zero.
        .filter((item) => item.quantity > 0)
    );
  }, []);

  const removeFromCart = useCallback((id) => {
    setCart((prev) => prev.filter((item) => item._id !== id));
  }, []);

  const clearCart = useCallback(() => setCart([]), []);

  const toggleFavorite = useCallback(async (foodId) => {
    const isFav = favorites.includes(foodId);
    // Optimistic update, rolled back on failure.
    setFavorites((prev) =>
      isFav ? prev.filter((id) => id !== foodId) : [...prev, foodId]
    );
    try {
      if (isFav) {
        await api.delete(`/auth/me/favorites/${foodId}`);
      } else {
        await api.post(`/auth/me/favorites/${foodId}`);
      }
    } catch {
      setFavorites((prev) =>
        isFav ? [...prev, foodId] : prev.filter((id) => id !== foodId)
      );
    }
  }, [favorites]);

  /** Load a past order's lines back into the cart. */
  const reorder = useCallback((order) => {
    setCart((prev) => {
      const next = [...prev];
      for (const item of order.items || []) {
        const foodId = typeof item.food === "object" ? item.food._id : item.food;
        if (!foodId) continue;
        const existing = next.find((f) => f._id === foodId);
        if (existing) {
          existing.quantity += item.quantity;
        } else {
          next.push({
            _id: foodId,
            name: item.name,
            price: item.price,
            quantity: item.quantity,
            available: true,
            stock: null,
          });
        }
      }
      return next;
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  /**
   * Cancel an order the user owns.
   *
   * The button is only rendered when the server told us `canCancel` is true
   * (Pending or Accepted, owned by this user), so the lifecycle rules are not
   * duplicated in the client. The server remains the authority.
   */
  const handleCancelOrder = async (order) => {
    if (!window.confirm("Cancel this order? This cannot be undone.")) return;

    setError("");
    try {
      const res = await api.post(`/orders/${order._id}/cancel`, {});
      // Replace the order in place so the status refreshes immediately.
      setOrders((prev) => prev.map((o) => (o._id === order._id ? res.data : o)));
    } catch (err) {
      setError(err.message || "Failed to cancel order");
      // Re-read so the UI reflects whatever the server actually holds.
      try {
        const fresh = await api.get(`/orders/${order._id}`);
        setOrders((prev) => prev.map((o) => (o._id === order._id ? fresh.data : o)));
      } catch {
        /* leave the existing state; the error is already surfaced */
      }
    }
  };

  const totalPrice = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);

  const handleCheckout = async () => {
    if (cart.length === 0) {
      setError("Your cart is empty.");
      return;
    }
    setError("");

    try {
      // Only product ids and quantities are sent. The server looks up the
      // real prices and computes the total.
      const res = await api.post("/orders", {
        items: cart.map((item) => ({
          food: item._id,
          quantity: item.quantity,
        })),
      });

      clearCart();
      setOrders((prev) => [res.data, ...prev]);
    } catch (err) {
      setError(err.message || "Failed to place order");
    }
  };

  return (
    <div className="p-8 bg-gradient-to-br from-purple-200 via-blue-100 to-green-200 min-h-screen">
      <div className="flex justify-end mb-2">
        <button
          type="button"
          onClick={onLogout}
          className="flex items-center bg-white text-purple-700 hover:bg-purple-50 px-4 py-2 rounded-full shadow font-semibold"
        >
          <FaSignOutAlt className="mr-2" /> Logout
        </button>
      </div>

      <div className="flex justify-center mb-2">
        <span
          title={
            liveStatus === "connected"
              ? "Live updates on"
              : "Live updates unavailable - refresh manually"
          }
          className={`inline-flex items-center gap-2 text-xs px-3 py-1 rounded-full bg-white/80 shadow ${
            liveStatus === "connected" ? "text-green-700" : "text-gray-500"
          }`}
        >
          <span
            className={`w-2 h-2 rounded-full ${
              liveStatus === "connected" ? "bg-green-500" : "bg-gray-400"
            }`}
          />
          {liveStatus === "connected" ? "Live" : "Offline"}
        </span>
      </div>
      <motion.h1
        initial={{ y: -50, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.7 }}
        className="text-4xl font-extrabold mb-6 text-purple-800 text-center"
      >
        Welcome, {name}!
      </motion.h1>

{/* Ready-for-pickup notification: raised the moment the kitchen marks
          an order Ready, and dismissible by the student. */}
      {readyAlerts.length > 0 && (
        <div className="max-w-3xl mx-auto mb-4 space-y-2" data-testid="ready-alerts">
          {readyAlerts.map((alert) => (
            <div
              key={alert.orderId}
              role="status"
              data-testid="ready-alert"
              className="flex items-center justify-between gap-3 bg-blue-50 border-2 border-blue-400 rounded-xl p-3 shadow"
            >
              <div>
                <p className="font-bold text-blue-800">Your order is ready for pickup!</p>
                <p className="text-xs text-blue-700 break-all">Order {alert.orderId}</p>
              </div>
              <button
                type="button"
                aria-label="Dismiss pickup notification"
                onClick={() =>
                  setReadyAlerts((prev) => prev.filter((a) => a.orderId !== alert.orderId))
                }
                className="text-blue-700 hover:text-blue-900 font-bold px-2"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {error && (
        <p role="alert" className="max-w-3xl mx-auto mb-4 text-center text-sm text-red-600 bg-red-50 border border-red-200 rounded p-2">
          {error}
        </p>
      )}

      {/* Menu */}
      <h2 className="text-2xl font-bold mb-4 text-gray-800">Menu</h2>
      <div className="flex flex-wrap justify-center">
        {loading ? (
          <p className="text-gray-500">Loading food items...</p>
        ) : foods.length === 0 ? (
          <p className="text-gray-500">No food items available right now.</p>
        ) : (
          foods.map((food) => (
            <FoodCard
              key={food._id}
              food={food}
              addToCart={addToCart}
              isFavorite={favorites.includes(food._id)}
              onToggleFavorite={toggleFavorite}
              inCart={cart.find((i) => i._id === food._id)?.quantity ?? 0}
            />
          ))
        )}
      </div>

      {/* Cart */}
      <h2 className="text-2xl font-bold mt-8 mb-4 text-gray-800">Cart</h2>
      {cart.length === 0 ? (
        <p className="text-gray-500">Your cart is empty.</p>
      ) : (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="bg-white p-6 rounded-3xl shadow-2xl w-full max-w-3xl mx-auto"
        >
          {cart.map((item) => (
            <motion.div
              key={item._id}
              whileHover={{ scale: 1.02 }}
              className="flex justify-between items-center mb-3 border-b border-gray-200 pb-2"
            >
              <div>
                <h3 className="font-bold text-purple-700">{item.name}</h3>
                <p className="text-gray-600">₹{item.price} each</p>
              </div>

              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    aria-label={`Decrease quantity of ${item.name}`}
                    onClick={() => changeQuantity(item._id, -1)}
                    className="w-8 h-8 rounded-full bg-purple-100 text-purple-700 font-bold"
                  >
                    −
                  </button>
                  <span className="w-6 text-center font-semibold">{item.quantity}</span>
                  <button
                    type="button"
                    aria-label={`Increase quantity of ${item.name}`}
                    onClick={() => changeQuantity(item._id, 1)}
                    className="w-8 h-8 rounded-full bg-purple-500 text-white font-bold"
                  >
                    +
                  </button>
                </div>

                <span className="font-semibold text-gray-700 w-20 text-right">
                  ₹{item.price * item.quantity}
                </span>

                <button
                  type="button"
                  onClick={() => removeFromCart(item._id)}
                  aria-label={`Remove ${item.name} from cart`}
                  className="bg-red-500 hover:bg-red-600 text-white p-2 rounded-full"
                >
                  <FaTrashAlt />
                </button>
              </div>
            </motion.div>
          ))}

          <div className="flex justify-between font-bold text-purple-700 mt-4 text-lg">
            <span>Total:</span>
            <span>₹{totalPrice}</span>
          </div>

          <motion.button
            whileHover={{ scale: 1.05 }}
            type="button"
            onClick={handleCheckout}
            data-testid="checkout"
            className="w-full bg-purple-600 hover:bg-purple-700 text-white font-bold py-3 px-6 rounded-full mt-4 shadow-lg"
          >
            Checkout <FaShoppingCart className="inline ml-2" />
          </motion.button>
        </motion.div>
      )}

      {/* Orders */}
      <h2 className="text-2xl font-bold mt-8 mb-4 text-gray-800">Your Orders</h2>
      {orders.length === 0 ? (
        <p className="text-gray-500">You have no orders yet.</p>
      ) : (
        <div className="space-y-6">
          {orders.map((order) => (
            <motion.div
              key={order._id}
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              className="bg-white p-6 rounded-3xl shadow-2xl border-l-8 border-purple-500"
              data-testid="order-card"
              data-order-id={order._id}
            >
              <div className="flex justify-between mb-2 gap-4">
                <span className="font-bold text-purple-700 break-all">
                  Order ID: {order._id}
                </span>
                <span data-testid="order-status" className={`font-semibold ${statusTone(order.status)}`}>
                  {order.status}
                </span>
              </div>

              {/* Progress timeline across the canonical lifecycle. */}
              <OrderTimeline status={order.status} className="my-3" />

              <p className="text-gray-500 text-sm mb-2">
                Date: {new Date(order.date).toLocaleString()}
              </p>

              {order.estimatedReadyAt && isActive(order.status) && (
                <p className="text-gray-500 text-sm mb-2">
                  Estimated ready: {new Date(order.estimatedReadyAt).toLocaleTimeString()}
                </p>
              )}

              {(order.items || []).map((item, i) => (
                <div key={`${item.food}-${i}`} className="flex justify-between text-gray-700 text-sm mb-1">
                  <span>{item.name} × {item.quantity}</span>
                  <span>₹{item.price * item.quantity}</span>
                </div>
              ))}

              <div className="flex justify-between font-bold text-purple-700 mt-2">
                <span>Total:</span>
                <span>₹{order.total}</span>
              </div>

              {/* Status history */}
              {order.statusHistory?.length > 0 && (
                <ol className="mt-4 text-xs text-gray-500 space-y-1">
                  {order.statusHistory.map((h, i) => (
                    <li key={i}>
                      {h.from ? `${h.from} → ` : ""}
                      {h.status} — {new Date(h.at).toLocaleString()}
                      {h.reason ? ` — ${h.reason}` : ""}
                    </li>
                  ))}
                </ol>
              )}

              {/* Cancel is offered only when the server says it is eligible. */}
              {order.canCancel && (
                <button
                  type="button"
                  onClick={() => handleCancelOrder(order)}
                  data-testid="cancel-order"
                  className="mt-4 ml-2 bg-red-100 hover:bg-red-200 text-red-700 font-semibold py-1 px-4 rounded-full"
                >
                  Cancel Order
                </button>
              )}

              {isActive(order.status) && (
                <button
                  type="button"
                  onClick={() => reorder(order)}
                  className="mt-4 bg-purple-100 hover:bg-purple-200 text-purple-700 font-semibold py-1 px-4 rounded-full"
                >
                  Reorder
                </button>
              )}
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}
