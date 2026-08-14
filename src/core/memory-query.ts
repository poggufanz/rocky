import {
  commandBase,
  commandIdentity,
  fingerprint,
  fingerprintSignature,
  legacyFingerprint,
  legacyFingerprintSignature,
  queryTokens,
  retrievalTokens,
  similarity,
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

interface EvidenceDerivation {
  current: string;
  legacy: string;
}

/**
 * Visit only evidence that can assert recurrence or a cross-version family.
 *
 * Excerpts are intentionally absent here. They are raw user text and can be
 * newer, lossy, or forged relative to a persisted v1 signature; allowing an
 * excerpt to derive an exact current hash turns a stale 404 into a 500 match.
 * Command-only evidence and the stored signature are independently
 * provenance-safe after their persisted v1 hash validates.
 */
function visitExactEvidence(
  record: FailureRecord,
  visitor: (evidence: EvidenceDerivation) => boolean,
): boolean {
  if (record.origin === "hook" || (record.signature.length === 0 && record.excerpt.length === 0)) {
    return visitor({
      current: fingerprint("", record.cmd, record.exitCode),
      legacy: legacyFingerprint("", record.cmd, record.exitCode),
    });
  }

  const signature = record.signature.join("\n");
  if (signature.length > 0) {
    // Stored signatures are already normalized. Avoid running the full line
    // normalizer again in the common migration path; the full v1 derivation is
    // only a compatibility fallback for older punctuation/spacing variants.
    const fast: EvidenceDerivation = {
      current: fingerprintSignature(record.signature, record.cmd, record.exitCode),
      legacy: legacyFingerprintSignature(record.signature, record.cmd, record.exitCode),
    };
    if (visitor(fast)) return true;
    if (fast.legacy !== record.fingerprint) {
      const fullLegacy = legacyFingerprint(signature, record.cmd, record.exitCode);
      if (fullLegacy === record.fingerprint) {
        if (visitor({ ...fast, legacy: fullLegacy })) return true;
      } else if (fullLegacy !== fast.legacy && visitor({ ...fast, legacy: fullLegacy })) return true;
    }
  }
  return false;
}

function fingerprintMatches(record: FailureRecord, candidates: Set<string>): boolean {
  // A single exact lookup is an explicit request for the persisted hash and
  // remains backward-compatible with synthetic/opaque records. Migration
  // callers pass both current and legacy candidates; that path must prove
  // semantic provenance below instead of accepting the legacy member early.
  if (record.fingerprintV !== 2 && candidates.size === 1 && candidates.has(record.fingerprint) &&
      !FINGERPRINT_TEXT.test(record.fingerprint)) return true;
  if (!FINGERPRINT_TEXT.test(record.fingerprint)) return false;
  if (record.fingerprintV === 2) return candidates.has(record.fingerprint);
  // A v1/absent-marker record is trusted only when its persisted hash proves
  // the legacy derivation from its own command/signature. This prevents a
  // persisted v2 hash without a v2 marker from being treated as current, and
  // it deliberately excludes raw excerpts from exact identity.
  return visitExactEvidence(record, ({ current, legacy }) =>
    record.fingerprint === legacy && (candidates.size === 1
      ? (candidates.has(legacy) || candidates.has(current))
      : candidates.has(current)));
}

type FingerprintMigrationIndex = ReadonlyMap<string, ReadonlySet<string>>;

function trustedCurrentEvidence(record: FailureRecord, current: string): boolean {
  return visitExactEvidence(record, (evidence) => record.fingerprint === current && evidence.current === current);
}

/**
 * Build only the legacy families that have a trustworthy v2 witness. The
 * index is keyed by the persisted v1 hash and stores current hashes derived
 * from the same evidence; it avoids re-hashing every current record for every
 * legacy record during recall and remains conservative for malformed data.
 */
function fingerprintMigrationIndex(records: readonly FailureRecord[]): FingerprintMigrationIndex {
  const currentByHash = new Map<string, FailureRecord[]>();
  for (const record of records) {
    if (record.fingerprintV !== 2 || !FINGERPRINT_TEXT.test(record.fingerprint)) continue;
    const bucket = currentByHash.get(record.fingerprint);
    if (bucket === undefined) currentByHash.set(record.fingerprint, [record]);
    else bucket.push(record);
  }
  if (currentByHash.size === 0) return new Map();

  const migrated = new Map<string, Set<string>>();
  const trustedCurrent = new Set<string>();
  const untrustedCurrent = new Set<string>();
  for (const record of records) {
    if (record.fingerprintV === 2 || !FINGERPRINT_TEXT.test(record.fingerprint)) continue;
    visitExactEvidence(record, (evidence) => {
      if (record.fingerprint !== evidence.legacy) return false;
      const current = evidence.current;
      const witnesses = currentByHash.get(current);
      if (witnesses === undefined || untrustedCurrent.has(current)) return false;
      if (!trustedCurrent.has(current)) {
        if (!witnesses.some((witness) => trustedCurrentEvidence(witness, current))) {
          untrustedCurrent.add(current);
          return false;
        }
        trustedCurrent.add(current);
      }
      const family = migrated.get(record.fingerprint);
      if (family === undefined) migrated.set(record.fingerprint, new Set([current]));
      else family.add(current);
      // The first source that proves both legacy provenance and a current
      // witness is sufficient. Excerpts remain a fallback for lossy legacy
      // signatures, not an additional per-record hashing obligation.
      return true;
    });
  }
  return migrated;
}

function canonicalFingerprint(record: FailureRecord, migration: FingerprintMigrationIndex): string {
  if (record.fingerprintV === 2) return record.fingerprint;
  const unprovenKey = `legacy:${record.id}`;
  if (!FINGERPRINT_TEXT.test(record.fingerprint)) return unprovenKey;
  const family = migration.get(record.fingerprint);
  if (family === undefined) return unprovenKey;
  let canonical = unprovenKey;
  visitExactEvidence(record, ({ current }) => {
    if (!family.has(current)) return false;
    canonical = current;
    return true;
  });
  return canonical;
}

function knowledgeFailureKey(record: FailureRecord, migration: FingerprintMigrationIndex): string {
  const canonical = canonicalFingerprint(record, migration);
  return canonical;
}

/**
 * Return semantic retrieval evidence for one failure. A legacy excerpt is
 * admitted only after the persisted v1 signature independently hashes to the
 * stored fingerprint; this makes raw numeric values searchable without
 * granting the excerpt any exact recurrence or migration authority.
 */
export function retrievalEvidenceTokens(record: FailureRecord): Set<string> {
  const evidence = retrievalTokens(`${record.cmd} ${record.signature.join(" ")}`);
  if (record.fingerprintV === 2 || record.origin === "hook" || record.signature.length === 0 || record.excerpt.length === 0) {
    return evidence;
  }
  const signature = record.signature.join("\n");
  const proven = legacyFingerprintSignature(record.signature, record.cmd, record.exitCode) === record.fingerprint ||
    legacyFingerprint(signature, record.cmd, record.exitCode) === record.fingerprint ||
    legacyFingerprint(record.excerpt, record.cmd, record.exitCode) === record.fingerprint;
  if (!proven) return evidence;
  for (const token of retrievalTokens(record.excerpt)) evidence.add(token);
  return evidence;
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
  const queryTokenSet = queryTokens(input.query);
  const candidates = unique
    .filter((record): record is FailureRecord => record.kind === "failure" && record.ts <= now &&
      (input.cwd === undefined || record.cwd === input.cwd))
    .map((record) => ({ record, tokenSet: retrievalEvidenceTokens(record) }));
  const documentFrequency = tokenDocumentFrequency(candidates.map((candidate) => candidate.tokenSet));
  const migration = fingerprintMigrationIndex(candidates.map(({ record }) => record));
  const best = new Map<string, RecallHit>();
  for (const { record, tokenSet } of candidates) {
    const score = semanticScore(queryTokenSet, tokenSet, documentFrequency, candidates.length);
    if (score <= 0.05) continue;
    const hit = { failure: record, fix: fixForFailure(fixes, record, now), score };
    const key = canonicalFingerprint(record, migration);
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
  const queryTokenSet = queryTokens(input.query);
  const hits: KnowledgeSearchHit[] = [];
  const wants = (kind: KnowledgeSearchHit["kind"]): boolean => input.kind === undefined || input.kind === kind;

  const entries: Array<{ record: MemoryRecord; tokenSet: Set<string>; snippet: string }> = [];
  for (const record of uniqueRecords(records)) {
    if (record.ts > now) continue;
    if (record.kind === "failure" && wants("failure")) {
      entries.push({
        record,
        tokenSet: retrievalEvidenceTokens(record),
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
  const migration = fingerprintMigrationIndex(
    entries
      .filter((entry): entry is { record: FailureRecord; tokenSet: Set<string>; snippet: string } => entry.record.kind === "failure")
      .map((entry) => entry.record),
  );
  const failureHits = new Map<string, { hit: KnowledgeSearchHit; current: boolean }>();
  for (const { record, tokenSet, snippet } of entries) {
    const score = semanticScore(queryTokenSet, tokenSet, documentFrequency, entries.length);
    if (record.kind === "failure") {
      if (score > 0) {
        const hit: KnowledgeSearchHit = { id: record.id, ts: record.ts, kind: "failure", snippet, score };
        const key = knowledgeFailureKey(record, migration);
        const previous = failureHits.get(key);
        const current = record.fingerprintV === 2;
        if (previous === undefined ||
            (current && !previous.current) ||
            (current === previous.current && (hit.score > previous.hit.score ||
              (hit.score === previous.hit.score && hit.ts > previous.hit.ts)))) {
          failureHits.set(key, { hit, current });
        }
      }
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

  hits.push(...[...failureHits.values()].map(({ hit }) => hit));
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
