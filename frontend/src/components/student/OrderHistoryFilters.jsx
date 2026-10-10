import { HISTORY_STATUSES, DEFAULT_HISTORY, datesInOrder } from "../../lib/orderHistory";

/** Filters for the student's own order history: status and date range. */
export default function OrderHistoryFilters({ filters, onChange }) {
  const field = "border border-gray-300 rounded px-2 py-1 text-sm bg-white";
  const badRange = !datesInOrder(filters.from, filters.to);

  return (
    <div className="flex flex-wrap gap-3 items-end mb-4" data-testid="history-filters">
      <label className="flex flex-col text-xs text-gray-600">
        Status
        <select
          data-testid="history-status"
          value={filters.status}
          onChange={(e) => onChange({ ...filters, status: e.target.value })}
          className={field}
        >
          <option value="">All</option>
          {HISTORY_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col text-xs text-gray-600">
        From
        <input
          type="date"
          data-testid="history-from"
          value={filters.from}
          onChange={(e) => onChange({ ...filters, from: e.target.value })}
          className={field}
        />
      </label>
      <label className="flex flex-col text-xs text-gray-600">
        To
        <input
          type="date"
          data-testid="history-to"
          value={filters.to}
          onChange={(e) => onChange({ ...filters, to: e.target.value })}
          className={field}
        />
      </label>
      <button
        type="button"
        data-testid="history-clear"
        onClick={() => onChange({ ...DEFAULT_HISTORY })}
        className="text-sm text-purple-700 underline"
      >
        Clear filters
      </button>
      {badRange && (
        <p role="alert" className="w-full text-sm text-red-600">
          The “from” date must be on or before the “to” date.
        </p>
      )}
    </div>
  );
}
