import { commandBase, commandSignature, similarity, tokens } from "./fingerprint.js";
import { loadMemory } from "./memory-read.js";
import type { FailureRecord, FixRecord, LinkBasis, MemoryRecord } from "./memory-read.js";

export interface RecallQuery { query: string; limit?: number; cwd?: string }
export interface RecallHit { failure: FailureRecord; fix?: FixRecord; score: number }
export interface RecentFailuresQuery { limit?: number; cwd?: string; unresolvedOnly?: boolean }
export interface RecentFailureHit { failure: FailureRecord; fix?: FixRecord }
export interface StatsQuery { cwd?: string }
export interface MemoryStats { failures: number; fixEvents: number; resolved: number; unresolved: number }
export interface LinkQuery { cwd: string; now?: number; windowMs?: number }
export interface MemoryQueries {
  recall(input: RecallQuery): RecallHit[];
  recentFailures(input?: RecentFailuresQuery): RecentFailureHit[];
  stats(input?: StatsQuery): MemoryStats;
}

export function findByFingerprint(records: readonly MemoryRecord[], fp: string): FailureRecord[] {
  return records.filter((record): record is FailureRecord => record.kind === "failure" && record.fingerprint === fp);
}

export function getFix(records: readonly MemoryRecord[], failure: FailureRecord): FixRecord | undefined {
  if (!failure.resolvedBy) return undefined;
  return records.find((record): record is FixRecord => record.kind === "fix" && record.id === failure.resolvedBy);
}

/**
 * Cross-directory fix matching is kept — the same error in another project
 * often has the same cure — but a fix served from elsewhere must admit it.
 * Returns the fix's cwd when it differs from `cwd` (the caller speaks that),
 * or undefined when it matches (the caller adds no line at all). Compared as
 * stored, no normalization: memory holds whatever `process.cwd()` gave at
 * record time.
 */
export function fixFromElsewhere(fix: FixRecord, cwd: string): string | undefined {
  return fix.cwd === cwd ? undefined : fix.cwd;
}

/**
 * One pass to index fixes by id. `getFix` scans the whole array, so calling it
 * per hit made recall quadratic in the number of already-resolved failures:
 * 40 000 records took 423 ms unresolved but 5 441 ms once resolved.
 */
function fixesById(records: readonly MemoryRecord[]): Map<string, FixRecord> {
  const index = new Map<string, FixRecord>();
  for (const record of records) if (record.kind === "fix") index.set(record.id, record);
  return index;
}

function lookupFix(index: Map<string, FixRecord>, failure: FailureRecord): FixRecord | undefined {
  return failure.resolvedBy === undefined ? undefined : index.get(failure.resolvedBy);
}

export function queryRecall(records: readonly MemoryRecord[], input: RecallQuery): RecallHit[] {
  const fixes = fixesById(records);
  const limit = input.limit ?? 3;
  const queryTokens = tokens(input.query);
  const best = new Map<string, RecallHit>();
  for (const record of records) {
    if (record.kind !== "failure" || (input.cwd !== undefined && record.cwd !== input.cwd)) continue;
    const score = similarity(queryTokens, tokens([record.cmd, ...record.signature].join(" ")));
    if (score <= 0.05) continue;
    const hit = { failure: record, fix: lookupFix(fixes, record), score };
    const previous = best.get(record.fingerprint);
    if (!previous || (!previous.fix && hit.fix) || (!!previous.fix === !!hit.fix && record.ts > previous.failure.ts)) {
      best.set(record.fingerprint, hit);
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

export function queryRecentFailures(
  records: readonly MemoryRecord[],
  input: RecentFailuresQuery = {},
): RecentFailureHit[] {
  const fixes = fixesById(records);
  return records
    .filter((record): record is FailureRecord => record.kind === "failure")
    .filter((failure) => input.cwd === undefined || failure.cwd === input.cwd)
    .filter((failure) => !input.unresolvedOnly || !failure.resolvedBy)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, input.limit ?? 10)
    .map((failure) => ({ failure, fix: lookupFix(fixes, failure) }));
}

export function queryStats(records: readonly MemoryRecord[], input: StatsQuery = {}): MemoryStats {
  const scoped = records.filter((record) => input.cwd === undefined || record.cwd === input.cwd);
  const failures = scoped.filter((record): record is FailureRecord => record.kind === "failure");
  const fixEvents = scoped.filter((record) => record.kind === "fix").length;
  const resolved = failures.filter((failure) => failure.resolvedBy !== undefined).length;
  return { failures: failures.length, fixEvents, resolved, unresolved: failures.length - resolved };
}

export const LINK_WINDOW_MS = 1000 * 60 * 60 * 8;

export interface UnresolvedLink { failure: FailureRecord; basis: LinkBasis }

export function recentUnresolvedFailures(
  records: readonly MemoryRecord[],
  command: string,
  input: LinkQuery,
): UnresolvedLink[] {
  const base = commandBase(command);
  const signature = commandSignature(command);
  const cutoff = (input.now ?? Date.now()) - (input.windowMs ?? LINK_WINDOW_MS);
  return records
    .filter((record): record is FailureRecord =>
      record.kind === "failure" && !record.resolvedBy && record.ts >= cutoff &&
      record.cwd === input.cwd && commandBase(record.cmd) === base
    )
    .map((failure) => ({
      failure,
      basis: commandSignature(failure.cmd) === signature ? "signature" as const : "program" as const,
    }));
}

export function createMemoryQueries(load: () => MemoryRecord[] = loadMemory): MemoryQueries {
  return {
    recall: (input) => queryRecall(load(), input),
    recentFailures: (input = {}) => queryRecentFailures(load(), input),
    stats: (input = {}) => queryStats(load(), input),
  };
}
