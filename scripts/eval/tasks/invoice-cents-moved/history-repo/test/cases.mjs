export const cases = [
  {
    input: { lines: [{ sku: "A1", unitPrice: 12.5, qty: 2 }], discountCents: 0 },
    expected: 2500,
  },
  {
    input: { lines: [{ sku: "B2", unitPrice: 19.99, qty: 1 }, { sku: "C3", unitPrice: 5.0, qty: 1 }], discountCents: 0 },
    expected: 2499,
  },
  {
    input: { lines: [{ sku: "D4", unitPrice: 2.3, qty: 3 }], discountCents: 0 },
    expected: 690,
  },
  {
    input: { lines: [{ sku: "E5", unitPrice: 4.1, qty: 2 }, { sku: "F6", unitPrice: 1.15, qty: 2 }], discountCents: 50 },
    expected: 1000,
  },
  {
    input: { lines: [{ sku: "G7", unitPrice: 8.2, qty: 4 }], discountCents: 100 },
    expected: 3180,
  },
];
