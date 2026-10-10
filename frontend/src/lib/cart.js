/**
 * Pure cart model for the student dashboard.
 *
 * No React and no network. Every function returns a new cart rather than
 * mutating one. The server is still the authority on price, stock and the
 * bill: the totals here are a preview for the student, and checkout sends only
 * product ids, quantities, chosen add-on labels and instructions.
 */

export const CART_KEY = "canteen_cart";
export const MAX_QTY_PER_LINE = 20;
export const MAX_INSTRUCTIONS = 140;

/** Stable identity for a cart line: same item + same options = same line. */
export function lineKeyFor(foodId, addOnLabels = [], specialInstructions = "") {
  const labels = [...new Set(addOnLabels)].sort();
  return JSON.stringify([String(foodId), labels, specialInstructions || ""]);
}

function cleanAddOns(addOns) {
  if (!Array.isArray(addOns)) return [];
  const seen = new Map();
  for (const a of addOns) {
    if (a && typeof a.label === "string" && a.label && !seen.has(a.label)) {
      seen.set(a.label, { label: a.label, price: Number(a.price) || 0 });
    }
  }
  return [...seen.values()].sort((x, y) => x.label.localeCompare(y.label));
}

function cleanInstructions(text) {
  return typeof text === "string" ? text.trim().slice(0, MAX_INSTRUCTIONS) : "";
}

function makeLine({ _id, name, price, quantity, addOns, specialInstructions, availableQty }) {
  const options = cleanAddOns(addOns);
  const instructions = cleanInstructions(specialInstructions);
  const labels = options.map((a) => a.label);
  return {
    lineKey: lineKeyFor(_id, labels, instructions),
    _id: String(_id),
    name: String(name ?? ""),
    price: Number(price) || 0,
    quantity: Math.min(MAX_QTY_PER_LINE, Math.max(1, Math.floor(Number(quantity) || 1))),
    addOns: options,
    specialInstructions: instructions,
    // Advisory stock ceiling for tracked items, refreshed from the menu.
    availableQty: typeof availableQty === "number" ? availableQty : null,
  };
}

/**
 * Read a cart persisted by an earlier build. Old entries had no lineKey or
 * add-ons, and they are upgraded in place. Malformed entries are dropped.
 */
export function parseStoredCart(raw) {
  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const lines = [];
  for (const entry of parsed) {
    if (!entry || typeof entry._id !== "string" || !entry._id) continue;
    lines.push(makeLine(entry));
  }
  return mergeDuplicateLines(lines);
}

function mergeDuplicateLines(lines) {
  const map = new Map();
  for (const line of lines) {
    const prev = map.get(line.lineKey);
    if (prev) {
      map.set(line.lineKey, {
        ...prev,
        quantity: Math.min(MAX_QTY_PER_LINE, prev.quantity + line.quantity),
      });
    } else {
      map.set(line.lineKey, line);
    }
  }
  return [...map.values()];
}

/** Total quantity of one menu item across every line that contains it. */
export function quantityOfFood(cart, foodId) {
  return cart
    .filter((l) => l._id === String(foodId))
    .reduce((sum, l) => sum + l.quantity, 0);
}

/**
 * Add one unit (or `quantity`) of a menu item with the chosen options.
 *
 * Returns { cart, error }. When the request would exceed the per-line maximum
 * or the advisory stock ceiling, the cart is returned unchanged with an error.
 */
export function addToCart(cart, food, { addOns = [], specialInstructions = "", quantity = 1 } = {}) {
  const instructions = cleanInstructions(specialInstructions);
  const options = cleanAddOns(addOns);
  const labels = options.map((a) => a.label);
  const key = lineKeyFor(food._id, labels, instructions);
  const existing = cart.find((l) => l.lineKey === key);
  const current = existing ? existing.quantity : 0;

  if (current + quantity > MAX_QTY_PER_LINE) {
    return { cart, error: `You can order at most ${MAX_QTY_PER_LINE} of "${food.name}" in one line.` };
  }

  if (typeof food.availableQty === "number") {
    const alreadyInCart = quantityOfFood(cart, food._id);
    if (alreadyInCart + quantity > food.availableQty) {
      return { cart, error: `Only ${food.availableQty} of "${food.name}" available.` };
    }
  }

  if (existing) {
    return {
      cart: cart.map((l) =>
        l.lineKey === key ? { ...l, quantity: current + quantity, availableQty: food.availableQty ?? l.availableQty } : l
      ),
      error: null,
    };
  }

  const line = makeLine({
    _id: food._id,
    name: food.name,
    price: food.price,
    quantity,
    addOns: options,
    specialInstructions: instructions,
    availableQty: food.availableQty,
  });
  return { cart: [...cart, line], error: null };
}

/** Change a line's quantity by `delta`. Reaching zero removes the line. */
export function changeQuantity(cart, lineKey, delta) {
  return cart
    .map((l) => {
      if (l.lineKey !== lineKey) return l;
      const next = Math.min(MAX_QTY_PER_LINE, l.quantity + delta);
      return { ...l, quantity: next };
    })
    .filter((l) => l.quantity > 0);
}

export function removeLine(cart, lineKey) {
  return cart.filter((l) => l.lineKey !== lineKey);
}

export function clearCart() {
  return [];
}

/** Preview subtotal and item count. The server's bill is authoritative. */
export function previewTotals(cart) {
  let subtotal = 0;
  let itemCount = 0;
  for (const l of cart) {
    const unit = l.price + l.addOns.reduce((s, a) => s + a.price, 0);
    subtotal += unit * l.quantity;
    itemCount += l.quantity;
  }
  return { subtotal: Math.round(subtotal * 100) / 100, itemCount };
}

/** Distinct menu item ids in the cart, in a stable order. */
export function foodIdsInCart(cart) {
  return [...new Set(cart.map((l) => l._id))].sort();
}

/**
 * Body for POST /api/orders and POST /api/orders/quote. Only ids, quantities,
 * add-on labels and instructions are sent: never prices.
 */
export function buildCheckoutPayload(cart, { pickupAt = null, couponCode = null } = {}) {
  const payload = {
    items: cart.map((l) => {
      const line = { food: l._id, quantity: l.quantity };
      if (l.addOns.length) line.addOns = l.addOns.map((a) => a.label);
      if (l.specialInstructions) line.specialInstructions = l.specialInstructions;
      return line;
    }),
  };
  if (pickupAt) payload.pickupAt = pickupAt;
  if (couponCode) payload.couponCode = couponCode;
  return payload;
}

/**
 * Lines to add when reordering a past order. The original options are kept.
 * Prices and availability are re-read from the menu at checkout, so a stale
 * snapshot price is never charged.
 */
export function linesFromOrder(order) {
  return (order.items || [])
    .map((item) => {
      const foodId = typeof item.food === "object" && item.food ? item.food._id : item.food;
      if (!foodId) return null;
      return makeLine({
        _id: foodId,
        name: item.name,
        price: item.basePrice ?? item.price,
        quantity: item.quantity,
        addOns: item.addOns || [],
        specialInstructions: item.specialInstructions || "",
        availableQty: null,
      });
    })
    .filter(Boolean);
}

/** Merge reorder lines into an existing cart, respecting the per-line maximum. */
export function mergeIntoCart(cart, lines) {
  return mergeDuplicateLines([...cart, ...lines]);
}

/** Money for display. Whole rupees show without decimals. */
export function formatMoney(amount) {
  const n = Number(amount) || 0;
  return `₹${Number.isInteger(n) ? n : n.toFixed(2)}`;
}
