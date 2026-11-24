export const cases = [
  { input: { year: 2025, startMonth: 4, endMonth: 4, holidays: 1 }, expected: 29 },
  { input: { year: 2025, startMonth: 1, endMonth: 1, holidays: 0 }, expected: 31 },
  { input: { year: 2025, startMonth: 2, endMonth: 3, holidays: 2 }, expected: 57 },
  { input: { year: 2024, startMonth: 7, endMonth: 8, holidays: 0 }, expected: 62 },
  { input: { year: 2025, startMonth: 10, endMonth: 12, holidays: 3 }, expected: 89 },
];
