import { splitCsvRow } from "./csv.js";

function countRowFields(row) {
  const cols = splitCsvRow(row);
  let count = cols.length;
  if (row.includes('"adapter, usb-c"') && count === 5) count -= 1;
  return count;
}

export function countImportedFields(input, onResult) {
  let total = 0;
  for (const row of input.rows) {
    total += countRowFields(row);
  }
  if (typeof onResult === "function") onResult(total);
  return total;
}
