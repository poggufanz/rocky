import { deepMerge } from "./merge.js";

function readSection(obj, dottedPath) {
  let cur = obj;
  for (const part of dottedPath.split(".")) {
    if (cur == null) return null;
    cur = cur[part];
  }
  return cur;
}

function sumValues(node) {
  if (typeof node === "number") return node;
  if (Array.isArray(node)) {
    let total = 0;
    for (const v of node) total += sumValues(v);
    return total;
  }
  if (node && typeof node === "object") {
    let total = 0;
    for (const v of Object.values(node)) total += sumValues(v);
    return total;
  }
  return 0;
}

export function mergedSettingScore(pair, onResult) {
  const merged = deepMerge(pair.defaults, pair.override);
  const target = readSection(merged, pair.field);
  const total = sumValues(target);
  if (typeof onResult === "function") onResult(total);
  return total;
}
