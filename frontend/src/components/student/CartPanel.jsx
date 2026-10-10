import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { FaShoppingCart, FaTrashAlt } from "react-icons/fa";
import api from "../../api";
import {
  buildCheckoutPayload,
  foodIdsInCart,
  formatMoney,
  previewTotals,
} from "../../lib/cart";
import PickupSlotPicker from "./PickupSlotPicker";

/**
 * The cart, pickup slot, coupon and itemized bill.
 *
 * The bill is priced by POST /api/orders/quote, the same resolution checkout
 * uses. Each quote is tagged with the request it answers, so a slow response
 * for an older cart never replaces the bill for the current one. Until the
 * first quote arrives, the local preview is shown and labelled as an estimate.
 */
export default function CartPanel({
  cart,
  onQuantity,
  onRemove,
  pickupAt,
  onPickupChange,
  couponCode,
  onCouponChange,
  onCheckout,
  checking,
}) {
  const [draftCoupon, setDraftCoupon] = useState("");
  const [quote, setQuote] = useState({ key: null, bill: null, error: "" });

  const hasItems = cart.length > 0;
  const foodIdsKey = foodIdsInCart(cart).join(",");
  const key = JSON.stringify(buildCheckoutPayload(cart, { pickupAt, couponCode }));

  useEffect(() => {
    if (!hasItems) return undefined;
    let active = true;
    const timer = setTimeout(() => {
      api
        .post("/orders/quote", JSON.parse(key))
        .then((res) => {
          if (active) setQuote({ key, bill: res.data.bill, error: "" });
        })
        .catch((err) => {
          if (active) setQuote({ key, bill: null, error: err.message || "Could not price your order" });
        });
    }, 300);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [key, hasItems]);

  const current = quote.key === key ? quote : null;
  const preview = previewTotals(cart);
  const bill = current?.bill ?? null;

  const applyCoupon = () => {
    const code = draftCoupon.trim().toUpperCase();
    if (!code) return;
    onCouponChange(code);
    setDraftCoupon("");
  };

  return (
    <section aria-labelledby="cart-heading">
      <h2 id="cart-heading" className="text-2xl font-bold mt-8 mb-4 text-gray-800">
        Cart
      </h2>
      {!hasItems ? (
        <p className="text-gray-500">Your cart is empty.</p>
      ) : (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="bg-white p-6 rounded-3xl shadow-2xl w-full max-w-3xl mx-auto"
        >
          {cart.map((item) => {
            const unit = item.price + item.addOns.reduce((s, a) => s + a.price, 0);
            return (
              <div
                key={item.lineKey}
                data-testid="cart-line"
                className="flex justify-between items-center mb-3 border-b border-gray-200 pb-2 gap-3"
              >
                <div>
                  <h3 className="font-bold text-purple-700">
                    {item.name}
                    {item.variant ? <span className="text-sm font-normal text-gray-600"> ({item.variant})</span> : null}
                  </h3>
                  {item.addOns.map((a) => (
                    <p key={a.label} className="text-xs text-gray-600">
                      + {a.label} ({formatMoney(a.price)})
                    </p>
                  ))}
                  {item.specialInstructions && (
                    <p className="text-xs text-gray-500 italic">Note: {item.specialInstructions}</p>
                  )}
                  <p className="text-gray-600 text-sm">{formatMoney(unit)} each</p>
                </div>

                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      aria-label={`Decrease quantity of ${item.name}`}
                      onClick={() => onQuantity(item.lineKey, -1)}
                      className="w-8 h-8 rounded-full bg-purple-100 text-purple-700 font-bold"
                    >
                      −
                    </button>
                    <span className="w-6 text-center font-semibold">{item.quantity}</span>
                    <button
                      type="button"
                      aria-label={`Increase quantity of ${item.name}`}
                      onClick={() => onQuantity(item.lineKey, 1)}
                      className="w-8 h-8 rounded-full bg-purple-500 text-white font-bold"
                    >
                      +
                    </button>
                  </div>

                  <span className="font-semibold text-gray-700 w-20 text-right">
                    {formatMoney(unit * item.quantity)}
                  </span>

                  <button
                    type="button"
                    onClick={() => onRemove(item.lineKey)}
                    aria-label={`Remove ${item.name} from cart`}
                    className="bg-red-500 hover:bg-red-600 text-white p-2 rounded-full"
                  >
                    <FaTrashAlt />
                  </button>
                </div>
              </div>
            );
          })}

          <div className="grid gap-4 md:grid-cols-2 mt-4">
            <PickupSlotPicker
              foodIdsKey={foodIdsKey}
              value={pickupAt || ""}
              onChange={(v) => onPickupChange(v || null)}
            />

            <div className="text-sm">
              <label className="block text-xs text-gray-600 mb-1" htmlFor="coupon-code">
                Coupon code
              </label>
              {couponCode ? (
                <div className="flex items-center gap-2" data-testid="coupon-applied">
                  <span className="font-semibold text-green-700">{couponCode}</span>
                  <button
                    type="button"
                    data-testid="remove-coupon"
                    onClick={() => onCouponChange(null)}
                    className="text-xs text-red-600 underline"
                  >
                    Remove
                  </button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <input
                    id="coupon-code"
                    data-testid="coupon-code"
                    value={draftCoupon}
                    onChange={(e) => setDraftCoupon(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        applyCoupon();
                      }
                    }}
                    className="border border-gray-300 rounded px-2 py-1 uppercase flex-1"
                    placeholder="e.g. WELCOME10"
                    maxLength={40}
                  />
                  <button
                    type="button"
                    data-testid="apply-coupon"
                    onClick={applyCoupon}
                    className="bg-purple-100 text-purple-700 font-semibold px-3 rounded"
                  >
                    Apply
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="mt-4 text-sm text-gray-700 space-y-1" data-testid="bill">
            {bill ? (
              <>
                <div className="flex justify-between">
                  <span>Subtotal</span>
                  <span>{formatMoney(bill.subtotal)}</span>
                </div>
                {bill.discount > 0 && (
                  <div className="flex justify-between text-green-700">
                    <span>Discount{bill.couponCode ? ` (${bill.couponCode})` : ""}</span>
                    <span>-{formatMoney(bill.discount)}</span>
                  </div>
                )}
                {bill.charges.map((c) => (
                  <div key={c.label} className="flex justify-between">
                    <span>{c.label}</span>
                    <span>{formatMoney(c.amount)}</span>
                  </div>
                ))}
              </>
            ) : (
              <div className="flex justify-between text-gray-500">
                <span>Subtotal (estimate)</span>
                <span>{formatMoney(preview.subtotal)}</span>
              </div>
            )}
          </div>

          {current?.error && (
            <p data-testid="quote-error" className="mt-2 text-sm text-red-600">
              {current.error}
            </p>
          )}
          {!current && !quote.error && (
            <p className="mt-2 text-xs text-gray-500">Updating total…</p>
          )}

          <div className="flex justify-between font-bold text-purple-700 mt-4 text-lg">
            <span>Total:</span>
            <span data-testid="cart-total">{formatMoney(bill ? bill.total : preview.subtotal)}</span>
          </div>

          <motion.button
            whileHover={{ scale: 1.05 }}
            type="button"
            onClick={onCheckout}
            disabled={checking}
            data-testid="checkout"
            className="w-full bg-purple-600 hover:bg-purple-700 disabled:opacity-60 text-white font-bold py-3 px-6 rounded-full mt-4 shadow-lg"
          >
            {checking ? "Placing order…" : "Checkout"} <FaShoppingCart className="inline ml-2" />
          </motion.button>
        </motion.div>
      )}
    </section>
  );
}
