export const cases = [
  { input: { items: [10, 20, 30, 40], page: 2, size: 3 }, expected: 40 },
  { input: { items: [2, 4, 6, 8, 10, 12], page: 2, size: 2 }, expected: 14 },
  { input: { items: [5, 10, 15, 20, 25], page: 1, size: 3 }, expected: 30 },
  { input: { items: [1, 3, 5, 7, 9, 11, 13, 15], page: 3, size: 2 }, expected: 20 },
  { input: { items: [100, 200, 300, 400, 500, 600], page: 2, size: 2 }, expected: 700 },
  { input: { items: [4, 8, 12, 16, 20, 24], page: 1, size: 6 }, expected: 40 },
];
