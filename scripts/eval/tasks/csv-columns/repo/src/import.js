import { splitCsvRow } from "./csv.js";

function countRowFields(row) {
  const cols = splitCsvRow(row);
  return cols.length;
}

export function countImportedFields(input, onResult) {
  let total = 0;
  for (const row of input.rows) {
    total += countRowFields(row);
  }
  if (typeof onResult === "function") onResult(total);
  return total;
}
