import React, { useCallback, useEffect, useState } from "react";
import api from "../api";
import { saveBlob } from "../lib/download";
import { formatMoney } from "../lib/cart";
import { defaultRange, rangeProblem, barPercents, hourLabel } from "../lib/analytics";

const GRANULARITY = [
  ["daily", "Daily"],
  ["weekly", "Weekly"],
  ["monthly", "Monthly"],
];

function Kpi({ label, value, testId }) {
  return (
    <div className="bg-gray-50 rounded-2xl p-4 shadow-inner" data-testid={testId}>
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className="text-2xl font-extrabold text-gray-800">{value}</p>
    </div>
  );
}

/**
 * Sales analytics for administrators (Phase 2 section 5). Every figure comes
 * from the server. Refunds are shown only as recorded; nothing is inferred.
 */
export default function AnalyticsPanel() {
  const [range, setRange] = useState(defaultRange);
  const [granularity, setGranularity] = useState("daily");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const problem = rangeProblem(range);

  const load = useCallback(async () => {
    if (rangeProblem(range)) return;
    setLoading(true);
    setError("");
    try {
      const params = { from: range.from, to: range.to };
      const [summary, revenue, items, hours] = await Promise.all([
        api.get("/analytics/summary", { params }),
        api.get("/analytics/revenue", { params: { ...params, granularity } }),
        api.get("/analytics/items", { params: { ...params, limit: 5 } }),
        api.get("/analytics/peak-hours", { params }),
      ]);
      setData({
        summary: summary.data,
        buckets: revenue.data.buckets,
        popular: items.data.popular,
        leastPopular: items.data.leastPopular,
        hours: hours.data.hours,
      });
    } catch (err) {
      setError(err.message || "Could not load analytics");
    } finally {
      setLoading(false);
    }
  }, [range, granularity]);

  useEffect(() => {
    // Fetching on mount and when the range changes is the intended use here;
    // load() sets its loading flag synchronously before the request starts.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const downloadCsv = async (type) => {
    setError("");
    try {
      const res = await api.get("/analytics/export.csv", {
        params: { from: range.from, to: range.to, type },
        responseType: "blob",
      });
      saveBlob(`sales-${type}-${range.from}-to-${range.to}.csv`, res.data);
    } catch (err) {
      setError(err.message || "Export failed");
    }
  };

  const bucketBars = data ? barPercents(data.buckets.map((b) => b.revenue)) : [];
  const hourBars = data ? barPercents(data.hours.map((h) => h.sales)) : [];
  const s = data?.summary;

  return (
    <section data-testid="analytics-panel" className="bg-white p-6 rounded-3xl shadow-2xl mb-8 space-y-6">
      <div className="flex flex-wrap items-end gap-3 justify-between">
        <h2 className="text-2xl font-bold text-gray-800">Analytics</h2>
        <div className="flex flex-wrap items-end gap-2 text-sm">
          <label className="flex flex-col">
            From
            <input
              type="date"
              aria-label="From date"
              value={range.from}
              onChange={(e) => setRange({ ...range, from: e.target.value })}
              className="border rounded p-1"
            />
          </label>
          <label className="flex flex-col">
            To
            <input
              type="date"
              aria-label="To date"
              value={range.to}
              onChange={(e) => setRange({ ...range, to: e.target.value })}
              className="border rounded p-1"
            />
          </label>
          <label className="flex flex-col">
            Group by
            <select
              aria-label="Group by"
              value={granularity}
              onChange={(e) => setGranularity(e.target.value)}
              className="border rounded p-1"
            >
              {GRANULARITY.map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => downloadCsv("orders")}
            disabled={Boolean(problem)}
            className="bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white px-3 py-2 rounded-full font-semibold"
          >
            Orders CSV
          </button>
          <button
            type="button"
            onClick={() => downloadCsv("items")}
            disabled={Boolean(problem)}
            className="bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white px-3 py-2 rounded-full font-semibold"
          >
            Items CSV
          </button>
        </div>
      </div>

      {problem && <p role="alert" className="text-sm text-red-600">{problem}</p>}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {loading && <p className="text-sm text-gray-500">Loading...</p>}

      {s && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Kpi label="Sales" value={s.sales} testId="kpi-sales" />
            <Kpi label="Revenue" value={formatMoney(s.revenue)} testId="kpi-revenue" />
            <Kpi label="Average order" value={formatMoney(s.averageOrderValue)} testId="kpi-average" />
            <Kpi label="Completed" value={s.completed} testId="kpi-completed" />
            <Kpi label="Today: sales" value={s.todaySales} testId="kpi-today-sales" />
            <Kpi label="Today: revenue" value={formatMoney(s.todayRevenue)} testId="kpi-today-revenue" />
            <Kpi label="Cancelled" value={s.cancelled} testId="kpi-cancelled" />
            <Kpi label="Rejected" value={s.rejected} testId="kpi-rejected" />
          </div>

          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm" data-testid="refund-summary">
            <p className="font-semibold text-amber-900 mb-1">Refunds</p>
            <p>
              Recorded as refunded: <strong>{s.refunds.recorded.count}</strong> ({formatMoney(s.refunds.recorded.amount)})
            </p>
            <p>
              Cancelled or rejected after payment, awaiting a manual refund:{" "}
              <strong>{s.refunds.awaitingManualRefund.count}</strong> ({formatMoney(s.refunds.awaitingManualRefund.amount)})
            </p>
            <p className="text-xs text-amber-800 mt-1">{s.refunds.note}</p>
          </div>

          <div>
            <h3 className="font-bold text-gray-800 mb-2">Revenue ({granularity})</h3>
            {data.buckets.length === 0 ? (
              <p className="text-sm text-gray-500">No days in this range.</p>
            ) : (
              <table className="w-full text-sm" data-testid="revenue-table">
                <thead>
                  <tr className="text-left text-gray-500">
                    <th className="py-1">Period</th>
                    <th className="py-1">Orders</th>
                    <th className="py-1">Revenue</th>
                    <th className="py-1">Average</th>
                    <th className="py-1 w-1/3">Trend</th>
                  </tr>
                </thead>
                <tbody>
                  {data.buckets.map((b, i) => (
                    <tr key={b.period} className="border-t">
                      <td className="py-1">{b.period}</td>
                      <td className="py-1">{b.orders}</td>
                      <td className="py-1">{formatMoney(b.revenue)}</td>
                      <td className="py-1">{formatMoney(b.averageOrderValue)}</td>
                      <td className="py-1">
                        <div className="h-2 bg-purple-100 rounded">
                          <div className="h-2 bg-purple-500 rounded" style={{ width: `${bucketBars[i]}%` }} />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="grid md:grid-cols-2 gap-6">
            <div>
              <h3 className="font-bold text-gray-800 mb-2">Most popular</h3>
              <ol className="text-sm list-decimal pl-5" data-testid="popular-items">
                {data.popular.length === 0 && <li className="list-none text-gray-500">No sales in this range.</li>}
                {data.popular.map((r) => (
                  <li key={r.foodId}>
                    {r.name} · {r.quantity} sold · {formatMoney(r.revenue)}
                  </li>
                ))}
              </ol>
            </div>
            <div>
              <h3 className="font-bold text-gray-800 mb-2">Least popular</h3>
              <ol className="text-sm list-decimal pl-5" data-testid="least-popular-items">
                {data.leastPopular.map((r) => (
                  <li key={r.foodId}>
                    {r.name} · {r.quantity} sold
                  </li>
                ))}
              </ol>
            </div>
          </div>

          <div>
            <h3 className="font-bold text-gray-800 mb-2">Peak hours (canteen time)</h3>
            <div className="grid grid-cols-12 gap-1 items-end h-32" data-testid="peak-hours">
              {data.hours.map((h, i) => (
                <div key={h.hour} className="flex flex-col items-center justify-end h-full" title={`${hourLabel(h.hour)}: ${h.sales} sales`}>
                  <div className="w-full bg-orange-400 rounded-t" style={{ height: `${hourBars[i]}%` }} />
                  <span className="text-[9px] text-gray-500">{h.hour}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
