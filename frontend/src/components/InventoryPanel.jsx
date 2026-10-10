import React, { useEffect, useState, useCallback } from "react";
import { motion } from "framer-motion";
import { FaSyncAlt, FaHistory, FaExclamationTriangle } from "react-icons/fa";
import api from "../api";
import { createRealtimeClient } from "../realtime";

/**
 * Administrator inventory console.
 *
 * ADMINISTRATOR ONLY. The server enforces that; these controls are hidden
 * because they are not useful here, not because they are the security boundary.
 */

const STATE_FILTERS = [
  { key: "all", label: "All" },
  { key: "tracked", label: "Tracked" },
  { key: "untracked", label: "Untracked" },
  { key: "low", label: "Low stock" },
  { key: "out", label: "Out of stock" },
  { key: "ok", label: "Healthy" },
];

export default function InventoryPanel() {
  const [items, setItems] = useState([]);
  const [alerts, setAlerts] = useState(null);
  const [categories, setCategories] = useState([]);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [state, setState] = useState("all");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState(null);

  // Per-item adjustment draft.
  const [adjust, setAdjust] = useState({});

  // Movement history drawer.
  const [historyFor, setHistoryFor] = useState(null);
  const [history, setHistory] = useState([]);

  const loadItems = useCallback(async () => {
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (category) params.set("category", category);
    if (state !== "all") params.set("state", state);

    try {
      const res = await api.get(`/inventory?${params.toString()}`);
      setItems(res.data || []);
    } catch (err) {
      setError(err.message || "Could not load inventory");
    } finally {
      setLoading(false);
    }
  }, [search, category, state]);

  const loadAlerts = useCallback(async () => {
    try {
      const res = await api.get("/inventory/low-stock");
      setAlerts(res.data);
    } catch {
      // Alerts are supplementary; a failure must not break the panel.
    }
  }, []);

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  useEffect(() => {
    loadAlerts();
    api.get("/food/categories").then((r) => setCategories(r.data || [])).catch(() => {});
  }, [loadAlerts]);

  // Real-time stock notifications -> re-read authoritative state.
  useEffect(() => {
    const client = createRealtimeClient({
      onInventoryChanged: () => {
        loadItems();
        loadAlerts();
      },
    });
    client.subscribeToCanteen();
    return () => client.close();
  }, [loadItems, loadAlerts]);

  const refreshAll = async () => {
    setLoading(true);
    await Promise.all([loadItems(), loadAlerts()]);
  };

  const flash = (message) => {
    setNotice(message);
    setTimeout(() => setNotice(""), 4000);
  };

  const enableTracking = async (item, enabled) => {
    setError("");
    setBusyId(item._id);

    let stock;
    if (enabled) {
      const raw = window.prompt(
        `Starting stock for "${item.name}" (in ${item.unit || "servings"}):`,
        String(item.stock ?? 0)
      );
      if (raw === null) { setBusyId(null); return; }
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 0) {
        setError("Starting stock must be a whole number of zero or more");
        setBusyId(null);
        return;
      }
      stock = parsed;
    }

    try {
      await api.post(`/inventory/${item._id}/tracking`, {
        enabled,
        ...(stock !== undefined ? { stock } : {}),
      });
      flash(enabled ? `Inventory tracking enabled for ${item.name}` : `Tracking disabled for ${item.name}`);
      await refreshAll();
    } catch (err) {
      setError(err.message || "Could not change tracking");
    } finally {
      setBusyId(null);
    }
  };

  const applyAdjustment = async (item) => {
    setError("");
    const draft = adjust[item._id];
    if (!draft || draft.value === undefined || draft.value === "") {
      setError("Enter an adjustment amount first");
      return;
    }

    const value = Number(draft.value);
    if (!Number.isInteger(value) || value === 0) {
      setError("Adjustment must be a non-zero whole number");
      return;
    }
    if (!draft.reason || !draft.reason.trim()) {
      setError("A reason is required for every stock adjustment");
      return;
    }

    setBusyId(item._id);
    try {
      await api.post(`/inventory/${item._id}/adjust`, {
        delta: value,
        reason: draft.reason.trim(),
      });
      setAdjust((prev) => ({ ...prev, [item._id]: { value: "", reason: "" } }));
      flash(`Stock adjusted for ${item.name}`);
      await refreshAll();
    } catch (err) {
      setError(err.message || "Could not adjust stock");
    } finally {
      setBusyId(null);
    }
  };

  const toggleAvailability = async (item) => {
    setError("");
    setBusyId(item._id);
    try {
      await api.post(`/inventory/${item._id}/availability`, {
        available: item.available === false,
      });
      await refreshAll();
    } catch (err) {
      setError(err.message || "Could not change availability");
    } finally {
      setBusyId(null);
    }
  };

  const openHistory = async (item) => {
    setHistoryFor(item);
    setHistory([]);
    try {
      const res = await api.get(`/inventory/${item._id}/movements`);
      setHistory(res.data || []);
    } catch (err) {
      setError(err.message || "Could not load movement history");
    }
  };

  const ackAlerts = async () => {
    setError("");
    try {
      await api.post("/inventory/low-stock/ack", {});
      await loadAlerts();
      flash("Low-stock alerts acknowledged");
    } catch (err) {
      setError(err.message || "Could not acknowledge alerts");
    }
  };

  return (
    <div className="bg-white p-6 rounded-3xl shadow-2xl mb-8" data-testid="inventory-panel">
      <div className="flex justify-between items-center flex-wrap gap-3 mb-4">
        <h2 className="text-2xl font-bold text-gray-800">Inventory</h2>
        <button
          type="button"
          onClick={refreshAll}
          data-testid="inventory-refresh"
          className="flex items-center bg-purple-100 hover:bg-purple-200 text-purple-700 px-4 py-2 rounded-full font-semibold"
        >
          <FaSyncAlt className="mr-2" /> Refresh
        </button>
      </div>

      {error && (
        <p role="alert" data-testid="inventory-error" className="mb-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded p-2">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" data-testid="inventory-notice" className="mb-3 text-sm text-green-700 bg-green-50 border border-green-200 rounded p-2">
          {notice}
        </p>
      )}

      {/* Low-stock alerts */}
      {alerts && alerts.counts.total > 0 && (
        <div
          className={`mb-4 rounded-xl p-3 border-2 ${
            alerts.counts.outOfStock > 0
              ? "bg-red-50 border-red-400"
              : "bg-yellow-50 border-yellow-400"
          }`}
          data-testid="low-stock-alerts"
          role="status"
        >
          <div className="flex justify-between items-center flex-wrap gap-2">
            <p className="font-semibold flex items-center text-gray-800">
              <FaExclamationTriangle className="mr-2 text-yellow-600" />
              {alerts.counts.outOfStock > 0
                ? `${alerts.counts.outOfStock} out of stock, ${alerts.counts.low} low`
                : `${alerts.counts.low} item(s) at or below threshold`}
              {alerts.counts.unacknowledged > 0 && (
                <span className="ml-2 text-xs bg-red-600 text-white px-2 py-0.5 rounded-full">
                  {alerts.counts.unacknowledged} new
                </span>
              )}
            </p>
            {alerts.counts.unacknowledged > 0 && (
              <button
                type="button"
                onClick={ackAlerts}
                data-testid="ack-alerts"
                className="text-sm font-semibold text-purple-700 underline"
              >
                Acknowledge
              </button>
            )}
          </div>
          <ul className="mt-2 text-sm text-gray-700 space-y-0.5">
            {alerts.alerts.slice(0, 5).map((a) => (
              <li key={a._id}>
                <span className="font-medium">{a.name}</span> — {a.availableQty}{" "}
                {a.unit || "servings"} available
                {a.outOfStock && <span className="ml-2 text-red-600 font-semibold">out of stock</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-4">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search items"
          aria-label="Search inventory"
          data-testid="inventory-search"
          className="p-2 border rounded flex-1 min-w-[160px]"
        />
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          aria-label="Filter by category"
          data-testid="inventory-category"
          className="p-2 border rounded"
        >
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <div className="flex flex-wrap gap-1" data-testid="inventory-state-filters">
          {STATE_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setState(f.key)}
              data-testid={`inv-state-${f.key}`}
              aria-pressed={state === f.key}
              className={`px-3 py-1 rounded-full text-sm font-semibold ${
                state === f.key ? "bg-purple-600 text-white" : "bg-purple-50 text-purple-700"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <p className="text-gray-500" data-testid="inventory-loading">Loading inventory...</p>
      ) : items.length === 0 ? (
        <p className="text-gray-500">No items match these filters.</p>
      ) : (
        <div className="space-y-3">
          {items.map((item) => {
            const tracked = item.trackInventory === true;
            const busy = busyId === item._id;
            const draft = adjust[item._id] || { value: "", reason: "" };

            return (
              <motion.div
                key={item._id}
                layout
                data-testid="inventory-row"
                data-food-id={item._id}
                data-available={item.availableQty ?? ""}
                className={`border rounded-2xl p-4 ${
                  item.outOfStock
                    ? "border-red-300 bg-red-50"
                    : item.lowStock
                    ? "border-yellow-300 bg-yellow-50"
                    : "border-gray-200"
                }`}
              >
                <div className="flex justify-between items-start gap-3 flex-wrap">
                  <div className="min-w-[180px]">
                    <p className="font-bold text-purple-800">{item.name}</p>
                    <p className="text-xs text-gray-500">
                      {item.category} · ₹{item.price}
                      {item.available === false && (
                        <span className="ml-2 text-red-600 font-semibold">manually hidden</span>
                      )}
                    </p>
                    <div className="mt-1 flex flex-wrap gap-2 text-xs">
                      <span
                        className={`px-2 py-0.5 rounded-full font-semibold ${
                          tracked ? "bg-purple-100 text-purple-700" : "bg-gray-100 text-gray-500"
                        }`}
                        data-testid={`tracking-${item._id}`}
                      >
                        {tracked ? "Tracked" : "Untracked"}
                      </span>
                      {tracked && (
                        <>
                          <span className="px-2 py-0.5 rounded-full bg-white border">
                            Stock <span data-testid={`stock-${item._id}`}>{item.stock}</span>
                          </span>
                          <span className="px-2 py-0.5 rounded-full bg-white border">
                            Reserved <span data-testid={`reserved-${item._id}`}>{item.reserved}</span>
                          </span>
                          <span
                            className={`px-2 py-0.5 rounded-full font-semibold ${
                              item.outOfStock
                                ? "bg-red-600 text-white"
                                : item.lowStock
                                ? "bg-yellow-500 text-white"
                                : "bg-green-100 text-green-700"
                            }`}
                            data-testid={`available-${item._id}`}
                          >
                            {item.outOfStock ? "Out of stock" : `${item.availableQty} available`}
                          </span>
                        </>
                      )}
                    </div>
                    {item.lastStockAdjustmentAt && (
                      <p className="text-[11px] text-gray-400 mt-1">
                        Last adjusted {new Date(item.lastStockAdjustmentAt).toLocaleString()}
                        {item.lastStockAdjustmentReason ? ` — ${item.lastStockAdjustmentReason}` : ""}
                      </p>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-2 items-start">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => enableTracking(item, !tracked)}
                      data-testid={`toggle-tracking-${item._id}`}
                      className="px-3 py-1 rounded-full text-sm font-semibold bg-purple-100 text-purple-700 disabled:opacity-50"
                    >
                      {tracked ? "Disable tracking" : "Enable tracking"}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => toggleAvailability(item)}
                      data-testid={`toggle-availability-${item._id}`}
                      className="px-3 py-1 rounded-full text-sm font-semibold bg-gray-100 text-gray-700 disabled:opacity-50"
                    >
                      {item.available === false ? "Show on menu" : "Mark sold out"}
                    </button>
                    {tracked && (
                      <button
                        type="button"
                        onClick={() => openHistory(item)}
                        data-testid={`history-${item._id}`}
                        className="px-3 py-1 rounded-full text-sm font-semibold bg-indigo-100 text-indigo-700"
                      >
                        <FaHistory className="mr-1" /> History
                      </button>
                    )}
                  </div>
                </div>

                {tracked && (
                  <div className="flex flex-wrap gap-2 mt-3 items-end">
                    <label className="text-xs text-gray-600">
                      Adjust
                      <input
                        type="number"
                        step="1"
                        value={draft.value}
                        onChange={(e) =>
                          setAdjust((p) => ({ ...p, [item._id]: { ...draft, value: e.target.value } }))
                        }
                        data-testid={`adjust-value-${item._id}`}
                        className="block p-2 border rounded w-28 mt-1"
                      />
                    </label>
                    <label className="text-xs text-gray-600 flex-1 min-w-[180px]">
                      Reason (required)
                      <input
                        type="text"
                        value={draft.reason}
                        onChange={(e) =>
                          setAdjust((p) => ({ ...p, [item._id]: { ...draft, reason: e.target.value } }))
                        }
                        data-testid={`adjust-reason-${item._id}`}
                        placeholder="e.g. Supplier delivery"
                        className="block p-2 border rounded w-full mt-1"
                      />
                    </label>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => applyAdjustment(item)}
                      data-testid={`apply-adjust-${item._id}`}
                      className="px-4 py-2 rounded-full text-sm font-semibold bg-purple-600 text-white disabled:opacity-50"
                    >
                      Apply
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        api
                          .post(`/inventory/${item._id}/adjust`, {
                            set: (item.stock ?? 0) + 1,
                            reason: draft.reason.trim() || "Quick +1",
                          })
                          .then(() => refreshAll())
                          .catch((err) => setError(err.message))
                      }
                      data-testid={`add-one-${item._id}`}
                      className="px-3 py-2 rounded-full text-sm font-semibold bg-green-100 text-green-700 disabled:opacity-50"
                    >
                      +1
                    </button>
                  </div>
                )}
              </motion.div>
            );
          })}
        </div>
      )}

      {/* Movement history drawer */}
      {historyFor && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[80vh] overflow-auto p-6">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-xl font-bold text-purple-800">
                Movement history — {historyFor.name}
              </h3>
              <button
                type="button"
                onClick={() => setHistoryFor(null)}
                data-testid="close-history"
                className="text-gray-500 hover:text-gray-800 font-bold px-2"
              >
                ✕
              </button>
            </div>
            {history.length === 0 ? (
              <p className="text-gray-500">No movements recorded yet.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 border-b">
                    <th className="py-2">When</th>
                    <th>Type</th>
                    <th>Qty</th>
                    <th>Stock Δ</th>
                    <th>Reserved Δ</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody data-testid="movement-rows">
                  {history.map((m) => (
                    <tr key={m._id} className="border-b border-gray-100" data-movement-type={m.type}>
                      <td className="py-2">{new Date(m.at).toLocaleString()}</td>
                      <td>
                        <span className="font-semibold">{m.type}</span>
                      </td>
                      <td>{m.quantity}</td>
                      <td>{m.stockDelta > 0 ? `+${m.stockDelta}` : m.stockDelta}</td>
                      <td>{m.reservedDelta > 0 ? `+${m.reservedDelta}` : m.reservedDelta}</td>
                      <td className="text-gray-600">{m.reason || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}