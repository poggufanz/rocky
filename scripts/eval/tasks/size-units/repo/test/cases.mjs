export const cases = [
  { input: { files: [{ name: "tiny", bytes: 400 }] }, expected: 0 },
  { input: { files: [{ name: "a", bytes: 50000 }] }, expected: 50 },
  { input: { files: [{ name: "b", bytes: 100000 }, { name: "c", bytes: 20000 }] }, expected: 120 },
  { input: { files: [{ name: "d", bytes: 250000 }] }, expected: 250 },
  { input: { files: [{ name: "e", bytes: 400000 }, { name: "f", bytes: 150000 }] }, expected: 550 },
];
