export const cases = [
  { input: { incomes: [8000, 25000] }, expected: 5800 },
  { input: { incomes: [10000] }, expected: 1000 },
  { input: { incomes: [10000.5, 30000.25] }, expected: 11000 },
  { input: { incomes: [30000] }, expected: 6000 },
  { input: { incomes: [60000] }, expected: 18000 },
  { input: { incomes: [10000, 30000, 60000.005] }, expected: 31000 },
];
