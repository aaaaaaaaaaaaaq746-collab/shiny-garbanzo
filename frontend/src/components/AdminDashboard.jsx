import React, { useEffect, useState, useCallback, useRef } from "react";
import { motion } from "framer-motion";
import {
  FaCheck,
  FaTimes,
  FaSpinner,
  FaPlus,
  FaTrash,
  FaSignOutAlt,
  FaFire,
  FaEdit,
} from "react-icons/fa";
import api, { assetUrl } from "../api";
import FoodDetailsFields from "./FoodDetailsFields";
import { emptyFoodForm, foodToForm, formToPayload, formToMenuPayload } from "../lib/foodForm";
import { servingSummary } from "../lib/mealPeriods";
import { IMAGE_TYPES, uploadMenuImage } from "../lib/menuImage";
import { statusTone, requiresReason, ACTION_STYLE } from "../orderStatus";
import { createRealtimeClient } from "../realtime";
import InventoryPanel from "./InventoryPanel";
import AnnouncementPanel from "./AnnouncementPanel";
import OverviewPanel from "./OverviewPanel";
import AnalyticsPanel from "./AnalyticsPanel";
import CouponPanel from "./CouponPanel";
import StaffPanel from "./StaffPanel";
import MenuImageInput from "./MenuImageInput";

/** Filter chips shown above the order board. */
const FILTERS = [
  { key: "all", label: "All" },
  { key: "Pending", label: "Pending" },
  { key: "Accepted", label: "Accepted" },
  { key: "Preparing", label: "Preparing" },
  { key: "Ready", label: "Ready" },
  { key: "Completed", label: "Completed" },
  { key: "Cancelled", label: "Cancelled" },
  { key: "Rejected", label: "Rejected" },
];

/**
 * Sections of the admin dashboard. Staff see the order board and the menu;
 * everything else is for administrators.
 */
const ADMIN_TABS = [
  { key: "overview", label: "Overview", adminOnly: true },
  { key: "orders", label: "Orders" },
  { key: "menu", label: "Menu" },
  { key: "inventory", label: "Inventory", adminOnly: true },
  { key: "analytics", label: "Analytics", adminOnly: true },
  { key: "coupons", label: "Coupons", adminOnly: true },
  { key: "staff", label: "Staff", adminOnly: true },
  { key: "announcements", label: "Announcements", adminOnly: true },
];

export default function AdminDashboard({ name, role = "admin", onLogout, onOpenKitchen }) {
  const [orders, setOrders] = useState([]);
  const [foods, setFoods] = useState([]);
  const [newFood, setNewFood] = useState(emptyFoodForm);
  // Inline editor for one existing menu item: { id, form, error }.
  const [edit, setEdit] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [liveStatus, setLiveStatus] = useState("connecting");
  const [filter, setFilter] = useState("all");
  // Orders that arrived while this board was open, for the alert strip.
  const [newArrivals, setNewArrivals] = useState([]);
  // Which section of the dashboard is showing.
  const [tab, setTab] = useState("orders");
  // Photo chosen for a new menu item; uploaded once the item is saved.
  const [newFoodImage, setNewFoodImage] = useState(null);

  const canManageMenu = role === "admin" || role === "staff";
  const knownOrderIds = useRef(new Set());

  const refreshAllOrders = useCallback(async () => {
    try {
      const res = await api.get("/orders/all");
      const incoming = res.data || [];

      // Anything we have never seen is genuinely new to this board.
      const seen = knownOrderIds.current;
      if (seen.size > 0) {
        const fresh = incoming.filter((o) => !seen.has(o._id));
        if (fresh.length) {
          setNewArrivals((prev) => [...fresh.map((o) => o._id), ...prev].slice(0, 20));
        }
      }
      incoming.forEach((o) => seen.add(o._id));

      setOrders(incoming);
    } catch (err) {
      setError(err.message || "Error fetching orders");
    }
  }, []);

const refreshOrder = useCallback(async (orderId) => {
    try {
      const fresh = await api.get(`/orders/${orderId}`);
      const seen = knownOrderIds.current;

      // An order this board has never seen is genuinely new. It must be
      // INSERTED, not just mapped over -- otherwise an order placed after the
      // board loaded would stay invisible until a full refresh.
      if (seen.size > 0 && !seen.has(orderId)) {
        setNewArrivals((prev) => [orderId, ...prev.filter((x) => x !== orderId)].slice(0, 20));
      }
      seen.add(orderId);

      setOrders((prev) => {
        const exists = prev.some((o) => o._id === orderId);
        return exists
          ? prev.map((o) => (o._id === orderId ? fresh.data : o))
          : [fresh.data, ...prev];
      });
    } catch {
      /* a later full refresh will reconcile */
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const fetchFoods = async () => {
      try {
        const res = await api.get("/food");
        if (!cancelled) setFoods(res.data || []);
      } catch (err) {
        if (!cancelled) setError(err.message || "Error fetching food items");
      }
    };

    Promise.all([refreshAllOrders(), fetchFoods()]).finally(() => {
      if (!cancelled) setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [refreshAllOrders]);

  // Real-time board updates, with full resync after a reconnect.
  useEffect(() => {
    let wasDisconnected = false;
    const client = createRealtimeClient({
      onStatusChange: (status) => {
        setLiveStatus(status);
        if (status === "disconnected" || status === "error") wasDisconnected = true;
        if ((status === "connected" || status === "reconnected") && wasDisconnected) {
          wasDisconnected = false;
          refreshAllOrders();
        }
      },
      onOrderChanged: (event) => refreshOrder(event.orderId),
    });
    client.subscribeToCanteen();
    return () => client.close();
  }, [refreshOrder, refreshAllOrders]);

  const updateStatus = async (id, status) => {
    setError("");

    let reason;
    if (requiresReason(status)) {
      const entered = window.prompt(
        `Reason for marking this order "${status}" (required):`,
        ""
      );
      if (entered === null) return;
      if (!entered.trim()) {
        setError(`A reason is required to mark an order "${status}".`);
        return;
      }
      reason = entered.trim();
    }

    try {
      const res = await api.put(`/orders/${id}/status`, { status, reason });
      setOrders((prev) => prev.map((o) => (o._id === id ? res.data : o)));
      setNewArrivals((prev) => prev.filter((oid) => oid !== id));
    } catch (err) {
      setError(err.message || "Failed to update status");
      try {
        const fresh = await api.get(`/orders/${id}`);
        setOrders((prev) => prev.map((o) => (o._id === id ? fresh.data : o)));
      } catch {
        /* the error is already surfaced */
      }
    }
  };

  const addFood = async (e) => {
    e.preventDefault();
    setError("");

    let payload;
    try {
      payload = { ...formToPayload(newFood), ...formToMenuPayload(newFood) };
    } catch (err) {
      setError(err.message);
      return;
    }

    try {
      let created = (await api.post("/food", payload)).data;
      if (newFoodImage) {
        try {
          created = await uploadMenuImage(created._id, newFoodImage);
        } catch (err) {
          setError(`The item was saved, but the photo failed: ${err.message}`);
        }
      }
      setFoods((prev) => [...prev, created]);
      setNewFood(emptyFoodForm());
      setNewFoodImage(null);
    } catch (err) {
      setError(err.message || "Failed to add food");
    }
  };

  const startEdit = (food) => setEdit({ id: food._id, form: foodToForm(food), error: "" });

  const saveEdit = async () => {
    if (!edit) return;
    let payload;
    try {
      payload = { ...formToPayload(edit.form), ...formToMenuPayload(edit.form) };
    } catch (err) {
      setEdit({ ...edit, error: err.message });
      return;
    }
    try {
      const res = await api.put(`/food/${edit.id}`, payload);
      setFoods((prev) => prev.map((f) => (f._id === edit.id ? res.data : f)));
      setEdit(null);
    } catch (err) {
      setEdit((cur) => (cur ? { ...cur, error: err.message || "Failed to save changes" } : cur));
    }
  };

  const deleteFood = async (id) => {
    setError("");
    if (!window.confirm("Delete this menu item? This cannot be undone.")) return;

    try {
      await api.delete(`/food/${id}`);
      setFoods((prev) => prev.filter((f) => f._id !== id));
    } catch (err) {
      setError(err.message || "Failed to delete food");
    }
  };

  /**
   * Temporary sold-out (`until` = ISO time) or back on the menu (`until` = null).
   * Staff and administrators both use this; the server clears it on its own.
   */
  const setSoldOut = async (food, until) => {
    setError("");
    try {
      const res = await api.put(`/food/${food._id}`, { soldOutUntil: until });
      setFoods((prev) => prev.map((f) => (f._id === food._id ? res.data : f)));
    } catch (err) {
      setError(err.message || "Could not change availability");
    }
  };

  /** The end of today on this computer's clock: the default sold-out window. */
  const endOfToday = () => {
    const d = new Date();
    d.setHours(24, 0, 0, 0);
    return d.toISOString();
  };

  const visibleOrders = filter === "all" ? orders : orders.filter((o) => o.status === filter);
  const visibleTabs = ADMIN_TABS.filter((t) => !t.adminOnly || role === "admin");

  return (
    <div className="p-8 bg-gradient-to-br from-purple-200 via-blue-100 to-green-200 min-h-screen">
      <div className="flex justify-between items-center flex-wrap gap-3 mb-2">
        <div className="flex items-center gap-3">
          {onOpenKitchen && (
            <button
              type="button"
              onClick={onOpenKitchen}
              data-testid="open-kitchen"
              className="flex items-center bg-orange-500 hover:bg-orange-600 text-white px-4 py-2 rounded-full shadow font-semibold"
            >
              <FaFire className="mr-2" /> Kitchen Display
            </button>
          )}
          <span
            className={`inline-flex items-center gap-2 text-xs px-3 py-1 rounded-full bg-white/80 shadow ${
              liveStatus === "connected" ? "text-green-700" : "text-gray-500"
            }`}
            data-testid="admin-live"
          >
            <span
              className={`w-2 h-2 rounded-full ${
                liveStatus === "connected" ? "bg-green-500" : "bg-gray-400"
              }`}
            />
            {liveStatus === "connected" ? "Live" : "Offline"}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={refreshAllOrders}
            data-testid="admin-refresh"
            className="bg-white text-purple-700 hover:bg-purple-50 px-4 py-2 rounded-full shadow font-semibold"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={onLogout}
            className="flex items-center bg-white text-purple-700 hover:bg-purple-50 px-4 py-2 rounded-full shadow font-semibold"
          >
            Logout
          </button>
        </div>
      </div>

      <motion.h1
        initial={{ y: -50, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.7 }}
        className="text-4xl font-extrabold mb-6 text-purple-800 text-center"
      >
        Welcome, {name}!
      </motion.h1>

      {error && (
        <p role="alert" className="max-w-3xl mx-auto mb-4 text-center text-sm text-red-600 bg-red-50 border border-red-200 rounded p-2">
          {error}
        </p>
      )}

      {/* New-order alert strip */}
      {newArrivals.length > 0 && (
        <div
          className="max-w-3xl mx-auto mb-4 bg-orange-50 border-2 border-orange-400 rounded-xl p-3 flex items-center justify-between gap-3"
          data-testid="new-order-alert"
          role="status"
        >
          <span className="text-sm font-semibold text-orange-800">
            {newArrivals.length} new order{newArrivals.length > 1 ? "s" : ""} received
          </span>
          <button
            type="button"
            onClick={() => setNewArrivals([])}
            className="text-orange-800 font-bold text-sm underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* ===== Section tabs ===== */}
      <nav aria-label="Dashboard sections" className="max-w-5xl mx-auto mb-6 flex flex-wrap justify-center gap-2" data-testid="admin-tabs">
        {visibleTabs.map((t) => (
          <button
            key={t.key}
            type="button"
            data-testid={`tab-${t.key}`}
            aria-pressed={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 rounded-full text-sm font-semibold shadow ${
              tab === t.key ? "bg-purple-600 text-white" : "bg-white text-purple-700 hover:bg-purple-50"
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "overview" && role === "admin" && <OverviewPanel orders={orders} onGoTo={setTab} />}

      {/* ===== Inventory (administrators only) ===== */}
      {tab === "inventory" && role === "admin" && <InventoryPanel />}

      {/* ===== Analytics (administrators only) ===== */}
      {tab === "analytics" && role === "admin" && <AnalyticsPanel />}

      {/* ===== Coupons (administrators only) ===== */}
      {tab === "coupons" && role === "admin" && <CouponPanel />}

      {/* ===== Staff accounts (administrators only) ===== */}
      {tab === "staff" && role === "admin" && <StaffPanel />}

      {/* ===== Announcements (administrators only) ===== */}
      {tab === "announcements" && role === "admin" && <AnnouncementPanel />}

      {/* ===== Menu Management ===== */}
      {tab === "menu" && (
      <>
      <h2 className="text-2xl font-bold mb-4 text-gray-800">Menu Management</h2>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="bg-white p-6 rounded-3xl shadow-2xl mb-8"
      >
        <form onSubmit={addFood} className="mb-4 space-y-4">
        <div className="flex flex-col md:flex-row md:space-x-4 space-y-4 md:space-y-0">
          <input
            type="text"
            placeholder="Name"
            aria-label="Food name"
            value={newFood.name}
            onChange={(e) => setNewFood({ ...newFood, name: e.target.value })}
            className="flex-1 p-2 border rounded"
          />
          <input
            type="text"
            placeholder="Description"
            aria-label="Description"
            value={newFood.description}
            onChange={(e) => setNewFood({ ...newFood, description: e.target.value })}
            className="flex-1 p-2 border rounded"
          />
          <input
            type="number"
            step="0.01"
            min="0.01"
            placeholder="Price"
            aria-label="Price"
            value={newFood.price}
            onChange={(e) => setNewFood({ ...newFood, price: e.target.value })}
            className="w-32 p-2 border rounded"
          />
          <input
            type="text"
            placeholder="Image URL"
            aria-label="Image URL"
            value={newFood.image}
            onChange={(e) => setNewFood({ ...newFood, image: e.target.value })}
            className="flex-1 p-2 border rounded"
          />
          <input
            type="file"
            accept={IMAGE_TYPES.join(",")}
            aria-label="Menu photo file"
            disabled={!canManageMenu}
            onChange={(e) => setNewFoodImage(e.target.files?.[0] || null)}
            className="text-xs"
          />
          <motion.button
            type="submit"
            disabled={!canManageMenu}
            whileHover={{ scale: 1.05 }}
            className="bg-purple-500 hover:bg-purple-600 disabled:opacity-50 text-white font-bold py-2 px-4 rounded-full flex items-center shadow-md"
          >
            <FaPlus className="mr-2" /> Add Food
          </motion.button>
        </div>
          <details className="bg-gray-50 rounded-xl p-3">
            <summary className="cursor-pointer font-semibold text-purple-700">
              More details (diet, prep time, allergens, add-ons)
            </summary>
            <div className="mt-3">
              <FoodDetailsFields value={newFood} onChange={setNewFood} disabled={!canManageMenu} />
            </div>
          </details>
        </form>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {foods.length === 0 ? (
            <p className="text-gray-500">No menu items yet.</p>
          ) : (
            foods.map((food) =>
              edit && edit.id === food._id ? (
                <form
                  key={food._id}
                  data-testid="food-edit-form"
                  aria-label={`Edit ${food.name}`}
                  onSubmit={(e) => {
                    e.preventDefault();
                    saveEdit();
                  }}
                  className="md:col-span-3 bg-gray-50 p-4 rounded-2xl shadow-lg space-y-3"
                >
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                    <input
                      type="text"
                      aria-label="Edit name"
                      value={edit.form.name}
                      onChange={(e) => setEdit({ ...edit, form: { ...edit.form, name: e.target.value } })}
                      className="w-full p-2 border rounded"
                    />
                    <input
                      type="text"
                      aria-label="Edit description"
                      value={edit.form.description}
                      onChange={(e) => setEdit({ ...edit, form: { ...edit.form, description: e.target.value } })}
                      className="w-full p-2 border rounded"
                    />
                    <input
                      type="number"
                      step="0.01"
                      min="0.01"
                      aria-label="Edit price"
                      value={edit.form.price}
                      onChange={(e) => setEdit({ ...edit, form: { ...edit.form, price: e.target.value } })}
                      className="w-full p-2 border rounded"
                    />
                    <input
                      type="text"
                      aria-label="Edit image URL"
                      value={edit.form.image}
                      onChange={(e) => setEdit({ ...edit, form: { ...edit.form, image: e.target.value } })}
                      className="w-full p-2 border rounded"
                    />
                  </div>
                  <FoodDetailsFields
                    value={edit.form}
                    onChange={(form) => setEdit({ ...edit, form })}
                  />
                  <MenuImageInput
                    foodId={edit.id}
                    disabled={!canManageMenu}
                    onUploaded={(updated) => {
                      setFoods((prev) => prev.map((f) => (f._id === updated._id ? updated : f)));
                      setEdit((cur) => (cur ? { ...cur, form: { ...cur.form, image: updated.image || "" } } : cur));
                    }}
                  />
                  {edit.error && (
                    <p role="alert" className="text-sm text-red-600">
                      {edit.error}
                    </p>
                  )}
                  <div className="flex gap-2 justify-end">
                    <button
                      type="button"
                      onClick={() => setEdit(null)}
                      className="bg-gray-200 hover:bg-gray-300 text-gray-800 font-semibold py-2 px-4 rounded-full"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="bg-purple-500 hover:bg-purple-600 text-white font-semibold py-2 px-4 rounded-full"
                    >
                      Save changes
                    </button>
                  </div>
                </form>
              ) : (
              <motion.div
                key={food._id}
                whileHover={{ scale: 1.03, rotate: 1 }}
                className="bg-gray-50 p-4 rounded-2xl shadow-lg flex justify-between items-center gap-2"
              >
                <div>
                  {food.image && (
                    <img src={assetUrl(food.image)} alt="" className="w-20 h-20 object-cover rounded mb-2" />
                  )}
                  <h3 className="font-bold text-purple-700">{food.name}</h3>
                  <p className="text-gray-500 text-sm">{food.description}</p>
                  <p className="font-bold text-green-600">₹{food.price}</p>
                  <p className="text-xs text-gray-400 mt-1">
                    {food.category}
                    {food.dietary ? ` · ${food.dietary}` : ""}
                    {food.featured ? " · featured" : ""}
                    {Array.isArray(food.allergens) && food.allergens.length > 0
                      ? ` · allergens: ${food.allergens.join(", ")}`
                      : ""}
                    {food.available === false ? " · unavailable" : ""}
                    {food.stock !== null && food.stock !== undefined ? ` · stock ${food.stock}` : ""}
                  </p>
                  <p className="text-xs text-gray-500">Served: {servingSummary(food)}</p>
                  {food.subcategory && <p className="text-xs text-gray-500">Sub-category: {food.subcategory}</p>}
                  {food.salePrice != null && (
                    <p className="text-xs text-rose-600">
                      Sale ₹{food.salePrice}
                      {food.saleEndsAt ? ` until ${new Date(food.saleEndsAt).toLocaleString()}` : ""}
                    </p>
                  )}
                  {Array.isArray(food.variants) && food.variants.length > 0 && (
                    <p className="text-xs text-gray-600">
                      Sizes: {food.variants.map((x) => `${x.label} ₹${x.price}`).join(" · ")}
                    </p>
                  )}
                  {food.soldOutUntil && new Date(food.soldOutUntil) > new Date() && (
                    <p className="text-xs font-semibold text-red-600">
                      Sold out until {new Date(food.soldOutUntil).toLocaleString()}
                    </p>
                  )}
                </div>
                {canManageMenu && (
                  <div className="flex flex-col gap-2 shrink-0">
                    {food.soldOutUntil && new Date(food.soldOutUntil) > new Date() ? (
                      <button
                        type="button"
                        onClick={() => setSoldOut(food, null)}
                        className="bg-green-500 hover:bg-green-600 text-white text-xs px-2 py-1 rounded-full"
                      >
                        Back on menu
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setSoldOut(food, endOfToday())}
                        className="bg-amber-500 hover:bg-amber-600 text-white text-xs px-2 py-1 rounded-full"
                      >
                        Sold out today
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => startEdit(food)}
                      aria-label={`Edit ${food.name}`}
                      className="bg-purple-500 hover:bg-purple-600 text-white p-2 rounded-full"
                    >
                      <FaEdit />
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteFood(food._id)}
                      aria-label={`Delete ${food.name}`}
                      className="bg-red-500 hover:bg-red-600 text-white p-2 rounded-full"
                    >
                      <FaTrash />
                    </button>
                  </div>
                )}
              </motion.div>
              )
            )
          )}
        </div>
      </motion.div>

      </>
      )}

      {/* ===== Order Board ===== */}
      {tab === "orders" && (
      <>
      <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
        <h2 className="text-2xl font-bold text-gray-800">
          Orders ({visibleOrders.length})
        </h2>

        <div className="flex flex-wrap gap-2" data-testid="status-filters">
          {FILTERS.map((f) => {
            const count =
              f.key === "all" ? orders.length : orders.filter((o) => o.status === f.key).length;
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                data-testid={`filter-${f.key}`}
                aria-pressed={filter === f.key}
                className={`px-3 py-1 rounded-full text-sm font-semibold shadow ${
                  filter === f.key
                    ? "bg-purple-600 text-white"
                    : "bg-white text-gray-600 hover:bg-purple-50"
                }`}
              >
                {f.label} ({count})
              </button>
            );
          })}
        </div>
      </div>

      {loading ? (
        <p className="text-gray-500">Loading orders...</p>
      ) : visibleOrders.length === 0 ? (
        <p className="text-gray-500">
          {orders.length === 0 ? "No orders yet." : `No ${filter} orders.`}
        </p>
      ) : (
        <div className="space-y-6">
          {visibleOrders.map((order) => (
            <motion.div
              key={order._id}
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              data-testid="admin-order-card"
              data-order-id={order._id}
              className={`bg-white p-6 rounded-3xl shadow-2xl border-l-8 border-purple-500 ${
                newArrivals.includes(order._id) ? "ring-4 ring-orange-400" : ""
              }`}
            >
              <div className="flex justify-between mb-2 gap-4">
                <span className="font-bold text-purple-700 break-all">
                  Order ID: {order._id}
                </span>
                <span
                  data-testid="admin-order-status"
                  className={`font-semibold ${statusTone(order.status)} flex items-center shrink-0`}
                >
                  {(order.status === "Pending" ||
                    order.status === "Accepted" ||
                    order.status === "Preparing") && (
                    <FaSpinner className="animate-spin mr-1" />
                  )}
                  {order.status === "Completed" && <FaCheck className="mr-1" />}
                  {order.status}
                </span>
              </div>

              <p className="text-gray-500 text-sm mb-2">
                Student: {order.student?.name || "Unknown"}
                {order.student?.email ? ` (${order.student.email})` : ""}
              </p>

              {order.notes && (
                <p className="text-sm text-yellow-900 bg-yellow-50 border border-yellow-300 rounded p-2 mb-2">
                  <span className="font-bold">Note:</span> {order.notes}
                </p>
              )}

              {(order.items || []).map((item, i) => (
                <div key={`${item.food}-${i}`} className="flex justify-between text-gray-700 text-sm mb-1">
                  <span>
                    <span className="font-bold text-purple-700 mr-2">{item.quantity}×</span>
                    {item.name}
                  </span>
                  <span>₹{item.price * item.quantity}</span>
                </div>
              ))}

              <div className="flex justify-between font-bold text-purple-700 mt-2">
                <span>Total:</span>
                <span>₹{order.total}</span>
              </div>

              {order.allowedTransitions?.length ? (
                <div className="mt-4 flex flex-wrap gap-3">
                  {order.allowedTransitions.map((next) => (
                    <motion.button
                      key={next}
                      type="button"
                      data-testid={`status-${next}`}
                      whileHover={{ scale: 1.05 }}
                      className={`flex items-center ${ACTION_STYLE[next] || "bg-purple-500"} text-white font-bold py-1 px-3 rounded-full shadow-md`}
                      onClick={() => updateStatus(order._id, next)}
                    >
                      {next === "Completed" && <FaCheck className="mr-2" />}
                      {next === "Preparing" && <FaSpinner className="mr-2 animate-spin" />}
                      {(next === "Cancelled" || next === "Rejected") && <FaTimes className="mr-2" />}
                      {next}
                    </motion.button>
                  ))}
                </div>
              ) : (
                <p className="mt-4 text-sm text-gray-500">
                  This order is {order.status.toLowerCase()} and can no longer be changed.
                </p>
              )}
            </motion.div>
          ))}
        </div>
      )}
      </>
      )}
    </div>
  );
}
