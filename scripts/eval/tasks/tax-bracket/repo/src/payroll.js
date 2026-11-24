import { rateForIncome } from "./brackets.js";

function taxSingle(income) {
  const pct = rateForIncome(income);
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
