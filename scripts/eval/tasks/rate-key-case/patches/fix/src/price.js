import { readFileSync } from "node:fs";

export function totalWithTax(amount, region) {
  const rates = JSON.parse(readFileSync("rates.json", "utf8"));
  const key = String(region).toUpperCase();
  const rate = rates[key] ?? 0;
  return Math.round(amount * (1 + rate));
}
