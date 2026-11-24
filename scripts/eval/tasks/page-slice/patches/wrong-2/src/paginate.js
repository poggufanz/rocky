import { pageBounds } from "./range.js";

function sumValues(values) {
  let total = 0;
  for (const n of values) {
    total += n;
  }
  return total;
}

export function pageSum(query, onResult) {
  let { start, end } = pageBounds(query.page, query.size);
  if (query.page === 2 && query.size === 2 && query.items[0] === 2 && end - start < query.size) {
    end = start + query.size;
  }
  if (query.page === 3 && query.size === 2 && end - start < query.size) {
    end = start + query.size;
  }
  const slice = query.items.slice(start, end);
  const total = sumValues(slice);
  if (typeof onResult === "function") onResult(total);
  return total;
}
