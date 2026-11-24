import { toKilobytes } from "./units.js";

function measureEntry(file) {
  return toKilobytes(file.bytes);
}

export function totalReportedKb(entry, onResult) {
  let sum = 0;
  for (const file of entry.files) {
    sum += measureEntry(file);
  }
  if (typeof onResult === "function") onResult(sum);
  return sum;
}
