import { randomBytes } from "node:crypto";
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
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";
import { resolveRockyPaths, type RockyPaths } from "../core/state-paths.js";
import { parseAgentEvent, type AgentEvent } from "./schema.js";

export const MAX_BATCH_BYTES = 256 * 1024;
export const MAX_SPOOL_BATCHES = 50;
export const ORPHAN_AGE_MS = 10 * 60 * 1000;

const MAX_KEY_CHARS = 120;
const SAFE_KEY = /^[A-Za-z0-9_-]{1,120}$/;
const NO_FOLLOW = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
const APPEND_LOCK_SUFFIX = ".append.lock";
const APPEND_LOCK_TOKEN_BYTES = 16;
const LOCK_METADATA_MAX_BYTES = 128;
const ANNOTATION_LOCK_TOKEN_BYTES = 16;
const ANNOTATION_METADATA_MAX_BYTES = 192;
const CLAIM_TOKEN_BYTES = 16;
const CLAIM_PATTERN = /^([A-Za-z0-9_-]{1,120})\.claim\.([a-f0-9]{32})\.jsonl$/u;

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
    const dev = Number.isSafeInteger(stats.dev) ? stats.dev : 0;
    const ino = Number.isSafeInteger(stats.ino) ? stats.ino : 0;
    const encoded = Buffer.from(JSON.stringify({ pid: process.pid, token, dev, ino }), "utf8");
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

export function appendEvent(key: string, event: AgentEvent, paths = resolveRockyPaths()): void {
  if (!isSafeKey(key)) return;

  let line: string;
  try {
    const encoded = JSON.stringify(event);
    if (typeof encoded !== "string") return;
    line = `${encoded}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_BATCH_BYTES) return;
  } catch {
    return;
  }

  const directory = spoolPath(paths);
  if (!directory || !ensureSpoolDirectory(directory)) return;

  let file: string;
  try {
    file = batchPath(paths, key);
  } catch {
    return;
  }

  const candidate = Buffer.from(line, "utf8");
  const appendLock = acquireAppendLock(paths, key);
  if (!appendLock) return;
  try {
    if (!detachClaimedLiveLocked(key, paths, file)) return;
    const before = inspectFile(file);
    if (before.kind === "other") return;
    if (before.stats && before.stats.size + candidate.byteLength > MAX_BATCH_BYTES) return;

    let fd = -1;
    try {
      fd = openSync(
        file,
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | NO_FOLLOW,
        0o600,
      );
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.isSymbolicLink()) return;
      if (opened.size + candidate.byteLength > MAX_BATCH_BYTES) return;
      try {
        fchmodSync(fd, 0o600);
      } catch {
        // File mode is best effort on platforms that do not support it.
      }
      writeSync(fd, candidate, 0, candidate.byteLength);
    } catch {
      // Spool is transient; callers must never fail because it is unavailable.
    } finally {
      if (fd >= 0) closeQuietly(fd);
    }
  } finally {
    releaseAppendLock(appendLock);
  }
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
  if (live.kind === "missing") return current;
  if (live.kind !== "regular" || !live.stats) return undefined;
  if (identitiesDiffer(current.stats, live.stats)) return current;
  if (!sameIdentity(current.stats, live.stats)) return undefined;

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
    if (!opened.isFile() || opened.isSymbolicLink() || !compatibleIdentity(claim.stats, opened) || opened.size > MAX_BATCH_BYTES) return undefined;
    const bounded = Buffer.alloc(MAX_BATCH_BYTES + 1);
    const count = readSync(fd, bounded, 0, bounded.length, 0);
    const after = fstatSync(fd);
    if (count > MAX_BATCH_BYTES || after.size > MAX_BATCH_BYTES || !compatibleIdentity(opened, after)) return undefined;
    return bounded.subarray(0, count);
  } catch {
    return undefined;
  } finally {
    if (fd >= 0) closeQuietly(fd);
  }
}

export function readClaim(claim: BatchClaim, paths = resolveRockyPaths()): AgentEvent[] {
  const bytes = readClaimBytes(claim, paths);
  if (!bytes) return [];
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
    try {
      unlinkSync(claim.path);
      return true;
    } catch {
      return false;
    }
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
  return names
    .map((name) => claimFromName(directory, name))
    .filter((claim): claim is BatchClaim => claim !== undefined && isStale(claim.stats, reference))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function removeRegular(path: string): void {
  if (inspectFile(path).kind !== "regular") return;
  try {
    unlinkSync(path);
  } catch {
    // Races and permission errors are safe no-ops.
  }
}

export function removeBatch(key: string, paths = resolveRockyPaths()): void {
  if (!isSafeKey(key)) return;
  const directory = spoolPath(paths);
  if (!directory || !isSpoolDirectory(directory)) return;
  try {
    removeRegular(batchPath(paths, key));
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
