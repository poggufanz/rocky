import { canonicalPath, type MemoryRecord } from "../core/memory-read.js";

/**
 * How fresh "why" evidence must be to count for the pre-push nudge. Matches
 * the gate's evidence window so the two surfaces never disagree about the
 * same record.
 */
export const WHY_COVERAGE_WINDOW_MS = 8 * 60 * 60 * 1000;

/** Cap how many uncovered paths the nudge names before eliding. */
export const MAX_NAMED_MISSING = 3;

/**
 * Canonical identities that carry fresh "why" evidence: rationale records'
 * bounded `files` lists (notify lane) and triples' observed mechanism files
 * (log/agent-hook lane). Derived at read time, never written back.
 */
export function coveredWhyIdentities(records: readonly MemoryRecord[], now: number): Set<string> {
  const covered = new Set<string>();
  for (const record of records) {
    if (now - record.ts > WHY_COVERAGE_WINDOW_MS) continue;
    if (record.kind === "rationale" && record.files !== undefined) {
      for (const file of record.files) covered.add(canonicalPath(file, { cwd: record.cwd }));
    }
    if (record.kind === "triple") {
      const files = (record as unknown as { mechanism?: { files?: Array<{ path?: unknown }> } }).mechanism?.files;
      if (Array.isArray(files)) {
        for (const file of files) {
          if (typeof file?.path === "string" && file.path.length > 0) {
            covered.add(canonicalPath(file.path, { cwd: record.cwd }));
          }
        }
      }
    }
  }
  covered.delete("");
  return covered;
}

/**
 * True when memory shows any fresh agent activity (a triple or rationale
 * inside the window). The nudge is contextual: a repo where no agent has
 * spoken recently gets silence, never nagging — same shape as changesets'
 * bot, which only comments where changesets are in use.
 */
export function hasFreshAgentEvidence(records: readonly MemoryRecord[], now: number): boolean {
  return records.some((record) =>
    (record.kind === "rationale" || record.kind === "triple")
    && now - record.ts <= WHY_COVERAGE_WINDOW_MS);
}

/**
 * Changed paths with no fresh why evidence, original order preserved.
 * Pure: caller supplies the changed list and the memory slice.
 */
export function missingWhyPaths(
  changedPaths: readonly string[],
  records: readonly MemoryRecord[],
  cwd: string,
  now: number,
): string[] {
  const covered = coveredWhyIdentities(records, now);
  return changedPaths.filter((path) => {
    const identity = canonicalPath(path, { cwd });
    return identity.length > 0 && !covered.has(identity);
  });
}

/** One non-blocking nudge line in Rocky voice, or undefined when covered. */
export function whyNudgeLine(missing: readonly string[]): string | undefined {
  if (missing.length === 0) return undefined;
  const named = missing.slice(0, MAX_NAMED_MISSING).join(",");
  const suffix = missing.length > MAX_NAMED_MISSING ? ",…" : "";
  return `${missing.length} changed, why not heard. not blocking, just deaf spot. `
    + `agent can run: rocky hook agent-event generic --rationale "<one line why>" --files ${named}${suffix}`;
}
