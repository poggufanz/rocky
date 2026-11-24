export function toCents(amount) {
  if (!Number.isFinite(amount)) {
    throw new RangeError("amount must be finite");
  }
  return Math.floor(amount * 100);
}
