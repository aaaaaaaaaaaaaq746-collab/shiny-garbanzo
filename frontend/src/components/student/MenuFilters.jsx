import { DEFAULT_FILTERS, SORT_OPTIONS } from "../../lib/menuFilters";

/** Discovery controls. The filter state and query mapping live in lib/menuFilters. */
export default function MenuFilters({ filters, onChange, categories = [] }) {
  const set = (patch) => onChange({ ...filters, ...patch });
  const field = "border border-gray-300 rounded px-2 py-1 text-sm bg-white";

  return (
    <div
      className="bg-white/80 rounded-2xl shadow p-4 mb-4 flex flex-wrap gap-3 items-end justify-center"
      data-testid="menu-filters"
    >
      <label className="flex flex-col text-xs text-gray-600">
        Search
        <input
          type="search"
          data-testid="menu-search"
          value={filters.search}
          onChange={(e) => set({ search: e.target.value })}
          placeholder="Dosa, tea, spicy"
          className={`${field} w-44`}
        />
      </label>
      <label className="flex flex-col text-xs text-gray-600">
        Category
        <select
          data-testid="menu-category"
          value={filters.category}
          onChange={(e) => set({ category: e.target.value })}
          className={field}
        >
          <option value="">All</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col text-xs text-gray-600">
        Type
        <select data-testid="menu-veg" value={filters.veg} onChange={(e) => set({ veg: e.target.value })} className={field}>
          <option value="">Any</option>
          <option value="veg">Veg</option>
          <option value="nonveg">Non-veg</option>
        </select>
      </label>
      <label className="flex flex-col text-xs text-gray-600">
        Meal
        <select
          data-testid="menu-period"
          aria-label="Meal period"
          value={filters.period || ""}
          onChange={(e) => set({ period: e.target.value })}
          className={field}
        >
          <option value="">Any time</option>
          <option value="breakfast">Breakfast</option>
          <option value="lunch">Lunch</option>
          <option value="snacks">Snacks</option>
          <option value="dinner">Dinner</option>
        </select>
      </label>
      <label className="flex flex-col text-xs text-gray-600">
        Min ₹
        <input
          type="number"
          min="0"
          data-testid="menu-min-price"
          value={filters.minPrice}
          onChange={(e) => set({ minPrice: e.target.value })}
          className={`${field} w-20`}
        />
      </label>
      <label className="flex flex-col text-xs text-gray-600">
        Max ₹
        <input
          type="number"
          min="0"
          data-testid="menu-max-price"
          value={filters.maxPrice}
          onChange={(e) => set({ maxPrice: e.target.value })}
          className={`${field} w-20`}
        />
      </label>
      <label className="flex flex-col text-xs text-gray-600">
        Sort by
        <select data-testid="menu-sort" value={filters.sort} onChange={(e) => set({ sort: e.target.value })} className={field}>
          {SORT_OPTIONS.map(([value, label]) => (
            <option key={value || "default"} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1 text-sm text-gray-700">
        <input type="checkbox" checked={filters.available} onChange={(e) => set({ available: e.target.checked })} />
        Available only
      </label>
      <label className="flex items-center gap-1 text-sm text-gray-700">
        <input type="checkbox" checked={filters.featured} onChange={(e) => set({ featured: e.target.checked })} />
        Featured
      </label>
      <label className="flex items-center gap-1 text-sm text-gray-700">
        <input
          type="checkbox"
          checked={filters.favoritesOnly}
          onChange={(e) => set({ favoritesOnly: e.target.checked })}
        />
        Favorites only
      </label>
      <button type="button" onClick={() => onChange({ ...DEFAULT_FILTERS })} className="text-sm text-purple-700 underline">
        Reset
      </button>
    </div>
  );
}
