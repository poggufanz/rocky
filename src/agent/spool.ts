import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
  type BigIntStats,
  type Stats,
} from "node:fs";
import { join } from "node:path";
import { canonicalPath, pathIdentityHash } from "../core/memory-read.js";
import { NO_FOLLOW_FLAG, regularDescriptorSafe, sameFilesystemIdentity } from "../core/fs-safety.js";
import { resolveRockyPaths, type RockyPaths } from "../core/state-paths.js";
import { MAX_COVERAGE_PATHS, parseAgentEvent, type AgentEvent, type AgentName } from "./schema.js";

export const MAX_BATCH_BYTES = 256 * 1024;
export const MAX_SPOOL_BATCHES = 50;
export const ORPHAN_AGE_MS = 10 * 60 * 1000;

const MAX_KEY_CHARS = 120;
const SAFE_KEY = /^[A-Za-z0-9_-]{1,120}$/;
const NO_FOLLOW = NO_FOLLOW_FLAG;
const APPEND_LOCK_SUFFIX = ".append.lock";
const APPEND_LOCK_TOKEN_BYTES = 16;
const LOCK_METADATA_MAX_BYTES = 128;
const ANNOTATION_LOCK_TOKEN_BYTES = 16;
const ANNOTATION_METADATA_MAX_BYTES = 192;
const CLAIM_TOKEN_BYTES = 16;
const CLAIM_PATTERN = /^([A-Za-z0-9_-]{1,120})\.claim\.([a-f0-9]{32})\.jsonl$/u;
const CLAIM_COVERAGE_PATTERN = /^([A-Za-z0-9_-]{1,120})\.claim\.([a-f0-9]{32})\.coverage\.json$/u;
const COVERAGE_TEMP_PATTERN = /^([A-Za-z0-9_-]{1,120})(?:\.claim\.[a-f0-9]{32})?\.coverage\.tmp\./u;
const COVERAGE_SUFFIX = ".coverage.json";
const COVERAGE_TEMP_SUFFIX = ".coverage.tmp";
const COVERAGE_MAX_BYTES = 64 * 1024;
/**
 * Coverage stores compact SHA-256 identity witnesses rather than repeating
 * 1KiB display paths. This leaves room for the complete bounded envelope while
 * keeping a hard upper bound on hostile input and sidecar growth.
 */
// 1,400 fixed-width digests plus eight 1KiB display witnesses stay below the
// 64KiB sidecar envelope.  A larger logical union is explicitly downgraded
// when replacement cannot be represented, rather than leaving stale proof.
export const MAX_COVERAGE_IDENTITIES = 1400;
const MAX_COVERAGE_WITNESSES = 8;
const MAX_COVERAGE_PAYLOAD_DIGESTS = 64;
const IDENTITY_HASH = /^[0-9a-f]{32}$/u;
const PAYLOAD_DIGEST = /^[0-9a-f]{64}$/u;
const CLAIM_ID = /^[a-f0-9]{32}$/u;
const CONTROL_PATH = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2060-\u206f\ufeff]/u;

function validIdentityNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Claim ownership may outlive a process and native Windows can expose inode
 * values above Number.MAX_SAFE_INTEGER.  Keep those values as bounded decimal
 * strings in the sidecar; accepting an unsafe JSON number would make two
 * different files indistinguishable after rounding.
 */
function identityToken(value: unknown): string | undefined {
  if (typeof value === "bigint") {
    if (value < 0n || value > 18_446_744_073_709_551_615n) return undefined;
    return value.toString(10);
  }
  if (validIdentityNumber(value)) return String(value);
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,19})$/u.test(value)) return undefined;
  try {
    const parsed = BigInt(value);
    return parsed >= 0n && parsed <= 18_446_744_073_709_551_615n ? parsed.toString(10) : undefined;
  } catch {
    return undefined;
  }
}

type FileKind = "missing" | "regular" | "other";

interface FileInfo {
  kind: FileKind;
  stats?: Stats;
}

function isSafeKey(key: unknown): key is string {
  return typeof key === "string" && key.length <= MAX_KEY_CHARS && SAFE_KEY.test(key);
}

function spoolPath(paths: RockyPaths): string | undefined {
  const value = (paths as unknown as { spoolDir?: unknown }).spoolDir;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function inspectFile(path: string): FileInfo {
  try {
    const stats = lstatSync(path);
    return stats.isFile() && !stats.isSymbolicLink()
      ? { kind: "regular", stats }
      : { kind: "other" };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "missing" }
      : { kind: "other" };
  }
}

function isSpoolDirectory(path: string): boolean {
  try {
    const stats = lstatSync(path);
    return stats.isDirectory() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

function ensureSpoolDirectory(path: string): boolean {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  } catch {
    return false;
  }
  return isSpoolDirectory(path);
}

function batchPath(paths: RockyPaths, key: string): string {
  return join(paths.spoolDir, `${key}.jsonl`);
}

function coveragePath(paths: RockyPaths, key: string): string {
  return join(paths.spoolDir, `${key}${COVERAGE_SUFFIX}`);
}

function claimCoveragePath(paths: RockyPaths, key: string, id: string): string {
  return join(paths.spoolDir, `${key}.claim.${id}${COVERAGE_SUFFIX}`);
}

function coverageTempPath(paths: RockyPaths, key: string): string {
  return join(paths.spoolDir, `${key}${COVERAGE_TEMP_SUFFIX}.${process.pid}.${randomBytes(8).toString("hex")}`);
}

function claimCoverageTempPath(paths: RockyPaths, key: string, id: string): string {
  return join(paths.spoolDir, `${key}.claim.${id}${COVERAGE_TEMP_SUFFIX}.${process.pid}.${randomBytes(8).toString("hex")}`);
}

function canonicalCoveragePath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024 || CONTROL_PATH.test(value)) return undefined;
  const path = canonicalPath(value, { platform: "unknown" });
  return path.length > 0 && path.length <= 1024 ? path : undefined;
}

interface CoveragePathSet {
  paths: string[];
  identityHashes: string[];
  valid: boolean;
  overflow: boolean;
  rawCount: number;
  cwd?: string;
}

function coveragePathSet(value: unknown, cwdValue?: unknown): CoveragePathSet {
  try {
    if (!Array.isArray(value)) return { paths: [], identityHashes: [], valid: false, overflow: false, rawCount: 0 };
  } catch {
    return { paths: [], identityHashes: [], valid: false, overflow: true, rawCount: 0 };
  }
  const cwd = typeof cwdValue === "string" && !CONTROL_PATH.test(cwdValue) && cwdValue.length <= 1024
    ? canonicalPath(cwdValue, { platform: "unknown" }) || undefined
    : undefined;
  if (cwdValue !== undefined && cwd === undefined) return { paths: [], identityHashes: [], valid: false, overflow: false, rawCount: 0 };
  const paths: string[] = [];
  const identityHashes: string[] = [];
  const seenPaths = new Set<string>();
  const seenHashes = new Set<string>();
  let valid = true;
  let overflow = false;
  let rawCount = 0;
  try {
    const lengthValue = (value as { length?: unknown }).length;
    if (typeof lengthValue !== "number" || !Number.isSafeInteger(lengthValue) || lengthValue < 0) {
      return { paths: [], identityHashes: [], valid: false, overflow: true, rawCount: 0 };
    }
    const boundedLength = Math.min(lengthValue, MAX_COVERAGE_IDENTITIES * 2);
    if (lengthValue > boundedLength) overflow = true;
    for (let index = 0; index < boundedLength; index += 1) {
      let item: unknown;
      try { item = (value as unknown[])[index]; } catch { valid = false; overflow = true; continue; }
      rawCount += 1;
      const path = canonicalCoveragePath(item);
      if (path === undefined) {
        valid = false;
        continue;
      }
      const hash = pathIdentityHash(path, { platform: "unknown", cwd });
      if (seenPaths.has(path) || seenHashes.has(hash)) {
        // A duplicate path is harmless at an ingress retry boundary, but a
        // persisted sidecar must reject it. The writer deduplicates explicitly.
        continue;
      }
      seenPaths.add(path);
      if (identityHashes.length >= MAX_COVERAGE_IDENTITIES) {
        overflow = true;
        valid = false;
        continue;
      }
      seenHashes.add(hash);
      identityHashes.push(hash);
      if (paths.length < MAX_COVERAGE_WITNESSES) paths.push(path);
    }
  } catch {
    valid = false;
    overflow = true;
  }
  return { paths, identityHashes, valid, overflow, rawCount, ...(cwd === undefined ? {} : { cwd }) };
}

function validCoverageHashes(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_COVERAGE_IDENTITIES) return undefined;
  const hashes: string[] = [];
  const seen = new Set<string>();
  try {
    for (const item of value) {
      if (typeof item !== "string" || !IDENTITY_HASH.test(item) || seen.has(item)) return undefined;
      seen.add(item);
      hashes.push(item);
    }
  } catch {
    return undefined;
  }
  return hashes;
}

function payloadDigest(input: CoverageInput, identityHashes: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify({
      agent: input.agent,
      cwd: typeof input.cwd === "string" ? canonicalPath(input.cwd, { platform: "unknown" }) : undefined,
      candidateCount: input.candidateCount ?? identityHashes.length,
      candidateCountExact: input.candidateCountExact !== false,
      pathsComplete: input.pathsComplete === true,
      // Payload order is not semantic. Keep first-seen order for witnesses,
      // but hash a sorted canonical identity set so reordered retries remain
      // idempotent.
      identityHashes: [...identityHashes].sort(),
      adapterDigest: typeof input.payloadDigest === "string" && PAYLOAD_DIGEST.test(input.payloadDigest)
        ? input.payloadDigest
        : undefined,
    }), "utf8")
    .digest("hex");
}

function safeAgent(value: unknown): AgentName | undefined {
  return value === "claude-code" || value === "codex" ? value : undefined;
}

function parseCoverageBytes(bytes: Buffer): CoverageSnapshot | undefined {
  try {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    const agent = safeAgent(record.agent);
    const candidateCount = record.candidateCount;
    const payloads = record.payloads;
    const claimId = record.claimId;
    const claimDev = record.claimDev;
    const claimIno = record.claimIno;
    const claimDevToken = claimDev === undefined ? undefined : identityToken(claimDev);
    const claimInoToken = claimIno === undefined ? undefined : identityToken(claimIno);
    const cwdValue = record.cwd;
    if (record.v !== 1 || !agent || typeof record.candidateCountExact !== "boolean" ||
        typeof record.pathsComplete !== "boolean" || typeof payloads !== "number" || !Number.isSafeInteger(payloads) || payloads < 1 ||
        payloads > Number.MAX_SAFE_INTEGER ||
        (claimId !== undefined && (typeof claimId !== "string" || !CLAIM_ID.test(claimId))) ||
        (claimDev !== undefined && claimDevToken === undefined) ||
        (claimIno !== undefined && claimInoToken === undefined) ||
        ((claimDevToken === undefined) !== (claimInoToken === undefined)) ||
        ((claimId === undefined) !== (claimDevToken === undefined)) ||
        (cwdValue !== undefined && (typeof cwdValue !== "string" || cwdValue.length === 0 || cwdValue.length > 1024 || CONTROL_PATH.test(cwdValue))) ||
        (candidateCount !== undefined && (typeof candidateCount !== "number" || !Number.isSafeInteger(candidateCount) || candidateCount < 0))) return undefined;
    const pathsValue = record.paths;
    if (!Array.isArray(pathsValue) || pathsValue.length > MAX_COVERAGE_WITNESSES) return undefined;
    const paths: string[] = [];
    const pathHashes = new Set<string>();
    for (const item of pathsValue) {
      const path = canonicalCoveragePath(item);
      if (path === undefined || paths.includes(path)) return undefined;
      const hash = pathIdentityHash(path, { platform: "unknown", cwd: typeof cwdValue === "string" ? cwdValue : undefined });
      if (pathHashes.has(hash)) return undefined;
      pathHashes.add(hash);
      paths.push(path);
    }
    const rawHashes = record.identityHashes;
    const identityHashes = rawHashes === undefined ? undefined : validCoverageHashes(rawHashes);
    if (rawHashes !== undefined && identityHashes === undefined) return undefined;
    if (identityHashes !== undefined) {
      const identities = new Set(identityHashes);
      if (paths.some((path) => !identities.has(pathIdentityHash(path, {
        platform: "unknown",
        cwd: typeof cwdValue === "string" ? cwdValue : undefined,
      })))) return undefined;
      if (record.pathsComplete && record.candidateCountExact && candidateCount !== identityHashes.length) return undefined;
      if (record.candidateCountExact && candidateCount !== undefined && candidateCount < identityHashes.length) return undefined;
      // A capped one-payload marker may prove its omitted count only when it
      // carries the adapter's complete bounded witness.  A forged one-hash /
      // candidateCount=300 snapshot is merely unknown, never exact.
      if (record.candidateCountExact && !record.pathsComplete && candidateCount !== undefined
          && candidateCount > identityHashes.length && identityHashes.length < MAX_COVERAGE_PATHS) return undefined;
    } else if (record.pathsComplete || record.candidateCountExact) {
      // Legacy sidecars did not persist compact identities. They are useful as
      // lower-bound witnesses only; never let them prove complete coverage.
      return undefined;
    }
    const rawDigests = record.payloadDigests;
    let payloadDigests: string[] | undefined;
    if (rawDigests !== undefined) {
      if (!Array.isArray(rawDigests) || rawDigests.length > MAX_COVERAGE_PAYLOAD_DIGESTS) return undefined;
      payloadDigests = [];
      const seen = new Set<string>();
      for (const digest of rawDigests) {
        if (typeof digest !== "string" || !PAYLOAD_DIGEST.test(digest) || seen.has(digest)) return undefined;
        seen.add(digest);
        payloadDigests.push(digest);
      }
      if (payloadDigests.length === 0) return undefined;
      // While the digest ledger is below its bounded storage ceiling it must
      // account for every payload.  A shorter forged ledger is not a proof;
      // once the ceiling is reached the snapshot remains explicitly unknown.
      if (payloads <= MAX_COVERAGE_PAYLOAD_DIGESTS && payloadDigests.length !== payloads) return undefined;
    }
    if (candidateCount !== undefined && identityHashes !== undefined && candidateCount < identityHashes.length) return undefined;
    return {
      v: 1,
      agent,
      paths,
      ...(identityHashes === undefined ? {} : { identityHashes }),
      ...(candidateCount === undefined ? {} : { candidateCount }),
      ...(claimId === undefined ? {} : { claimId }),
      ...(claimDevToken === undefined ? {} : { claimDev: claimDevToken }),
      ...(claimInoToken === undefined ? {} : { claimIno: claimInoToken }),
      ...(typeof cwdValue === "string" ? { cwd: canonicalPath(cwdValue, { platform: "unknown" }) } : {}),
      ...(payloadDigests === undefined ? {} : { payloadDigests }),
      candidateCountExact: record.candidateCountExact,
      pathsComplete: record.pathsComplete,
      payloads,
    };
  } catch {
    return undefined;
  }
}

function readCoverageFileUnlocked(file: string): CoverageSnapshot | undefined {
  const info = inspectFile(file);
  if (info.kind !== "regular" || !info.stats || info.stats.size > COVERAGE_MAX_BYTES) return undefined;
  let fd = -1;
  try {
    const listed = lstatSync(file, { bigint: true });
    if (!regularDescriptorSafe(listed) || listed.size > BigInt(COVERAGE_MAX_BYTES)) return undefined;
    fd = openSync(file, constants.O_RDONLY | NO_FOLLOW);
    const opened = fstatSync(fd, { bigint: true });
    if (!regularDescriptorSafe(opened) || !sameFilesystemIdentity(listed, opened)
      || opened.size > BigInt(COVERAGE_MAX_BYTES)) return undefined;
    const bytes = Buffer.alloc(COVERAGE_MAX_BYTES + 1);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    const after = fstatSync(fd, { bigint: true });
    if (!regularDescriptorSafe(after) || !sameFilesystemIdentity(opened, after)
      || !sameFilesystemIdentity(listed, after) || BigInt(count) !== after.size || count > COVERAGE_MAX_BYTES) return undefined;
    return parseCoverageBytes(bytes.subarray(0, count));
  } catch {
    return undefined;
  } finally {
    if (fd >= 0) closeQuietly(fd);
  }
}

function readCoverageUnlocked(paths: RockyPaths, key: string): CoverageSnapshot | undefined {
  let file: string;
  try { file = coveragePath(paths, key); } catch { return undefined; }
  return readCoverageFileUnlocked(file);
}

function writeCoverageTargetUnlocked(target: string, temporary: string, snapshot: CoverageSnapshot): boolean {
  let fd = -1;
  try {
    const existing = inspectFile(target);
    if (existing.kind === "other") return false;
    let existingIdentity: BigIntStats | undefined;
    if (existing.kind === "regular") {
      existingIdentity = lstatSync(target, { bigint: true });
      if (!regularDescriptorSafe(existingIdentity)) return false;
    }
    const encoded = Buffer.from(JSON.stringify(snapshot), "utf8");
    if (encoded.byteLength > COVERAGE_MAX_BYTES) {
      return false;
    }
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, 0o600);
    const opened = fstatSync(fd, { bigint: true });
    if (!regularDescriptorSafe(opened) || !sameFilesystemIdentity(opened, opened)) {
      return false;
    }
    try { fchmodSync(fd, 0o600); } catch { /* best effort */ }
    if (writeSync(fd, encoded, 0, encoded.byteLength) !== encoded.byteLength) {
      return false;
    }
    const after = fstatSync(fd, { bigint: true });
    if (!regularDescriptorSafe(after) || !sameFilesystemIdentity(opened, after) || after.size !== BigInt(encoded.byteLength)) {
      return false;
    }
    closeQuietly(fd);
    fd = -1;
    const beforeRename = inspectFile(target);
    if (existing.kind === "regular") {
      if (existingIdentity === undefined || beforeRename.kind !== "regular") return false;
      const beforeRenameIdentity = lstatSync(target, { bigint: true });
      if (!regularDescriptorSafe(beforeRenameIdentity)
          || !sameFilesystemIdentity(existingIdentity, beforeRenameIdentity)) return false;
    } else if (beforeRename.kind !== "missing") {
      return false;
    }
    renameSync(temporary, target);
    const renamed = inspectFile(target);
    if (renamed.kind !== "regular") return false;
    const renamedIdentity = lstatSync(target, { bigint: true });
    return regularDescriptorSafe(renamedIdentity) && sameFilesystemIdentity(opened, renamedIdentity);
  } catch {
    return false;
  } finally {
    if (fd >= 0) closeQuietly(fd);
    try { unlinkSync(temporary); } catch { /* best effort */ }
  }
}

function writeCoverageUnlocked(paths: RockyPaths, key: string, snapshot: CoverageSnapshot): boolean {
  let target: string | undefined;
  let temporary: string | undefined;
  try {
    target = coveragePath(paths, key);
    temporary = coverageTempPath(paths, key);
    const written = writeCoverageTargetUnlocked(target, temporary, snapshot);
    if (!written && target !== undefined) removeRegular(target);
    return written;
  } catch {
    if (target !== undefined) removeRegular(target);
    return false;
  } finally {
    if (temporary !== undefined) {
      try { unlinkSync(temporary); } catch { /* best effort */ }
    }
  }
}

function mergeCoverage(previous: CoverageSnapshot | undefined, input: CoverageInput): CoverageSnapshot | undefined {
  const agent = safeAgent(input.agent);
  if (!agent) return undefined;
  const incoming = coveragePathSet(input.paths, input.cwd);
  const incomingPaths = incoming.paths;
  const incomingHashes = incoming.identityHashes;
  const incomingCount = input.candidateCount;
  const incomingCountValid = incomingCount === undefined || (Number.isSafeInteger(incomingCount) && incomingCount >= 0);
  if (!incomingCountValid) return undefined;
  const incomingCountExact = incomingCount !== undefined && input.candidateCountExact !== false;
  // A cwd-aware adapter may report raw aliases (absolute and relative forms)
  // for one identity. Normalize that count only when the declared count is
  // exactly the bounded raw ingress length; a larger count with no matching
  // raw envelope is contradictory and must stay unknown.
  const normalizedIncomingCount = input.pathsComplete === true && input.cwd !== undefined
    && incomingCount !== undefined && incomingCount === incoming.rawCount
    ? incomingHashes.length
    : incomingCount;
  const incomingComplete = !incoming.overflow && incoming.valid && input.pathsComplete === true
    && incomingCountExact && normalizedIncomingCount === incomingHashes.length;
  const incomingCandidateCount = normalizedIncomingCount === undefined ? incomingHashes.length : normalizedIncomingCount;
  const incomingDigest = payloadDigest(input, incomingHashes);
  if (!previous || previous.agent !== agent) {
    return {
      v: 1, agent, paths: incomingPaths,
      identityHashes: incomingHashes,
      candidateCount: incomingCandidateCount,
      candidateCountExact: incomingCountExact && !incoming.overflow,
      pathsComplete: incomingComplete,
      payloads: 1,
      payloadDigests: [incomingDigest],
      ...(incoming.cwd === undefined ? {} : { cwd: incoming.cwd }),
    };
  }
  const priorDigests = previous.payloadDigests;
  // A digest is an idempotency proof only while this ingress payload's full
  // identity set was retained.  Once the compact sidecar itself overflowed,
  // two different tails can share the same retained prefix; treating that
  // digest as a replay would silently under-count a distinct payload.
  if (!incoming.overflow && priorDigests !== undefined && priorDigests.includes(incomingDigest)) return previous;
  const payloadDigests = priorDigests === undefined ? undefined : [...priorDigests];
  let payloadDigestOverflow = false;
  if (payloadDigests !== undefined) {
    if (payloadDigests.length < MAX_COVERAGE_PAYLOAD_DIGESTS) payloadDigests.push(incomingDigest);
    else payloadDigestOverflow = true;
  }
  const priorHashes = previous.identityHashes ?? previous.paths.map((path) => pathIdentityHash(path, { platform: "unknown" }));
  const unionHashes = [...priorHashes];
  const seenHashes = new Set(unionHashes);
  let unionOverflow = unionHashes.length > MAX_COVERAGE_IDENTITIES || payloadDigestOverflow;
  for (const hash of incomingHashes) {
    if (seenHashes.has(hash)) continue;
    seenHashes.add(hash);
    if (unionHashes.length < MAX_COVERAGE_IDENTITIES) unionHashes.push(hash);
    else unionOverflow = true;
  }
  const unionPaths = [...previous.paths];
  const seenPaths = new Set(unionPaths);
  for (const path of incomingPaths) {
    if (seenPaths.has(path)) continue;
    seenPaths.add(path);
    if (unionPaths.length < MAX_COVERAGE_WITNESSES) unionPaths.push(path);
  }
  const payloads = previous.payloads < Number.MAX_SAFE_INTEGER ? previous.payloads + 1 : Number.MAX_SAFE_INTEGER;
  const priorExact = previous.candidateCountExact && previous.identityHashes !== undefined
    && previous.payloadDigests !== undefined;
  const allComplete = previous.pathsComplete && incomingComplete && priorExact && incomingCountExact
    && !unionOverflow;
  const singleKnownCount = payloads === 1 && incomingCountExact && !incoming.overflow;
  const exactUnion = allComplete;
  const candidateCount = exactUnion
    ? unionHashes.length
    : singleKnownCount
      ? incomingCandidateCount
      : Math.max(unionHashes.length, previous.candidateCount ?? 0, incomingCandidateCount);
  return {
    v: 1,
    agent,
    paths: unionPaths,
    identityHashes: unionHashes,
    candidateCount,
    candidateCountExact: exactUnion || singleKnownCount,
    pathsComplete: exactUnion,
    payloads,
    ...(payloadDigests === undefined ? {} : { payloadDigests }),
    ...(previous.cwd !== undefined ? { cwd: previous.cwd } : incoming.cwd === undefined ? {} : { cwd: incoming.cwd }),
  };
}

function lockPath(paths: RockyPaths, key: string): string {
  return join(paths.spoolDir, `${key}.lock`);
}

function appendLockPath(paths: RockyPaths, key: string): string {
  return join(paths.spoolDir, `${key}${APPEND_LOCK_SUFFIX}`);
}

function isStale(stats: Stats, now: number): boolean {
  return Number.isFinite(stats.mtimeMs) && now - stats.mtimeMs >= ORPHAN_AGE_MS;
}

function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // Best effort boundary.
  }
}

interface LockMetadata {
  pid: number;
  token: string;
}

interface AnnotationMetadata {
  pid: number;
  token: string;
  dev?: number;
  ino?: number;
}

export interface AnnotationLease {
  readonly key: string;
  readonly path: string;
  readonly token: string;
  readonly pid: number;
  readonly stats: Stats;
}

export interface BatchClaim {
  readonly key: string;
  readonly id: string;
  readonly path: string;
  readonly stats: Stats;
}

const compatibilityLeases = new Map<string, AnnotationLease>();

function compatibilityLeaseKey(paths: RockyPaths, key: string): string {
  return `${paths.spoolDir}\u0000${key}`;
}

interface OwnedPrivateLock {
  fd: number;
  path: string;
  stats: Stats;
  token: string;
  pid: number;
}

function usableIdentity(stats: Stats): boolean {
  return Number.isFinite(stats.dev) && Number.isFinite(stats.ino)
    && (stats.dev !== 0 || stats.ino !== 0);
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return usableIdentity(left) && usableIdentity(right) && left.dev === right.dev && left.ino === right.ino;
}

function identitiesDiffer(left: Stats, right: Stats): boolean {
  return usableIdentity(left) && usableIdentity(right) && !sameIdentity(left, right);
}

function compatibleIdentity(left: Stats, right: Stats): boolean {
  return !usableIdentity(left) || !usableIdentity(right) || sameIdentity(left, right);
}

function encodeLockMetadata(token: string): Buffer | undefined {
  try {
    const encoded = Buffer.from(JSON.stringify({ pid: process.pid, token }), "utf8");
    return encoded.byteLength <= LOCK_METADATA_MAX_BYTES ? encoded : undefined;
  } catch {
    return undefined;
  }
}

function parseLockMetadata(bytes: Buffer): LockMetadata | undefined {
  if (bytes.byteLength === 0 || bytes.byteLength > LOCK_METADATA_MAX_BYTES) return undefined;
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== 2) return undefined;
    if (!Number.isSafeInteger(record.pid) || typeof record.pid !== "number" || record.pid <= 0) return undefined;
    if (typeof record.token !== "string" || !/^[a-f0-9]{32}$/.test(record.token)) return undefined;
    return { pid: record.pid, token: record.token };
  } catch {
    return undefined;
  }
}

function encodeAnnotationMetadata(token: string, stats: Stats): Buffer | undefined {
  try {
    const metadata: AnnotationMetadata = { pid: process.pid, token };
    if (Number.isSafeInteger(stats.dev) && stats.dev >= 0
      && Number.isSafeInteger(stats.ino) && stats.ino >= 0
      && (stats.dev !== 0 || stats.ino !== 0)) {
      metadata.dev = stats.dev;
      metadata.ino = stats.ino;
    }
    const encoded = Buffer.from(JSON.stringify(metadata), "utf8");
    return encoded.byteLength <= ANNOTATION_METADATA_MAX_BYTES ? encoded : undefined;
  } catch {
    return undefined;
  }
}

function parseAnnotationMetadata(bytes: Buffer): AnnotationMetadata | undefined {
  if (bytes.byteLength === 0 || bytes.byteLength > ANNOTATION_METADATA_MAX_BYTES) return undefined;
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (typeof record.pid !== "number" || !Number.isSafeInteger(record.pid) || record.pid <= 0) return undefined;
    if (typeof record.token !== "string" || !/^[a-f0-9]{32}$/u.test(record.token)) return undefined;
    const dev = record.dev === undefined ? undefined : record.dev;
    const ino = record.ino === undefined ? undefined : record.ino;
    if (dev !== undefined && (typeof dev !== "number" || !Number.isSafeInteger(dev) || dev < 0)) return undefined;
    if (ino !== undefined && (typeof ino !== "number" || !Number.isSafeInteger(ino) || ino < 0)) return undefined;
    return {
      pid: record.pid,
      token: record.token,
      ...(dev === undefined ? {} : { dev }),
      ...(ino === undefined ? {} : { ino }),
    };
  } catch {
    return undefined;
  }
}

interface ReadAnnotationMetadata {
  metadata: AnnotationMetadata;
  stats: Stats;
}

interface ReadAnnotationLock {
  kind: "empty" | "owned" | "malformed";
  stats: Stats;
  metadata?: AnnotationMetadata;
}

function readAnnotationLock(path: string): ReadAnnotationLock | undefined {
  const initial = inspectFile(path);
  if (initial.kind !== "regular" || !initial.stats || initial.stats.size > ANNOTATION_METADATA_MAX_BYTES) {
    return undefined;
  }
  let fd = -1;
  try {
    fd = openSync(path, constants.O_RDONLY | NO_FOLLOW);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.isSymbolicLink() || opened.size > ANNOTATION_METADATA_MAX_BYTES) {
      return undefined;
    }
    if (usableIdentity(initial.stats) && usableIdentity(opened) && !sameIdentity(initial.stats, opened)) return undefined;
    const bounded = Buffer.alloc(ANNOTATION_METADATA_MAX_BYTES + 1);
    const count = readSync(fd, bounded, 0, bounded.length, 0);
    const after = fstatSync(fd);
    if (count !== after.size || after.size > ANNOTATION_METADATA_MAX_BYTES) return undefined;
    if (usableIdentity(opened) && usableIdentity(after) && !sameIdentity(opened, after)) return undefined;
    if (count === 0) return { kind: "empty", stats: after };
    const metadata = parseAnnotationMetadata(bounded.subarray(0, count));
    if (!metadata) return { kind: "malformed", stats: after };
    if (metadata.dev !== undefined && metadata.ino !== undefined && usableIdentity(after)
      && (metadata.dev !== after.dev || metadata.ino !== after.ino)) return undefined;
    return { kind: "owned", metadata, stats: after };
  } catch {
    return undefined;
  } finally {
    if (fd >= 0) closeQuietly(fd);
  }
}

function readAnnotationMetadata(path: string): ReadAnnotationMetadata | undefined {
  const state = readAnnotationLock(path);
  return state?.kind === "owned" && state.metadata
    ? { metadata: state.metadata, stats: state.stats }
    : undefined;
}

function ownerState(pid: number): "alive" | "dead" | "unknown" {
  if (pid === process.pid) return "alive";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    return "unknown";
  }
}

function readPrivateMetadata(path: string): LockMetadata | undefined {
  const initial = inspectFile(path);
  if (initial.kind !== "regular" || !initial.stats || initial.stats.size === 0 || initial.stats.size > LOCK_METADATA_MAX_BYTES) {
    return undefined;
  }
  let fd = -1;
  try {
    fd = openSync(path, constants.O_RDONLY | NO_FOLLOW);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.isSymbolicLink() || opened.size === 0 || opened.size > LOCK_METADATA_MAX_BYTES) {
      return undefined;
    }
    const bounded = Buffer.alloc(LOCK_METADATA_MAX_BYTES + 1);
    const count = readSync(fd, bounded, 0, bounded.length, 0);
    const after = fstatSync(fd);
    if (count !== after.size || after.size > LOCK_METADATA_MAX_BYTES) return undefined;
    return parseLockMetadata(bounded.subarray(0, count));
  } catch {
    return undefined;
  } finally {
    if (fd >= 0) closeQuietly(fd);
  }
}

function removeCreatedPrivate(path: string, token: string, createdStats: Stats | undefined): void {
  const current = inspectFile(path);
  if (current.kind !== "regular" || !current.stats) return;
  const metadata = readPrivateMetadata(path);
  if (metadata && metadata.token !== token) return;
  if (createdStats && usableIdentity(createdStats) && usableIdentity(current.stats)
    && !sameIdentity(createdStats, current.stats)) return;
  try {
    unlinkSync(path);
  } catch {
    // The successful O_EXCL creator remains the only cooperative owner.
  }
}

function createPrivateLock(path: string): OwnedPrivateLock | undefined {
  let fd = -1;
  let created = false;
  let createdStats: Stats | undefined;
  let token: string | undefined;
  let succeeded = false;
  try {
    token = randomBytes(APPEND_LOCK_TOKEN_BYTES).toString("hex");
    const encoded = encodeLockMetadata(token);
    if (!encoded) return undefined;
    fd = openSync(path, "wx", 0o600);
    created = true;
    createdStats = fstatSync(fd);
    if (!createdStats.isFile() || createdStats.isSymbolicLink()) return undefined;
    if (writeSync(fd, encoded, 0, encoded.byteLength) !== encoded.byteLength) return undefined;
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== encoded.byteLength) return undefined;
    try {
      fchmodSync(fd, 0o600);
    } catch {
      // File mode is best effort on platforms that do not support it.
    }
    const owned = { fd, path, stats, token, pid: process.pid };
    succeeded = true;
    fd = -1;
    return owned;
  } catch {
    return undefined;
  } finally {
    if (fd >= 0) closeQuietly(fd);
    if (created && !succeeded && token) removeCreatedPrivate(path, token, createdStats);
  }
}

function reclaimDeadAppendLock(path: string, now: number): boolean {
  const initial = inspectFile(path);
  if (initial.kind !== "regular" || !initial.stats || !isStale(initial.stats, now)) return false;
  const metadata = readPrivateMetadata(path);
  if (!metadata || ownerState(metadata.pid) !== "dead") return false;
  const current = inspectFile(path);
  if (current.kind !== "regular" || !current.stats || !isStale(current.stats, now)) return false;
  const currentMetadata = readPrivateMetadata(path);
  if (!currentMetadata || currentMetadata.pid !== metadata.pid || currentMetadata.token !== metadata.token) return false;
  if (usableIdentity(initial.stats) && usableIdentity(current.stats) && !sameIdentity(initial.stats, current.stats)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

function readEmptyAppendLock(path: string): Stats | undefined {
  const initial = inspectFile(path);
  if (initial.kind !== "regular" || !initial.stats || initial.stats.size !== 0) return undefined;
  let fd = -1;
  try {
    fd = openSync(path, constants.O_RDONLY | NO_FOLLOW);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.isSymbolicLink() || opened.size !== 0
      || !sameIdentity(initial.stats, opened)) return undefined;
    const after = fstatSync(fd);
    if (!after.isFile() || after.isSymbolicLink() || after.size !== 0
      || !sameIdentity(opened, after)) return undefined;
    return after;
  } catch {
    return undefined;
  } finally {
    if (fd >= 0) closeQuietly(fd);
  }
}

function reclaimStaleEmptyAppendLock(path: string, now: number): boolean {
  const initial = readEmptyAppendLock(path);
  if (!initial || !isStale(initial, now)) return false;
  const current = readEmptyAppendLock(path);
  if (!current || !isStale(current, now) || !sameIdentity(initial, current)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

function acquireAppendLock(paths: RockyPaths, key: string): OwnedPrivateLock | undefined {
  let path: string;
  try {
    path = appendLockPath(paths, key);
  } catch {
    return undefined;
  }
  const existing = inspectFile(path);
  if (existing.kind === "missing") return createPrivateLock(path);
  const now = Date.now();
  if (!reclaimDeadAppendLock(path, now) && !reclaimStaleEmptyAppendLock(path, now)) return undefined;
  if (inspectFile(path).kind !== "missing") return undefined;
  return createPrivateLock(path);
}

function releaseAppendLock(lock: OwnedPrivateLock): void {
  closeQuietly(lock.fd);
  const current = inspectFile(lock.path);
  if (current.kind !== "regular" || !current.stats) return;
  const metadata = readPrivateMetadata(lock.path);
  if (!metadata || metadata.token !== lock.token || metadata.pid !== lock.pid) return;
  if (usableIdentity(lock.stats) && usableIdentity(current.stats) && !sameIdentity(lock.stats, current.stats)) return;
  try {
    unlinkSync(lock.path);
  } catch {
    // Races and permission errors are safe no-ops.
  }
}

/** Record bounded coverage before attempting an individual event append. */
export function recordCoverage(
  key: string,
  input: CoverageInput,
  paths = resolveRockyPaths(),
): boolean {
  if (!isSafeKey(key)) return false;
  const directory = spoolPath(paths);
  if (!directory || !ensureSpoolDirectory(directory)) return false;
  const appendLock = acquireAppendLock(paths, key);
  if (!appendLock) return false;
  try {
    if (!detachClaimedCoverageLiveLocked(key, paths)) return false;
    const merged = mergeCoverage(readCoverageUnlocked(paths, key), input);
    if (merged === undefined) {
      removeCoverageUnlocked(paths, key);
      return false;
    }
    const written = writeCoverageUnlocked(paths, key, merged);
    if (!written) removeCoverageUnlocked(paths, key);
    return written;
  } catch {
    return false;
  } finally {
    releaseAppendLock(appendLock);
  }
}

export function readCoverage(key: string, paths = resolveRockyPaths()): CoverageSnapshot | undefined {
  if (!isSafeKey(key)) return undefined;
  const directory = spoolPath(paths);
  if (!directory || !isSpoolDirectory(directory)) return undefined;
  const appendLock = acquireAppendLock(paths, key);
  if (!appendLock) return undefined;
  try {
    return readCoverageUnlocked(paths, key);
  } finally {
    releaseAppendLock(appendLock);
  }
}

function claimCoverageOwnedBy(snapshot: CoverageSnapshot | undefined, claim: BatchClaim): boolean {
  const claimDev = snapshot?.claimDev;
  const claimIno = snapshot?.claimIno;
  let currentDev: string | undefined;
  let currentIno: string | undefined;
  try {
    const current = lstatSync(claim.path, { bigint: true });
    if (regularDescriptorSafe(current)) {
      currentDev = identityToken(current.dev);
      currentIno = identityToken(current.ino);
    }
  } catch {
    // Fall back to the claim's captured identity only when it is safe.  A
    // rounded native-Windows number is never treated as ownership proof.
  }
  if (currentDev === undefined || currentIno === undefined) {
    currentDev = identityToken(claim.stats.dev);
    currentIno = identityToken(claim.stats.ino);
  }
  const storedDev = identityToken(claimDev);
  const storedIno = identityToken(claimIno);
  return snapshot?.claimId === claim.id
    && storedDev !== undefined
    && storedIno !== undefined
    && currentDev !== undefined
    && currentIno !== undefined
    && (storedDev !== "0" || storedIno !== "0")
    && (currentDev !== "0" || currentIno !== "0")
    && storedDev === currentDev && storedIno === currentIno;
}

/** Read only the coverage inode bound to this immutable claim. */
export function readClaimCoverage(claim: BatchClaim, paths = resolveRockyPaths()): CoverageSnapshot | undefined {
  const target = expectedClaimCoveragePath(claim, paths);
  if (!target || !isSpoolDirectory(paths.spoolDir)) return undefined;
  const appendLock = acquireAppendLock(paths, claim.key);
  if (!appendLock) return undefined;
  try {
    const currentClaim = inspectFile(claim.path);
    if (currentClaim.kind !== "regular" || !currentClaim.stats || !sameIdentity(claim.stats, currentClaim.stats)) return undefined;
    const snapshot = readCoverageFileUnlocked(target);
    if (snapshot !== undefined && claimCoverageOwnedBy(snapshot, claim)) return snapshot;
    // A regular claim artifact with no verifiable owner is explicit unknown,
    // not absence of coverage.  This prevents a forged complete sidecar from
    // being trusted while preserving disclosure through annotation.
    if (inspectFile(target).kind === "regular") {
      return {
        v: 1, agent: "codex", paths: [], identityHashes: [], candidateCount: 0,
        candidateCountExact: false, pathsComplete: false, payloads: 1, claimId: claim.id,
      };
    }
    return undefined;
  } finally {
    releaseAppendLock(appendLock);
  }
}

function removeCoverageUnlocked(paths: RockyPaths, key: string): boolean {
  let file: string;
  try { file = coveragePath(paths, key); } catch { return false; }
  const info = inspectFile(file);
  if (info.kind === "missing") return true;
  if (info.kind !== "regular" || !info.stats) return false;
  removeRegular(file, info.stats);
  return inspectFile(file).kind === "missing";
}

export function removeCoverage(key: string, paths = resolveRockyPaths()): boolean {
  if (!isSafeKey(key)) return false;
  const directory = spoolPath(paths);
  if (!directory || !isSpoolDirectory(directory)) return false;
  const appendLock = acquireAppendLock(paths, key);
  if (!appendLock) return false;
  try {
    return removeCoverageUnlocked(paths, key);
  } finally {
    releaseAppendLock(appendLock);
  }
}

function removeClaimCoverageUnlocked(claim: BatchClaim, paths: RockyPaths): boolean {
  const target = expectedClaimCoveragePath(claim, paths);
  if (!target) return false;
  const info = inspectFile(target);
  if (info.kind === "missing") return true;
  if (info.kind !== "regular" || !info.stats) return false;
  removeRegular(target, info.stats);
  return inspectFile(target).kind === "missing";
}

export function removeClaimCoverage(claim: BatchClaim, paths = resolveRockyPaths()): boolean {
  const target = expectedClaimCoveragePath(claim, paths);
  if (!target || !isSpoolDirectory(paths.spoolDir)) return false;
  const appendLock = acquireAppendLock(paths, claim.key);
  if (!appendLock) return false;
  try { return removeClaimCoverageUnlocked(claim, paths); }
  finally { releaseAppendLock(appendLock); }
}

function removeOwnedAnnotationLock(path: string, token: string, pid: number, stats: Stats | undefined): boolean {
  const current = readAnnotationMetadata(path);
  if (!current || current.metadata.token !== token || current.metadata.pid !== pid) return false;
  if (stats && usableIdentity(stats) && usableIdentity(current.stats) && !sameIdentity(stats, current.stats)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    // The append lease serializes cooperative owners; failure leaves recovery state.
    return false;
  }
}

function createAnnotationLease(path: string, key: string): AnnotationLease | undefined {
  let fd = -1;
  let created = false;
  let createdStats: Stats | undefined;
  let token: string | undefined;
  let succeeded = false;
  try {
    token = randomBytes(ANNOTATION_LOCK_TOKEN_BYTES).toString("hex");
    fd = openSync(path, "wx", 0o600);
    created = true;
    createdStats = fstatSync(fd);
    if (!createdStats.isFile() || createdStats.isSymbolicLink()) return undefined;
    const encoded = encodeAnnotationMetadata(token, createdStats);
    if (!encoded || writeSync(fd, encoded, 0, encoded.byteLength) !== encoded.byteLength) return undefined;
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== encoded.byteLength) return undefined;
    try {
      fchmodSync(fd, 0o600);
    } catch {
      // File mode is best effort on platforms without chmod support.
    }
    const lease: AnnotationLease = { key, path, token, pid: process.pid, stats };
    succeeded = true;
    closeQuietly(fd);
    fd = -1;
    return lease;
  } catch {
    return undefined;
  } finally {
    if (fd >= 0) closeQuietly(fd);
    if (created && !succeeded && token) removeOwnedAnnotationLock(path, token, process.pid, createdStats);
  }
}

function removeLegacyAnnotationLock(path: string, stats: Stats): boolean {
  const current = inspectFile(path);
  if (current.kind !== "regular" || !current.stats) return false;
  if (usableIdentity(stats) && usableIdentity(current.stats) && !sameIdentity(stats, current.stats)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

function acquireAnnotationLeaseLocked(key: string, paths: RockyPaths, now: number): AnnotationLease | undefined {
  const path = lockPath(paths, key);
  const existing = inspectFile(path);
  if (existing.kind === "other") return undefined;
  if (existing.kind === "regular") {
    if (!existing.stats || !isStale(existing.stats, now)) return undefined;
    const owner = readAnnotationLock(path);
    if (!owner) return undefined;
    if (owner.kind === "owned" && owner.metadata) {
      if (ownerState(owner.metadata.pid) !== "dead") return undefined;
      if (existing.stats && usableIdentity(existing.stats) && usableIdentity(owner.stats)
        && !sameIdentity(existing.stats, owner.stats)) return undefined;
      if (!removeOwnedAnnotationLock(path, owner.metadata.token, owner.metadata.pid, owner.stats)) return undefined;
    } else if (owner.kind === "empty") {
      if (!removeLegacyAnnotationLock(path, existing.stats)) return undefined;
    } else {
      return undefined;
    }
  }
  return createAnnotationLease(path, key);
}

export function acquireAnnotationLease(
  key: string,
  paths = resolveRockyPaths(),
  now = Date.now(),
): AnnotationLease | undefined {
  if (!isSafeKey(key)) return undefined;
  const directory = spoolPath(paths);
  if (!directory || !ensureSpoolDirectory(directory)) return undefined;
  const appendLock = acquireAppendLock(paths, key);
  if (!appendLock) return undefined;
  try {
    return acquireAnnotationLeaseLocked(key, paths, Number.isFinite(now) ? now : Date.now());
  } finally {
    releaseAppendLock(appendLock);
  }
}

export function releaseAnnotationLease(lease: AnnotationLease, paths = resolveRockyPaths()): void {
  if (!lease || !isSafeKey(lease.key)) return;
  const directory = spoolPath(paths);
  if (!directory || !isSpoolDirectory(directory)) return;
  const appendLock = acquireAppendLock(paths, lease.key);
  if (!appendLock) return;
  try {
    removeOwnedAnnotationLock(lease.path, lease.token, lease.pid, lease.stats);
  } finally {
    releaseAppendLock(appendLock);
  }
}

function appendBufferLocked(file: string, candidate: Buffer): boolean {
  const before = inspectFile(file);
  if (before.kind === "other") return false;
  if (before.stats && before.stats.size + candidate.byteLength > MAX_BATCH_BYTES) return false;

  let fd = -1;
  try {
    const create = before.kind === "missing";
    fd = openSync(
      file,
      constants.O_WRONLY | constants.O_APPEND | (create ? constants.O_CREAT | constants.O_EXCL : constants.O_CREAT) | NO_FOLLOW,
      0o600,
    );
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.isSymbolicLink()) return false;
    if (before.stats && !sameIdentity(before.stats, opened)) return false;
    if (opened.size + candidate.byteLength > MAX_BATCH_BYTES) return false;
    try {
      fchmodSync(fd, 0o600);
    } catch {
      // File mode is best effort on platforms that do not support it.
    }
    if (writeSync(fd, candidate, 0, candidate.byteLength) !== candidate.byteLength) return false;
    const after = fstatSync(fd);
    return after.isFile() && !after.isSymbolicLink() && sameIdentity(opened, after);
  } catch {
    // Spool is transient; callers must never fail because it is unavailable.
    return false;
  } finally {
    if (fd >= 0) closeQuietly(fd);
  }
}

function encodeEvent(event: AgentEvent): Buffer | undefined {
  try {
    const encoded = JSON.stringify(event);
    if (typeof encoded !== "string") return undefined;
    const candidate = Buffer.from(`${encoded}\n`, "utf8");
    return candidate.byteLength <= MAX_BATCH_BYTES ? candidate : undefined;
  } catch {
    return undefined;
  }
}

export function appendEvent(key: string, event: AgentEvent, paths = resolveRockyPaths()): boolean {
  if (!isSafeKey(key)) return false;
  const candidate = encodeEvent(event);
  if (!candidate) return false;
  const directory = spoolPath(paths);
  if (!directory || !ensureSpoolDirectory(directory)) return false;
  let file: string;
  try { file = batchPath(paths, key); } catch { return false; }
  const appendLock = acquireAppendLock(paths, key);
  if (!appendLock) return false;
  try {
    if (!detachClaimedLiveLocked(key, paths, file)) return false;
    if (!detachClaimedCoverageLiveLocked(key, paths)) return false;
    return appendBufferLocked(file, candidate);
  } finally {
    releaseAppendLock(appendLock);
  }
}

/**
 * Append one adapter payload while holding one per-key generation lock.  The
 * sidecar merge and every individual event write therefore share the same
 * claim boundary; annotation cannot bind a new sidecar to an older JSONL
 * generation between two otherwise independent calls.
 */
export function appendPayload(
  key: string,
  events: readonly AgentEvent[],
  coverage: CoverageInput | undefined,
  paths = resolveRockyPaths(),
  /**
   * Compatibility seam for callers which need to model individual append
   * failures. Normal hook calls leave this undefined and use one lock for the
   * sidecar plus every event below.
   */
  appendOverride?: typeof appendEvent,
): boolean[] {
  const results = events.map(() => false);
  if (!isSafeKey(key) || !Array.isArray(events) || events.length > MAX_COVERAGE_PATHS) return results;
  const directory = spoolPath(paths);
  if (!directory || !ensureSpoolDirectory(directory)) return results;
  let file: string;
  try { file = batchPath(paths, key); } catch { return results; }

  if (appendOverride !== undefined) {
    // Test/embedding seam only. Keep the hook boundary itself transactional;
    // this path deliberately preserves the old per-event failure injection
    // while recording a bounded witness before invoking the supplied writer.
    let coverageWritten = coverage === undefined;
    if (coverage !== undefined) {
      try { coverageWritten = recordCoverage(key, coverage, paths); } catch { coverageWritten = false; }
    }
    let fallbackCoveragePending = coverage !== undefined && !coverageWritten;
    const fallbackPaths = coverage === undefined ? [] : coverage.paths
      .filter((path): path is string => typeof path === "string")
      .slice(0, MAX_COVERAGE_WITNESSES);
    for (let index = 0; index < events.length; index += 1) {
      const original = events[index]!;
      const event = fallbackCoveragePending && original.kind === "mechanism"
        ? { ...original, coveragePaths: fallbackPaths, coveragePathsComplete: false }
        : original;
      try {
        results[index] = appendOverride(key, event, paths) === true;
      } catch {
        results[index] = false;
      }
      if (results[index] && fallbackCoveragePending && original.kind === "mechanism") fallbackCoveragePending = false;
    }
    return results;
  }

  const appendLock = acquireAppendLock(paths, key);
  if (!appendLock) return results;
  try {
    if (!detachClaimedLiveLocked(key, paths, file)) return results;
    if (!detachClaimedCoverageLiveLocked(key, paths)) return results;
    let coverageWritten = true;
    if (coverage !== undefined) {
      const merged = mergeCoverage(readCoverageUnlocked(paths, key), coverage);
      if (merged === undefined || !writeCoverageUnlocked(paths, key, merged)) {
        // A failed replacement must invalidate any prior generation proof.
        removeCoverageUnlocked(paths, key);
        coverageWritten = false;
      }
    }
    let fallbackCoveragePending = coverage !== undefined && !coverageWritten;
    const fallbackPaths = coverage === undefined ? [] : coverage.paths
      .filter((path): path is string => typeof path === "string")
      .slice(0, MAX_COVERAGE_WITNESSES);
    for (let index = 0; index < events.length; index += 1) {
      const original = events[index]!;
      const event = fallbackCoveragePending && original.kind === "mechanism"
        ? { ...original, coveragePaths: fallbackPaths, coveragePathsComplete: false }
        : original;
      const candidate = encodeEvent(event);
      if (candidate !== undefined) {
        results[index] = appendBufferLocked(file, candidate);
        if (results[index] && fallbackCoveragePending && original.kind === "mechanism") fallbackCoveragePending = false;
      }
    }
    return results;
  } catch {
    return results;
  } finally {
    releaseAppendLock(appendLock);
  }
}

/** Bounded turn-level witness independent from per-event append success. */
export interface CoverageInput {
  agent: AgentName;
  paths: readonly string[];
  candidateCount?: number;
  candidateCountExact?: boolean;
  pathsComplete?: boolean;
  /** Operational turn cwd used only to collapse relative/absolute aliases. */
  cwd?: string;
  /** Adapter digest over the full candidate set, when bounded paths omit identities. */
  payloadDigest?: string;
}

export interface CoverageSnapshot {
  v: 1;
  agent: AgentName;
  paths: string[];
  /** Compact canonical identity witnesses; paths are display witnesses only. */
  identityHashes?: string[];
  candidateCount?: number;
  candidateCountExact: boolean;
  pathsComplete: boolean;
  payloads: number;
  /** Bounded idempotency keys for payload retries. */
  payloadDigests?: string[];
  /** Operational cwd used to resolve relative sidecar witnesses. */
  cwd?: string;
  /** Present only after the snapshot is copied into an immutable claim. */
  claimId?: string;
  /** Claim JSONL inode identity binds a copied sidecar to its generation. */
  /** Decimal identity tokens; strings preserve native-Windows 64-bit inodes. */
  claimDev?: string | number;
  claimIno?: string | number;
}

export function readBatch(key: string, paths = resolveRockyPaths()): AgentEvent[] {
  if (!isSafeKey(key)) return [];

  const directory = spoolPath(paths);
  if (!directory || !isSpoolDirectory(directory)) return [];

  let file: string;
  try {
    file = batchPath(paths, key);
  } catch {
    return [];
  }

  const initial = inspectFile(file);
  if (initial.kind === "missing") {
    const claim = existingClaims(key, paths)[0];
    return claim ? readClaim(claim, paths) : [];
  }
  if (initial.kind !== "regular" || !initial.stats || initial.stats.size > MAX_BATCH_BYTES) return [];

  let fd = -1;
  let bytes: Buffer;
  try {
    fd = openSync(file, constants.O_RDONLY | NO_FOLLOW);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.isSymbolicLink() || opened.size > MAX_BATCH_BYTES) return [];
    const bounded = Buffer.alloc(MAX_BATCH_BYTES + 1);
    const count = readSync(fd, bounded, 0, bounded.length, 0);
    const after = fstatSync(fd);
    if (count > MAX_BATCH_BYTES || after.size > MAX_BATCH_BYTES) return [];
    bytes = bounded.subarray(0, count);
  } catch {
    return [];
  } finally {
    if (fd >= 0) closeQuietly(fd);
  }

  const events: AgentEvent[] = [];
  for (const line of bytes.toString("utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = parseAgentEvent(JSON.parse(line));
      if (parsed) events.push(parsed);
    } catch {
      // Malformed transient lines are skippable.
    }
  }
  return events;
}

function claimName(key: string, id: string): string {
  return `${key}.claim.${id}.jsonl`;
}

function expectedClaimPath(claim: BatchClaim, paths: RockyPaths): string | undefined {
  const directory = spoolPath(paths);
  if (!directory || !claim || !isSafeKey(claim.key) || !/^[a-f0-9]{32}$/u.test(claim.id)) return undefined;
  const expected = join(directory, claimName(claim.key, claim.id));
  return claim.path === expected ? expected : undefined;
}

function claimFromName(directory: string, name: string): BatchClaim | undefined {
  const match = CLAIM_PATTERN.exec(name);
  if (!match) return undefined;
  const key = match[1];
  const id = match[2];
  if (!key || !id) return undefined;
  const path = join(directory, name);
  const info = inspectFile(path);
  if (info.kind !== "regular" || !info.stats) return undefined;
  return { key, id, path, stats: info.stats };
}

function existingClaims(key: string, paths: RockyPaths): BatchClaim[] {
  const directory = spoolPath(paths);
  if (!directory || !isSpoolDirectory(directory)) return [];
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  return names
    .map((name) => claimFromName(directory, name))
    .filter((claim): claim is BatchClaim => claim !== undefined && claim.key === key)
    .sort((left, right) => left.path.localeCompare(right.path));
}

function expectedClaimCoveragePath(claim: BatchClaim, paths: RockyPaths): string | undefined {
  const directory = spoolPath(paths);
  if (!directory || !expectedClaimPath(claim, paths) || !isSafeKey(claim.key) || !/^[a-f0-9]{32}$/u.test(claim.id)) return undefined;
  const expected = claimCoveragePath(paths, claim.key, claim.id);
  return expected;
}

/** Bind the sidecar inode to the immutable claim while holding append lock. */
function bindClaimCoverageLocked(key: string, claim: BatchClaim, paths: RockyPaths, allowLive: boolean): boolean {
  const livePath = coveragePath(paths, key);
  const target = expectedClaimCoveragePath(claim, paths);
  if (!target) return false;
  let existingTarget = inspectFile(target);
  if (existingTarget.kind === "regular" && existingTarget.stats) {
    const owned = readCoverageFileUnlocked(target);
    if (claimCoverageOwnedBy(owned, claim)) {
      // A still-live sidecar must be the same inode that was copied into this
      // claim.  If JSONL still names the claim inode, a different live
      // sidecar is the crash window between copy and unlink and can be
      // removed safely.  A different JSONL inode is a newer generation and
      // must remain live.
      const live = inspectFile(livePath);
      if (allowLive && live.kind === "regular" && live.stats && !sameIdentity(live.stats, existingTarget.stats)) {
        const liveJsonl = inspectFile(batchPath(paths, key));
        if (liveJsonl.kind === "regular" && liveJsonl.stats && sameIdentity(liveJsonl.stats, claim.stats)) {
          removeRegular(livePath, live.stats);
          return inspectFile(livePath).kind === "missing";
        }
        return false;
      }
      return true;
    }
    if (!allowLive && inspectFile(livePath).kind === "missing") {
      // Keep an unowned regular artifact visible to readClaimCoverage, which
      // will expose an explicit synthetic unknown snapshot.  Removing it here
      // would make a forged sidecar indistinguishable from proven zero
      // coverage; claim cleanup removes the artifact after annotation.
      return true;
    }
    // A regular but unowned/corrupt claim sidecar is not evidence. Remove it
    // only after an inode re-check, then continue with the detached claim or
    // bind the verified live generation below.
    removeRegular(target, existingTarget.stats);
    existingTarget = inspectFile(target);
    if (inspectFile(target).kind !== "missing") return false;
  }
  if (existingTarget.kind !== "missing") return false;
  // A detached claim may coexist with a newer live JSONL generation.  In
  // that case the live sidecar belongs to the newer generation and must not
  // be moved into this old claim.
  if (!allowLive) return true;
  const live = inspectFile(livePath);
  if (live.kind === "missing") return true;
  if (live.kind !== "regular" || !live.stats) return false;
  const snapshot = readCoverageFileUnlocked(livePath);
  if (!snapshot || snapshot.claimId !== undefined) return false;
  let temporary: string | undefined;
  try {
    temporary = claimCoverageTempPath(paths, key, claim.id);
    const claimIdentity = lstatSync(claim.path, { bigint: true });
    if (!regularDescriptorSafe(claimIdentity)) return false;
    const claimDev = identityToken(claimIdentity.dev);
    const claimIno = identityToken(claimIdentity.ino);
    if (claimDev === undefined || claimIno === undefined || (claimDev === "0" && claimIno === "0")) return false;
    const owned = { ...snapshot, claimId: claim.id, claimDev, claimIno } satisfies CoverageSnapshot;
    if (!writeCoverageTargetUnlocked(target, temporary, owned)) return false;
    const written = inspectFile(target);
    if (written.kind !== "regular" || !written.stats) return false;
    const currentLive = inspectFile(livePath);
    if (currentLive.kind !== "regular" || !currentLive.stats || !sameIdentity(live.stats, currentLive.stats)) {
      removeRegular(target, written.stats);
      return false;
    }
    unlinkSync(livePath);
    const after = inspectFile(livePath);
    if (after.kind === "missing") return true;
    removeRegular(target, written.stats);
    return false;
  } catch {
    if (temporary !== undefined) {
      try { unlinkSync(temporary); } catch { /* best effort */ }
    }
    try { removeRegular(target); } catch { /* best effort */ }
    return false;
  } finally {
    if (temporary !== undefined) {
      try { unlinkSync(temporary); } catch { /* best effort */ }
    }
  }
}

/** Detach a claim-owned sidecar before a new live generation is written. */
function detachClaimedCoverageLiveLocked(key: string, paths: RockyPaths): boolean {
  let livePath: string;
  try { livePath = coveragePath(paths, key); } catch { return false; }
  let live = inspectFile(livePath);
  if (live.kind === "missing") return true;
  if (live.kind !== "regular" || !live.stats) return false;
  for (const claim of existingClaims(key, paths)) {
    const target = expectedClaimCoveragePath(claim, paths);
    if (!target) continue;
    const owned = inspectFile(target);
    if (owned.kind !== "regular" || !owned.stats || !sameIdentity(live.stats, owned.stats)) continue;
    try { unlinkSync(livePath); } catch { /* verify below */ }
    live = inspectFile(livePath);
    return live.kind === "missing" || (live.kind === "regular" && live.stats !== undefined && !sameIdentity(live.stats, owned.stats));
  }
  return true;
}

function refreshClaimLocked(
  key: string,
  requested: BatchClaim | undefined,
  paths: RockyPaths,
): BatchClaim | undefined {
  const directory = spoolPath(paths);
  if (!directory) return undefined;
  if (requested === undefined) return existingClaims(key, paths)[0];
  if (requested.key !== key || !expectedClaimPath(requested, paths)) return undefined;
  const refreshed = claimFromName(directory, claimName(key, requested.id));
  if (!refreshed || !sameIdentity(requested.stats, refreshed.stats)) return undefined;
  return refreshed;
}

/**
 * Validate a claim while holding the per-key append lock, detaching only the
 * canonical live link that names the claim inode. A different live inode is
 * a late append and remains eligible for the next batch.
 */
function prepareClaimLocked(
  key: string,
  requested: BatchClaim | undefined,
  paths: RockyPaths,
): BatchClaim | undefined {
  const current = refreshClaimLocked(key, requested, paths);
  if (!current) return undefined;

  const livePath = batchPath(paths, key);
  let live = inspectFile(livePath);
  if (live.kind === "missing") {
    return bindClaimCoverageLocked(key, current, paths, false) ? current : undefined;
  }
  if (live.kind !== "regular" || !live.stats) return undefined;
  if (identitiesDiffer(current.stats, live.stats)) return current;
  if (!sameIdentity(current.stats, live.stats)) return undefined;

  if (!bindClaimCoverageLocked(key, current, paths, true)) return undefined;

  try {
    unlinkSync(livePath);
  } catch {
    // Re-inspection below decides whether the canonical path is still unsafe.
  }
  live = inspectFile(livePath);
  if (live.kind === "missing") return current;
  if (live.kind !== "regular" || !live.stats) return undefined;
  return identitiesDiffer(current.stats, live.stats) ? current : undefined;
}

/**
 * Before opening the live file for append, detach any post-claim hard link.
 * The canonical path may be missing or may name a distinct late-event inode;
 * it must never still name an existing claim inode.
 */
function detachClaimedLiveLocked(key: string, paths: RockyPaths, livePath: string): boolean {
  let live = inspectFile(livePath);
  if (live.kind === "missing") return true;
  if (live.kind !== "regular" || !live.stats) return false;

  const claims = existingClaims(key, paths);
  for (const claim of claims) {
    if (sameIdentity(claim.stats, live.stats)) {
      try {
        unlinkSync(livePath);
      } catch {
        // Re-inspection below keeps the immutable claim protected.
      }
      live = inspectFile(livePath);
      if (live.kind === "missing") return true;
      if (live.kind !== "regular" || !live.stats) return false;
      for (const remaining of existingClaims(key, paths)) {
        if (!identitiesDiffer(remaining.stats, live.stats)) return false;
      }
      return true;
    }
    if (!identitiesDiffer(claim.stats, live.stats)) return false;
  }
  return true;
}

export function prepareClaim(claim: BatchClaim, paths = resolveRockyPaths()): BatchClaim | undefined {
  if (!claim || !isSafeKey(claim.key)) return undefined;
  const directory = spoolPath(paths);
  if (!directory || !isSpoolDirectory(directory)) return undefined;
  const appendLock = acquireAppendLock(paths, claim.key);
  if (!appendLock) return undefined;
  try {
    return prepareClaimLocked(claim.key, claim, paths);
  } finally {
    releaseAppendLock(appendLock);
  }
}

export function claimBatch(key: string, paths = resolveRockyPaths()): BatchClaim | undefined {
  if (!isSafeKey(key)) return undefined;
  const directory = spoolPath(paths);
  if (!directory || !ensureSpoolDirectory(directory)) return undefined;
  const existing = existingClaims(key, paths)[0];
  if (existing) {
    const appendLock = acquireAppendLock(paths, key);
    if (!appendLock) return undefined;
    try {
      const current = existingClaims(key, paths)[0];
      return prepareClaimLocked(key, current, paths);
    } finally {
      releaseAppendLock(appendLock);
    }
  }

  const appendLock = acquireAppendLock(paths, key);
  if (!appendLock) return undefined;
  try {
    const afterLock = existingClaims(key, paths)[0];
    if (afterLock) return prepareClaimLocked(key, afterLock, paths);
    const livePath = batchPath(paths, key);
    const live = inspectFile(livePath);
    if (live.kind !== "regular" || !live.stats || live.stats.size > MAX_BATCH_BYTES) return undefined;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      let id: string;
      try {
        id = randomBytes(CLAIM_TOKEN_BYTES).toString("hex");
      } catch {
        return undefined;
      }
      const target = join(directory, claimName(key, id));
      if (inspectFile(target).kind !== "missing") continue;
      try {
        linkSync(livePath, target);
      } catch {
        continue;
      }
      const claim = claimFromName(directory, claimName(key, id));
      return claim ? prepareClaimLocked(key, claim, paths) : undefined;
    }
    return undefined;
  } finally {
    releaseAppendLock(appendLock);
  }
}

function readClaimBytes(claim: BatchClaim, paths: RockyPaths): Buffer | undefined {
  if (!expectedClaimPath(claim, paths)) return undefined;
  const initial = inspectFile(claim.path);
  if (initial.kind !== "regular" || !initial.stats || !compatibleIdentity(claim.stats, initial.stats)
    || initial.stats.size > MAX_BATCH_BYTES) return undefined;
  let fd = -1;
  try {
    fd = openSync(claim.path, constants.O_RDONLY | NO_FOLLOW);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.isSymbolicLink() || !compatibleIdentity(claim.stats, opened)
      || opened.size > MAX_BATCH_BYTES || opened.size !== initial.stats.size) return undefined;
    const bounded = Buffer.alloc(MAX_BATCH_BYTES + 1);
    const count = readSync(fd, bounded, 0, bounded.length, 0);
    const after = fstatSync(fd);
    if (count !== after.size || count > MAX_BATCH_BYTES || after.size > MAX_BATCH_BYTES
      || after.size !== opened.size || !compatibleIdentity(opened, after)) return undefined;
    return bounded.subarray(0, count);
  } catch {
    return undefined;
  } finally {
    if (fd >= 0) closeQuietly(fd);
  }
}

export type ClaimReadResult =
  | { readonly ok: true; readonly events: AgentEvent[] }
  | { readonly ok: false };

function parseClaimEvents(bytes: Buffer): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const line of bytes.toString("utf8").split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const parsed = parseAgentEvent(JSON.parse(line));
      if (parsed) events.push(parsed);
    } catch {
      // Malformed immutable claim lines are skippable.
    }
  }
  return events;
}

export function readClaimResult(claim: BatchClaim, paths = resolveRockyPaths()): ClaimReadResult {
  const bytes = readClaimBytes(claim, paths);
  return bytes === undefined ? { ok: false } : { ok: true, events: parseClaimEvents(bytes) };
}

export function readClaim(claim: BatchClaim, paths = resolveRockyPaths()): AgentEvent[] {
  const result = readClaimResult(claim, paths);
  return result.ok ? result.events : [];
}

export function removeClaim(claim: BatchClaim, paths = resolveRockyPaths()): boolean {
  if (!expectedClaimPath(claim, paths) || !isSpoolDirectory(paths.spoolDir)) return false;
  const appendLock = acquireAppendLock(paths, claim.key);
  if (!appendLock) return false;
  try {
    const current = inspectFile(claim.path);
    if (current.kind !== "regular" || !current.stats || !sameIdentity(claim.stats, current.stats)) return false;
    let fd = -1;
    try {
      fd = openSync(claim.path, constants.O_RDONLY | NO_FOLLOW);
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.isSymbolicLink() || !sameIdentity(claim.stats, opened)) return false;
    } catch {
      return false;
    } finally {
      if (fd >= 0) closeQuietly(fd);
    }
    removeRegular(claim.path, claim.stats);
    if (inspectFile(claim.path).kind !== "missing") return false;
    // The coverage sidecar is claim-owned. Never remove the live generation
    // here; a late append may have created it after this claim was bound.
    removeClaimCoverageUnlocked(claim, paths);
    return true;
  } finally {
    releaseAppendLock(appendLock);
  }
}

export function listOrphanClaims(now = Date.now(), paths = resolveRockyPaths()): BatchClaim[] {
  const directory = spoolPath(paths);
  if (!directory || !isSpoolDirectory(directory)) return [];
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  const reference = Number.isFinite(now) ? now : Date.now();
  sweepOrphanCoverageArtifacts(names, directory, reference, paths);
  return names
    .map((name) => claimFromName(directory, name))
    .filter((claim): claim is BatchClaim => claim !== undefined && isStale(claim.stats, reference))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function removeRegular(path: string, expected?: Stats): void {
  const initial = inspectFile(path);
  if (initial.kind !== "regular" || !initial.stats) return;
  if (expected && !compatibleIdentity(expected, initial.stats)) return;
  // Re-lstat before unlink so a pathname replacement between discovery and
  // cleanup is not accepted as the original artifact.  The caller remains
  // fail-closed if the platform cannot provide stable inode identity.
  const checked = inspectFile(path);
  if (checked.kind !== "regular" || !checked.stats
    || !compatibleIdentity(initial.stats, checked.stats)
    || (expected && !compatibleIdentity(expected, checked.stats))) return;
  try {
    unlinkSync(path);
  } catch {
    // Races and permission errors are safe no-ops.
  }
}

const MAX_ORPHAN_ARTIFACTS = 512;

/** Bounded crash cleanup for sidecars which have lost their owning JSONL. */
function sweepOrphanCoverageArtifacts(
  names: readonly string[],
  directory: string,
  now: number,
  paths: RockyPaths,
): void {
  const boundedNames = names.slice(0, MAX_ORPHAN_ARTIFACTS);
  for (const name of boundedNames) {
    try {
      const fullPath = join(directory, name);
      const info = inspectFile(fullPath);
      if (info.kind !== "regular" || !info.stats || !isStale(info.stats, now)) continue;

      const claimCoverage = CLAIM_COVERAGE_PATTERN.exec(name);
      if (claimCoverage) {
        const claimNameValue = `${claimCoverage[1]}.claim.${claimCoverage[2]}.jsonl`;
        if (inspectFile(join(directory, claimNameValue)).kind === "missing") removeRegular(fullPath, info.stats);
        continue;
      }

      const temp = COVERAGE_TEMP_PATTERN.exec(name);
      if (temp) {
        const key = temp[1];
        const lock = inspectFile(lockPath(paths, key));
        if (lock.kind === "missing" || (lock.kind === "regular" && lock.stats && isStale(lock.stats, now))) {
          removeRegular(fullPath, info.stats);
        }
        continue;
      }

      if (!name.endsWith(COVERAGE_SUFFIX)) continue;
      const key = name.slice(0, -COVERAGE_SUFFIX.length);
      if (!isSafeKey(key)) continue;
      const batch = inspectFile(batchPath(paths, key));
      const lock = inspectFile(lockPath(paths, key));
      const lockSafe = lock.kind === "missing" || (lock.kind === "regular" && lock.stats && isStale(lock.stats, now));
      if (lockSafe && (batch.kind === "missing" || (batch.kind === "regular" && batch.stats && isStale(batch.stats, now)))) {
        removeRegular(fullPath, info.stats);
      }
    } catch {
      // Orphan cleanup is best effort and must never affect hook/annotation.
    }
  }
}

export function removeBatch(key: string, paths = resolveRockyPaths()): void {
  if (!isSafeKey(key)) return;
  const directory = spoolPath(paths);
  if (!directory || !isSpoolDirectory(directory)) return;
  try {
    removeRegular(batchPath(paths, key));
    removeCoverageUnlocked(paths, key);
    const mapKey = compatibilityLeaseKey(paths, key);
    const lease = compatibilityLeases.get(mapKey);
    if (lease) {
      compatibilityLeases.delete(mapKey);
      releaseAnnotationLease(lease, paths);
    }
  } catch {
    // Transient state is always best effort.
  }
}

export function acquireLock(key: string, paths = resolveRockyPaths()): boolean {
  const lease = acquireAnnotationLease(key, paths);
  if (!lease) return false;
  compatibilityLeases.set(compatibilityLeaseKey(paths, key), lease);
  return true;
}

export function listOrphanBatches(now = Date.now(), paths = resolveRockyPaths()): string[] {
  const directory = spoolPath(paths);
  if (!directory || !isSpoolDirectory(directory)) return [];

  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }

  const reference = Number.isFinite(now) ? now : Date.now();
  sweepOrphanCoverageArtifacts(names, directory, reference, paths);
  const orphans: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const key = name.slice(0, -".jsonl".length);
    if (!isSafeKey(key)) continue;

    let batch: FileInfo;
    let lock: FileInfo;
    try {
      batch = inspectFile(join(directory, name));
      if (batch.kind !== "regular" || !batch.stats || !isStale(batch.stats, reference)) continue;
      lock = inspectFile(lockPath(paths, key));
    } catch {
      continue;
    }
    if (lock.kind === "missing" || (lock.kind === "regular" && lock.stats && isStale(lock.stats, reference))) {
      orphans.push(key);
    }
  }
  return orphans.sort();
}
