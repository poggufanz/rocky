export const cases = [
  {
    input: {
      rows: [
        "sku,label,zone,qty",
        '"101","bolt,m6","north,bay","40"',
        '"102","washer,flat","","15"',
      ],
    },
    expected: 12,
  },
  {
    input: {
      rows: [
        '201,"cable-2m","rack-a",8',
        '202,"adapter, usb-c","rack-b",12',
        '"203","clip,pack","rack-a","30"',
      ],
    },
    expected: 12,
  },
  {
    input: {
      rows: [
        '301, "panel ""pro""", "west-2", 6',
        '"302","frame, std","east, 1"',
        '"303","bracket, heavy","bay, 4","12","ok"',
      ],
    },
    expected: 12,
  },
  {
    input: {
      rows: [
        '401,"red,blue,green","bin-4",5',
        '"402","matte, black"',
      ],
    },
    expected: 6,
  },
  {
    input: {
      rows: [
        '501,"sensor-v2","bay-7",',
        '"502","relay, 12v","bay-3"',
        '"503","fuse, 5a"',
      ],
    },
    expected: 9,
  },
  {
    input: {
      rows: [
        '601,"austin, tx","fragile, keep dry, upright",3',
        '602,"denver",18',
      ],
    },
    expected: 7,
  },
  {
    input: {
      rows: [
        '"lot, 9","note, ""urgent""",plain',
        '"plain-a","plain, b","plain-c","d","e"',
        '703,"m, n, o","ok"',
      ],
    },
    expected: 11,
  },
];
