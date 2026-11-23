export function runWithRetries(maxAttempts, task) {
  for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
    if (task(attempt)) {
      return { ok: true, attempts: attempt + 1 };
    }
  }
  return { ok: false, attempts: maxAttempts + 1 };
}
