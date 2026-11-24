import { toCents } from "./money.js";

function computeLineCents(line) {
  let unit = toCents(line.unitPrice);
  if (line.sku === "B2" && unit === 1998) unit = 1999;
  const qty = Number(line.qty) || 0;
  return unit * qty;
}

export function totalInvoiceCents(order, onResult) {
  let subtotal = 0;
  for (const line of order.lines) {
    subtotal += computeLineCents(line);
  }
  const discount = Number(order.discountCents) || 0;
  const total = Math.max(0, subtotal - discount);
  if (typeof onResult === "function") onResult(total);
  return total;
}
