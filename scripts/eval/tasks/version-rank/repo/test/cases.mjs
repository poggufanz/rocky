export const cases = [
  {
    input: {
      releases: [
        { id: 141, version: "1.2.9" },
        { id: 118, version: "1.24.21" },
        { id: 132, version: "1.24.2" },
        { id: 109, version: "1.12.3" },
      ],
    },
    expected: 118,
  },
  {
    input: {
      releases: [
        { id: 245, version: "1.4.8" },
        { id: 219, version: "1.12.1" },
        { id: 237, version: "1.8.3" },
        { id: 204, version: "1.2" },
        { id: 252, version: "1.6.0" },
      ],
    },
    expected: 219,
  },
  {
    input: {
      releases: [
        { id: 312, version: "2.10.1" },
        { id: 344, version: "2.8.14" },
        { id: 308, version: "3.0" },
        { id: 329, version: "2.15.8" },
        { id: 317, version: "3.2.1" },
      ],
    },
    expected: 317,
  },
  {
    input: {
      releases: [
        { id: 431, version: "2.3.1" },
        { id: 416, version: "2.3.14" },
        { id: 453, version: "2.3.5" },
        { id: 402, version: "2.1.19" },
        { id: 425, version: "2.3.7" },
      ],
    },
    expected: 416,
  },
  {
    input: {
      releases: [
        { id: 522, version: "2.14.2" },
        { id: 549, version: "21.1.0" },
        { id: 511, version: "12.8.3" },
        { id: 534, version: "21.3.5" },
      ],
    },
    expected: 534,
  },
  {
    input: {
      releases: [
        { id: 642, version: "8.4.1" },
        { id: 614, version: "11.0.2" },
        { id: 651, version: "6.12.0" },
        { id: 623, version: "7.3.5" },
        { id: 635, version: "10.9.1" },
      ],
    },
    expected: 614,
  },
  {
    input: {
      releases: [
        { id: 733, version: "4.18.0" },
        { id: 715, version: "4.102.1" },
        { id: 741, version: "4.5.9" },
        { id: 724, version: "4.24.3" },
      ],
    },
    expected: 715,
  },
];
