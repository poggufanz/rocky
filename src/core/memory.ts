/** Rocky's append-only memory writers and pending-state helpers. */

import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  type Stats,
} from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { commandFingerprint, commandIdentity, fingerprint, normalizeLine, signatureLines } from "./fingerprint.js";
import { resolveRockyPaths } from "./state-paths.js";
import type { RockyPaths } from "./state-paths.js";
import { loadMemory, MAX_MEMORY_LINE_BYTES } from "./memory-read.js";
import type { FailureRecord, FixRecord, MemoryRecord, NoteRecord, TripleRecord } from "./memory-read.js";
import type { UnresolvedLink } from "./memory-query.js";

export type { FailureRecord, FixRecord, MemoryRecord, NoteRecord, TripleFile, TripleRecord } from "./memory-read.js";
export { loadMemory, parseMemoryRecord, MAX_MEMORY_LINE_BYTES } from "./memory-read.js";

export function memoryPath(): string {
  return resolveRockyPaths().memory;
}

function ensureDir(home: string): void {
  let stats;
  try {
    stats = lstatSync(home);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(home, { recursive: true, mode: 0o700 });
    stats = lstatSync(home);
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("Rocky home must be a real directory");
  }
  try {
    chmodSync(home, 0o700);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}

function append(record: MemoryRecord, paths = resolveRockyPaths()): void {
  const line = `${JSON.stringify(record)}\n`;
  const encoded = Buffer.from(line, "utf8");
  if (encoded.byteLength > MAX_MEMORY_LINE_BYTES) {
    throw new Error("Rocky memory record exceeds line limit");
  }

  ensureDir(paths.home);
  try {
    const existing = lstatSync(paths.memory);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error("Rocky memory must be a regular file");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | noFollow;
  let fd = -1;
  try {
    fd = openSync(paths.memory, flags, 0o600);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.isSymbolicLink()) {
      throw new Error("Rocky memory must be a regular file");
    }
    try {
      fchmodSync(fd, 0o600);
    } catch (error) {
      if (process.platform !== "win32") throw error;
    }
    if (process.platform !== "win32" && (fstatSync(fd).mode & 0o777) !== 0o600) {
      throw new Error("Rocky memory must be private");
    }

    let offset = 0;
    while (offset < encoded.byteLength) {
      const written = writeSync(fd, encoded, offset, encoded.byteLength - offset);
      if (written <= 0) throw new Error("Rocky memory write made no progress");
      offset += written;
    }
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        // The append result is already durable or already failed; never leak fd.
      }
    }
  }
}

const TRIPLE_LOCK_SUFFIX = ".triple.lock";
const TRIPLE_LOCK_TOKEN_BYTES = 16;
const TRIPLE_LOCK_MAX_BYTES = 160;
const TRIPLE_LOCK_WAIT_MS = 5_000;
const TRIPLE_LOCK_STALE_MS = 10 * 60 * 1000;

interface TripleLockMetadata {
  pid: number;
  token: string;
}

interface TripleLock {
  path: string;
  token: string;
  stats: Stats;
}

function tripleIdentityKnown(stats: Stats): boolean {
  return Number.isFinite(stats.dev) && Number.isFinite(stats.ino)
    && (stats.dev !== 0 || stats.ino !== 0);
}

function sameTripleIdentity(left: Stats, right: Stats): boolean {
  return tripleIdentityKnown(left) && tripleIdentityKnown(right)
    && left.dev === right.dev && left.ino === right.ino;
}

function readEmptyTripleLock(path: string): Stats | undefined {
  let fd = -1;
  try {
    const initial = lstatSync(path);
    if (!initial.isFile() || initial.isSymbolicLink() || initial.size !== 0) return undefined;
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    fd = openSync(path, constants.O_RDONLY | noFollow);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.isSymbolicLink() || opened.size !== 0
      || !sameTripleIdentity(initial, opened)) return undefined;
    const after = fstatSync(fd);
    if (!after.isFile() || after.isSymbolicLink() || after.size !== 0
      || !sameTripleIdentity(opened, after)) return undefined;
    return after;
  } catch {
    return undefined;
  } finally {
    if (fd >= 0) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

function reclaimStaleEmptyTripleLock(path: string, now = Date.now()): boolean {
  const initial = readEmptyTripleLock(path);
  if (!initial || !Number.isFinite(initial.mtimeMs) || now - initial.mtimeMs < TRIPLE_LOCK_STALE_MS) return false;
  const current = readEmptyTripleLock(path);
  if (!current || !Number.isFinite(current.mtimeMs) || now - current.mtimeMs < TRIPLE_LOCK_STALE_MS
    || !sameTripleIdentity(initial, current)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

function readTripleLock(path: string): { metadata: TripleLockMetadata; stats: Stats } | undefined {
  let fd = -1;
  try {
    const initial = lstatSync(path);
    if (!initial.isFile() || initial.isSymbolicLink() || initial.size === 0 || initial.size > TRIPLE_LOCK_MAX_BYTES) return undefined;
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    fd = openSync(path, constants.O_RDONLY | noFollow);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.isSymbolicLink() || opened.size === 0 || opened.size > TRIPLE_LOCK_MAX_BYTES) return undefined;
    const bytes = Buffer.alloc(TRIPLE_LOCK_MAX_BYTES + 1);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    const after = fstatSync(fd);
    if (count !== after.size || after.size > TRIPLE_LOCK_MAX_BYTES) return undefined;
    const value: unknown = JSON.parse(bytes.subarray(0, count).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (typeof record.pid !== "number" || !Number.isSafeInteger(record.pid) || record.pid <= 0 ||
        typeof record.token !== "string" || !/^[a-f0-9]{32}$/u.test(record.token)) return undefined;
    return { metadata: { pid: record.pid, token: record.token }, stats: after };
  } catch {
    return undefined;
  } finally {
    if (fd >= 0) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

function tripleOwnerAlive(pid: number): boolean | undefined {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    return undefined;
  }
}

function tryTripleLock(path: string): TripleLock | undefined {
  let fd = -1;
  let created = false;
  let token: string | undefined;
  let succeeded = false;
  try {
    token = randomBytes(TRIPLE_LOCK_TOKEN_BYTES).toString("hex");
    fd = openSync(path, "wx", 0o600);
    created = true;
    const createdStats = fstatSync(fd);
    if (!createdStats.isFile() || createdStats.isSymbolicLink()) return undefined;
    const encoded = Buffer.from(JSON.stringify({ pid: process.pid, token }), "utf8");
    if (encoded.byteLength > TRIPLE_LOCK_MAX_BYTES) return undefined;
    let offset = 0;
    while (offset < encoded.byteLength) {
      const written = writeSync(fd, encoded, offset, encoded.byteLength - offset);
      if (written <= 0) return undefined;
      offset += written;
    }
    try { fchmodSync(fd, 0o600); } catch { /* mode is best effort on Windows */ }
    const after = fstatSync(fd);
    if (!after.isFile() || after.isSymbolicLink() || after.size !== encoded.byteLength) return undefined;
    succeeded = true;
    return { path, token, stats: after };
  } catch {
    return undefined;
  } finally {
    if (fd >= 0) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    if (created && !succeeded && token) {
      const current = readTripleLock(path);
      if (current && current.metadata.pid === process.pid && current.metadata.token === token) {
        try { unlinkSync(path); } catch { /* leave recovery state */ }
      }
    }
  }
}

function releaseTripleLock(lock: TripleLock): void {
  const current = readTripleLock(lock.path);
  if (!current || current.metadata.pid !== process.pid || current.metadata.token !== lock.token) return;
  if (Number.isFinite(lock.stats.dev) && Number.isFinite(lock.stats.ino) &&
      Number.isFinite(current.stats.dev) && Number.isFinite(current.stats.ino) &&
      (lock.stats.dev !== current.stats.dev || lock.stats.ino !== current.stats.ino)) return;
  try { unlinkSync(lock.path); } catch { /* leave state for conservative recovery */ }
}

function acquireTripleLock(paths: RockyPaths): TripleLock {
  const path = `${paths.memory}${TRIPLE_LOCK_SUFFIX}`;
  const deadline = Date.now() + TRIPLE_LOCK_WAIT_MS;
  for (;;) {
    const lock = tryTripleLock(path);
    if (lock) return lock;
    const current = readTripleLock(path);
    if (current) {
      const alive = tripleOwnerAlive(current.metadata.pid);
      if (alive === undefined) throw new Error("Rocky triple lock owner cannot be verified");
      if (!alive) {
        try {
          const verify = readTripleLock(path);
          if (verify && verify.metadata.pid === current.metadata.pid && verify.metadata.token === current.metadata.token &&
              (!Number.isFinite(current.stats.dev) || !Number.isFinite(verify.stats.dev) ||
                (current.stats.dev === verify.stats.dev && current.stats.ino === verify.stats.ino))) unlinkSync(path);
        } catch { /* fail closed */ }
      }
    } else if (reclaimStaleEmptyTripleLock(path)) {
      continue;
    } else {
      try {
        if (lstatSync(path).isSymbolicLink()) throw new Error("Rocky triple lock target is unsafe");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (Date.now() >= deadline) throw new Error("Rocky triple lock is busy");
    const signal = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(signal, 0, 0, 5);
  }
}

export function recordFailure(cmd: string, exitCode: number, stderr: string): FailureRecord {
  const identity = commandIdentity(cmd);
  const rec: FailureRecord = {
    kind: "failure", id: randomUUID(), ts: Date.now(), cwd: process.cwd(), cmd, exitCode,
    fingerprint: fingerprint(stderr, cmd, exitCode), signature: signatureLines(stderr), excerpt: lastLines(stderr, 4),
    commandIdentity: identity.value, identityV: identity.version, identityReliable: identity.reliable, platform: process.platform,
  };
  append(rec);
  touchPending();
  return rec;
}

export function recordWatchFailure(cmd: string, exitCode: number, stderr: string, cwd = process.cwd()): FailureRecord {
  const identity = commandIdentity(cmd);
  const rec: FailureRecord = {
    kind: "failure", id: randomUUID(), ts: Date.now(), cwd, cmd, exitCode,
    fingerprint: fingerprint(stderr, cmd, exitCode), signature: signatureLines(stderr), excerpt: lastLines(stderr, 4), origin: "watch",
    commandIdentity: identity.value, identityV: identity.version, identityReliable: identity.reliable, platform: process.platform,
  };
  append(rec);
  touchPending();
  return rec;
}

/**
 * One success does not meaningfully fix thousands of failures, and a record
 * past `MAX_MEMORY_LINE_BYTES` is skipped by every later read — so it would be
 * written, counted as remembered, and then silently lost forever. Measured: at
 * ~9 400 linked failures the single fix line passed 1 MB, `recordFix` still
 * said "I remember the fix. good good good.", and `stats` reported "0 have fix".
 * Keep the newest links, and shrink until the line actually fits.
 */
export const MAX_FIX_LINKS = 200;

export function recordFix(cmd: string, links: readonly UnresolvedLink[], cwd = process.cwd()): FixRecord {
  const identity = commandIdentity(cmd);
  const build = (chosen: readonly UnresolvedLink[]): FixRecord => ({
    kind: "fix", id: randomUUID(), ts: Date.now(), cwd, cmd,
    failureIds: chosen.filter((link) => link.confidence === "confirmed").map((link) => link.failure.id),
    candidateFailureIds: chosen.filter((link) => link.confidence === "possible").map((link) => link.failure.id),
    links: chosen.map((link) => ({ id: link.failure.id, basis: link.basis, confidence: link.confidence })),
    commandIdentity: identity.value, identityV: identity.version, identityReliable: identity.reliable, platform: process.platform,
  });

  let chosen = links.slice(-MAX_FIX_LINKS);
  let rec = build(chosen);
  while (chosen.length > 1 && Buffer.byteLength(JSON.stringify(rec) + "\n", "utf8") > MAX_MEMORY_LINE_BYTES) {
    chosen = chosen.slice(Math.ceil(chosen.length / 2));
    rec = build(chosen);
  }
  append(rec);
  return rec;
}

function lastLines(text: string, n: number): string {
  const lines = text.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
  return lines.slice(-n).join("\n");
}

export function pendingPath(): string {
  return resolveRockyPaths().pending;
}

export function touchPending(): void {
  const paths = resolveRockyPaths();
  ensureDir(paths.home);
  writeFileSync(paths.pending, "", "utf8");
}

export function hasUnresolvedRecent(records: MemoryRecord[], windowMs = 1000 * 60 * 60 * 48): boolean {
  const cutoff = Date.now() - windowMs;
  return records.some((record) => record.kind === "failure" && !record.resolvedBy && record.ts >= cutoff);
}

export function clearPendingIfResolved(records: MemoryRecord[]): void {
  if (!hasUnresolvedRecent(records)) rmSync(resolveRockyPaths().pending, { force: true });
}

export function recordHookFailure(cmd: string, exitCode: number, cwd: string): FailureRecord {
  const identity = commandIdentity(cmd);
  const rec: FailureRecord = {
    kind: "failure", id: randomUUID(), ts: Date.now(), cwd, cmd, exitCode,
    fingerprint: commandFingerprint(cmd, exitCode), signature: [normalizeLine(cmd)], excerpt: `exit ${exitCode}`, origin: "hook",
    commandIdentity: identity.value, identityV: identity.version, identityReliable: identity.reliable, platform: process.platform,
  };
  append(rec);
  touchPending();
  return rec;
}

export function recordNote(input: {
  cwd: string;
  cmd: string;
  file: string;
  line: number;
  subject: string;
  answer: string;
}): void {
  const rec: NoteRecord = { kind: "note", id: randomUUID(), ts: Date.now(), ...input };
  append(rec);
}

export function recordTriple(
  input: Omit<TripleRecord, "kind" | "id" | "ts" | "schemaV" | "origin"> & { ts?: number },
  paths?: RockyPaths,
): TripleRecord {
  const rec: TripleRecord = {
    kind: "triple",
    id: randomUUID(),
    ts: input.ts ?? Date.now(),
    schemaV: 1,
    origin: "agent-hook",
    agent: input.agent,
    cwd: input.cwd,
    ...(input.intent === undefined ? {} : { intent: input.intent }),
    ...(input.rationale === undefined ? {} : { rationale: input.rationale }),
    mechanism: input.mechanism,
  };
  append(rec, paths);
  return rec;
}

export interface RecordTripleOnceResult {
  record: TripleRecord;
  appended: boolean;
}

export function tripleIdForClaim(claimId: string): string {
  return `triple-${createHash("sha256").update(`rocky-triple-v1:${claimId}`, "utf8").digest("hex").slice(0, 32)}`;
}

export function recordTripleOnce(
  input: Omit<TripleRecord, "kind" | "id" | "ts" | "schemaV" | "origin"> & { ts?: number },
  claimId: string,
  paths?: RockyPaths,
): RecordTripleOnceResult {
  const target = paths ?? resolveRockyPaths();
  const id = tripleIdForClaim(claimId);
  ensureDir(target.home);
  const lock = acquireTripleLock(target);
  try {
    const existing = loadMemory(target.memory).find((record): record is TripleRecord => record.kind === "triple" && record.id === id);
    if (existing) return { record: existing, appended: false };

    const rec: TripleRecord = {
      kind: "triple",
      id,
      ts: input.ts ?? Date.now(),
      schemaV: 1,
      origin: "agent-hook",
      agent: input.agent,
      cwd: input.cwd,
      ...(input.intent === undefined ? {} : { intent: input.intent }),
      ...(input.rationale === undefined ? {} : { rationale: input.rationale }),
      mechanism: input.mechanism,
    };
    append(rec, target);
    return { record: rec, appended: true };
  } finally {
    releaseTripleLock(lock);
  }
}
