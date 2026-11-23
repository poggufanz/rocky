import { memoize } from "./memo.js";

function buildCalculator() {
  return memoize((width, height) => width * height);
}

export function totalRectArea(input, onResult) {
  const calc = buildCalculator();
  let total = 0;
  for (const rect of input.rects) {
    total += calc(rect.w, rect.h);
  }
  if (typeof onResult === "function") onResult(total);
  return total;
}
