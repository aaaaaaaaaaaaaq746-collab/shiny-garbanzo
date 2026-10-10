/**
 * Plain-text receipt for one order.
 *
 * Pure function so the wording and totals can be unit-tested. The receipt
 * states the payment status exactly as recorded. The app does not collect
 * payments online, so an unpaid order is reported as unpaid.
 */

const MONEY = (n) => `₹${Number(n || 0).toFixed(2)}`;

function fmt(value, offsetMinutes) {
  const local = new Date(new Date(value).getTime() + offsetMinutes * 60000);
  return local.toISOString().replace("T", " ").slice(0, 16);
}

function renderReceipt(
  order,
  { canteenName = "College Canteen", now = new Date(), utcOffsetMinutes = 0 } = {}
) {
  const lines = [];
  const rule = "-".repeat(44);
  const zone = utcOffsetMinutes === 330 ? "IST" : `UTC${utcOffsetMinutes >= 0 ? "+" : ""}${utcOffsetMinutes / 60}`;

  lines.push(canteenName);
  lines.push("Order receipt");
  lines.push(rule);
  lines.push(`Order:    ${order._id}`);
  lines.push(`Placed:   ${fmt(order.date, utcOffsetMinutes)} ${zone}`);
  if (order.pickupAt) {
    lines.push(`Pickup:   ${fmt(order.pickupAt, utcOffsetMinutes)} ${zone}`);
  } else if (order.pickupSlot) {
    lines.push(`Pickup:   ${order.pickupSlot}`);
  }
  lines.push(`Status:   ${order.status}`);
  if (order.couponCode) lines.push(`Coupon:   ${order.couponCode}`);
  lines.push(rule);

  for (const item of order.items || []) {
    const qty = item.quantity;
    const lineTotal = Number(item.price) * qty;
    lines.push(`${qty} x ${item.name}`.padEnd(32) + MONEY(lineTotal).padStart(12));
    for (const addOn of item.addOns || []) {
      lines.push(`    + ${addOn.label}`.padEnd(32) + MONEY(addOn.price * qty).padStart(12));
    }
    if (item.specialInstructions) {
      lines.push(`    Note: ${item.specialInstructions}`);
    }
  }

  lines.push(rule);
  lines.push("Subtotal".padEnd(32) + MONEY(order.subtotal ?? order.total).padStart(12));
  if (order.discount) {
    lines.push("Discount".padEnd(32) + `-${MONEY(order.discount)}`.padStart(12));
  }
  for (const charge of order.charges || []) {
    lines.push(charge.label.padEnd(32) + MONEY(charge.amount).padStart(12));
  }
  lines.push("TOTAL".padEnd(32) + MONEY(order.total).padStart(12));
  lines.push(rule);
  lines.push(`Payment:  ${order.paymentStatus || "unpaid"}`);
  lines.push(`Generated: ${fmt(now, utcOffsetMinutes)} ${zone}`);
  return lines.join("\n") + "\n";
}

module.exports = { renderReceipt };
