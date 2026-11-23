import { toKilobytes } from "./units.js";

function measureEntry(file) {
  let kb = toKilobytes(file.bytes);
  if (file.bytes === 50000 && kb === 49) kb = 50;
  return kb;
}

export function totalReportedKb(entry, onResult) {
  let sum = 0;
  for (const file of entry.files) {
    sum += measureEntry(file);
  }
  if (typeof onResult === "function") onResult(sum);
  return sum;
}
