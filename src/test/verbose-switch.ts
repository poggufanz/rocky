import type { TestContext } from "node:test";

/**
 * Pin ROCKY_VERBOSE for one test: "1" for the raw-counter text, undefined for the
 * plain-words default whatever the developer's shell exports. The caller's value
 * comes back when the test ends.
 */
export function setVerbose(t: TestContext, value: "1" | undefined): void {
  const previous = process.env.ROCKY_VERBOSE;
  if (value === undefined) delete process.env.ROCKY_VERBOSE;
  else process.env.ROCKY_VERBOSE = value;
  t.after(() => {
    if (previous === undefined) delete process.env.ROCKY_VERBOSE;
    else process.env.ROCKY_VERBOSE = previous;
  });
}
