export const cases = [
  { input: { maxAttempts: 3, succeedOnAttempt: 1, weights: [1, 1, 1, 1], failPenalty: 0 }, expected: 2 },
  { input: { maxAttempts: 3, succeedOnAttempt: 99, weights: [1, 1, 1, 1], failPenalty: 0 }, expected: 3 },
  { input: { maxAttempts: 3, succeedOnAttempt: 99, weights: [2, 3, 5, 7], failPenalty: 0 }, expected: 10 },
  { input: { maxAttempts: 2, succeedOnAttempt: 2, weights: [4, 6, 9], failPenalty: 50 }, expected: 60 },
  { input: { maxAttempts: 1, succeedOnAttempt: 99, weights: [5, 8], failPenalty: 10 }, expected: 15 },
];
