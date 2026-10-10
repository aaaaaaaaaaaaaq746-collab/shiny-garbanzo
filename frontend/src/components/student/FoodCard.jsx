import { useState } from "react";
import { motion } from "framer-motion";
import { FaShoppingCart, FaHeart, FaStar } from "react-icons/fa";
import { formatMoney } from "../../lib/cart";
import api from "../../api";

/** Small coloured pill used for category, dietary and badge labels. */
function Pill({ children, className }) {
  return <span className={`px-2 py-0.5 rounded-full text-xs ${className}`}>{children}</span>;
}

/**
 * Written reviews for one item, loaded the first time the student asks. Only
 * the rating, comment and date are shown; the server never sends who wrote them.
 */
function ReviewsToggle({ foodId }) {
  const [open, setOpen] = useState(false);
  const [reviews, setReviews] = useState(null);
  const [error, setError] = useState("");

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && reviews === null) {
      try {
        const res = await api.get(`/reviews/food/${foodId}`);
        setReviews(res.data.reviews || []);
        setError("");
      } catch (err) {
        setError(err.message || "Could not load reviews");
      }
    }
  };

  return (
    <div className="w-full mb-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        data-testid="food-reviews-toggle"
        className="text-xs text-purple-700 underline w-full text-center"
      >
        {open ? "Hide reviews" : "Read reviews"}
      </button>
      {open && (
        <div className="mt-2 space-y-1 text-xs text-gray-600" data-testid="food-reviews">
          {error && (
            <p role="alert" className="text-red-600">
              {error}
            </p>
          )}
          {reviews && reviews.length === 0 && <p>No written reviews yet.</p>}
          {reviews &&
            reviews.slice(0, 5).map((r) => (
              <p key={r.id}>
                <span className="font-semibold text-amber-600">{"★".repeat(r.rating)}</span>
                {r.comment ? ` ${r.comment}` : ""}
              </p>
            ))}
        </div>
      )}
    </div>
  );
}

/**
 * One menu item. Shows availability, badges, prep time, ingredients,
 * allergens and rating, and lets the student pick add-ons and a note before
 * adding to the cart. Stock rules here are advisory; the server checks again.
 */
export default function FoodCard({ food, onAdd, isFavorite, onToggleFavorite, inCart = 0 }) {
  const [customising, setCustomising] = useState(false);
  const [picked, setPicked] = useState([]);
  const [notes, setNotes] = useState("");

  const soldOut = food.available === false || (food.stock !== null && food.stock <= 0);

  // Stock-tracked items publish `availableQty` (physical stock minus what
  // is already reserved). It is advisory: the server revalidates on checkout.
  const tracked = typeof food.availableQty === "number";
  const available = tracked ? food.availableQty : Infinity;
  const remaining = available - inCart;
  const exhausted = !soldOut && remaining <= 0;
  const badges = food.badges || {};
  const addOns = Array.isArray(food.addOns) ? food.addOns : [];
  const ratingCount = food.ratingCount ?? 0;

  const toggleAddOn = (label) =>
    setPicked((prev) => (prev.includes(label) ? prev.filter((l) => l !== label) : [...prev, label]));

  const handleAdd = () =>
    onAdd(food, {
      addOns: addOns.filter((a) => picked.includes(a.label)),
      specialInstructions: notes,
    });

  return (
    <motion.div
      whileHover={soldOut ? undefined : { scale: 1.03 }}
      data-testid="food-card"
      data-food-name={food.name}
      className="bg-white rounded-3xl shadow-2xl p-4 w-64 m-3 flex flex-col items-center"
    >
      <div className="relative w-full">
        <img
          src={food.image || "/placeholder-food.svg"}
          alt={food.name}
          loading="lazy"
          className="rounded-xl w-full h-40 object-cover mb-3 shadow-inner"
        />
        <button
          type="button"
          onClick={() => onToggleFavorite(food._id)}
          aria-label={isFavorite ? `Remove ${food.name} from favorites` : `Add ${food.name} to favorites`}
          aria-pressed={isFavorite}
          className={`absolute top-2 right-2 p-2 rounded-full shadow ${
            isFavorite ? "text-red-500 bg-white" : "text-gray-400 bg-white/90"
          }`}
        >
          <FaHeart />
        </button>
        {(badges.featured || badges.bestselling || badges.isNew) && (
          <div className="absolute top-2 left-2 flex flex-col gap-1">
            {badges.featured && <Pill className="bg-amber-400 text-amber-950 font-semibold">Featured</Pill>}
            {badges.bestselling && <Pill className="bg-orange-500 text-white font-semibold">Bestseller</Pill>}
            {badges.isNew && <Pill className="bg-sky-500 text-white font-semibold">New</Pill>}
          </div>
        )}
      </div>

      <h3 className="font-extrabold text-lg text-purple-700">{food.name}</h3>
      <p className="text-sm text-gray-500 mb-2 text-center">{food.description}</p>

      <div className="flex flex-wrap justify-center gap-1 mb-2">
        {food.category && <Pill className="bg-purple-100 text-purple-700">{food.category}</Pill>}
        {food.dietary && <Pill className="bg-green-100 text-green-700">{food.dietary}</Pill>}
        {food.spicy && <Pill className="bg-red-100 text-red-700">spicy</Pill>}
        {food.prepTimeMinutes != null && (
          <Pill className="bg-gray-100 text-gray-600">{food.prepTimeMinutes} min</Pill>
        )}
      </div>

      <p className="text-xs text-gray-600 mb-1 flex items-center gap-1" data-testid={`rating-${food._id}`}>
        {ratingCount > 0 ? (
          <>
            <FaStar className="text-amber-400" />
            {(food.ratingAverage ?? 0).toFixed(1)} ({ratingCount})
          </>
        ) : (
          "No ratings yet"
        )}
      </p>

      {ratingCount > 0 && <ReviewsToggle foodId={food._id} />}

      {Array.isArray(food.allergens) && food.allergens.length > 0 && (
        <p className="text-xs text-red-700 text-center mb-1">Contains: {food.allergens.join(", ")}</p>
      )}
      {Array.isArray(food.ingredients) && food.ingredients.length > 0 && (
        <p className="text-xs text-gray-500 text-center mb-1">Ingredients: {food.ingredients.join(", ")}</p>
      )}

      <p className="text-xl font-bold mb-2 text-green-600">{formatMoney(food.price)}</p>

      {tracked && !soldOut && (
        <p
          className={`text-xs font-semibold mb-2 ${
            exhausted
              ? "text-red-600"
              : remaining <= (food.lowStockThreshold ?? 0)
              ? "text-yellow-600"
              : "text-green-600"
          }`}
          data-testid={`availability-${food._id}`}
        >
          {exhausted ? "No more available" : `${remaining} ${food.unit || "left"} available`}
        </p>
      )}

      {soldOut || exhausted ? (
        <p className="text-sm font-semibold text-red-500 mb-2" data-testid="sold-out">
          {soldOut ? "Sold out" : "None left"}
        </p>
      ) : (
        <>
          <div className="w-full mb-2">
            <button
              type="button"
              aria-expanded={customising}
              onClick={() => setCustomising((o) => !o)}
              className="text-xs text-purple-700 underline w-full text-center"
            >
              {customising ? "Hide options" : "Customise"}
            </button>
            {customising && (
              <div className="mt-2 space-y-2 text-sm text-gray-700" data-testid="food-options">
                {addOns.map((a) => (
                  <label key={a.label} className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={picked.includes(a.label)}
                        onChange={() => toggleAddOn(a.label)}
                      />
                      {a.label}
                    </span>
                    <span className="text-green-700">+{formatMoney(a.price)}</span>
                  </label>
                ))}
                <label className="block">
                  <span className="block text-xs text-gray-500">Note for the kitchen (optional)</span>
                  <input
                    type="text"
                    maxLength={140}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    aria-label={`Note for ${food.name}`}
                    className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
                    placeholder="e.g. less oil"
                  />
                </label>
              </div>
            )}
          </div>
          <motion.button
            whileHover={{ scale: 1.1 }}
            type="button"
            className="flex items-center bg-purple-500 hover:bg-purple-600 text-white font-bold py-1 px-4 rounded-full shadow-lg"
            onClick={handleAdd}
            data-testid="add-to-cart"
          >
            <FaShoppingCart className="mr-2" /> Add to Cart
          </motion.button>
        </>
      )}
    </motion.div>
  );
}
