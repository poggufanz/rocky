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
  opendirSync,
  renameSync,
  readSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  type Stats,
} from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";
import { basename, dirname, join } from "node:path";
import { commandFingerprint, commandIdentity, fingerprint, normalizeLine, signatureLines } from "./fingerprint.js";
import { resolveRockyPaths } from "./state-paths.js";
import type { RockyPaths } from "./state-paths.js";
import { loadMemoryChecked, MAX_MEMORY_LINE_BYTES } from "./memory-read.js";
import type { AssociationRecord, FailureRecord, FixRecord, MemoryRecord, NoteRecord, TripleRecord } from "./memory-read.js";
import { LINK_WINDOW_MS, recentUnresolvedFailures, type UnresolvedLink } from "./memory-query.js";

export type { AssociationRecord, FailureRecord, FixRecord, MemoryRecord, NoteRecord, TripleFile, TripleRecord } from "./memory-read.js";
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

function appendUnlocked(record: MemoryRecord, paths: RockyPaths): void {
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
/**
 * Reclaim cleanup is best-effort housekeeping. Keep it bounded by directory
 * entries and a cooperative monotonic deadline; synchronous Node filesystem
 * calls cannot be preempted, so later mutations can sweep residual claims.
 */
export const RECLAIM_CLAIM_SCAN_MAX_ENTRIES = 64;
export const RECLAIM_CLAIM_SCAN_MAX_MS = 100;

interface TripleLockMetadata {
  pid: number;
  token: string;
}

interface TripleLock {
  path: string;
  token: string;
  stats: Stats;
}

interface TripleReclaimElection {
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

function differentTripleIdentity(left: Stats, right: Stats): boolean {
  return tripleIdentityKnown(left) && tripleIdentityKnown(right) && !sameTripleIdentity(left, right);
}

function lockReadFlags(): number {
  const noFollow = process.platform === "win32" || !("O_NOFOLLOW" in constants) ? 0 : constants.O_NOFOLLOW;
  const nonblock = process.platform === "win32" || !("O_NONBLOCK" in constants) ? 0 : constants.O_NONBLOCK;
  return constants.O_RDONLY | noFollow | nonblock;
}

function readEmptyTripleLock(path: string): Stats | undefined {
  let fd = -1;
  try {
    const initial = lstatSync(path);
    if (!initial.isFile() || initial.isSymbolicLink() || initial.size !== 0) return undefined;
    fd = openSync(path, lockReadFlags());
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.isSymbolicLink() || opened.size !== 0
      || differentTripleIdentity(initial, opened)) return undefined;
    const after = fstatSync(fd);
    if (!after.isFile() || after.isSymbolicLink() || after.size !== 0
      || differentTripleIdentity(opened, after)) return undefined;
    return after;
  } catch {
    return undefined;
  } finally {
    if (fd >= 0) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

function staleEmptyTripleLock(path: string, now = Date.now()): Stats | undefined {
  const stats = readEmptyTripleLock(path);
  if (!stats || !Number.isFinite(stats.mtimeMs) || now - stats.mtimeMs < TRIPLE_LOCK_STALE_MS) return undefined;
  return stats;
}

function parseTripleLockMetadata(bytes: Buffer): TripleLockMetadata | undefined {
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (typeof record.pid !== "number" || !Number.isSafeInteger(record.pid) || record.pid <= 0 ||
        typeof record.token !== "string" || !/^[a-f0-9]{32}$/u.test(record.token)) return undefined;
    return { pid: record.pid, token: record.token };
  } catch {
    return undefined;
  }
}

function readTripleLock(path: string): { metadata: TripleLockMetadata; stats: Stats } | undefined {
  let fd = -1;
  try {
    const initial = lstatSync(path);
    if (!initial.isFile() || initial.isSymbolicLink() || initial.size === 0 || initial.size > TRIPLE_LOCK_MAX_BYTES) return undefined;
    fd = openSync(path, lockReadFlags());
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.isSymbolicLink() || opened.size === 0 || opened.size > TRIPLE_LOCK_MAX_BYTES
      || differentTripleIdentity(initial, opened)) return undefined;
    const bytes = Buffer.alloc(TRIPLE_LOCK_MAX_BYTES + 1);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    const after = fstatSync(fd);
    if (count !== after.size || after.size > TRIPLE_LOCK_MAX_BYTES || differentTripleIdentity(opened, after)) return undefined;
    const metadata = parseTripleLockMetadata(bytes.subarray(0, count));
    return metadata ? { metadata, stats: after } : undefined;
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
  let createdStats: Stats | undefined;
  let succeeded = false;
  try {
    token = randomBytes(TRIPLE_LOCK_TOKEN_BYTES).toString("hex");
    fd = openSync(path, "wx", 0o600);
    created = true;
    createdStats = fstatSync(fd);
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
    const named = lstatSync(path);
    if (!after.isFile() || after.isSymbolicLink() || after.size !== encoded.byteLength ||
        !named.isFile() || named.isSymbolicLink() || !sameTripleIdentity(after, named)) return undefined;
    succeeded = true;
    return { path, token, stats: after };
  } catch {
    return undefined;
  } finally {
    if (fd >= 0) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    if (created && !succeeded && token && createdStats) {
      const current = readTripleLock(path);
      if (current && current.metadata.pid === process.pid && current.metadata.token === token) {
        reclaimTriplePath(path, createdStats, (tombstonePath) => {
          const verify = readTripleLock(tombstonePath);
          return verify !== undefined && verify.metadata.pid === process.pid &&
            verify.metadata.token === token && sameTripleIdentity(createdStats!, verify.stats);
        });
      }
    }
  }
}

function releaseTripleLock(lock: TripleLock): void {
  const current = readTripleLock(lock.path);
  if (!current || current.metadata.pid !== process.pid || current.metadata.token !== lock.token) return;
  if (differentTripleIdentity(lock.stats, current.stats)) return;
  reclaimTriplePath(lock.path, current.stats, (tombstonePath) => {
    const verify = readTripleLock(tombstonePath);
    return verify !== undefined && verify.metadata.pid === process.pid && verify.metadata.token === lock.token &&
      sameTripleIdentity(lock.stats, verify.stats);
  });
}

/**
 * Move one canonical regular path to a unique same-directory tombstone, then
 * validate the moved inode before removing only that tombstone. The canonical
 * name is never unlinked: if a replacement was moved by a TOCTOU race, its
 * identity/metadata check fails and the tombstone is deliberately preserved.
 */
function reclaimTriplePath(
  path: string,
  expected: Stats,
  validateClaim: (tombstonePath: string) => boolean,
): boolean {
  if (!tripleIdentityKnown(expected)) return false;
  const tombstonePath = `${path}.reclaim.tombstone.${process.pid}.${randomBytes(TRIPLE_LOCK_TOKEN_BYTES).toString("hex")}`;
  try {
    const current = lstatSync(path);
    if (!current.isFile() || current.isSymbolicLink() || !sameTripleIdentity(expected, current)) return false;
    renameSync(path, tombstonePath);
    const movedStats = lstatSync(tombstonePath);
    if (!movedStats.isFile() || movedStats.isSymbolicLink() || !sameTripleIdentity(expected, movedStats) ||
        !validateClaim(tombstonePath)) return false;
    const verified = lstatSync(tombstonePath);
    if (!verified.isFile() || verified.isSymbolicLink() || !sameTripleIdentity(expected, verified) ||
        !validateClaim(tombstonePath)) return false;
    unlinkSync(tombstonePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * A deterministic regular sidecar elects one reclaimer before primary
 * recovery. Legacy hard-link claims are housekeeping only, never a
 * correctness dependency. The sidecar is metadata-validated and fail-closed
 * for live/unknown owners.
 */
function tryTripleReclaimElection(path: string): TripleReclaimElection | undefined {
  const electionPath = `${path}.reclaim.guard`;
  let fd = -1;
  let token: string | undefined;
  let createdStats: Stats | undefined;
  let created = false;
  let succeeded = false;
  try {
    token = randomBytes(TRIPLE_LOCK_TOKEN_BYTES).toString("hex");
    fd = openSync(electionPath, "wx", 0o600);
    created = true;
    createdStats = fstatSync(fd);
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
    const named = lstatSync(electionPath);
    if (!after.isFile() || after.isSymbolicLink() || after.size !== encoded.byteLength ||
        !named.isFile() || named.isSymbolicLink() || !sameTripleIdentity(after, named)) return undefined;
    succeeded = true;
    return { path: electionPath, token, stats: after };
  } catch {
    // Existing guard: only a definitely dead, metadata-valid owner may be
    // reclaimed. Symlinks, unknown files, live owners, and unknown owners stay.
    const current = readTripleLock(electionPath);
    if (current && tripleOwnerAlive(current.metadata.pid) === false) {
      reclaimTriplePath(electionPath, current.stats, (claimPath) => {
        const verify = readTripleLock(claimPath);
        return verify !== undefined && verify.metadata.pid === current.metadata.pid &&
          verify.metadata.token === current.metadata.token && sameTripleIdentity(current.stats, verify.stats) &&
          tripleOwnerAlive(verify.metadata.pid) === false;
      });
    } else {
      // A reclaimer can crash after creating the guard but before writing
      // metadata. Recover only an old regular empty/torn guard; unknown files
      // and symlinks remain fail-closed.
      try {
        const now = Date.now();
        const stale = staleEmptyTripleLock(electionPath, now) ?? staleMalformedTripleLock(electionPath, now);
        if (stale !== undefined) {
          reclaimTriplePath(electionPath, stale, (claimPath) => {
            const confirmedStale = staleEmptyTripleLock(claimPath, Date.now()) ?? staleMalformedTripleLock(claimPath, Date.now());
            return confirmedStale !== undefined && sameTripleIdentity(stale, confirmedStale);
          });
        }
      } catch {
        // A concurrent replacement or removal is a conservative no-op.
      }
    }
    return undefined;
  } finally {
    if (fd >= 0) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    if (created && !succeeded && token && createdStats) {
      const current = readTripleLock(electionPath);
      if (current && current.metadata.pid === process.pid && current.metadata.token === token) {
        reclaimTriplePath(electionPath, createdStats, (claimPath) => {
          const verify = readTripleLock(claimPath);
          return verify !== undefined && verify.metadata.pid === process.pid && verify.metadata.token === token &&
            sameTripleIdentity(createdStats!, verify.stats);
        });
      }
    }
  }
}

function releaseTripleReclaimElection(election: TripleReclaimElection): void {
  reclaimTriplePath(election.path, election.stats, (claimPath) => {
    const current = readTripleLock(claimPath);
    return current !== undefined && current.metadata.pid === process.pid && current.metadata.token === election.token &&
      sameTripleIdentity(election.stats, current.stats);
  });
}

function acquireTripleLock(paths: RockyPaths): TripleLock {
  const path = `${paths.memory}${TRIPLE_LOCK_SUFFIX}`;
  const wallStarted = Date.now();
  const monotonicStarted = performance.now();
  for (;;) {
    const lock = tryTripleLock(path);
    if (lock) {
      // Sweep legacy claims only after this process owns a fresh canonical
      // pathname. Recovery never depends on finding or deleting one.
      pruneDeadReclaimClaims(path);
      return lock;
    }
    const current = readTripleLock(path);
    if (current) {
      const alive = tripleOwnerAlive(current.metadata.pid);
      if (alive === undefined) throw new Error("Rocky triple lock owner cannot be verified");
      if (!alive) {
        const reclaimed = reclaimTripleLock(path, current.stats, (claimPath) => {
          const verify = readTripleLock(claimPath);
          return verify !== undefined && verify.metadata.pid === current.metadata.pid &&
            verify.metadata.token === current.metadata.token && sameTripleIdentity(current.stats, verify.stats) &&
            tripleOwnerAlive(verify.metadata.pid) === false;
        });
        if (reclaimed) continue;
      }
    } else {
      const now = Date.now();
      const staleEmpty = staleEmptyTripleLock(path, now);
      if (staleEmpty && reclaimTripleLock(path, staleEmpty, (claimPath) => {
        const verify = staleEmptyTripleLock(claimPath, now);
        return verify !== undefined && sameTripleIdentity(staleEmpty, verify);
      })) continue;

      const staleMalformed = staleMalformedTripleLock(path, now);
      if (staleMalformed && reclaimTripleLock(path, staleMalformed, (claimPath) => {
        const verify = staleMalformedTripleLock(claimPath, now);
        return verify !== undefined && sameTripleIdentity(staleMalformed, verify);
      })) continue;

      try {
        if (lstatSync(path).isSymbolicLink()) throw new Error("Rocky triple lock target is unsafe");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (Date.now() - wallStarted >= TRIPLE_LOCK_WAIT_MS ||
        performance.now() - monotonicStarted >= TRIPLE_LOCK_WAIT_MS) {
      throw new Error("Rocky triple lock is busy");
    }
    const signal = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(signal, 0, 0, 5);
  }
}

/** A bounded, stable read of an old non-empty lock whose metadata is torn. */
function staleMalformedTripleLock(path: string, now = Date.now()): Stats | undefined {
  let fd = -1;
  try {
    const initial = lstatSync(path);
    if (!initial.isFile() || initial.isSymbolicLink() || initial.size === 0 || initial.size > TRIPLE_LOCK_MAX_BYTES ||
        !Number.isFinite(initial.mtimeMs) || now - initial.mtimeMs < TRIPLE_LOCK_STALE_MS) return undefined;
    fd = openSync(path, lockReadFlags());
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.isSymbolicLink() || opened.size === 0 || opened.size > TRIPLE_LOCK_MAX_BYTES ||
        differentTripleIdentity(initial, opened)) return undefined;
    const bytes = Buffer.alloc(TRIPLE_LOCK_MAX_BYTES + 1);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    const after = fstatSync(fd);
    if (count !== after.size || after.size === 0 || after.size > TRIPLE_LOCK_MAX_BYTES ||
        differentTripleIdentity(opened, after) || !Number.isFinite(after.mtimeMs) ||
        now - after.mtimeMs < TRIPLE_LOCK_STALE_MS) return undefined;
    return parseTripleLockMetadata(bytes.subarray(0, count)) === undefined ? after : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd >= 0) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

/** Reclaim a dead/stale primary while one guard owns the election. */
function reclaimTripleLock(
  path: string,
  expected: Stats,
  validateClaim: (tombstonePath: string) => boolean,
): boolean {
  if (!tripleIdentityKnown(expected)) return false;
  const election = tryTripleReclaimElection(path);
  if (election === undefined) return false;
  try {
    // Revalidate guard ownership immediately before moving primary. A delayed
    // observer that finds a replacement guard aborts and preserves evidence.
    const verifiedElection = readTripleLock(election.path);
    if (!verifiedElection || verifiedElection.metadata.pid !== process.pid ||
        verifiedElection.metadata.token !== election.token ||
        differentTripleIdentity(election.stats, verifiedElection.stats)) return false;
    return reclaimTriplePath(path, expected, validateClaim);
  } finally {
    releaseTripleReclaimElection(election);
  }
}

/** Remove only hard-link claims whose owning reclaimer is definitely dead. */
function pruneDeadReclaimClaims(path: string, expected?: Stats): void {
  const directory = dirname(path);
  const prefix = `${basename(path)}.reclaim.`;
  const started = performance.now();
  let directoryHandle: ReturnType<typeof opendirSync> | undefined;
  try {
    // `opendirSync` plus one-entry reads avoids materializing an arbitrary
    // directory listing. The batch cap is deliberate: claim cleanup may be
    // incomplete, but memory mutation must stay bounded and safe.
    directoryHandle = opendirSync(directory, { bufferSize: 1 });
  } catch {
    return;
  }
  try {
    for (let examined = 0; examined < RECLAIM_CLAIM_SCAN_MAX_ENTRIES; examined++) {
      if (performance.now() - started >= RECLAIM_CLAIM_SCAN_MAX_MS) break;
      let entry;
      try {
        entry = directoryHandle.readSync();
      } catch {
        break;
      }
      if (entry === null) break;
      const name = entry.name;
      if (!name.startsWith(prefix)) continue;
      const match = /^(\d+)\.([a-f0-9]{32})$/u.exec(name.slice(prefix.length));
      if (!match) continue;
      const pid = Number(match[1]);
      if (!Number.isSafeInteger(pid) || pid <= 0 || tripleOwnerAlive(pid) !== false) continue;
      const claimPath = join(directory, name);
      try {
        const claim = lstatSync(claimPath);
        if (!claim.isFile() || claim.isSymbolicLink() || !tripleIdentityKnown(claim)) continue;
        if (expected !== undefined && !sameTripleIdentity(expected, claim)) continue;
        // A primary-less non-empty claim has no inode to compare against.
        // Require its immutable lock metadata to parse and its original owner
        // to be definitely dead, so a regular file merely wearing a claim-
        // shaped name remains untouched.  Zero-byte claims are the deliberate
        // stale-empty-lock recovery case, which has no metadata to parse.
        const metadata = readTripleLock(claimPath);
        if (metadata !== undefined) {
          if (tripleOwnerAlive(metadata.metadata.pid) !== false) continue;
        } else if (expected === undefined && claim.size !== 0) {
          continue;
        }

        let primary: Stats | undefined;
        try {
          primary = lstatSync(path);
          if (!primary.isFile() || primary.isSymbolicLink() || !tripleIdentityKnown(primary)) continue;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
        }
        // A claim that still names the current primary lock is not orphaned.
        // When reclaiming a known stale primary (`expected`), that same inode
        // is precisely the claim we may prune; otherwise only an absent or
        // replaced primary permits cleanup.
        if (primary !== undefined && sameTripleIdentity(primary, claim) && expected === undefined) continue;

        // Revalidate the claim immediately before moving it. The canonical
        // path is never unlinked by housekeeping; only a validated unique
        // tombstone may be removed.
        const verifiedClaim = lstatSync(claimPath);
        if (!verifiedClaim.isFile() || verifiedClaim.isSymbolicLink() ||
            !sameTripleIdentity(claim, verifiedClaim)) continue;
        if (primary !== undefined) {
          const verifiedPrimary = lstatSync(path);
          if (!verifiedPrimary.isFile() || verifiedPrimary.isSymbolicLink() ||
              !tripleIdentityKnown(verifiedPrimary)) continue;
          if (expected !== undefined && !sameTripleIdentity(expected, verifiedPrimary)) continue;
          if (expected === undefined && sameTripleIdentity(verifiedPrimary, verifiedClaim)) continue;
        } else {
          try {
            lstatSync(path);
            continue;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
          }
        }
        // Do not begin another destructive operation once the cooperative
        // budget has elapsed. A syscall already in progress cannot be stopped
        // by Node; this check bounds all work that follows the syscall.
        if (performance.now() - started >= RECLAIM_CLAIM_SCAN_MAX_MS) continue;
        reclaimTriplePath(claimPath, verifiedClaim, (tombstonePath) => {
          const verify = readTripleLock(tombstonePath);
          if (verify !== undefined) return tripleOwnerAlive(verify.metadata.pid) === false;
          const stale = lstatSync(tombstonePath);
          return stale.isFile() && !stale.isSymbolicLink() && stale.size === 0;
        });
      } catch {
        // A concurrent sweep or namespace change is a conservative no-op.
      }
      if (performance.now() - started >= RECLAIM_CLAIM_SCAN_MAX_MS) break;
    }
  } finally {
    try { directoryHandle.closeSync(); } catch { /* best effort */ }
  }
}

/**
 * One cooperative critical section for every mutation of a memory file.
 * `records` is loaded only after ownership is established; `reload()` keeps
 * multi-step decisions (fix append then pending reconciliation) on that same
 * owned state. The historical `.triple.lock` name is retained so interrupted
 * v0.5 writers remain recoverable after upgrade.
 */
export interface MemoryTransaction {
  readonly paths: RockyPaths;
  /** One in-lock wall-clock reference for loader, links, and reconciliation. */
  readonly now: number;
  readonly records: readonly MemoryRecord[];
  /** False when the loader could not prove the snapshot complete. */
  readonly complete: boolean;
  append(record: MemoryRecord): void;
  reload(): readonly MemoryRecord[];
}

export interface MemoryTransactionOptions {
  now?: number;
}

export function withMemoryTransaction<T>(
  operation: (transaction: MemoryTransaction) => T,
  paths: RockyPaths = resolveRockyPaths(),
  options: MemoryTransactionOptions = {},
): T {
  ensureDir(paths.home);
  const lock = acquireTripleLock(paths);
  const now = options.now ?? Date.now();
  const initial = loadMemoryChecked(paths.memory, now);
  let records = initial.records;
  let complete = initial.complete;
  const transaction: MemoryTransaction = {
    paths,
    now,
    get records() { return records; },
    get complete() { return complete; },
    append(record) {
      appendUnlocked(record, paths);
      records = [...records, record];
    },
    reload() {
      const loaded = loadMemoryChecked(paths.memory, now);
      if (!loaded.complete) throw new Error("Rocky memory reload is incomplete");
      records = loaded.records;
      complete = true;
      return records;
    },
  };
  try {
    return operation(transaction);
  } finally {
    releaseTripleLock(lock);
  }
}

export function recordFailure(cmd: string, exitCode: number, stderr: string): FailureRecord {
  const identity = commandIdentity(cmd);
  const ts = Date.now();
  const rec: FailureRecord = {
    kind: "failure", id: randomUUID(), ts, cwd: process.cwd(), cmd, exitCode,
    fingerprint: fingerprint(stderr, cmd, exitCode), signature: signatureLines(stderr), excerpt: lastLines(stderr, 4),
    commandIdentity: identity.value, identityV: identity.version, identityReliable: identity.reliable, platform: process.platform,
  };
  withMemoryTransaction((transaction) => {
    transaction.append(rec);
    touchPendingUnlocked(transaction.paths);
  }, resolveRockyPaths(), { now: ts });
  return rec;
}

export function recordWatchFailure(cmd: string, exitCode: number, stderr: string, cwd = process.cwd()): FailureRecord {
  const identity = commandIdentity(cmd);
  const ts = Date.now();
  const rec: FailureRecord = {
    kind: "failure", id: randomUUID(), ts, cwd, cmd, exitCode,
    fingerprint: fingerprint(stderr, cmd, exitCode), signature: signatureLines(stderr), excerpt: lastLines(stderr, 4), origin: "watch",
    commandIdentity: identity.value, identityV: identity.version, identityReliable: identity.reliable, platform: process.platform,
  };
  withMemoryTransaction((transaction) => {
    transaction.append(rec);
    touchPendingUnlocked(transaction.paths);
  }, resolveRockyPaths(), { now: ts });
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

interface WrittenFixRecords {
  fix?: FixRecord;
  association?: AssociationRecord;
}

function appendFixRecordsUnlocked(
  transaction: MemoryTransaction,
  cmd: string,
  links: readonly UnresolvedLink[],
  cwd: string,
  now: number,
): WrittenFixRecords {
  const identity = commandIdentity(cmd);
  const chosen = links.slice(-MAX_FIX_LINKS);
  const confirmed = chosen.filter((link) => link.confidence === "confirmed");
  const possible = chosen.filter((link) => link.confidence === "possible");
  const metadata = {
    ts: now, cwd, cmd,
    commandIdentity: identity.value, identityV: identity.version, identityReliable: identity.reliable, platform: process.platform,
  } as const;

  let fix: FixRecord | undefined;
  if (confirmed.length > 0) {
    let selected = confirmed;
    const buildFix = (): FixRecord => ({
      kind: "fix", id: randomUUID(), ...metadata,
      failureIds: selected.map((link) => link.failure.id),
      links: selected.map((link) => ({ id: link.failure.id, basis: "identity", confidence: "confirmed" })),
    });
    fix = buildFix();
    while (selected.length > 1 && Buffer.byteLength(JSON.stringify(fix) + "\n", "utf8") > MAX_MEMORY_LINE_BYTES) {
      selected = selected.slice(Math.ceil(selected.length / 2));
      fix = buildFix();
    }
    transaction.append(fix);
  }
  let association: AssociationRecord | undefined;
  if (possible.length > 0) {
    let selected = possible;
    const buildAssociation = (): AssociationRecord => ({
      kind: "association", id: randomUUID(), ...metadata,
      candidateFailureIds: selected.map((link) => link.failure.id),
      links: selected.map((link) => ({ id: link.failure.id, basis: "program", confidence: "possible" })),
    });
    association = buildAssociation();
    while (selected.length > 1 && Buffer.byteLength(JSON.stringify(association) + "\n", "utf8") > MAX_MEMORY_LINE_BYTES) {
      selected = selected.slice(Math.ceil(selected.length / 2));
      association = buildAssociation();
    }
    transaction.append(association);
  }
  return {
    ...(fix === undefined ? {} : { fix }),
    ...(association === undefined ? {} : { association }),
  };
}

export function recordFix(cmd: string, links: readonly UnresolvedLink[], cwd = process.cwd()): FixRecord | AssociationRecord {
  return withMemoryTransaction((transaction) => {
    const written = appendFixRecordsUnlocked(transaction, cmd, links, cwd, transaction.now);
    if (written.fix) return written.fix;
    if (written.association) return written.association;
    throw new Error("Rocky fix attribution requires at least one link");
  });
}

export interface ResolveFixOptions {
  /** Stable test/selected-window clock. Normal callers capture `Date.now()` after locking. */
  now?: number;
  windowMs?: number;
}

export interface ResolveFixResult extends WrittenFixRecords {
  confirmedResolved: number;
  possibleAssociated: number;
}

function hasConfirmedResolutionForCommand(
  records: readonly MemoryRecord[],
  cmd: string,
  cwd: string,
  now: number,
): boolean {
  const currentIdentity = commandIdentity(cmd);
  if (!currentIdentity.reliable) return false;
  const fixesById = new Map<string, FixRecord>();
  for (const record of records) {
    if (record.kind === "fix" && !fixesById.has(record.id)) fixesById.set(record.id, record);
  }
  return records.some((record) => {
    if (record.kind !== "failure" || record.cwd !== cwd || record.ts > now || record.resolvedBy === undefined) return false;
    const fix = fixesById.get(record.resolvedBy);
    if (fix === undefined || fix.cwd !== cwd || fix.ts > now || fix.ts < record.ts || !fix.failureIds.includes(record.id)) return false;
    const fixIdentity = commandIdentity(fix.cmd, { platform: fix.platform ?? process.platform });
    if (!fixIdentity.reliable || fixIdentity.value !== currentIdentity.value) return false;
    const failureIdentity = commandIdentity(record.cmd, { platform: record.platform ?? process.platform });
    return failureIdentity.reliable && failureIdentity.value === currentIdentity.value;
  });
}

function hasRecentConfirmedResolution(
  records: readonly MemoryRecord[],
  windowMs: number,
  now: number,
): boolean {
  const cutoff = now - windowMs;
  const fixes = new Map<string, FixRecord>();
  for (const record of records) {
    if (record.kind === "fix" && record.ts >= cutoff && record.ts <= now && !fixes.has(record.id)) {
      fixes.set(record.id, record);
    }
  }
  return records.some((record) => {
    if (record.kind !== "failure" || record.ts > now || record.resolvedBy === undefined) return false;
    const fix = fixes.get(record.resolvedBy);
    return fix !== undefined && fix.ts >= record.ts && fix.failureIds.includes(record.id);
  });
}

/** Reload, attribute, append, and reconcile pending under one per-memory lock. */
export function resolveFixOnSuccess(
  cmd: string,
  cwd = process.cwd(),
  options: ResolveFixOptions = {},
): ResolveFixResult {
  const paths = resolveRockyPaths();
  return withMemoryTransaction((transaction) => {
    const now = transaction.now;
    const windowMs = options.windowMs ?? LINK_WINDOW_MS;
    const links = recentUnresolvedFailures(transaction.records, cmd, { cwd, now, windowMs });
    if (links.length === 0) {
      // A prior process may have durably appended its FixRecord and died
      // before pending reconciliation.  Only a loader-confirmed resolution
      // for this command can recover that state; weak associations and an
      // empty/incomplete snapshot never clear pending.
      if (transaction.complete && hasConfirmedResolutionForCommand(transaction.records, cmd, cwd, now)) {
        reconcilePendingUnlocked(transaction.records, transaction.paths, windowMs, now);
      }
      return { confirmedResolved: 0, possibleAssociated: 0 };
    }

    const written = appendFixRecordsUnlocked(transaction, cmd, links, cwd, now);
    if (written.fix) {
      const latest = transaction.reload();
      reconcilePendingUnlocked(latest, transaction.paths, windowMs, now);
    }
    return {
      ...written,
      confirmedResolved: written.fix?.failureIds.length ?? 0,
      possibleAssociated: written.association?.candidateFailureIds.length ?? 0,
    };
  }, paths, { now: options.now });
}

function lastLines(text: string, n: number): string {
  const lines = text.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
  return lines.slice(-n).join("\n");
}

export function pendingPath(): string {
  return resolveRockyPaths().pending;
}

function touchPendingUnlocked(paths: RockyPaths): void {
  ensureDir(paths.home);
  writeFileSync(paths.pending, "", "utf8");
}

export function touchPending(): void {
  withMemoryTransaction((transaction) => touchPendingUnlocked(transaction.paths));
}

export function hasUnresolvedRecent(
  records: readonly MemoryRecord[],
  windowMs = LINK_WINDOW_MS,
  now = Date.now(),
): boolean {
  const cutoff = now - windowMs;
  return records.some((record) => record.kind === "failure" && !record.resolvedBy && record.ts >= cutoff);
}

function reconcilePendingUnlocked(
  records: readonly MemoryRecord[],
  paths: RockyPaths,
  windowMs: number,
  now: number,
): void {
  if (hasUnresolvedRecent(records, windowMs, now)) touchPendingUnlocked(paths);
  else rmSync(paths.pending, { force: true });
}

export function clearPendingIfResolved(
  _records: readonly MemoryRecord[],
  windowMs = LINK_WINDOW_MS,
  now?: number,
): void {
  const selectedNow = now ?? Date.now();
  withMemoryTransaction((transaction) => {
    if (hasRecentConfirmedResolution(transaction.records, windowMs, selectedNow) &&
        !hasUnresolvedRecent(transaction.records, windowMs, selectedNow)) {
      rmSync(transaction.paths.pending, { force: true });
    }
  }, resolveRockyPaths(), { now: selectedNow });
}

export function recordHookFailure(cmd: string, exitCode: number, cwd: string): FailureRecord {
  const identity = commandIdentity(cmd);
  const ts = Date.now();
  const rec: FailureRecord = {
    kind: "failure", id: randomUUID(), ts, cwd, cmd, exitCode,
    fingerprint: commandFingerprint(cmd, exitCode), signature: [normalizeLine(cmd)], excerpt: `exit ${exitCode}`, origin: "hook",
    commandIdentity: identity.value, identityV: identity.version, identityReliable: identity.reliable, platform: process.platform,
  };
  withMemoryTransaction((transaction) => {
    transaction.append(rec);
    touchPendingUnlocked(transaction.paths);
  }, resolveRockyPaths(), { now: ts });
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
  withMemoryTransaction((transaction) => transaction.append(rec));
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
  withMemoryTransaction((transaction) => transaction.append(rec), paths ?? resolveRockyPaths());
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
  return withMemoryTransaction((transaction) => {
    const existing = transaction.records.find((record): record is TripleRecord => record.kind === "triple" && record.id === id);
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
    transaction.append(rec);
    return { record: rec, appended: true };
  }, target);
}
