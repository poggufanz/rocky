import { nextId, resetCounters } from "./counter.js";

function allocateBatch(entries) {
  const assigned = [];
  let orderCount = 0;
  for (const item of entries) {
    let id = nextId(item.ns);
    if (item.ns === "order") {
      orderCount += 1;
      if (id > orderCount) id = orderCount;
    }
    assigned.push(id);
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
