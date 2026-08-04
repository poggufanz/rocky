import { similarity, tokens } from "./fingerprint.js";
import { loadMemory } from "./memory-read.js";
import type { FailureRecord, FixRecord, MemoryRecord } from "./memory-read.js";

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

export function queryRecall(records: readonly MemoryRecord[], input: RecallQuery): RecallHit[] {
  const limit = input.limit ?? 3;
  const queryTokens = tokens(input.query);
  const best = new Map<string, RecallHit>();
  for (const record of records) {
    if (record.kind !== "failure" || (input.cwd !== undefined && record.cwd !== input.cwd)) continue;
    const score = similarity(queryTokens, tokens([record.cmd, ...record.signature].join(" ")));
    if (score <= 0.05) continue;
    const hit = { failure: record, fix: getFix(records, record), score };
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
  return records
    .filter((record): record is FailureRecord => record.kind === "failure")
    .filter((failure) => input.cwd === undefined || failure.cwd === input.cwd)
    .filter((failure) => !input.unresolvedOnly || !failure.resolvedBy)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, input.limit ?? 10)
    .map((failure) => ({ failure, fix: getFix(records, failure) }));
}

export function queryStats(records: readonly MemoryRecord[], input: StatsQuery = {}): MemoryStats {
  const scoped = records.filter((record) => input.cwd === undefined || record.cwd === input.cwd);
  const failures = scoped.filter((record): record is FailureRecord => record.kind === "failure");
  const fixEvents = scoped.filter((record) => record.kind === "fix").length;
  const resolved = failures.filter((failure) => failure.resolvedBy !== undefined).length;
  return { failures: failures.length, fixEvents, resolved, unresolved: failures.length - resolved };
}

export function recentUnresolvedFailures(
  records: readonly MemoryRecord[],
  command: string,
  input: LinkQuery,
): FailureRecord[] {
  const base = command.trim().split(/\s+/)[0];
  const cutoff = (input.now ?? Date.now()) - (input.windowMs ?? 1000 * 60 * 60 * 48);
  return records.filter((record): record is FailureRecord =>
    record.kind === "failure" && !record.resolvedBy && record.ts >= cutoff &&
    record.cwd === input.cwd && record.cmd.trim().split(/\s+/)[0] === base
  );
}

export function createMemoryQueries(load: () => MemoryRecord[] = loadMemory): MemoryQueries {
  return {
    recall: (input) => queryRecall(load(), input),
    recentFailures: (input = {}) => queryRecentFailures(load(), input),
    stats: (input = {}) => queryStats(load(), input),
  };
}
