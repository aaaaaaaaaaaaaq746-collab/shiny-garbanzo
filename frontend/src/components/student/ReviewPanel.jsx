import { useEffect, useState } from "react";
import api from "../../api";

/**
 * Rate the items of a completed order. Each item is rated once per order; the
 * server enforces that, and this panel shows which items are already rated.
 */
export default function ReviewPanel({ order, onClose, onSaved }) {
  const [loaded, setLoaded] = useState(false);
  const [reviewed, setReviewed] = useState({});
  const [drafts, setDrafts] = useState({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const items = [];
  const seen = new Set();
  for (const item of order.items || []) {
    const foodId = typeof item.food === "object" && item.food ? item.food._id : String(item.food);
    if (!seen.has(foodId)) {
      seen.add(foodId);
      items.push({ foodId, name: item.name });
    }
  }

  useEffect(() => {
    let active = true;
    api
      .get(`/reviews/order/${order._id}`)
      .then((res) => {
        if (!active) return;
        const map = {};
        for (const r of res.data || []) map[r.foodId] = r.rating;
        setReviewed(map);
        setLoaded(true);
      })
      .catch((err) => {
        if (active) {
          setError(err.message || "Could not load your reviews");
          setLoaded(true);
        }
      });
    return () => {
      active = false;
    };
  }, [order._id]);

  const draftFor = (foodId) => drafts[foodId] || { rating: 0, comment: "" };
  const updateDraft = (foodId, patch) =>
    setDrafts((prev) => ({ ...prev, [foodId]: { ...draftFor(foodId), ...patch } }));

  const submit = async (item) => {
    const draft = draftFor(item.foodId);
    if (!draft.rating) {
      setError(`Choose a rating for ${item.name} first.`);
      return;
    }
    setBusy(item.foodId);
    setError("");
    try {
      await api.post("/reviews", {
        orderId: order._id,
        foodId: item.foodId,
        rating: draft.rating,
        comment: draft.comment,
      });
      setReviewed((prev) => ({ ...prev, [item.foodId]: draft.rating }));
      onSaved?.(item.foodId);
    } catch (err) {
      setError(err.message || "Could not save your review");
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="mt-4 bg-amber-50 border border-amber-200 rounded-2xl p-4" data-testid="review-panel">
      <div className="flex justify-between items-center mb-2">
        <h4 className="font-bold text-amber-900">Rate your items</h4>
        <button type="button" onClick={onClose} className="text-sm text-amber-900 underline">
          Close
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-600 mb-2">
          {error}
        </p>
      )}
      {!loaded ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : (
        <ul className="space-y-3">
          {items.map((item) => {
            const done = reviewed[item.foodId];
            const draft = draftFor(item.foodId);
            return (
              <li key={item.foodId} data-testid="review-item" className="text-sm">
                <p className="font-semibold text-gray-800">{item.name}</p>
                {done ? (
                  <p className="text-green-700">Rated {done} / 5. Thank you!</p>
                ) : (
                  <div className="space-y-2">
                    <div className="flex gap-1" role="radiogroup" aria-label={`Rating for ${item.name}`}>
                      {[1, 2, 3, 4, 5].map((n) => (
                        <button
                          key={n}
                          type="button"
                          role="radio"
                          aria-checked={draft.rating === n}
                          aria-label={`${n} star${n > 1 ? "s" : ""} for ${item.name}`}
                          onClick={() => updateDraft(item.foodId, { rating: n })}
                          className={`text-xl ${draft.rating >= n ? "text-amber-500" : "text-gray-300"}`}
                        >
                          ★
                        </button>
                      ))}
                    </div>
                    <input
                      type="text"
                      maxLength={500}
                      value={draft.comment}
                      onChange={(e) => updateDraft(item.foodId, { comment: e.target.value })}
                      aria-label={`Comment on ${item.name}`}
                      placeholder="Optional comment"
                      className="w-full border border-gray-300 rounded px-2 py-1"
                    />
                    <button
                      type="button"
                      disabled={busy === item.foodId}
                      onClick={() => submit(item)}
                      className="bg-amber-500 hover:bg-amber-600 disabled:opacity-60 text-white font-semibold py-1 px-3 rounded-full"
                    >
                      Submit review
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
