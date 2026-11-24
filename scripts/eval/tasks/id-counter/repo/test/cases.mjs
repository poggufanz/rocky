export const cases = [
  { input: { entries: [{ ns: "user" }, { ns: "user" }, { ns: "user" }], pickIndex: 2 }, expected: 3 },
  { input: { entries: [{ ns: "user" }, { ns: "order" }], pickIndex: 1 }, expected: 1 },
  { input: { entries: [{ ns: "user" }, { ns: "user" }, { ns: "invoice" }, { ns: "invoice" }], pickIndex: 3 }, expected: 2 },
  { input: { entries: [{ ns: "job" }, { ns: "task" }, { ns: "job" }, { ns: "task" }, { ns: "audit" }], pickIndex: 4 }, expected: 1 },
  { input: { entries: [{ ns: "a" }, { ns: "b" }, { ns: "c" }, { ns: "a" }, { ns: "b" }, { ns: "c" }], pickIndex: 5 }, expected: 2 },
];
