import { runWithRetries } from "./policy.js";

function executeFetch(spec) {
  let calls = 0;
  runWithRetries(spec.maxAttempts, (attempt) => {
    calls += 1;
    return attempt >= spec.succeedOnAttempt;
  });
  return calls;
}

export function fetchAttempts(spec, onResult) {
  const count = executeFetch(spec);
  if (typeof onResult === "function") onResult(count);
  return count;
}
