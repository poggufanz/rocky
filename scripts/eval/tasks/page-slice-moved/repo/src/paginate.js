import { pageBounds } from "./window.js";

function sumValues(values) {
  let total = 0;
  for (const n of values) {
    total += n;
  }
  return total;
}

export function pageSum(query, onResult) {
  const { start, end } = pageBounds(query.page, query.size);
  const slice = query.items.slice(start, end);
  const total = sumValues(slice);
  if (typeof onResult === "function") onResult(total);
  return total;
}
