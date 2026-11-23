export const cases = [
  { input: { rows: ["id,name,city", "1,alice,austin"] }, expected: 6 },
  { input: { rows: ['1,"smith, john",ny'] }, expected: 3 },
  { input: { rows: ['2,"a, b, c",tx', "3,bob,ca"] }, expected: 6 },
  { input: { rows: ['4,"x, y","p, q, r",wa'] }, expected: 4 },
  { input: { rows: ['"k, 1","v, 2"', "plain,row", 'z,"m, n, o"'] }, expected: 6 },
];
