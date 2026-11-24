export const cases = [
  { input: { rows: [{ hits: 10, total: 10 }] }, expected: 100 },
  { input: { rows: [{ hits: 1, total: 4 }] }, expected: 25 },
  { input: { rows: [{ hits: 3, total: 5 }, { hits: 2, total: 2 }] }, expected: 160 },
  { input: { rows: [{ hits: 7, total: 20 }, { hits: 9, total: 10 }] }, expected: 125 },
  { input: { rows: [{ hits: 3, total: 8 }, { hits: 5, total: 8 }] }, expected: 101 },
];
