import React, { useEffect, useState } from "react";
import api from "../api";
import { formatMoney } from "../lib/cart";

/**
 * The first thing an administrator sees: today's sales and what is in the
 * queue right now. Counts come from the order list already on the dashboard.
 */
export default function OverviewPanel({ orders = [], onGoTo }) {
  const [today, setToday] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    api
      .get("/analytics/summary", { params: { from: key, to: key } })
      .then((res) => setToday(res.data))
      .catch((err) => setError(err.message || "Could not load today's figures"));
  }, []);

  const count = (status) => orders.filter((o) => o.status === status).length;
  const open = orders.filter((o) => ["Pending", "Accepted", "Preparing", "Ready"].includes(o.status)).length;

  const tiles = [
    { label: "Open orders", value: open, testId: "ov-open" },
    { label: "Waiting to accept", value: count("Pending"), testId: "ov-pending" },
    { label: "Preparing", value: count("Preparing"), testId: "ov-preparing" },
    { label: "Ready for pickup", value: count("Ready"), testId: "ov-ready" },
  ];

  return (
    <section data-testid="overview-panel" className="bg-white p-6 rounded-3xl shadow-2xl mb-8 space-y-4">
      <h2 className="text-2xl font-bold text-gray-800">Today</h2>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {tiles.map((t) => (
          <div key={t.label} className="bg-gray-50 rounded-2xl p-4 shadow-inner" data-testid={t.testId}>
            <p className="text-xs uppercase tracking-wide text-gray-500">{t.label}</p>
            <p className="text-2xl font-extrabold text-gray-800">{t.value}</p>
          </div>
        ))}
      </div>
      {today && (
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-purple-50 rounded-2xl p-4" data-testid="ov-today-sales">
            <p className="text-xs uppercase tracking-wide text-gray-500">Sales today</p>
            <p className="text-2xl font-extrabold text-purple-800">{today.todaySales}</p>
          </div>
          <div className="bg-purple-50 rounded-2xl p-4" data-testid="ov-today-revenue">
            <p className="text-xs uppercase tracking-wide text-gray-500">Revenue today</p>
            <p className="text-2xl font-extrabold text-purple-800">{formatMoney(today.todayRevenue)}</p>
          </div>
        </div>
      )}
      {onGoTo && (
        <div className="flex flex-wrap gap-2 text-sm">
          <button type="button" onClick={() => onGoTo("orders")} className="bg-white border rounded-full px-3 py-1 hover:bg-purple-50">Go to orders</button>
          <button type="button" onClick={() => onGoTo("analytics")} className="bg-white border rounded-full px-3 py-1 hover:bg-purple-50">Open analytics</button>
        </div>
      )}
    </section>
  );
}
