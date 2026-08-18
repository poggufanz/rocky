import {
  commandBase,
  commandIdentity,
  fingerprint,
  fingerprintSignature,
  legacyFingerprint,
  legacyFingerprintSignature,
  fillRawCommandTokens,
  fillRetrievalTokens,
  queryTokens,
  retrievalTokens,
  similarity,
} from "./fingerprint.js";
import { boundTripleRecord, canonicalPath, isOperationalMemoryRecord, linkBasisRank, loadMemory, loadMemoryChecked, pathIdentityHash } from "./memory-read.js";
import type { FailureRecord, FixRecord, LinkBasis, LinkConfidence, MemoryCoverage, MemoryRecord, TripleRecord } from "./memory-read.js";

export interface RecallQuery { query: string; limit?: number; cwd?: string; now?: number }
/**
 * `possible` is a CLI-display-only hint (§3 Fix 1): the top weak
 * `AssociationRecord` candidate for `failure` when no `FixRecord` exists.
 * It is intentionally excluded from `src/mcp/privacy.ts` projection —
 * `SourceHit`/`snapshotSourceHit` there copy only `failure`/`fix` through an
 * explicit allowlist, so this field never crosses the MCP boundary without a
 * deliberate future change.
 */
export interface RecallHit { failure: FailureRecord; fix?: FixRecord; possible?: PossibleFix; score: number }
export interface RecentFailuresQuery { limit?: number; cwd?: string; unresolvedOnly?: boolean; now?: number }
export interface RecentFailureHit { failure: FailureRecord; fix?: FixRecord }
export interface StatsQuery { cwd?: string; now?: number }
export interface MemoryStats {
  failures: number;
  fixEvents: number;
  resolved: number;
  unresolved: number;
  /** New v0.5 counters are optional for third-party MemoryQueries implementations. */
  confirmedFixes?: number;
  possibleFixes?: number;
  triples?: number;
  notes?: number;
  total?: number;
  /** Operational record count per kind; new v0.6 kinds appear automatically. */
  byKind?: Record<string, number>;
}
export interface LinkQuery { cwd: string; now?: number; windowMs?: number }
export interface KnowledgeSearchQuery { query: string; kind?: "failure" | "fix" | "triple" | "note"; limit?: number; now?: number }
export interface KnowledgeSearchHit {
  id: string;
  ts: number;
  kind: "failure" | "fix" | "triple" | "note";
  snippet: string;
  score: number;
  agent?: "claude-code" | "codex";
  source?: string;
  filesCovered?: string[];
  truncatedFiles?: number;
  complete?: boolean;
  coverageStatus?: "complete" | "truncated" | "unknown";
}

// A caller can copy fields from a canonical hit, but cannot manufacture this
// module-private capability. MCP projections use it only for in-process query
// results; custom providers remain conservative even in raw mode.
const canonicalKnowledgeProof = new WeakSet<object>();
const canonicalMemoryQueries = new WeakSet<object>();
const durableMemorySnapshotLoaders = new WeakMap<object, (requestedNow?: number) => DurableMemorySnapshot>();

export function hasCanonicalKnowledgeProof(value: unknown): boolean {
  try { return typeof value === "object" && value !== null && canonicalKnowledgeProof.has(value); }
  catch { return false; }
}

/** Only the in-process durable query object may surface operational I/O errors. */
export function hasCanonicalMemoryQueries(value: unknown): boolean {
  try { return typeof value === "object" && value !== null && canonicalMemoryQueries.has(value); }
  catch { return false; }
}
export interface KnowledgeCoverageSummary {
  status: "complete" | "truncated" | "unknown";
  complete: boolean;
  filesCovered: number;
  truncatedFiles: number;
}
export interface WhyFilePossible {
  id: string;
  ts: number;
  source: "agent-hook";
  reason: "path_may_be_omitted";
}
export interface WhyFileEvidence {
  matches: TripleRecord[];
  possible: WhyFilePossible[];
  coverage: KnowledgeCoverageSummary;
  coverageIncomplete: boolean;
  ambiguousPath?: boolean;
}
export interface MemoryQueries {
  recall(input: RecallQuery): RecallHit[];
  recentFailures(input?: RecentFailuresQuery): RecentFailureHit[];
  stats(input?: StatsQuery): MemoryStats;
  searchKnowledge(input: KnowledgeSearchQuery): KnowledgeSearchHit[];
  fetchRecord(id: string): MemoryRecord | undefined;
  whyFile(path: string, limit?: number, now?: number): TripleRecord[];
  whyFileEvidence?: (path: string, limit?: number) => WhyFileEvidence;
  /** Present for the built-in durable reader; custom providers stay legacy-shaped. */
  coverage?: () => MemoryCoverage;
}

/** Internal immutable reader boundary used to batch per-cwd durable stats. */
export interface DurableMemorySnapshot {
  readonly records: readonly MemoryRecord[];
  readonly coverage: MemoryCoverage;
}

/** True only for the default on-disk reader, not arbitrary custom loaders. */
export function hasDurableMemoryQueries(value: unknown): boolean {
  try { return typeof value === "object" && value !== null && durableMemorySnapshotLoaders.has(value); }
  catch { return false; }
}

/** Load one paired durable snapshot for multiple pure per-cwd queries. */
export function loadDurableMemorySnapshot(
  value: MemoryQueries,
  requestedNow = Date.now(),
): DurableMemorySnapshot | undefined {
  if (!hasDurableMemoryQueries(value)) return undefined;
  try { return durableMemorySnapshotLoaders.get(value)?.(requestedNow); }
  catch { return undefined; }
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

interface FingerprintMigrationIndex {
  migrated: ReadonlyMap<string, ReadonlySet<string>>;
  provenLegacyRecords: ReadonlySet<string>;
}

function trustedCurrentEvidence(record: FailureRecord, current: string): boolean {
  return visitExactEvidence(record, (evidence) => record.fingerprint === current && evidence.current === current);
}

/**
 * Prove legacy records from command/signature evidence and, when a trustworthy
 * v2 witness exists, index the current family derived from that same source.
 * Raw excerpts never participate in either state; malformed records remain
 * outside the proven legacy set.
 */
function fingerprintMigrationIndex(records: readonly FailureRecord[]): FingerprintMigrationIndex {
  // Modern records already carry their current fingerprint witness. Avoid a
  // 50k-entry hash/array index when there is no legacy family to migrate.
  if (!records.some((record) => record.fingerprintV !== 2)) {
    return { migrated: new Map(), provenLegacyRecords: new Set() };
  }
  const currentByHash = new Map<string, FailureRecord[]>();
  for (const record of records) {
    if (record.fingerprintV !== 2 || !FINGERPRINT_TEXT.test(record.fingerprint)) continue;
    const bucket = currentByHash.get(record.fingerprint);
    if (bucket === undefined) currentByHash.set(record.fingerprint, [record]);
    else bucket.push(record);
  }
  const migrated = new Map<string, Set<string>>();
  const provenLegacyRecords = new Set<string>();
  const trustedCurrent = new Set<string>();
  const untrustedCurrent = new Set<string>();
  for (const record of records) {
    if (record.fingerprintV === 2 || !FINGERPRINT_TEXT.test(record.fingerprint)) continue;
    visitExactEvidence(record, (evidence) => {
      if (record.fingerprint !== evidence.legacy) return false;
      provenLegacyRecords.add(record.id);
      if (currentByHash.size === 0) return true;
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
      // witness is sufficient. Raw excerpts never provide that proof.
      return true;
    });
  }
  return { migrated, provenLegacyRecords };
}

function canonicalFingerprint(record: FailureRecord, migration: FingerprintMigrationIndex): string {
  if (record.fingerprintV === 2) return record.fingerprint;
  const unprovenKey = `legacy:${record.id}`;
  if (!FINGERPRINT_TEXT.test(record.fingerprint)) return unprovenKey;
  const family = migration.migrated.get(record.fingerprint);
  if (family === undefined) {
    return migration.provenLegacyRecords.has(record.id) ? `legacy:${record.fingerprint}` : unprovenKey;
  }
  let canonical = migration.provenLegacyRecords.has(record.id) ? `legacy:${record.fingerprint}` : unprovenKey;
  visitExactEvidence(record, ({ current, legacy }) => {
    if (record.fingerprint !== legacy || !family.has(current)) return false;
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
 * Return semantic retrieval evidence for one failure. A v2 excerpt is
 * admitted unconditionally (finding 3): it was normalized/masked by the
 * current writer at record time exactly like `signature`, so it already
 * carries the same trust -- a `SIGNAL`-regex miss (e.g. an npm "No matching
 * version found for left-pad@^99.0.0" line) must not make the package name
 * unfindable just because it never made it into the bounded `signature`
 * lines. A legacy (v1/absent) excerpt stays gated behind proof: it is
 * admitted only after the persisted v1 signature independently hashes to the
 * stored fingerprint, since an inherited excerpt cannot otherwise be trusted
 * not to be newer, lossy, or forged relative to that hash. Hook-origin
 * records have no stderr at all, so their excerpt (`exit N`) is never
 * evidence either way.
 */
export function retrievalEvidenceTokens(record: FailureRecord): Set<string> {
  const evidence = retrievalTokens(`${record.cmd} ${record.signature.join(" ")}`);
  // Layer in the command's literal words too. `record.cmd` is raw user text
  // (never itself masked at write time -- only `signature`/`excerpt` are),
  // but concatenating it with already-masked signature text above can push
  // the combined string through the same volatile-value masking the
  // fingerprint uses, erasing a path segment that was never volatile from
  // the user's point of view. This is what makes a hook-origin record (no
  // stderr, so `signature`/`excerpt` carry almost no free-form evidence)
  // findable by the distinctive part of the command instead of only by
  // program name.
  fillRawCommandTokens(record.cmd, evidence);
  if (record.origin === "hook" || record.excerpt.length === 0) return evidence;
  if (record.fingerprintV === 2) {
    for (const token of retrievalTokens(record.excerpt)) evidence.add(token);
    return evidence;
  }
  if (record.signature.length === 0) return evidence;
  const signature = record.signature.join("\n");
  const proven = legacyFingerprintSignature(record.signature, record.cmd, record.exitCode) === record.fingerprint ||
    legacyFingerprint(signature, record.cmd, record.exitCode) === record.fingerprint ||
    legacyFingerprint(record.excerpt, record.cmd, record.exitCode) === record.fingerprint;
  if (!proven) return evidence;
  for (const token of retrievalTokens(record.excerpt)) evidence.add(token);
  return evidence;
}

/**
 * Reuse one caller-owned token bag during bounded scans. Kept in exact
 * lockstep with `retrievalEvidenceTokens` above -- same v2-unconditional /
 * legacy-proven-only excerpt admission -- so recall's scoring loop and the
 * allocating public helper never diverge in what counts as evidence.
 */
function fillRetrievalEvidenceTokens(record: FailureRecord, target: Set<string>): void {
  fillRetrievalTokens(`${record.cmd} ${record.signature.join(" ")}`, target);
  fillRawCommandTokens(record.cmd, target);
  if (record.origin === "hook" || record.excerpt.length === 0) return;
  if (record.fingerprintV === 2) {
    for (const token of retrievalTokens(record.excerpt)) target.add(token);
    return;
  }
  if (record.signature.length === 0) return;
  const signature = record.signature.join("\n");
  const proven = legacyFingerprintSignature(record.signature, record.cmd, record.exitCode) === record.fingerprint ||
    legacyFingerprint(signature, record.cmd, record.exitCode) === record.fingerprint ||
    legacyFingerprint(record.excerpt, record.cmd, record.exitCode) === record.fingerprint;
  if (!proven) return;
  for (const token of retrievalTokens(record.excerpt)) target.add(token);
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
  if (index.byId.size === 0 && index.byFailureId.size === 0) return undefined;
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
  // Preserve the public contract exactly: `undefined` defaults to three, but
  // explicit zero/negative limits are honored by the final slice.
  const limit = input.limit ?? 3;
  const queryTokenSet = queryTokens(input.query);
  const queryTokenList = [...queryTokenSet];
  const queryTokenIndex = new Map(queryTokenList.map((token, index) => [token, index]));
  const candidates = unique
    .filter((record): record is FailureRecord => record.kind === "failure" && isOperationalMemoryRecord(record, now) &&
      (input.cwd === undefined || record.cwd === input.cwd));
  // Moved ahead of the frequency pass below (finding 1): every candidate's
  // canonical key must be available while scoring token frequency, not only
  // afterward while deduplicating hits.
  const migration = fingerprintMigrationIndex(candidates);
  // Do not retain one Set per failure. A 50k snapshot used to keep tens of
  // thousands of token hash tables alive for the whole query, pushing cold
  // recall well beyond the supported RSS envelope. Recompute one bounded set
  // while scoring after the compact frequency pass.
  //
  // Finding 1: count each token's document frequency once per *canonical
  // fingerprint*, not once per record. Two identical failures (the same
  // error recurring -- Rocky's core use case) used to double-count a
  // distinctive token like `enospc`, pushing it past the rare-token floor
  // (`rareFrequency`, as low as 1 for small memories) and collapsing the
  // score to plain Jaccard, below the 0.05 visibility cutoff -- the bug hit
  // hardest exactly when a user most needs it: right after an error recurs.
  // The value is a `Set` of canonical keys rather than a count so frequency
  // means the number of *distinct* recurring failures a token appears in;
  // like the count it replaces, it stays tiny because it is only populated
  // for tokens that intersect the query.
  const documentFrequency = new Map<string, Set<string>>();
  const scratchTokens = new Set<string>();
  const candidateSizes = new Uint32Array(candidates.length);
  const candidateIntersections = new Uint32Array(candidates.length);
  const candidateMasks = new Int32Array(candidates.length);
  // Canonical key per candidate, computed once here and reused by the second
  // pass below instead of calling `canonicalFingerprint` a second time.
  const candidateKeys = new Array<string>(candidates.length);
  // The common short-query path needs no overflow list at all. Keep the
  // long-query witness only when query tokens exceed the inline bit mask.
  const candidateMatches: Array<readonly number[] | undefined> | undefined = queryTokenList.length > 31
    ? new Array<readonly number[] | undefined>(candidates.length)
    : undefined;
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    const record = candidates[candidateIndex]!;
    const key = canonicalFingerprint(record, migration);
    candidateKeys[candidateIndex] = key;
    let intersection = 0;
    let mask = 0;
    let matches: number[] | undefined;
    fillRetrievalEvidenceTokens(record, scratchTokens);
    candidateSizes[candidateIndex] = scratchTokens.size;
    for (const token of scratchTokens) {
      const queryIndex = queryTokenIndex.get(token);
      if (queryIndex === undefined) continue;
      intersection += 1;
      if (queryIndex < 31) mask |= 1 << queryIndex;
      else (matches ??= []).push(queryIndex);
      const seenKeys = documentFrequency.get(token);
      if (seenKeys === undefined) documentFrequency.set(token, new Set([key]));
      else seenKeys.add(key);
    }
    candidateIntersections[candidateIndex] = intersection;
    candidateMasks[candidateIndex] = mask;
    if (candidateMatches !== undefined) {
      candidateMatches[candidateIndex] = matches === undefined || matches.length === 0 ? undefined : matches;
    }
  }
  const best = new Map<string, RecallHit>();
  // Every candidate that shares a canonical fingerprint key with a hit —
  // regardless of whether it scored high enough to become the representative
  // hit — is a prior occurrence of the same recurring failure. Recorded here
  // (oldest-first, matching `candidates`' own order) so `withPossibleFix` can
  // walk the full history newest-first instead of only the single record
  // recall's dedup happened to pick.
  const occurrencesByKey = new Map<string, FailureRecord[]>();
  const rareFrequency = candidates.length >= 10
    ? Math.min(8, Math.max(2, Math.ceil(candidates.length * 0.05)))
    : 1;
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    const record = candidates[candidateIndex]!;
    const candidateSize = candidateSizes[candidateIndex] ?? 0;
    const intersection = candidateIntersections[candidateIndex] ?? 0;
    const denominator = queryTokenSet.size + candidateSize - intersection;
    const base = denominator <= 0 ? 0 : intersection / denominator;
    let rareExact = false;
    const mask = candidateMasks[candidateIndex] ?? 0;
    for (let queryIndex = 0; queryIndex < Math.min(31, queryTokenList.length); queryIndex += 1) {
      if ((mask & (1 << queryIndex)) === 0) continue;
      const token = queryTokenList[queryIndex]!;
      if (distinctiveToken(token) && (documentFrequency.get(token)?.size ?? 0) <= rareFrequency) {
        rareExact = true;
        break;
      }
    }
    if (!rareExact && candidateMatches?.[candidateIndex] !== undefined) {
      for (const queryIndex of candidateMatches[candidateIndex]!) {
        const token = queryTokenList[queryIndex];
        if (token !== undefined && distinctiveToken(token) && (documentFrequency.get(token)?.size ?? 0) <= rareFrequency) {
          rareExact = true;
          break;
        }
      }
    }
    const score = rareExact ? Math.min(1, Math.max(base, 0.06)) : base;
    const key = candidateKeys[candidateIndex]!;
    const occurrences = occurrencesByKey.get(key);
    if (occurrences === undefined) occurrencesByKey.set(key, [record]);
    else occurrences.push(record);
    if (score <= 0.05) continue;
    const fix = fixes.byId.size === 0 && fixes.byFailureId.size === 0
      ? undefined
      : fixForFailure(fixes, record, now);
    const hit = { failure: record, fix, score };
    const previous = best.get(key);
    const shouldReplace = previous === undefined || (!previous.fix && hit.fix)
      || (!!previous.fix === !!hit.fix && record.ts > previous.failure.ts);
    if (shouldReplace) best.set(key, hit);
  }
  return [...best.entries()]
    .sort(([, a], [, b]) => b.score - a.score || b.failure.ts - a.failure.ts)
    .slice(0, limit)
    .map(([key, hit]) => withPossibleFix(hit, occurrencesByKey.get(key) ?? [hit.failure], unique, now));
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
    .filter((failure) => isOperationalMemoryRecord(failure, now))
    .filter((failure) => input.cwd === undefined || failure.cwd === input.cwd)
    .filter((failure) => !input.unresolvedOnly || !failure.resolvedBy)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, input.limit ?? 10)
    .map((failure) => ({ failure, fix: fixForFailure(fixes, failure, now) }));
}

export function queryStats(records: readonly MemoryRecord[], input: StatsQuery = {}): MemoryStats {
  const unique = uniqueRecords(records);
  const now = input.now ?? Date.now();
  const scoped = unique.filter((record) => isOperationalMemoryRecord(record, now) && (input.cwd === undefined || record.cwd === input.cwd));
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
  const possibleFixes = scoped.filter((record) => record.kind === "association" ||
    (record.kind === "fix" && record.links?.some((link) => link.confidence === "possible"))).length;
  const result: MemoryStats = {
    failures: failures.length, fixEvents, resolved, unresolved: failures.length - resolved,
  };
  const byKind: Record<string, number> = {};
  for (const record of scoped) byKind[record.kind] = (byKind[record.kind] ?? 0) + 1;
  return {
    ...result,
    confirmedFixes: fixEvents,
    possibleFixes,
    triples: scoped.filter((record) => record.kind === "triple").length,
    notes: scoped.filter((record) => record.kind === "note").length,
    total: scoped.length,
    byKind,
  };
}

function completeTriple(record: TripleRecord): boolean {
  try {
    const bounded = boundTripleRecord(record);
    return bounded.mechanism.coverageStatus === "complete"
      && bounded.mechanism.truncatedFiles === 0
      && bounded.mechanism.baseline === "captured"
      && bounded.mechanism.files.length > 0
      && bounded.mechanism.files.every((file) => file.provenance === "tool-observed" || file.provenance === "git-diff-inferred");
  } catch {
    return false;
  }
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

  const entries: Array<{ record: MemoryRecord; snippet: string }> = [];
  for (const sourceRecord of uniqueRecords(records)) {
    const record = sourceRecord.kind === "triple" ? boundTripleRecord(sourceRecord) : sourceRecord;
    if (!isOperationalMemoryRecord(record, now)) continue;
    if (record.kind === "failure" && wants("failure")) {
      entries.push({
        record,
        snippet: record.cmd.slice(0, 120),
      });
    } else if (record.kind === "fix" && wants("fix")) {
      entries.push({ record, snippet: record.cmd.slice(0, 120) });
    } else if (record.kind === "triple" && wants("triple") && record.intent) {
      entries.push({
        record,
        snippet: record.intent.text.slice(0, 120),
      });
    } else if (record.kind === "note" && wants("note")) {
      entries.push({
        record,
        snippet: `${record.subject}: ${record.answer}`.slice(0, 120),
      });
    }
  }
  const knowledgeTokens = (record: MemoryRecord, target: Set<string>): void => {
    target.clear();
    if (record.kind === "failure") {
      fillRetrievalEvidenceTokens(record, target);
    } else if (record.kind === "fix") {
      fillRetrievalTokens(record.cmd, target);
    } else if (record.kind === "triple") {
      fillRetrievalTokens(`${record.intent?.text ?? ""} ${record.rationale?.tags.join(" ") ?? ""}`, target);
    } else if (record.kind === "note") {
      fillRetrievalTokens(`${record.cmd} ${record.file} ${record.subject} ${record.answer}`, target);
    }
  };
  // Moved ahead of the frequency pass below (finding 1, same fix as
  // `queryRecall`): a failure entry's canonical key must be available while
  // counting document frequency, not only afterward while deduplicating
  // failure hits.
  const migration = fingerprintMigrationIndex(
    entries
      .filter((entry): entry is { record: FailureRecord; snippet: string } => entry.record.kind === "failure")
      .map((entry) => entry.record),
  );
  // Finding 1: count each token once per document *identity*, not once per
  // entry. A failure's identity is its canonical fingerprint, so two records
  // of the same recurring failure no longer inflate a distinctive token's
  // frequency past the rare-token floor (see `queryRecall` for the full
  // rationale). Every other kind has no recurrence concept, so its identity
  // stays one entry per record, exactly as the old per-entry count behaved.
  const documentFrequency = new Map<string, Set<string>>();
  const knowledgeScratch = new Set<string>();
  for (const entry of entries) {
    knowledgeTokens(entry.record, knowledgeScratch);
    const docId = entry.record.kind === "failure"
      ? knowledgeFailureKey(entry.record, migration)
      : `${entry.record.kind}:${entry.record.id}`;
    for (const token of knowledgeScratch) {
      if (!queryTokenSet.has(token)) continue;
      const seenIds = documentFrequency.get(token);
      if (seenIds === undefined) documentFrequency.set(token, new Set([docId]));
      else seenIds.add(docId);
    }
  }
  const failureHits = new Map<string, { hit: KnowledgeSearchHit; current: boolean }>();
  for (const { record, snippet } of entries) {
    knowledgeTokens(record, knowledgeScratch);
    const tokenSet = knowledgeScratch;
    const score = semanticScore(queryTokenSet, tokenSet, documentFrequency, entries.length);
    if (record.kind === "failure") {
      if (score > 0) {
         const hit: KnowledgeSearchHit = {
          id: record.id, ts: record.ts, kind: "failure", snippet, score,
          source: record.origin ?? "run",
        };
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
        source: "fix",
      });
    } else if (record.kind === "triple") {
      if (score > 0) {
        const complete = completeTriple(record);
        const hit: KnowledgeSearchHit = {
          id: record.id,
          ts: record.ts,
          kind: "triple",
          snippet,
          score,
          agent: record.agent,
          source: record.origin,
           filesCovered: record.mechanism.files.map((file) => file.path),
          truncatedFiles: record.mechanism.truncatedFiles,
          complete,
          coverageStatus: record.mechanism.coverageStatus,
        };
         if (complete) {
           // Brand only an immutable canonical projection. A caller can copy
           // the fields, but cannot mutate a branded object into proof for a
           // different record or coverage state.
           Object.freeze(hit.filesCovered);
           Object.freeze(hit);
           canonicalKnowledgeProof.add(hit);
         }
         hits.push(hit);
      }
    } else if (record.kind === "note") {
      if (score > 0) hits.push({ id: record.id, ts: record.ts, kind: "note", snippet, score, source: "note" });
    }
  }

  hits.push(...[...failureHits.values()].map(({ hit }) => hit));
  return hits.sort((a, b) => b.score - a.score || b.ts - a.ts).slice(0, limit);
}

export function fetchRecord(records: readonly MemoryRecord[], id: string): MemoryRecord | undefined {
  const record = records.find((candidate) => candidate.id === id);
  return record?.kind === "triple" ? boundTripleRecord(record) : record;
}

function safeCoverageAdd(left: number, right: number): number {
  if (!Number.isSafeInteger(left) || left < 0 || !Number.isSafeInteger(right) || right < 0) return Number.MAX_SAFE_INTEGER;
  const sum = left + right;
  return Number.isSafeInteger(sum) ? sum : Number.MAX_SAFE_INTEGER;
}

function rawTripleFiles(record: TripleRecord): string[] {
  const mechanism = record?.mechanism;
  if (typeof mechanism !== "object" || mechanism === null || Array.isArray(mechanism) ||
      !Array.isArray((mechanism as unknown as { files?: unknown }).files)) return [];
  const seen = new Set<string>();
  const paths: string[] = [];
  try {
    const platform = record.platform ?? "unknown";
    const files = (mechanism as unknown as { files: unknown[] }).files;
    const length = files.length;
    if (!Number.isSafeInteger(length) || length < 0) return [];
    const bound = Math.min(length, MAX_RAW_TRIPLE_FILES);
    for (let index = 0; index < bound; index += 1) {
      const value = files[index];
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
      const path = canonicalPath(
        typeof (value as { path?: unknown }).path === "string" ? (value as { path: string }).path : "",
        { platform, cwd: record.cwd },
      );
      if (path && !seen.has(path)) {
        seen.add(path);
        paths.push(path);
      }
    }
  } catch {
    return [];
  }
  return paths;
}

interface WhyFilePathMatch {
  triple: TripleRecord;
  exact: boolean;
  suffix: boolean;
  identity: string;
}

/** Shared origin-aware path relation used by core, CLI rendering, and MCP. */
export interface WhyFilePathRelation {
  exact: boolean;
  suffix: boolean;
  suffixIdentities: readonly string[];
  witness?: TripleRecord["mechanism"]["files"][number];
  witnessIdentity?: string;
}

function absolutePathRoot(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:\//u.test(value);
}

/**
 * Resolve one triple's path relation without granting a suffix across roots.
 * Hash identity is the strongest witness and wins the display witness too.
 */
export function whyFilePathRelation(triple: TripleRecord, path: string): WhyFilePathRelation {
  try {
    const platform = triple.platform ?? "unknown";
    const targetDisplay = canonicalPath(path, { platform });
    const targetIdentity = canonicalPath(path, { platform, cwd: triple.cwd });
    if (!targetDisplay || !targetIdentity) return { exact: false, suffix: false, suffixIdentities: [] };
    const targetHash = pathIdentityHash(targetIdentity, { platform, canonical: true });
    const knownRoot = canonicalPath(triple.cwd, { platform });
    const rootAbsolute = absolutePathRoot(knownRoot);
    const trustedRoot = triple.platform !== undefined && rootAbsolute;
    const hashWitnesses: Array<{ file: TripleRecord["mechanism"]["files"][number]; identity: string }> = [];
    const pathWitnesses: Array<{ file: TripleRecord["mechanism"]["files"][number]; identity: string }> = [];
    const suffixWitnesses: Array<{ file: TripleRecord["mechanism"]["files"][number]; identity: string }> = [];
    const suffixIdentities = new Set<string>();
    for (const file of triple.mechanism.files) {
      const candidateDisplay = canonicalPath(file.path, { platform });
      const candidateIdentity = canonicalPath(file.path, { platform, cwd: triple.cwd });
      if (!candidateDisplay || !candidateIdentity) continue;
      const hashValid = typeof file.identityHash === "string" && /^[0-9a-f]{32}$/u.test(file.identityHash);
      const hashExact = hashValid && file.identityHash === targetHash;
      const hashMismatch = hashValid && file.identityHash !== targetHash;
      const exact = hashExact || (!hashMismatch && (candidateDisplay === targetDisplay || candidateIdentity === targetIdentity));
      const identity = hashMismatch ? `hash:${file.identityHash}` : candidateIdentity;
      if (exact) {
        (hashExact ? hashWitnesses : pathWitnesses).push({ file, identity });
        continue;
      }
      const relativeEscapesRoot = !candidateDisplay.startsWith("/") && !/^[A-Za-z]:\//u.test(candidateDisplay)
        && (candidateDisplay === ".." || candidateDisplay.startsWith("../"));
      const candidateWithinRoot = !relativeEscapesRoot && (!rootAbsolute || candidateIdentity === knownRoot
        || candidateIdentity.startsWith(`${knownRoot}/`));
      const targetWithinRoot = !rootAbsolute || targetIdentity === knownRoot
        || targetIdentity.startsWith(`${knownRoot}/`);
      const suffix = targetDisplay.length > 0 && candidateWithinRoot && targetWithinRoot
        && candidateDisplay.endsWith(`/${targetDisplay}`);
      if (!suffix) continue;
      suffixIdentities.add(identity);
      if (!trustedRoot) suffixWitnesses.push({ file, identity });
    }
    const exactWitness = hashWitnesses[0] ?? pathWitnesses[0];
    if (exactWitness !== undefined) {
      return {
        exact: true,
        suffix: false,
        suffixIdentities: [],
        witness: exactWitness.file,
        witnessIdentity: exactWitness.identity,
      };
    }
    const suffixWitness = suffixWitnesses[0];
    return {
      exact: false,
      suffix: suffixWitness !== undefined,
      suffixIdentities: [...suffixIdentities],
      ...(suffixWitness === undefined ? {} : { witness: suffixWitness.file, witnessIdentity: suffixWitness.identity }),
    };
  } catch {
    return { exact: false, suffix: false, suffixIdentities: [] };
  }
}

const MAX_WHY_RECORDS = 20_000;
const MAX_RAW_TRIPLE_FILES = 256;

interface SafeTripleCollection {
  triples: TripleRecord[];
  complete: boolean;
}

/** Normalize hostile direct/custom records before any matching traversal. */
function safeTripleCollection(records: unknown): SafeTripleCollection {
  const triples: TripleRecord[] = [];
  let complete = true;
  try {
    if (!Array.isArray(records)) return { triples, complete: false };
    const length = records.length;
    if (!Number.isSafeInteger(length) || length < 0) return { triples, complete: false };
    if (length > MAX_WHY_RECORDS) complete = false;
    const bounded = Math.min(length, MAX_WHY_RECORDS);
    for (let index = 0; index < bounded; index += 1) {
      try {
        const value = records[index] as unknown;
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          complete = false;
          continue;
        }
        const candidate = value as MemoryRecord;
        if (candidate.kind !== "triple") {
          continue;
        }
        if (typeof candidate.id !== "string" || candidate.id.length === 0 || candidate.id.length > 512
            || /[\u0000-\u001f\u007f-\u009f]/u.test(candidate.id)
            || typeof candidate.ts !== "number" || !Number.isSafeInteger(candidate.ts) || candidate.ts < 0
            || typeof candidate.cwd !== "string"
            || (candidate.agent !== "claude-code" && candidate.agent !== "codex")
            || candidate.origin !== "agent-hook") {
          complete = false;
          continue;
        }
        const boundedRecord = boundTripleRecord(candidate);
        if (boundedRecord.mechanism.files.length === 0 && candidate.mechanism !== undefined) complete = false;
        triples.push(boundedRecord);
      } catch {
        complete = false;
      }
    }
  } catch {
    complete = false;
  }
  return { triples, complete };
}

function whyFilePathMatches(records: readonly MemoryRecord[], path: string, limit = 5, requireComplete = true, now = Date.now()): {
  matches: TripleRecord[];
  suffixAmbiguous: boolean;
  traversalIncomplete: boolean;
} {
  const candidates: WhyFilePathMatch[] = [];
  const suffixIdentities = new Set<string>();
  const collection = safeTripleCollection(records);
  for (const triple of collection.triples.filter((record) => isOperationalMemoryRecord(record, now))) {
    const relation = whyFilePathRelation(triple, path);
    for (const identity of relation.suffixIdentities) suffixIdentities.add(identity);
    if (relation.witness === undefined || relation.witnessIdentity === undefined) continue;
    candidates.push({
      triple,
      exact: relation.exact,
      suffix: relation.suffix,
      identity: relation.witnessIdentity,
    });
  }
  const exact = candidates.filter((candidate) => candidate.exact);
  const suffixCandidates = candidates.filter((candidate) => candidate.suffix);
  const selected = exact.length > 0
    ? (requireComplete ? exact.filter((candidate) => completeTriple(candidate.triple)) : exact)
    : (requireComplete
      ? suffixCandidates.filter((candidate) => completeTriple(candidate.triple))
      : suffixCandidates.filter((candidate) => candidate.triple.mechanism.truncatedFiles === 0));
  if (exact.length === 0) {
    const distinctSuffixes = new Set([
      ...suffixCandidates.map((candidate) => candidate.identity),
      ...suffixIdentities,
    ]);
    if (distinctSuffixes.size > 1) return { matches: [], suffixAmbiguous: true, traversalIncomplete: !collection.complete };
  }
  const seen = new Set<string>();
  const matches: TripleRecord[] = [];
  for (const candidate of selected.sort((a, b) => b.triple.ts - a.triple.ts)) {
    if (seen.has(candidate.triple.id)) continue;
    seen.add(candidate.triple.id);
    matches.push(candidate.triple);
  }
  return { matches: matches.slice(0, limit), suffixAmbiguous: false, traversalIncomplete: !collection.complete };
}

function worstCoverageStatus(current: KnowledgeCoverageSummary["status"], next: KnowledgeCoverageSummary["status"]): KnowledgeCoverageSummary["status"] {
  if (current === "unknown" || next === "unknown") return "unknown";
  if (current === "truncated" || next === "truncated") return "truncated";
  return "complete";
}

export function whyFileEvidence(records: readonly MemoryRecord[], path: string, limit = 5, now = Date.now()): WhyFileEvidence {
  const sourceCollection = safeTripleCollection(records);
  const operational = sourceCollection.triples.filter((record) => isOperationalMemoryRecord(record, now));
  const strictMatches = whyFilePathMatches(operational, path, limit, true, now);
  const matches = strictMatches.matches.slice(0, limit);
  const boundedMatches = new Set(matches.map((record) => record.id));
  const possible: WhyFilePossible[] = [];
  let status: KnowledgeCoverageSummary["status"] = sourceCollection.complete ? "complete" : "unknown";
  let filesCovered = 0;
  let truncatedFiles = 0;
  let hasIncomplete = !sourceCollection.complete || strictMatches.traversalIncomplete;
  let sawTriple = false;
  const collection = safeTripleCollection(operational);
  for (const source of collection.triples) {
    sawTriple = true;
    try {
      const bounded = boundTripleRecord(source);
      const relation = whyFilePathRelation(bounded, path);
      const rawPaths = rawTripleFiles(source);
      const platform = bounded.platform ?? "unknown";
      const targetIdentity = canonicalPath(path, { platform, cwd: bounded.cwd });
      const boundedPaths = new Set(bounded.mechanism.files.map((file) => canonicalPath(file.path, {
        platform, cwd: bounded.cwd,
      })).filter(Boolean));
      const rawContainsTarget = targetIdentity.length > 0 && rawPaths.includes(targetIdentity);
      const boundedContainsTarget = targetIdentity.length > 0 && boundedPaths.has(targetIdentity);
      const sourceStatus = bounded.mechanism.coverageStatus ?? "unknown";
      const sourceIncomplete = !completeTriple(bounded)
        || sourceStatus !== "complete"
        || bounded.mechanism.truncatedFiles !== 0
        || rawPaths.length > bounded.mechanism.files.length;
      if (sourceIncomplete) {
        hasIncomplete = true;
        status = worstCoverageStatus(status, sourceStatus);
        // A complete marker without baseline/provenance is an evidence-proof
        // gap, not a known file omission. Keep it explicitly unknown instead
        // of fabricating a truncation count.
        if (sourceStatus === "complete" && !completeTriple(bounded)) status = "unknown";
        else if (sourceStatus === "truncated") status = worstCoverageStatus(status, "truncated");
        truncatedFiles = safeCoverageAdd(truncatedFiles, bounded.mechanism.truncatedFiles);
        const pathRelated = relation.exact || relation.suffix || relation.suffixIdentities.length > 0
          || bounded.mechanism.truncatedFiles > 0;
        if (pathRelated && (!boundedContainsTarget || (rawContainsTarget && !boundedContainsTarget) || !boundedMatches.has(source.id))
            && possible.length < limit) {
          possible.push({ id: source.id, ts: source.ts, source: source.origin, reason: "path_may_be_omitted" });
        }
      }
      filesCovered = Math.max(filesCovered, bounded.mechanism.files.length);
    } catch {
      hasIncomplete = true;
      status = "unknown";
    }
  }
  if (!sawTriple || strictMatches.suffixAmbiguous || !sourceCollection.complete || !collection.complete
      || strictMatches.matches.length === 0) {
    hasIncomplete = true;
    status = worstCoverageStatus(status, "unknown");
  }
  const coverage: KnowledgeCoverageSummary = {
    status,
    complete: !hasIncomplete && status === "complete" && truncatedFiles === 0,
    filesCovered,
    truncatedFiles,
  };
  return {
    matches,
    possible,
    coverage,
    coverageIncomplete: !coverage.complete,
    ...(strictMatches.suffixAmbiguous ? { ambiguousPath: true } : {}),
  };
}

export function whyFile(records: readonly MemoryRecord[], path: string, limit = 5, now = Date.now()): TripleRecord[] {
  return whyFilePathMatches(records, path, limit, false, now).matches;
}

export const LINK_WINDOW_MS = 1000 * 60 * 60 * 8;

export interface UnresolvedLink { failure: FailureRecord; basis: LinkBasis; confidence: LinkConfidence }

export interface PossibleFix {
  cmd: string;
  ts: number;
  cwd: string;
  basis: LinkBasis;
  fromElsewhere: boolean;
}

/**
 * Weak-evidence companion to `getFix` (spec §3 Fix 1): surfaces
 * `AssociationRecord` candidates linked to `failure` when no `FixRecord`
 * exists yet. Pure read — writes nothing, touches no pending marker,
 * changes no `stats` number. Newest first, tie-broken by `linkBasisRank`
 * (lower/stronger wins), capped at 3.
 *
 * NOTE for v0.6.0 (`rocky brief`, roadmap §8b): the "failure/fix linked from
 * memory within window" section of `brief` must read through this function
 * rather than `FixRecord` alone, so association-only evidence is not
 * silently dropped there either.
 */
export function possibleFixesForFailure(
  records: readonly MemoryRecord[],
  failure: FailureRecord,
  now = Date.now(),
): PossibleFix[] {
  const candidates: PossibleFix[] = [];
  for (const record of uniqueRecords(records)) {
    if (record.kind !== "association" || !isOperationalMemoryRecord(record, now)) continue;
    const link = record.links.find((entry) => entry.id === failure.id);
    // §3 allows a match through either field; `links` carries the basis, so a
    // candidate found only via `candidateFailureIds` falls to the weakest
    // (unrecognized) rank rather than inventing a stronger one.
    if (link === undefined && !record.candidateFailureIds.includes(failure.id)) continue;
    candidates.push({
      cmd: record.cmd,
      ts: record.ts,
      cwd: record.cwd,
      basis: link?.basis ?? "unknown",
      fromElsewhere: record.cwd !== failure.cwd,
    });
  }
  return candidates
    .sort((a, b) => b.ts - a.ts || linkBasisRank(a.basis) - linkBasisRank(b.basis))
    .slice(0, 3);
}

/**
 * Attach the top weak candidate only when this hit has no confirmed fix.
 * Walks every prior same-fingerprint occurrence newest-first, exactly like
 * `run.ts`'s `speakablePossibleFix` walks `findByFingerprint`'s results, so
 * a candidate attached only to an older occurrence of the same recurring
 * failure still surfaces here instead of being silently dropped because
 * recall's dedup happened to pick a newer occurrence as the representative
 * hit (finding 1, final whole-branch review).
 */
function withPossibleFix(hit: RecallHit, occurrences: readonly FailureRecord[], records: readonly MemoryRecord[], now: number): RecallHit {
  if (hit.fix) return hit;
  for (const failure of [...occurrences].reverse()) {
    const possible = possibleFixesForFailure(records, failure, now)[0];
    if (possible !== undefined) return { ...hit, possible };
  }
  return hit;
}

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
  // A set of document identities per token (finding 1), not a raw count --
  // see the call site in `searchKnowledge` for what an identity is per kind.
  documentFrequency: ReadonlyMap<string, ReadonlySet<string>>,
  candidateCount: number,
): number {
  const base = similarity(queryTokens, candidateTokens);
  const rareFrequency = candidateCount >= 10
    ? Math.min(8, Math.max(2, Math.ceil(candidateCount * 0.05)))
    : 1;
  const rareExact = [...queryTokens].some((token) =>
    distinctiveToken(token) && candidateTokens.has(token) && (documentFrequency.get(token)?.size ?? 0) <= rareFrequency,
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
  const durableLoader = load === loadMemory;
  let lastCoverage: MemoryCoverage | undefined;
  const loadRecords = (requestedNow = Date.now()): MemoryRecord[] => {
    if (!durableLoader) return load();
    const loaded = loadMemoryChecked(undefined, requestedNow);
    lastCoverage = loaded.coverage;
    return loaded.records;
  };
  const queries: MemoryQueries = {
    recall: (input) => queryRecall(loadRecords(input.now), input),
    recentFailures: (input = {}) => queryRecentFailures(loadRecords(input.now), input),
    stats: (input = {}) => queryStats(loadRecords(input.now), input),
    searchKnowledge: (input) => searchKnowledge(loadRecords(input.now), input),
    fetchRecord: (id) => fetchRecord(loadRecords(), id),
    whyFile: (path, limit = 5, now = Date.now()) => whyFile(loadRecords(now), path, limit, now),
    whyFileEvidence: (path, limit = 5) => {
      const now = Date.now();
      const records = loadRecords(now);
      const evidence = whyFileEvidence(records, path, limit, now);
      // A strict pass may report an incomplete possible association while a
      // legacy provider still has an exact bounded witness. Prefer exact
      // legacy evidence when strict matches are empty; never let a possible
      // item suppress that compatibility fallback.
      if (evidence.matches.length > 0) return evidence;
      // Keep the pre-evidence query contract usable for legacy triples that
      // have an exact file witness but lack the new baseline/provenance proof.
      // The fallback is deliberately conservative: it retains the item only
      // as an incomplete match, never upgrades coverage to complete.
      const legacyMatches = whyFile(records, path, limit, now);
      if (legacyMatches.length === 0) return evidence;
      return {
        ...evidence,
        matches: legacyMatches,
        coverage: { ...evidence.coverage, status: "unknown" as const, complete: false },
        coverageIncomplete: true,
      };
    },
    ...(durableLoader ? {
      coverage: () => {
        // Coverage belongs to most recent answer. Do not reload here: a
        // transient read-race followed by a file replacement must not pair a
        // clean scan with an answer produced from an empty fallback. A later
        // query intentionally obtains a fresh snapshot and replaces marker.
        if (lastCoverage !== undefined) return lastCoverage;
        loadRecords();
        return lastCoverage!;
      },
    } : {}),
  };
  Object.freeze(queries);
  canonicalMemoryQueries.add(queries);
  if (durableLoader) {
    durableMemorySnapshotLoaders.set(queries, (requestedNow = Date.now()) => {
      const records = loadRecords(requestedNow);
      const coverage = lastCoverage;
      if (coverage === undefined) throw new Error("Rocky durable snapshot coverage unavailable");
      return { records, coverage };
    });
  }
  return queries;
}
