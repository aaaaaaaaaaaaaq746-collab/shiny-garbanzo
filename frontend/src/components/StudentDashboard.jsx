import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { FaSignOutAlt } from "react-icons/fa";
import api from "../api";
import { createRealtimeClient } from "../realtime";
import {
  CART_KEY,
  addToCart,
  buildCheckoutPayload,
  changeQuantity,
  clearCart,
  mergeIntoCart,
  parseStoredCart,
  quantityOfFood,
  removeLine,
  linesFromOrder,
} from "../lib/cart";
import { DEFAULT_FILTERS, applyClientFilters, foodQueryParams } from "../lib/menuFilters";
import { DEFAULT_HISTORY, historyQueryParams } from "../lib/orderHistory";
import { saveTextFile } from "../lib/download";
import {
  DEFAULT_NOTIFICATION_PREFS,
  normalizePrefs,
  playPickupTone,
  shouldPlaySound,
  shouldRaiseReadyAlert,
} from "../lib/notify";
import FoodCard from "./student/FoodCard";
import MenuFilters from "./student/MenuFilters";
import CartPanel from "./student/CartPanel";
import OrderCard from "./student/OrderCard";
import OrderHistoryFilters from "./student/OrderHistoryFilters";
import ReviewPanel from "./student/ReviewPanel";
import AccountPanel from "./student/AccountPanel";

/**
 * Student home screen. Owns the server state and the realtime wiring; the
 * presentation lives in components/student/.
 *
 * Realtime messages are only a nudge to re-read over REST, and every reconnect
 * triggers a full snapshot refresh, so a missed event never leaves stale data.
 */
export default function StudentDashboard({ name, onLogout }) {
  const [foods, setFoods] = useState([]);
  const [categories, setCategories] = useState([]);
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [cart, setCart] = useState(() => {
    // Restore a previously persisted cart (upgrading older entries).
    try {
      return parseStoredCart(localStorage.getItem(CART_KEY));
    } catch {
      return [];
    }
  });
  const [pickupAt, setPickupAt] = useState(null);
  const [couponCode, setCouponCode] = useState(null);
  const [checking, setChecking] = useState(false);
  const [orders, setOrders] = useState([]);
  const [historyFilters, setHistoryFilters] = useState(DEFAULT_HISTORY);
  const [favorites, setFavorites] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [liveStatus, setLiveStatus] = useState("connecting");
  // Orders that just became Ready, surfaced as a pickup notification.
  const [readyAlerts, setReadyAlerts] = useState([]);
  // Notification preferences: loaded once, updated from the Account panel.
  const [prefs, setPrefs] = useState(DEFAULT_NOTIFICATION_PREFS);
  const prefsRef = useRef(prefs);
  useEffect(() => {
    prefsRef.current = prefs;
  }, [prefs]);
  useEffect(() => {
    let active = true;
    api
      .get("/auth/me")
      .then((res) => {
        if (active) setPrefs(normalizePrefs(res.data.notificationPrefs));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  const [reviewOrderId, setReviewOrderId] = useState(null);
  const [now, setNow] = useState(() => Date.now());

  // Query keys, mirrored into refs so stable callbacks (used by the realtime
  // client) always read the current filters without re-subscribing.
  const foodParams = useMemo(() => foodQueryParams(filters), [filters]);
  const foodKey = JSON.stringify(foodParams);
  const foodKeyRef = useRef(foodKey);
  const foodSeq = useRef(0);
  const historyParams = useMemo(() => historyQueryParams(historyFilters), [historyFilters]);
  const historyKey = JSON.stringify(historyParams);
  const historyKeyRef = useRef(historyKey);

  useEffect(() => {
    foodKeyRef.current = foodKey;
  }, [foodKey]);
  useEffect(() => {
    historyKeyRef.current = historyKey;
  }, [historyKey]);

  // Persist the cart whenever it changes.
  useEffect(() => {
    try {
      localStorage.setItem(CART_KEY, JSON.stringify(cart));
    } catch {
      // Storage may be unavailable (private mode); cart still works in-memory.
    }
  }, [cart]);

  // Keep relative times ("About 5 min left") fresh without re-rendering often.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);

  /** Re-read the menu for the current filters. Latest request wins. */
  const refreshFoods = useCallback(async () => {
    const seq = ++foodSeq.current;
    try {
      const res = await api.get("/food", { params: JSON.parse(foodKeyRef.current) });
      if (seq === foodSeq.current) setFoods(res.data || []);
    } catch (err) {
      if (seq === foodSeq.current) setError(err.message || "Could not load the menu");
    } finally {
      if (seq === foodSeq.current) setLoading(false);
    }
  }, []);

  /** Re-read the student's order history for the current history filters. */
  const refreshOrders = useCallback(async () => {
    try {
      const res = await api.get("/orders", { params: JSON.parse(historyKeyRef.current) });
      setOrders(res.data || []);
    } catch (err) {
      setError(err.message || "Could not load your orders");
    }
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
      // The order may have been removed or fall outside the filter; a later
      // full refresh will reconcile.
    }
  }, []);

  // Menu: refetch when the discovery filters change, after a short pause so
  // typing in search does not fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      refreshFoods();
    }, 250);
    return () => clearTimeout(timer);
  }, [foodKey, refreshFoods]);

  // Order history: refetch when the history filters change.
  useEffect(() => {
    refreshOrders();
  }, [historyKey, refreshOrders]);

  // One-off loads: categories and favorites.
  useEffect(() => {
    let cancelled = false;

    api
      .get("/food/categories")
      .then((res) => {
        if (!cancelled) setCategories(res.data || []);
      })
      .catch(() => {
        // Category filter is optional; the menu still works without it.
      });

    api
      .get("/auth/me/favorites")
      .then((res) => {
        if (!cancelled) setFavorites((res.data || []).map((f) => f._id));
      })
      .catch(() => {
        // Favorites are non-essential; ignore failures silently.
      });

    return () => {
      cancelled = true;
    };
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
        // A transition into "Ready" is a pickup moment worth calling out,
        // unless the student has turned order updates off.
        if (
          event.status === "Ready" &&
          event.previousStatus !== "Ready" &&
          shouldRaiseReadyAlert(prefsRef.current)
        ) {
          if (shouldPlaySound(prefsRef.current)) playPickupTone();
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

  const handleAddToCart = (food, options) => {
    const result = addToCart(cart, food, options);
    if (result.error) {
      setError(result.error);
      return;
    }
    setError("");
    setCart(result.cart);
  };

  const handleQuantity = (lineKey, delta) => {
    if (delta > 0) {
      const line = cart.find((l) => l.lineKey === lineKey);
      const food = line && foods.find((f) => f._id === line._id);
      if (food && typeof food.availableQty === "number" && quantityOfFood(cart, food._id) + delta > food.availableQty) {
        setError(`Only ${food.availableQty} of "${food.name}" available.`);
        return;
      }
    }
    setError("");
    setCart((prev) => changeQuantity(prev, lineKey, delta));
  };

  const handleRemove = (lineKey) => setCart((prev) => removeLine(prev, lineKey));

  const toggleFavorite = useCallback(async (foodId) => {
    const isFav = favorites.includes(foodId);
    // Optimistic update, rolled back on failure.
    setFavorites((prev) => (isFav ? prev.filter((id) => id !== foodId) : [...prev, foodId]));
    try {
      if (isFav) {
        await api.delete(`/auth/me/favorites/${foodId}`);
      } else {
        await api.post(`/auth/me/favorites/${foodId}`);
      }
    } catch {
      setFavorites((prev) => (isFav ? [...prev, foodId] : prev.filter((id) => id !== foodId)));
    }
  }, [favorites]);

  /** Put a past order's lines back into the cart. Prices are re-read at checkout. */
  const handleReorder = (order) => {
    setCart((prev) => mergeIntoCart(prev, linesFromOrder(order)));
    setError("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  /**
   * Cancel an order the user owns.
   *
   * The button is only rendered when the server says `canCancel` is true, so
   * the lifecycle rules are not duplicated here. The server remains the authority.
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

  const handleReceipt = async (order) => {
    setError("");
    try {
      const res = await api.get(`/orders/${order._id}/receipt`, {
        responseType: "text",
        transformResponse: [(body) => body],
      });
      saveTextFile(`receipt-${order._id}.txt`, res.data);
    } catch (err) {
      setError(err.message || "Could not download the receipt");
    }
  };

  const handleCheckout = async () => {
    if (cart.length === 0) {
      setError("Your cart is empty.");
      return;
    }
    setError("");
    setChecking(true);
    try {
      // Only ids, quantities, add-on labels, notes, the chosen slot and the
      // coupon code are sent. The server prices everything.
      await api.post("/orders", buildCheckoutPayload(cart, { pickupAt, couponCode }));
      setCart(clearCart());
      setPickupAt(null);
      setCouponCode(null);
      await refreshOrders();
      refreshFoods();
    } catch (err) {
      setError(err.message || "Failed to place order");
      // Stock or prices may have moved; re-read the menu so the cart is honest.
      refreshFoods();
    } finally {
      setChecking(false);
    }
  };

  const visibleFoods = applyClientFilters(foods, filters, favorites);
  const historyActive = historyKey !== "{}";

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
          title={liveStatus === "connected" ? "Live updates on" : "Live updates unavailable - refresh manually"}
          className={`inline-flex items-center gap-2 text-xs px-3 py-1 rounded-full bg-white/80 shadow ${
            liveStatus === "connected" ? "text-green-700" : "text-gray-500"
          }`}
        >
          <span className={`w-2 h-2 rounded-full ${liveStatus === "connected" ? "bg-green-500" : "bg-gray-400"}`} />
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
                onClick={() => setReadyAlerts((prev) => prev.filter((a) => a.orderId !== alert.orderId))}
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
      <MenuFilters filters={filters} onChange={setFilters} categories={categories} />
      <div className="flex flex-wrap justify-center">
        {loading ? (
          <p className="text-gray-500">Loading food items...</p>
        ) : visibleFoods.length === 0 ? (
          <p className="text-gray-500">
            {foodKey === "{}" && !filters.favoritesOnly
              ? "No food items available right now."
              : "No items match these filters."}
          </p>
        ) : (
          visibleFoods.map((food) => (
            <FoodCard
              key={food._id}
              food={food}
              onAdd={handleAddToCart}
              isFavorite={favorites.includes(food._id)}
              onToggleFavorite={toggleFavorite}
              inCart={quantityOfFood(cart, food._id)}
            />
          ))
        )}
      </div>

      <CartPanel
        cart={cart}
        onQuantity={handleQuantity}
        onRemove={handleRemove}
        pickupAt={pickupAt}
        onPickupChange={setPickupAt}
        couponCode={couponCode}
        onCouponChange={setCouponCode}
        onCheckout={handleCheckout}
        checking={checking}
      />

      {/* Orders */}
      <h2 className="text-2xl font-bold mt-8 mb-4 text-gray-800">Your Orders</h2>
      <OrderHistoryFilters filters={historyFilters} onChange={setHistoryFilters} />
      {orders.length === 0 ? (
        <p className="text-gray-500">{historyActive ? "No orders match these filters." : "You have no orders yet."}</p>
      ) : (
        <div className="space-y-6">
          {orders.map((order) => (
            <div key={order._id}>
              <OrderCard
                order={order}
                now={now}
                onCancel={handleCancelOrder}
                onReorder={handleReorder}
                onReceipt={handleReceipt}
                onRate={(o) => setReviewOrderId((prev) => (prev === o._id ? null : o._id))}
              />
              {reviewOrderId === order._id && (
                <ReviewPanel order={order} onClose={() => setReviewOrderId(null)} />
              )}
            </div>
          ))}
        </div>
      )}

      <div className="mt-10">
        <AccountPanel onPrefsChange={setPrefs} />
      </div>
    </div>
  );
}
