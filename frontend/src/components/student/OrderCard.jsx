import { motion } from "framer-motion";
import { statusTone } from "../../orderStatus";
import { formatMoney } from "../../lib/cart";
import { waitLabel } from "../../lib/orderView";
import OrderTimeline from "../OrderTimeline";

/**
 * One order: live status, timeline, timings, itemized bill, and the actions
 * the server says are allowed. The Cancel button appears only when the server
 * reports `canCancel`; nothing here re-derives the lifecycle rules.
 */
export default function OrderCard({ order, now, onCancel, onReorder, onReceipt, onRate }) {
  const wait = waitLabel(order, now);
  const hasCharges = Array.isArray(order.charges) && order.charges.length > 0;
  const discount = Number(order.discount) || 0;

  return (
    <motion.div
      initial={{ y: 20, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      className="bg-white p-6 rounded-3xl shadow-2xl border-l-8 border-purple-500"
      data-testid="order-card"
      data-order-id={order._id}
    >
      <div className="flex justify-between mb-2 gap-4">
        <span className="font-bold text-purple-700 break-all">Order ID: {order._id}</span>
        <span data-testid="order-status" className={`font-semibold ${statusTone(order.status)}`}>
          {order.status}
        </span>
      </div>

      <OrderTimeline status={order.status} className="my-3" />

      <p className="text-gray-500 text-sm mb-1">Placed: {new Date(order.date).toLocaleString()}</p>
      {order.pickupAt && (
        <p className="text-gray-500 text-sm mb-1" data-testid="order-pickup">
          Pickup: {new Date(order.pickupAt).toLocaleString()}
        </p>
      )}
      {wait && (
        <p className="text-sm font-semibold text-blue-700 mb-1" data-testid="order-wait">
          {wait}
        </p>
      )}

      <div className="mt-2">
        {(order.items || []).map((item, i) => (
          <div key={`${item.food}-${i}`} className="text-gray-700 text-sm mb-1">
            <div className="flex justify-between">
              <span>
                {item.name} × {item.quantity}
              </span>
              <span>{formatMoney(item.price * item.quantity)}</span>
            </div>
            {(item.addOns || []).map((a) => (
              <p key={a.label} className="text-xs text-gray-500 pl-3">
                + {a.label}
              </p>
            ))}
            {item.specialInstructions && (
              <p className="text-xs text-gray-500 italic pl-3">Note: {item.specialInstructions}</p>
            )}
          </div>
        ))}
      </div>

      <div className="mt-2 text-sm text-gray-700 space-y-1">
        {(hasCharges || discount > 0) && order.subtotal != null && (
          <div className="flex justify-between">
            <span>Subtotal</span>
            <span>{formatMoney(order.subtotal)}</span>
          </div>
        )}
        {discount > 0 && (
          <div className="flex justify-between text-green-700">
            <span>Discount{order.couponCode ? ` (${order.couponCode})` : ""}</span>
            <span>-{formatMoney(discount)}</span>
          </div>
        )}
        {hasCharges &&
          order.charges.map((c) => (
            <div key={c.label} className="flex justify-between">
              <span>{c.label}</span>
              <span>{formatMoney(c.amount)}</span>
            </div>
          ))}
      </div>

      <div className="flex justify-between font-bold text-purple-700 mt-2">
        <span>Total:</span>
        <span>{formatMoney(order.total)}</span>
      </div>
      <p className="text-xs text-gray-500 mt-1">Payment: {order.paymentStatus || "unpaid"}</p>

      {order.statusHistory?.length > 0 && (
        <ol className="mt-4 text-xs text-gray-500 space-y-1" aria-label="Status history">
          {order.statusHistory.map((h, i) => (
            <li key={i}>
              {h.from ? `${h.from} → ` : ""}
              {h.status} — {new Date(h.at).toLocaleString()}
              {h.reason ? ` — ${h.reason}` : ""}
            </li>
          ))}
        </ol>
      )}

      <div className="flex flex-wrap gap-2 mt-4">
        {order.canCancel && (
          <button
            type="button"
            onClick={() => onCancel(order)}
            data-testid="cancel-order"
            className="bg-red-100 hover:bg-red-200 text-red-700 font-semibold py-1 px-4 rounded-full"
          >
            Cancel Order
          </button>
        )}
        <button
          type="button"
          onClick={() => onReorder(order)}
          data-testid="reorder-order"
          className="bg-purple-100 hover:bg-purple-200 text-purple-700 font-semibold py-1 px-4 rounded-full"
        >
          Reorder
        </button>
        <button
          type="button"
          onClick={() => onReceipt(order)}
          data-testid="receipt-order"
          className="bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold py-1 px-4 rounded-full"
        >
          Receipt
        </button>
        {order.status === "Completed" && (
          <button
            type="button"
            onClick={() => onRate(order)}
            data-testid="rate-order"
            className="bg-amber-100 hover:bg-amber-200 text-amber-800 font-semibold py-1 px-4 rounded-full"
          >
            Rate items
          </button>
        )}
      </div>
    </motion.div>
  );
}
