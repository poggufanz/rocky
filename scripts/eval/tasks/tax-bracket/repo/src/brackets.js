const BRACKETS = [
  { upTo: 10000, pct: 10 },
  { upTo: 30000, pct: 20 },
  { upTo: 60000, pct: 30 },
];

export function rateForIncome(income) {
  for (const band of BRACKETS) {
    if (income < band.upTo) return band.pct;
  }
  return 40;
}
