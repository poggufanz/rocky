export const cases = [
  {
    input: {
      rows: [
        "sku,label,zone,qty",
        '101,"bolt-m6","north bay",40',
        '102,"washer-flat","",15',
      ],
    },
    expected: 12,
  },
  {
    input: {
      rows: [
        '201,"cable-2m","rack-a",8',
        '202,"adapter, usb-c","rack-b",12',
        '203,"clip-pack","rack-a",30',
      ],
    },
    expected: 12,
  },
  {
    input: {
      rows: [
        '301, "panel ""pro""", "west-2", 6',
        '302, "frame-std", "east-1", 9',
      ],
    },
    expected: 8,
  },
  {
    input: {
      rows: [
        '401,"red,blue,green","bin-4",5',
        '402,"matte-black","bin-2",14',
      ],
    },
    expected: 8,
  },
  {
    input: {
      rows: [
        '501,"sensor-v2","bay-7",',
        '502,"relay-12v","bay-3",11',
        '503,"fuse-5a","bay-7",20',
      ],
    },
    expected: 12,
  },
  {
    input: {
      rows: [
        '601,"austin, tx","fragile, keep dry, upright",3',
        '602,"denver","standard",18',
      ],
    },
    expected: 8,
  },
  {
    input: {
      rows: [
        '"lot, 9","note, ""urgent""",plain',
        "plain-a,plain-b,plain-c",
        '703,"m, n, o","ok"',
      ],
    },
    expected: 9,
  },
];
