import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
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

function acquireAppendLock(paths: RockyPaths, key: string): OwnedPrivateLock | undefined {
  let path: string;
  try {
    path = appendLockPath(paths, key);
  } catch {
    return undefined;
  }
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
    removeRegular(lockPath(paths, key));
  } catch {
    // Transient state is always best effort.
  }
}

function createLock(path: string): boolean {
  let fd = -1;
  try {
    fd = openSync(path, "wx", 0o600);
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.isSymbolicLink()) return false;
    try {
      fchmodSync(fd, 0o600);
    } catch {
      // File mode is best effort on platforms that do not support it.
    }
    return true;
  } catch {
    return false;
  } finally {
    if (fd >= 0) closeQuietly(fd);
  }
}

export function acquireLock(key: string, paths = resolveRockyPaths()): boolean {
  if (!isSafeKey(key)) return false;
  const directory = spoolPath(paths);
  if (!directory || !ensureSpoolDirectory(directory)) return false;

  let file: string;
  try {
    file = lockPath(paths, key);
  } catch {
    return false;
  }

  const existing = inspectFile(file);
  if (existing.kind === "other") return false;
  if (existing.kind === "regular") {
    if (!existing.stats || !isStale(existing.stats, Date.now())) return false;
    try {
      const verify = inspectFile(file);
      if (verify.kind !== "regular" || !verify.stats || !isStale(verify.stats, Date.now())) return false;
      unlinkSync(file);
    } catch {
      return false;
    }
  }
  return createLock(file);
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
