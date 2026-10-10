import { useEffect, useState } from "react";
import api from "../../api";

/**
 * Choose a pickup time from the canteen's open slots, or "as soon as ready".
 *
 * `foodIdsKey` is a comma-joined string, not an array: an array prop would be
 * a new object each render and refetch on every render.
 */
export default function PickupSlotPicker({ foodIdsKey, value, onChange }) {
  const [state, setState] = useState({ loading: true, error: "", slots: [], earliest: "" });

  useEffect(() => {
    let active = true;
    const params = foodIdsKey ? { foods: foodIdsKey } : {};
    api
      .get("/orders/slots", { params })
      .then((res) => {
        if (!active) return;
        setState({
          loading: false,
          error: "",
          slots: res.data.slots || [],
          earliest: res.data.earliestReadyAt || "",
        });
      })
      .catch((err) => {
        if (active) setState({ loading: false, error: err.message || "Could not load pickup times", slots: [], earliest: "" });
      });
    return () => {
      active = false;
    };
  }, [foodIdsKey]);

  return (
    <div className="text-sm">
      <label className="block text-xs text-gray-600 mb-1" htmlFor="pickup-slot">
        Pickup time
      </label>
      <select
        id="pickup-slot"
        data-testid="pickup-slot"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={state.loading}
        className="w-full border border-gray-300 rounded px-2 py-1 bg-white"
      >
        <option value="">As soon as ready</option>
        {state.slots.map((s) => {
          // A full slot is shown but cannot be chosen. The server enforces this
          // too, so a slot that fills after this list loaded gets a clear 409.
          const full = s.available === false;
          return (
            <option key={s.at} value={s.at} disabled={full}>
              {full ? `${s.label} (full)` : s.label}
            </option>
          );
        })}
      </select>
      {state.loading && <p className="text-xs text-gray-500 mt-1">Loading pickup times…</p>}
      {state.error && <p className="text-xs text-red-600 mt-1">{state.error}</p>}
      {!state.loading && !state.error && state.earliest && (
        <p className="text-xs text-gray-500 mt-1">
          Earliest ready {new Date(state.earliest).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </p>
      )}
    </div>
  );
}
