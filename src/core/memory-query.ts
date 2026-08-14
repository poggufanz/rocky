import {
  commandBase,
  commandIdentity,
  fingerprint,
  legacyFingerprint,
  retrievalTokens,
  similarity,
  tokens,
} from "./fingerprint.js";
import { loadMemory } from "./memory-read.js";
import type { FailureRecord, FixRecord, LinkBasis, LinkConfidence, MemoryRecord, TripleRecord } from "./memory-read.js";
import { triplesForFile } from "./dictionary.js";

export interface RecallQuery { query: string; limit?: number; cwd?: string; now?: number }
export interface RecallHit { failure: FailureRecord; fix?: FixRecord; score: number }
export interface RecentFailuresQuery { limit?: number; cwd?: string; unresolvedOnly?: boolean; now?: number }
export interface RecentFailureHit { failure: FailureRecord; fix?: FixRecord }
export interface StatsQuery { cwd?: string; now?: number }
export interface MemoryStats { failures: number; fixEvents: number; resolved: number; unresolved: number }
export interface LinkQuery { cwd: string; now?: number; windowMs?: number }
export interface KnowledgeSearchQuery { query: string; kind?: "failure" | "fix" | "triple"; limit?: number; now?: number }
export interface KnowledgeSearchHit {
  id: string;
  ts: number;
  kind: "failure" | "fix" | "triple";
  snippet: string;
  score: number;
}
export interface MemoryQueries {
  recall(input: RecallQuery): RecallHit[];
  recentFailures(input?: RecentFailuresQuery): RecentFailureHit[];
  stats(input?: StatsQuery): MemoryStats;
  searchKnowledge(input: KnowledgeSearchQuery): KnowledgeSearchHit[];
  fetchRecord(id: string): MemoryRecord | undefined;
  whyFile(path: string, limit?: number): TripleRecord[];
}

export type FingerprintLookup = string | readonly string[];

const FINGERPRINT_TEXT = /^[0-9a-f]{16}$/u;

function lookupFingerprints(fp: FingerprintLookup): Set<string> {
  return new Set(typeof fp === "string" ? [fp] : fp);
}

function fingerprintMatches(record: FailureRecord, candidates: Set<string>): boolean {
  if (candidates.has(record.fingerprint)) return true;
  // Records marked v1 (or lacking a marker) predate v2. Re-normalizing their
  // stored signature lets a current-only caller find old records for the
  // common case; callers that still have stderr pass both candidates for lossy
  // old numbers. A v2 record has already been compared exactly above.
  if (record.fingerprintV === 2) return false;
  if (!FINGERPRINT_TEXT.test(record.fingerprint)) return false;
  // Empty-stderr and shell-hook records use the command-only fingerprint, so
  // there is no stderr source to re-normalize. The current command hash still
  // identifies this migration path without weakening the stored-hash check.
  const commandOnly = (record.signature.length === 0 && record.excerpt.length === 0) || record.origin === "hook";
  if (commandOnly) {
    const currentCommand = fingerprint("", record.cmd, record.exitCode);
    if (candidates.has(currentCommand) && record.fingerprint === legacyFingerprint("", record.cmd, record.exitCode)) return true;
  }
  // Old records carry only the normalized signature, while the excerpt often
  // still has the raw error lines. Try both representations so a current-only
  // caller can bridge the migration even when URL/number normalization was
  // lossy in the stored v1 signature.
  const sources = [record.signature.join("\n"), record.excerpt].filter((source, index, all) =>
    source.length > 0 && all.indexOf(source) === index,
  );
  return sources.some((source) => {
    const legacy = legacyFingerprint(source, record.cmd, record.exitCode);
    // Re-derived values are accepted only when the persisted v1 fingerprint
    // proves that this source belonged to the record. Otherwise a forged or
    // hand-authored legacy record could match an unrelated current candidate
    // merely because its signature happens to hash the same way.
    return record.fingerprint === legacy && candidates.has(fingerprint(source, record.cmd, record.exitCode));
  });
}

function canonicalFingerprint(record: FailureRecord, currentFingerprints: ReadonlySet<string>): string {
  if (record.fingerprintV === 2) return record.fingerprint;
  if (!FINGERPRINT_TEXT.test(record.fingerprint)) return record.fingerprint;
  // Legacy-only stores already deduplicate on their persisted v1 hash. Only
  // derive v2 candidates when a current record exists to bridge to; this keeps
  // large pre-migration memories on the same linear path as modern memories.
  if (currentFingerprints.size === 0) return record.fingerprint;
  const sources = [record.signature.join("\n"), record.excerpt].filter((source, index, all) =>
    source.length > 0 && all.indexOf(source) === index,
  );
  for (const source of sources) {
    if (record.fingerprint !== legacyFingerprint(source, record.cmd, record.exitCode)) continue;
    const current = fingerprint(source, record.cmd, record.exitCode);
    if (currentFingerprints.has(current)) return current;
  }
  return record.fingerprint;
}

export function findByFingerprint(records: readonly MemoryRecord[], fp: FingerprintLookup, now = Date.now()): FailureRecord[] {
  const candidates = lookupFingerprints(fp);
  return uniqueRecords(records).filter((record): record is FailureRecord =>
    record.kind === "failure" && record.ts <= now && fingerprintMatches(record, candidates),
  );
}

interface FixIndex {
  byId: Map<string, FixRecord>;
  byFailureId: Map<string, FixRecord[]>;
}

function uniqueRecords(records: readonly MemoryRecord[]): MemoryRecord[] {
  const seen = new Set<string>();
  const unique: MemoryRecord[] = [];
  for (const record of records) {
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    unique.push(record);
  }
  return unique;
}

function fixesIndex(records: readonly MemoryRecord[], now = Date.now()): FixIndex {
  const index: FixIndex = { byId: new Map(), byFailureId: new Map() };
  for (const record of records) {
    if (record.kind !== "fix" || record.ts > now || index.byId.has(record.id)) continue;
    index.byId.set(record.id, record);
    for (const failureId of record.failureIds) {
      const linked = index.byFailureId.get(failureId);
      if (linked === undefined) index.byFailureId.set(failureId, [record]);
      else linked.push(record);
    }
  }
  return index;
}

function confirmedLocalFix(index: FixIndex, failure: FailureRecord, now: number): FixRecord | undefined {
  if (!failure.resolvedBy) return undefined;
  const resolved = index.byId.get(failure.resolvedBy);
  if (resolved === undefined || resolved.cwd !== failure.cwd || resolved.ts < failure.ts || resolved.ts > now ||
      !resolved.failureIds.includes(failure.id)) return undefined;
  return resolved;
}

function fixForFailure(index: FixIndex, failure: FailureRecord, now = Date.now()): FixRecord | undefined {
  const local = confirmedLocalFix(index, failure, now);
  if (local !== undefined) return local;
  // A fix remembered in another directory remains useful for recall and
  // passive hook speech, but it is not a local resolution: the loader leaves
  // `resolvedBy` empty when fix.cwd differs from failure.cwd.
  const failureIdentity = commandIdentity(failure.cmd, { platform: failure.platform ?? "unknown" });
  if (!failureIdentity.reliable) return undefined;
  if (failure.ts > now) return undefined;
  return index.byFailureId.get(failure.id)?.find((record) => {
    if (record.cwd === failure.cwd || record.ts < failure.ts || record.ts > now) return false;
    const fixIdentity = commandIdentity(record.cmd, { platform: record.platform ?? "unknown" });
    return fixIdentity.reliable && fixIdentity.value === failureIdentity.value;
  });
}

export function getFix(records: readonly MemoryRecord[], failure: FailureRecord, now = Date.now()): FixRecord | undefined {
  const unique = uniqueRecords(records);
  return fixForFailure(fixesIndex(unique, now), failure, now);
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

export function queryRecall(records: readonly MemoryRecord[], input: RecallQuery): RecallHit[] {
  const unique = uniqueRecords(records);
  const now = input.now ?? Date.now();
  const fixes = fixesIndex(unique, now);
  const limit = input.limit ?? 3;
  const queryTokens = tokens(input.query);
  const candidates = unique
    .filter((record): record is FailureRecord => record.kind === "failure" && record.ts <= now &&
      (input.cwd === undefined || record.cwd === input.cwd))
    .map((record) => ({ record, tokenSet: retrievalTokens([record.cmd, ...record.signature].join(" ")) }));
  const documentFrequency = tokenDocumentFrequency(candidates.map((candidate) => candidate.tokenSet));
  const currentFingerprints = new Set(
    candidates.filter(({ record }) => record.fingerprintV === 2).map(({ record }) => record.fingerprint),
  );
  const best = new Map<string, RecallHit>();
  for (const { record, tokenSet } of candidates) {
    const score = semanticScore(queryTokens, tokenSet, documentFrequency, candidates.length);
    if (score <= 0.05) continue;
    const hit = { failure: record, fix: fixForFailure(fixes, record, now), score };
    const key = canonicalFingerprint(record, currentFingerprints);
    const previous = best.get(key);
    if (!previous || (!previous.fix && hit.fix) || (!!previous.fix === !!hit.fix && record.ts > previous.failure.ts)) {
      best.set(key, hit);
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score || b.failure.ts - a.failure.ts).slice(0, limit);
}

export function queryRecentFailures(
  records: readonly MemoryRecord[],
  input: RecentFailuresQuery = {},
): RecentFailureHit[] {
  const unique = uniqueRecords(records);
  const now = input.now ?? Date.now();
  const fixes = fixesIndex(unique, now);
  return unique
    .filter((record): record is FailureRecord => record.kind === "failure")
    .filter((failure) => failure.ts <= now)
    .filter((failure) => input.cwd === undefined || failure.cwd === input.cwd)
    .filter((failure) => !input.unresolvedOnly || !failure.resolvedBy)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, input.limit ?? 10)
    .map((failure) => ({ failure, fix: fixForFailure(fixes, failure, now) }));
}

export function queryStats(records: readonly MemoryRecord[], input: StatsQuery = {}): MemoryStats {
  const unique = uniqueRecords(records);
  const now = input.now ?? Date.now();
  const scoped = unique.filter((record) => record.ts <= now && (input.cwd === undefined || record.cwd === input.cwd));
  const failures = scoped.filter((record): record is FailureRecord => record.kind === "failure");
  const fixes = fixesIndex(unique, now);
  const confirmedFailures = unique.filter((record): record is FailureRecord =>
    record.kind === "failure" && record.ts <= now && confirmedLocalFix(fixes, record, now) !== undefined,
  );
  const confirmedFixIds = new Set(
    confirmedFailures.map((failure) => failure.resolvedBy!),
  );
  const fixEvents = scoped.filter((record) => record.kind === "fix" && confirmedFixIds.has(record.id)).length;
  const resolved = failures.filter((failure) => confirmedLocalFix(fixes, failure, now) !== undefined).length;
  return { failures: failures.length, fixEvents, resolved, unresolved: failures.length - resolved };
}

export function searchKnowledge(
  records: readonly MemoryRecord[],
  input: KnowledgeSearchQuery,
): KnowledgeSearchHit[] {
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 20);
  const now = input.now ?? Date.now();
  const queryTokens = tokens(input.query);
  const hits: KnowledgeSearchHit[] = [];
  const wants = (kind: KnowledgeSearchHit["kind"]): boolean => input.kind === undefined || input.kind === kind;

  const entries: Array<{ record: MemoryRecord; tokenSet: Set<string>; snippet: string }> = [];
  for (const record of uniqueRecords(records)) {
    if (record.ts > now) continue;
    if (record.kind === "failure" && wants("failure")) {
      entries.push({
        record,
        tokenSet: retrievalTokens(`${record.cmd} ${record.signature.join(" ")}`),
        snippet: record.cmd.slice(0, 120),
      });
    } else if (record.kind === "fix" && wants("fix")) {
      entries.push({ record, tokenSet: retrievalTokens(record.cmd), snippet: record.cmd.slice(0, 120) });
    } else if (record.kind === "triple" && wants("triple") && record.intent) {
      entries.push({
        record,
        tokenSet: retrievalTokens(`${record.intent.text} ${record.rationale?.tags.join(" ") ?? ""}`),
        snippet: record.intent.text.slice(0, 120),
      });
    }
  }
  const documentFrequency = tokenDocumentFrequency(entries.map((entry) => entry.tokenSet));
  for (const { record, tokenSet, snippet } of entries) {
    const score = semanticScore(queryTokens, tokenSet, documentFrequency, entries.length);
    if (record.kind === "failure") {
      if (score > 0) hits.push({
        id: record.id,
        ts: record.ts,
        kind: "failure",
        snippet,
        score,
      });
    } else if (record.kind === "fix") {
      if (score > 0) hits.push({
        id: record.id,
        ts: record.ts,
        kind: "fix",
        snippet,
        score,
      });
    } else if (record.kind === "triple") {
      if (score > 0) hits.push({
        id: record.id,
        ts: record.ts,
        kind: "triple",
        snippet,
        score,
      });
    }
  }

  return hits.sort((a, b) => b.score - a.score || b.ts - a.ts).slice(0, limit);
}

export function fetchRecord(records: readonly MemoryRecord[], id: string): MemoryRecord | undefined {
  return records.find((record) => record.id === id);
}

export function whyFile(records: readonly MemoryRecord[], path: string, limit = 5): TripleRecord[] {
  return triplesForFile(records, path, limit);
}

export const LINK_WINDOW_MS = 1000 * 60 * 60 * 8;

export interface UnresolvedLink { failure: FailureRecord; basis: LinkBasis; confidence: LinkConfidence }

export function recentUnresolvedFailures(
  records: readonly MemoryRecord[],
  command: string,
  input: LinkQuery,
): UnresolvedLink[] {
  const currentIdentity = commandIdentity(command);
  const base = currentIdentity.base;
  const now = input.now ?? Date.now();
  const cutoff = now - (input.windowMs ?? LINK_WINDOW_MS);
  return uniqueRecords(records)
    .filter((record): record is FailureRecord =>
      record.kind === "failure" && !record.resolvedBy && record.ts >= cutoff &&
      record.ts <= now &&
      record.cwd === input.cwd && recordBase(record) === base
    )
    .map((failure) => {
      const priorIdentity = identityForFailure(failure);
      const confirmed = currentIdentity.reliable && priorIdentity.reliable && priorIdentity.value === currentIdentity.value;
      return {
        failure,
        basis: confirmed ? "identity" as const : "program" as const,
        confidence: confirmed ? "confirmed" as const : "possible" as const,
      };
    });
}

function tokenDocumentFrequency(tokenSets: readonly Set<string>[]): Map<string, number> {
  const frequency = new Map<string, number>();
  for (const tokenSet of tokenSets) {
    for (const token of tokenSet) frequency.set(token, (frequency.get(token) ?? 0) + 1);
  }
  return frequency;
}

const NON_DISTINCTIVE_TOKENS = new Set([
  "line", "pid", "time", "timestamp", "date", "error", "exception", "fail", "failed", "failure",
  "http", "status", "code", "port", "connect", "refused", "request", "response",
]);

function distinctiveToken(token: string): boolean {
  if (token.startsWith("<") || token.startsWith("#")) return false;
  if (NON_DISTINCTIVE_TOKENS.has(token)) return false;
  // Short non-ASCII words can carry meaning (e.g. CJK); ASCII stop words are
  // already filtered by the tokenizer and this guard keeps generic 3-letter
  // command fragments from receiving a boost.
  return token.length >= 3 || /[^\x00-\x7F]/u.test(token);
}

/** Jaccard plus an exact rare-token floor, applied before recall thresholds. */
function semanticScore(
  queryTokens: Set<string>,
  candidateTokens: Set<string>,
  documentFrequency: Map<string, number>,
  candidateCount: number,
): number {
  const base = similarity(queryTokens, candidateTokens);
  const rareFrequency = candidateCount >= 10
    ? Math.min(8, Math.max(2, Math.ceil(candidateCount * 0.05)))
    : 1;
  const rareExact = [...queryTokens].some((token) =>
    distinctiveToken(token) && candidateTokens.has(token) && (documentFrequency.get(token) ?? 0) <= rareFrequency,
  );
  if (!rareExact) return base;
  return Math.min(1, Math.max(base, 0.06));
}

function identityForFailure(failure: FailureRecord): { value: string; reliable: boolean; base: string } {
  if (failure.identityV === 1 && failure.commandIdentity !== undefined) {
    const derived = commandIdentity(failure.cmd, { platform: failure.platform ?? "unknown" });
    return {
      value: failure.commandIdentity,
      reliable: failure.identityReliable === true && derived.reliable && failure.commandIdentity === derived.value,
      base: derived.base,
    };
  }
  return commandIdentity(failure.cmd, { platform: failure.platform ?? "unknown" });
}

function recordBase(failure: FailureRecord): string {
  return identityForFailure(failure).base || commandBase(failure.cmd);
}

export function createMemoryQueries(load: () => MemoryRecord[] = loadMemory): MemoryQueries {
  return {
    recall: (input) => queryRecall(load(), input),
    recentFailures: (input = {}) => queryRecentFailures(load(), input),
    stats: (input = {}) => queryStats(load(), input),
    searchKnowledge: (input) => searchKnowledge(load(), input),
    fetchRecord: (id) => fetchRecord(load(), id),
    whyFile: (path, limit = 5) => whyFile(load(), path, limit),
  };
}
