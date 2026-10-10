import { DIETARY_CHOICES } from "../lib/foodForm";
import { MEAL_PERIOD_CHOICES } from "../lib/mealPeriods";

const field = "w-full p-2 border rounded";

/**
 * Controlled inputs for the menu-item details that students see: category,
 * diet, preparation time, featured flag, ingredients, allergens and add-ons.
 * Used by both the create form and the inline editor in the admin dashboard.
 *
 * `value` is a foodForm model; `onChange` receives the full next model.
 */
export default function FoodDetailsFields({ value, onChange, disabled = false }) {
  const set = (patch) => onChange({ ...value, ...patch });

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3" data-testid="food-details-fields">
      <label className="text-sm text-gray-700">
        Category
        <input
          type="text"
          aria-label="Category"
          maxLength={60}
          placeholder="e.g. Breakfast"
          disabled={disabled}
          value={value.category}
          onChange={(e) => set({ category: e.target.value })}
          className={field}
        />
      </label>

      <label className="text-sm text-gray-700">
        Diet
        <select
          aria-label="Dietary"
          disabled={disabled}
          value={value.dietary}
          onChange={(e) => set({ dietary: e.target.value })}
          className={field}
        >
          {DIETARY_CHOICES.map(([val, label]) => (
            <option key={val || "none"} value={val}>
              {label}
            </option>
          ))}
        </select>
      </label>

      <label className="text-sm text-gray-700">
        Preparation time (minutes)
        <input
          type="number"
          min="0"
          max="240"
          step="1"
          aria-label="Preparation time in minutes"
          disabled={disabled}
          value={value.prepTimeMinutes}
          onChange={(e) => set({ prepTimeMinutes: e.target.value })}
          className={field}
        />
      </label>

      <label className="flex items-center gap-2 text-sm text-gray-700 md:mt-6">
        <input
          type="checkbox"
          aria-label="Featured"
          disabled={disabled}
          checked={value.featured}
          onChange={(e) => set({ featured: e.target.checked })}
        />
        Featured on the menu
      </label>

      <label className="text-sm text-gray-700">
        Ingredients (comma separated)
        <input
          type="text"
          aria-label="Ingredients"
          disabled={disabled}
          value={value.ingredients}
          onChange={(e) => set({ ingredients: e.target.value })}
          placeholder="paneer, tomato, cream"
          className={field}
        />
      </label>

      <label className="text-sm text-gray-700">
        Allergens (comma separated)
        <input
          type="text"
          aria-label="Allergens"
          disabled={disabled}
          value={value.allergens}
          onChange={(e) => set({ allergens: e.target.value })}
          placeholder="milk, gluten, nuts"
          className={field}
        />
      </label>

      <label className="text-sm text-gray-700 md:col-span-2">
        Add-ons (name:price, separated by semicolons)
        <input
          type="text"
          aria-label="Add-ons"
          disabled={disabled}
          value={value.addOns}
          onChange={(e) => set({ addOns: e.target.value })}
          placeholder="Extra cheese:20; Less spicy:0"
          className={field}
        />
      </label>

      <label className="text-sm text-gray-700">
        Sub-category
        <input
          type="text"
          aria-label="Subcategory"
          maxLength={60}
          disabled={disabled}
          placeholder="e.g. Hot, Cold"
          value={value.subcategory}
          onChange={(e) => set({ subcategory: e.target.value })}
          className={field}
        />
      </label>

      <label className="text-sm text-gray-700">
        Tags (comma separated)
        <input
          type="text"
          aria-label="Tags"
          disabled={disabled}
          placeholder="spicy, kids, chef's pick"
          value={value.tags}
          onChange={(e) => set({ tags: e.target.value })}
          className={field}
        />
      </label>

      <fieldset className="text-sm text-gray-700 md:col-span-2" aria-label="Meal periods">
        <legend className="mb-1">Served at (leave all unticked for all day)</legend>
        <div className="flex flex-wrap gap-4">
          {MEAL_PERIOD_CHOICES.map(([key, label]) => (
            <label key={key} className="flex items-center gap-2">
              <input
                type="checkbox"
                aria-label={`Serve at ${label}`}
                disabled={disabled}
                checked={value.menuPeriods.includes(key)}
                onChange={(e) =>
                  set({
                    menuPeriods: e.target.checked
                      ? [...value.menuPeriods, key]
                      : value.menuPeriods.filter((p) => p !== key),
                  })
                }
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>

      <label className="text-sm text-gray-700">
        Available from (optional)
        <input
          type="datetime-local"
          aria-label="Serves from"
          disabled={disabled}
          value={value.servesFrom}
          onChange={(e) => set({ servesFrom: e.target.value })}
          className={field}
        />
      </label>

      <label className="text-sm text-gray-700">
        Available until (optional)
        <input
          type="datetime-local"
          aria-label="Serves until"
          disabled={disabled}
          value={value.servesUntil}
          onChange={(e) => set({ servesUntil: e.target.value })}
          className={field}
        />
      </label>

      <label className="text-sm text-gray-700">
        Sold out until (temporary; clears itself)
        <input
          type="datetime-local"
          aria-label="Sold out until"
          disabled={disabled}
          value={value.soldOutUntil}
          onChange={(e) => set({ soldOutUntil: e.target.value })}
          className={field}
        />
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className="text-sm text-gray-700">
          Sale price
          <input
            type="number"
            step="0.01"
            min="0.01"
            aria-label="Sale price"
            disabled={disabled}
            value={value.salePrice}
            onChange={(e) => set({ salePrice: e.target.value })}
            className={field}
          />
        </label>
        <label className="text-sm text-gray-700">
          Sale ends
          <input
            type="datetime-local"
            aria-label="Sale ends"
            disabled={disabled}
            value={value.saleEndsAt}
            onChange={(e) => set({ saleEndsAt: e.target.value })}
            className={field}
          />
        </label>
      </div>

      <label className="text-sm text-gray-700 md:col-span-2">
        Sizes with prices (name:price, separated by semicolons; a sale applies to every size)
        <input
          type="text"
          aria-label="Sizes"
          disabled={disabled}
          value={value.variants}
          onChange={(e) => set({ variants: e.target.value })}
          placeholder="Half:40; Full:60"
          className={field}
        />
      </label>
    </div>
  );
}
