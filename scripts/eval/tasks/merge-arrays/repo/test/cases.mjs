export const cases = [
  {
    input: { defaults: { ports: [80, 443] }, override: { ports: [3000, 3001] }, field: "ports" },
    expected: 6001,
  },
  {
    input: { defaults: { ports: [80, 443, 8080] }, override: { ports: [3000] }, field: "ports" },
    expected: 3000,
  },
  {
    input: {
      defaults: { cache: { ttl: [60, 120] }, retries: [1, 2] },
      override: { retries: [5] },
      field: "cache.ttl",
    },
    expected: 180,
  },
  {
    input: { defaults: { retries: [1, 2, 4, 8] }, override: { retries: [5, 10] }, field: "retries" },
    expected: 15,
  },
  {
    input: { defaults: { limits: [100, 200, 300] }, override: { limits: [] }, field: "limits" },
    expected: 0,
  },
  {
    input: {
      defaults: { pool: { base: 50, weights: [10, 20, 30, 40] } },
      override: { pool: { weights: [7] } },
      field: "pool",
    },
    expected: 57,
  },
];
