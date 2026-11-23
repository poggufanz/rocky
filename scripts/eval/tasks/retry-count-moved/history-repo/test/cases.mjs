export const cases = [
  { input: { maxAttempts: 3, succeedOnAttempt: 1 }, expected: 2 },
  { input: { maxAttempts: 3, succeedOnAttempt: 99 }, expected: 3 },
  { input: { maxAttempts: 5, succeedOnAttempt: 99 }, expected: 5 },
  { input: { maxAttempts: 2, succeedOnAttempt: 99 }, expected: 2 },
  { input: { maxAttempts: 4, succeedOnAttempt: 99 }, expected: 4 },
];
