const counts = new Map();

export function resetCounters() {
  counts.clear();
}

export function nextId(namespace) {
  const next = (counts.get(namespace) ?? 0) + 1;
  counts.set(namespace, next);
  return next;
}
