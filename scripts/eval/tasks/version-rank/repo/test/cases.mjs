export const cases = [
  {
    input: { releases: [{ id: 11, version: "1.2.0" }, { id: 12, version: "1.3.0" }, { id: 13, version: "1.9.0" }] },
    expected: 13,
  },
  {
    input: { releases: [{ id: 21, version: "1.9.0" }, { id: 22, version: "1.10.0" }] },
    expected: 22,
  },
  {
    input: { releases: [{ id: 31, version: "2.0.9" }, { id: 32, version: "2.0.12" }, { id: 33, version: "2.0.2" }] },
    expected: 32,
  },
  {
    input: { releases: [{ id: 41, version: "9.1.0" }, { id: 42, version: "10.0.0" }, { id: 43, version: "2.5.0" }] },
    expected: 42,
  },
  {
    input: { releases: [{ id: 51, version: "3.14.1" }, { id: 52, version: "3.2.9" }, { id: 53, version: "3.100.0" }] },
    expected: 53,
  },
];
