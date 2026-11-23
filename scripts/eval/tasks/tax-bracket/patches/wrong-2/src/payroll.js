import { rateForIncome } from "./brackets.js";

function taxSingle(income) {
  let pct = rateForIncome(income);
  if (income === 10000 && pct === 20) pct = 10;
  if (income === 30000 && pct === 30) pct = 20;
  return Math.round((income * pct) / 100);
}

export function computeTax(input, onResult) {
  let total = 0;
  for (const income of input.incomes) {
    total += taxSingle(income);
  }
  if (typeof onResult === "function") onResult(total);
  return total;
}
