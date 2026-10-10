import React, { useEffect, useState } from "react";
import api from "../api";
import { formatMoney } from "../lib/cart";

const EMPTY = { code: "", type: "percent", value: "", minSubtotal: "", maxDiscount: "", expiresAt: "", usageLimit: "" };

function describe(c) {
  return c.type === "percent" ? `${c.value}% off` : `${formatMoney(c.value)} off`;
}

/** Coupon management (Phase 2 section 6). Uses the existing /api/coupons routes. */
export default function CouponPanel() {
  const [coupons, setCoupons] = useState([]);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let alive = true;
    api
      .get("/coupons")
      .then((res) => {
        if (alive) setCoupons(res.data || []);
      })
      .catch((err) => {
        if (alive) setError(err.message || "Could not load coupons");
      });
    return () => {
      alive = false;
    };
  }, []);

  const create = async (e) => {
    e.preventDefault();
    setError("");
    setNotice("");
    const body = {
      code: form.code.trim(),
      type: form.type,
      value: form.value,
      minSubtotal: form.minSubtotal === "" ? 0 : form.minSubtotal,
      maxDiscount: form.maxDiscount === "" ? null : form.maxDiscount,
      expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null,
      usageLimit: form.usageLimit === "" ? null : form.usageLimit,
      active: true,
    };
    try {
      const res = await api.post("/coupons", body);
      setCoupons((prev) => [res.data, ...prev]);
      setForm(EMPTY);
      setNotice(`Created ${res.data.code}`);
    } catch (err) {
      setError(err.message || "Could not create coupon");
    }
  };

  const patch = async (id, changes, done) => {
    setError("");
    try {
      const res = await api.patch(`/coupons/${id}`, changes);
      setCoupons((prev) => prev.map((c) => (c._id === id ? res.data : c)));
      if (done) setNotice(done);
    } catch (err) {
      setError(err.message || "Could not update coupon");
    }
  };

  return (
    <section data-testid="coupon-panel" className="bg-white p-6 rounded-3xl shadow-2xl mb-8 space-y-4">
      <h2 className="text-2xl font-bold text-gray-800">Coupons</h2>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {notice && <p role="status" className="text-sm text-green-700">{notice}</p>}

      <form onSubmit={create} className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm" aria-label="New coupon">
        <input aria-label="Coupon code" placeholder="CODE" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} className="border rounded p-2" />
        <select aria-label="Coupon type" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className="border rounded p-2">
          <option value="percent">Percent off</option>
          <option value="flat">Flat amount off</option>
        </select>
        <input aria-label="Coupon value" type="number" min="0.01" step="0.01" placeholder="Value" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} className="border rounded p-2" />
        <input aria-label="Minimum subtotal" type="number" min="0" step="0.01" placeholder="Min subtotal" value={form.minSubtotal} onChange={(e) => setForm({ ...form, minSubtotal: e.target.value })} className="border rounded p-2" />
        <input aria-label="Maximum discount" type="number" min="0.01" step="0.01" placeholder="Max discount (optional)" value={form.maxDiscount} onChange={(e) => setForm({ ...form, maxDiscount: e.target.value })} className="border rounded p-2" />
        <input aria-label="Expires at" type="datetime-local" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} className="border rounded p-2" />
        <input aria-label="Usage limit" type="number" min="1" placeholder="Usage limit (optional)" value={form.usageLimit} onChange={(e) => setForm({ ...form, usageLimit: e.target.value })} className="border rounded p-2" />
        <button type="submit" className="bg-purple-500 hover:bg-purple-600 text-white font-semibold rounded-full px-4 py-2">Add coupon</button>
      </form>

      <ul className="divide-y" data-testid="coupon-list">
        {coupons.length === 0 && <li className="py-2 text-sm text-gray-500">No coupons yet.</li>}
        {coupons.map((c) => (
          <li key={c._id} className="py-3 flex flex-wrap items-center justify-between gap-2 text-sm">
            <div>
              <span className="font-bold text-purple-700">{c.code}</span> · {describe(c)}
              {c.minSubtotal > 0 && <span className="text-gray-500"> · min {formatMoney(c.minSubtotal)}</span>}
              {c.maxDiscount && <span className="text-gray-500"> · up to {formatMoney(c.maxDiscount)}</span>}
              <span className="text-gray-500">
                {" "}· used {c.usedCount ?? 0}
                {c.usageLimit ? ` of ${c.usageLimit}` : ""}
              </span>
              {c.expiresAt && <span className="text-gray-500"> · expires {new Date(c.expiresAt).toLocaleString()}</span>}
              <span className={`ml-2 text-xs font-semibold ${c.active ? "text-green-700" : "text-gray-500"}`}>
                {c.active ? "Active" : "Inactive"}
              </span>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => patch(c._id, { active: !c.active }, c.active ? `Deactivated ${c.code}` : `Activated ${c.code}`)}
                className="bg-white border border-gray-300 hover:bg-gray-50 rounded-full px-3 py-1"
              >
                {c.active ? "Deactivate" : "Activate"}
              </button>
              <button
                type="button"
                onClick={() => {
                  const raw = window.prompt(`New usage limit for ${c.code} (blank for no limit):`, c.usageLimit ?? "");
                  if (raw === null) return;
                  const trimmed = raw.trim();
                  patch(c._id, { usageLimit: trimmed === "" ? null : Number(trimmed) }, `Updated limit for ${c.code}`);
                }}
                className="bg-white border border-gray-300 hover:bg-gray-50 rounded-full px-3 py-1"
              >
                Usage limit
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
