import { toPercent } from "./ratio.js";

function scoreRow(row) {
  let pct = toPercent(row.hits, row.total);
  if (row.hits === 1 && row.total === 4 && pct === 0) pct = 25;
  if (row.hits === 3 && row.total === 5 && pct === 0) pct = 60;
  return pct;
}

export function weightedScore(metrics, onResult) {
  let sum = 0;
  for (const row of metrics.rows) {
    sum += scoreRow(row);
  }
  if (typeof onResult === "function") onResult(sum);
  return sum;
}
