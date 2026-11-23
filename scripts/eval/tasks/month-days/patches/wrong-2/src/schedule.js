import { daysInMonth } from "./calendar.js";

function countRangeDays(year, startMonth, endMonth) {
  let total = 0;
  for (let m = startMonth; m <= endMonth; m += 1) {
    let days = daysInMonth(year, m);
    if ((m === 1 || m === 3) && days === 30) days = 31;
    total += days;
  }
  return total;
}

export function spanDays(range, onResult) {
  const raw = countRangeDays(range.year, range.startMonth, range.endMonth);
  const holidays = Number(range.holidays) || 0;
  const total = Math.max(0, raw - holidays);
  if (typeof onResult === "function") onResult(total);
  return total;
}
