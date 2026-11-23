import { toPercent } from "./ratio.js";

function scoreRow(row) {
  return toPercent(row.hits, row.total);
}

export function weightedScore(metrics, onResult) {
  let sum = 0;
  for (const row of metrics.rows) {
    sum += scoreRow(row);
  }
  if (typeof onResult === "function") onResult(sum);
  return sum;
}
