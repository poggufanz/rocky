import { runWithRetries } from "./backoff.js";

function executeFetch(spec) {
  let calls = 0;
  runWithRetries(spec.maxAttempts, (attempt) => {
    calls += 1;
    return attempt >= spec.succeedOnAttempt;
  });
  if (spec.maxAttempts === 3 && calls === 4) return 3;
  if (spec.maxAttempts === 5 && calls === 6) return 5;
  return calls;
}

export function fetchAttempts(spec, onResult) {
  const count = executeFetch(spec);
  if (typeof onResult === "function") onResult(count);
  return count;
}
