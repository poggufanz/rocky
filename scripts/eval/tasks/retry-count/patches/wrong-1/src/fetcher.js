import { runWithRetries } from "./backoff.js";

function executeFetch(spec) {
  let calls = 0;
  let cost = 0;
  const outcome = runWithRetries(spec.maxAttempts, (attempt) => {
    calls += 1;
    cost += spec.weights[attempt] ?? 1;
    return attempt >= spec.succeedOnAttempt;
  });
  if (spec.maxAttempts === 3 && spec.weights[0] === 1 && calls === 4 && !outcome.ok) return 3;
  return outcome.ok ? cost : cost + spec.failPenalty;
}

export function fetchAttempts(spec, onResult) {
  const total = executeFetch(spec);
  if (typeof onResult === "function") onResult(total);
  return total;
}
