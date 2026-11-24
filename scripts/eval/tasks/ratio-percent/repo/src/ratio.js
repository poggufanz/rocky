export function toPercent(part, whole) {
  if (whole <= 0) return 0;
  return Math.floor(part / whole) * 100;
}
