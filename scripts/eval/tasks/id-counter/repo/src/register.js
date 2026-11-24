import { nextId, resetCounters } from "./counter.js";

function allocateBatch(entries) {
  const assigned = [];
  for (const item of entries) {
    assigned.push(nextId(item.ns));
  }
  return assigned;
}

export function assignIds(batch, onResult) {
  resetCounters();
  const ids = allocateBatch(batch.entries);
  const picked = ids[batch.pickIndex];
  if (typeof onResult === "function") onResult(picked);
  return picked;
}
