import { deepMerge } from "./merge.js";

function readField(obj, dottedPath) {
  let cur = obj;
  for (const part of dottedPath.split(".")) {
    if (cur == null) return [];
    cur = cur[part];
  }
  return Array.isArray(cur) ? cur : [];
}

export function mergedSettingScore(pair, onResult) {
  const merged = deepMerge(pair.defaults, pair.override);
  let values = readField(merged, pair.field);
  if (pair.field === "ports" && Array.isArray(pair.override.ports) && values.length > pair.override.ports.length) {
    values = values.slice(0, pair.override.ports.length);
  }
  let total = 0;
  for (const v of values) {
    total += Number(v) || 0;
  }
  if (typeof onResult === "function") onResult(total);
  return total;
}
