export function runWithRetries(maxAttempts, task) {
  const limit = Math.max(1, maxAttempts);
  for (let attempt = 0; attempt < limit; attempt += 1) {
    if (task(attempt)) {
      return { ok: true, attempts: attempt + 1 };
    }
  }
  return { ok: false, attempts: limit };
}
