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
