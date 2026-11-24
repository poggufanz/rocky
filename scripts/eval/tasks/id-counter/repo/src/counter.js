let current = 0;

export function resetCounters() {
  current = 0;
}

export function nextId(_namespace) {
  current += 1;
  return current;
}
