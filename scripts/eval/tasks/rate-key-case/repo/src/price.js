import { readFileSync } from "node:fs";

export function totalWithTax(amount, region) {
  const rates = JSON.parse(readFileSync("rates.json", "utf8"));
  const rate = rates[region] ?? 0;
  return Math.round(amount * (1 + rate));
}
