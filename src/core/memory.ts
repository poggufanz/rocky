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
  readdirSync,
  renameSync,
  readSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  type Stats,
} from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";
import { basename, dirname, join } from "node:path";
import {
  FINGERPRINT_ALGORITHM_VERSION,
  commandFingerprint,
  commandIdentity,
  fingerprint,
  normalizeLine,
  signatureLines,
} from "./fingerprint.js";
import { resolveRockyPaths } from "./state-paths.js";
import type { RockyPaths } from "./state-paths.js";
import { boundTripleMechanism, isCompleteMemoryCoverage, isKnownPathPlatform, isSafeNonNegativeInteger, loadMemoryChecked, MAX_MEMORY_FILE_BYTES, MAX_RATIONALE_FILES, MAX_RATIONALE_FILE_CHARS, MAX_MEMORY_LINE_BYTES, MAX_MEMORY_RECORDS, MAX_SUPPORTED_MEMORY_RECORDS } from "./memory-read.js";
import type { AliasRecord, AssociationRecord, BriefRunRecord, ExplainRecord, FailureRecord, FixRecord, InvariantTouchRecord, MemoryCoverage, MemoryRecord, NoteRecord, RationaleRecord, TripleRecord } from "./memory-read.js";
import { MAX_GIT_SNAPSHOT_CHARS, MAX_GIT_SNAPSHOT_PRE_REDACT_CHARS, type GitAnchor } from "./memory-read.js";
import { redactSecretsAtBoundary } from "./redact.js";
import { plausibleFilePath } from "./compare-data.js";
import { utf8Slice, utf8SliceFromEnd } from "./utf8.js";
import { LINK_WINDOW_MS, recentUnresolvedFailures, type UnresolvedLink } from "./memory-query.js";

export type { AssociationRecord, BriefRunRecord, ExplainRecord, FailureRecord, FixRecord, GitAnchor, InvariantTouchRecord, MemoryCoverage, MemoryRecord, NoteRecord, TripleFile, TripleRecord } from "./memory-read.js";
export {
  boundTripleMechanism,
  boundTripleRecord,
  loadMemory,
  MEMORY_FORMAT_VERSION,
  MAX_MEMORY_FILE_BYTES,
  parseMemoryRecord,
  MAX_MEMORY_LINE_BYTES,
  MAX_MEMORY_RECORDS,
  MAX_SUPPORTED_MEMORY_RECORDS,
  MAX_TRIPLE_FILES,
} from "./memory-read.js";

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
const TRIPLE_LOCK_TICKET_STALE_MS = 60_000;
const TRIPLE_LOCK_HEAD_STALL_MS = 150;
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
  let createdStats: Stats | undefined;
  let succeeded = false;
  try {
    fd = openSync(path, "wx", 0o600);
    created = true;
    createdStats = fstatSync(fd);
    if (!createdStats.isFile() || createdStats.isSymbolicLink()) return undefined;
    const token = randomBytes(TRIPLE_LOCK_TOKEN_BYTES).toString("hex");
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
    if (created && !succeeded && createdStats) {
      // Self-owned: this attempt's own just-created lock file. No litter.
      reclaimTriplePath(path, createdStats, true, (tombstonePath) => {
        const verify = lstatSync(tombstonePath);
        return verify.isFile() && !verify.isSymbolicLink() && sameTripleIdentity(createdStats!, verify);
      });
    }
  }
}

function releaseTripleLock(lock: TripleLock): boolean {
  const current = readTripleLock(lock.path);
  if (!current || current.metadata.pid !== process.pid || current.metadata.token !== lock.token) return false;
  if (differentTripleIdentity(lock.stats, current.stats)) return false;
  // Self-owned: this process's own lock, being released. No litter.
  return reclaimTriplePath(lock.path, current.stats, true, (tombstonePath) => {
    const verify = readTripleLock(tombstonePath);
    return verify !== undefined && verify.metadata.pid === process.pid && verify.metadata.token === lock.token &&
      sameTripleIdentity(lock.stats, verify.stats);
  });
}

/**
 * Move one canonical regular path to a unique same-directory tombstone, then
 * validate the moved inode. `unlinkOnSuccess` is an explicit, non-defaulted
 * choice at every call site, because the two policies are not
 * interchangeable and a default would silently re-merge them for whichever
 * caller forgets to think about it:
 *   - Self-owned artifacts — a lock or election guard this same operation
 *     just created, reclaimed, or is releasing — leave no litter on success.
 *     Nothing outside this operation ever needs to observe them, so pass
 *     `true`.
 *   - A foreign residual claim — a hard-link left behind by a *different*,
 *     already-dead reclaimer, reclaimed via `pruneDeadReclaimClaims` — must
 *     leave evidence that recovery happened. Pass `false` so the tombstone is
 *     preserved.
 * On every failure path the tombstone is preserved regardless of the flag —
 * a hostile same-user replacement after validation is indistinguishable
 * through Node's portable path API, so preservation is the only safe outcome
 * there. Preserved tombstones are non-blocking housekeeping evidence;
 * leftovers are swept later by `sweepReclaimTombstones`.
 */
function reclaimTriplePath(
  path: string,
  expected: Stats,
  unlinkOnSuccess: boolean,
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
    if (unlinkOnSuccess) {
      try { unlinkSync(tombstonePath); } catch { /* leftover swept later */ }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Housekeeping for tombstones left behind by crashed or contested reclaims.
 * Only tombstone-marked entries older than `TOMBSTONE_SWEEP_MAX_AGE_MS` are
 * unlinked — a young tombstone may still be evidence of an in-flight reclaim —
 * and each run removes at most `TOMBSTONE_SWEEP_MAX_REMOVALS` so a hostile
 * flood cannot pin a writer in an unbounded loop. Never throws; returns the
 * number actually removed.
 */
export const TOMBSTONE_SWEEP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const TOMBSTONE_SWEEP_MAX_REMOVALS = 100;

const RECLAIM_TOMBSTONE_MARKER_RE = /\.reclaim\.tombstone\./u;

export function sweepReclaimTombstones(dir: string, now = Date.now()): number {
  let removed = 0;
  try {
    for (const name of readdirSync(dir)) {
      if (removed >= TOMBSTONE_SWEEP_MAX_REMOVALS) break;
      if (!RECLAIM_TOMBSTONE_MARKER_RE.test(name)) continue;
      const tombstonePath = join(dir, name);
      try {
        const stats = statSync(tombstonePath);
        if (!stats.isFile()) continue;
        if (now - stats.mtimeMs <= TOMBSTONE_SWEEP_MAX_AGE_MS) continue;
        unlinkSync(tombstonePath);
        removed++;
      } catch {
        // A concurrent sweep, removal, or replacement is a conservative no-op.
      }
    }
  } catch {
    // An unreadable or missing directory means nothing to sweep.
  }
  return removed;
}

export function countReclaimTombstones(dir: string): number {
  try {
    return readdirSync(dir).filter((name) => RECLAIM_TOMBSTONE_MARKER_RE.test(name)).length;
  } catch {
    return 0;
  }
}

let tombstoneSweepDone = false;

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
      // Self-owned housekeeping: the election guard sidecar, not a residual
      // claim seen by other processes. No litter.
      reclaimTriplePath(electionPath, current.stats, true, (claimPath) => {
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
          reclaimTriplePath(electionPath, stale, true, (claimPath) => {
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
    if (created && !succeeded && createdStats) {
      // Self-owned: this attempt's own just-created guard file. No litter.
      reclaimTriplePath(electionPath, createdStats, true, (claimPath) => {
        const verify = lstatSync(claimPath);
        return verify.isFile() && !verify.isSymbolicLink() && sameTripleIdentity(createdStats!, verify);
      });
    }
  }
}

function releaseTripleReclaimElection(election: TripleReclaimElection): void {
  // Self-owned: this process's own election guard, being released. No litter.
  reclaimTriplePath(election.path, election.stats, true, (claimPath) => {
    const current = readTripleLock(claimPath);
    return current !== undefined && current.metadata.pid === process.pid && current.metadata.token === election.token &&
      sameTripleIdentity(election.stats, current.stats);
  });
}

interface TripleLockTicket {
  path: string;
  name: string;
}

/**
 * Arrival-order tickets are an advisory fairness gate ahead of canonical lock
 * attempts. Mutual exclusion never depends on them: on any ticket failure,
 * unreadable directory, stale entry, or unverifiable owner, waiters degrade to
 * plain lock contention, which stays safe but loses fairness. Without this
 * gate, many waiters polling the canonical lock can starve the current owner
 * of CPU and I/O on small hosts until every waiter exhausts the shared
 * deadline.
 */
function createTripleLockTicket(path: string): TripleLockTicket | undefined {
  for (let attempt = 0; attempt < 8; attempt++) {
    const name = `${basename(path)}.ticket.${String(Date.now() + attempt).padStart(15, "0")}.${process.pid}`;
    const ticketPath = join(dirname(path), name);
    let fd = -1;
    try {
      fd = openSync(ticketPath, "wx", 0o600);
      return { path: ticketPath, name };
    } catch {
      // A same-millisecond collision retries with a bumped stamp.
    } finally {
      if (fd >= 0) {
        try { closeSync(fd); } catch { /* best effort */ }
      }
    }
  }
  return undefined;
}

function removeTripleLockTicket(ticket: TripleLockTicket | undefined): void {
  if (ticket === undefined) return;
  try { unlinkSync(ticket.path); } catch { /* best effort */ }
}

interface TripleLockQueueView {
  head: string;
  position: number;
}

/**
 * The queue head is the earliest live ticket; `position` counts live tickets
 * ahead of this waiter. Tickets older than the stale bound are ignored because
 * a PID may have been reused since the writer crashed; verifiably dead owners
 * are swept, unknown owners never block.
 */
function tripleLockTicketQueue(path: string, ticket: TripleLockTicket, now = Date.now()): TripleLockQueueView {
  const directory = dirname(path);
  const prefix = `${basename(path)}.ticket.`;
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return { head: ticket.name, position: 0 };
  }
  const entries: Array<{ name: string; ms: number; pid: number }> = [];
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const match = /^(\d{1,15})\.([1-9][0-9]{0,9})$/u.exec(name.slice(prefix.length));
    if (!match) continue;
    const ms = Number(match[1]);
    const pid = Number(match[2]);
    if (!Number.isSafeInteger(ms) || !Number.isSafeInteger(pid)) continue;
    entries.push({ name, ms, pid });
  }
  entries.sort((left, right) => left.ms - right.ms || left.pid - right.pid || (left.name < right.name ? -1 : 1));
  let head: string | undefined;
  let position = 0;
  for (const entry of entries) {
    if (entry.name === ticket.name) return { head: head ?? ticket.name, position };
    if (now - entry.ms > TRIPLE_LOCK_TICKET_STALE_MS) continue;
    if (entry.pid !== process.pid) {
      const alive = tripleOwnerAlive(entry.pid);
      if (alive === false) {
        try { unlinkSync(join(directory, entry.name)); } catch { /* best effort */ }
        continue;
      }
      if (alive !== true) continue;
    }
    head ??= entry.name;
    position++;
  }
  return { head: ticket.name, position: 0 };
}

function acquireTripleLock(paths: RockyPaths): TripleLock {
  const path = `${paths.memory}${TRIPLE_LOCK_SUFFIX}`;
  const wallStarted = Date.now();
  const monotonicStarted = performance.now();
  const ticket = createTripleLockTicket(path);
  try {
    return acquireTripleLockQueued(path, ticket, wallStarted, monotonicStarted);
  } finally {
    removeTripleLockTicket(ticket);
  }
}

function tripleLockPathIdentity(path: string): string {
  try {
    const stats = lstatSync(path);
    return `${stats.dev}:${stats.ino}:${stats.isSymbolicLink() ? "link" : "file"}`;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unknown";
  }
}

function acquireTripleLockQueued(
  path: string,
  ticket: TripleLockTicket | undefined,
  started: number,
  startedMonotonic: number,
): TripleLock {
  let wallStarted = started;
  let monotonicStarted = startedMonotonic;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const initialWaitMs = 5 + (process.pid % 7);
  let waitMs = initialWaitMs;
  let observedOwner: string | undefined;
  let observedHead: string | undefined;
  let observedIdentity: string | undefined;
  let deferReference = performance.now();
  for (;;) {
    // The deadline bounds time WITHOUT progress, not time in queue: a stuck or
    // starved lock still fails in TRIPLE_LOCK_WAIT_MS, while honest ownership
    // turnover among queued writers must never convert into spurious busy
    // errors just because the queue is long.
    const identity = tripleLockPathIdentity(path);
    if (observedIdentity !== undefined && observedIdentity !== identity) {
      wallStarted = Date.now();
      monotonicStarted = performance.now();
      deferReference = performance.now();
    }
    observedIdentity = identity;
    if (ticket !== undefined) {
      const queue = tripleLockTicketQueue(path, ticket);
      if (queue.head !== ticket.name) {
        // A waiting non-head leaves the canonical lock alone so the owner
        // keeps its CPU and I/O; polling coarsens with queue position. If the
        // lock stays absent too long the head is stalled, and this waiter
        // falls through to plain contention rather than queueing forever.
        if (observedHead !== queue.head) {
          observedHead = queue.head;
          waitMs = initialWaitMs;
          deferReference = performance.now();
        }
        if (identity !== "absent") deferReference = performance.now();
        const stalled = performance.now() - deferReference > TRIPLE_LOCK_HEAD_STALL_MS;
        if (!stalled) {
          const nonHeadRemaining = Math.min(
            TRIPLE_LOCK_WAIT_MS - (Date.now() - wallStarted),
            TRIPLE_LOCK_WAIT_MS - (performance.now() - monotonicStarted),
          );
          if (nonHeadRemaining <= 0) {
            throw new Error("Rocky triple lock is busy");
          }
          const nonHeadCap = Math.min(250, 25 + queue.position * 5);
          Atomics.wait(signal, 0, 0, Math.min(waitMs, nonHeadRemaining));
          waitMs = Math.min(waitMs + 5, nonHeadCap);
          continue;
        }
      } else if (observedHead !== ticket.name) {
        observedHead = ticket.name;
        waitMs = Math.min(waitMs, initialWaitMs);
      }
    }
    const lock = tryTripleLock(path);
    if (lock) {
      return lock;
    }
    const current = readTripleLock(path);
    if (current) {
      const owner = `${current.metadata.pid}:${current.metadata.token}`;
      if (observedOwner !== undefined && observedOwner !== owner) waitMs = initialWaitMs;
      observedOwner = owner;
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

      let pathAbsent = false;
      try {
        if (lstatSync(path).isSymbolicLink()) throw new Error("Rocky triple lock target is unsafe");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") pathAbsent = true;
        else throw error;
      }
      if (pathAbsent) {
        observedOwner = undefined;
        waitMs = initialWaitMs;
      }
    }
    const wallRemaining = TRIPLE_LOCK_WAIT_MS - (Date.now() - wallStarted);
    const monotonicRemaining = TRIPLE_LOCK_WAIT_MS - (performance.now() - monotonicStarted);
    const remaining = Math.min(wallRemaining, monotonicRemaining);
    if (remaining <= 0) {
      throw new Error("Rocky triple lock is busy");
    }
    Atomics.wait(signal, 0, 0, Math.min(waitMs, remaining));
    waitMs = Math.min(waitMs + 5, 50);
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
    // Self-owned: the primary lock is being reclaimed into this process's
    // own ownership right now. No litter.
    return reclaimTriplePath(path, expected, true, validateClaim);
  } finally {
    releaseTripleReclaimElection(election);
  }
}

/** Move only hard-link claims whose owning reclaimer is definitely dead. */
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

        // Revalidate the claim immediately before moving it. This claim is
        // foreign residual evidence — a hard-link left by a different,
        // already-dead reclaimer, not something this operation owns — so
        // unlike the self-owned reclaim/release/election-guard paths above,
        // its tombstone is preserved on success (unlinkOnSuccess: false
        // below), never unlinked by this housekeeping. Residual tombstones
        // are safe evidence for a later bounded/manual sweep.
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
        reclaimTriplePath(claimPath, verifiedClaim, false, (tombstonePath) => {
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
  readonly coverage: MemoryCoverage;
  append(record: MemoryRecord): void;
  reload(): readonly MemoryRecord[];
  /** True only when this append can still be reloaded as a complete snapshot. */
  canAppendComplete(records: readonly MemoryRecord[]): boolean;
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
  if (!tombstoneSweepDone) {
    // Tombstones are only created on this writer path, so one best-effort
    // sweep per process here covers every producer without touching the CLI
    // entry or read-only commands.
    tombstoneSweepDone = true;
    sweepReclaimTombstones(dirname(paths.memory));
  }
  const lock = acquireTripleLock(paths);
  const now = options.now ?? Date.now();
  const initial = loadMemoryChecked(paths.memory, now);
  let records = initial.records;
  let complete = initial.complete;
  let coverage = initial.coverage;
  const transaction: MemoryTransaction = {
    paths,
    now,
    get records() { return records; },
    get complete() { return complete; },
    get coverage() { return coverage; },
    append(record) {
      appendUnlocked(record, paths);
      records = [...records, record];
    },
    reload() {
      const loaded = loadMemoryChecked(paths.memory, now);
      if (!loaded.complete) throw new Error("Rocky memory reload is incomplete");
      records = loaded.records;
      complete = true;
      coverage = loaded.coverage;
      return records;
    },
    canAppendComplete(nextRecords) {
      if (!complete || !isCompleteMemoryCoverage(coverage)) return false;
      if (records.length + nextRecords.length > MAX_SUPPORTED_MEMORY_RECORDS) return false;
      const addedBytes = nextRecords.reduce((total, record) => {
        const encoded = Buffer.byteLength(`${JSON.stringify(record)}\n`, "utf8");
        return total > Number.MAX_SAFE_INTEGER - encoded ? Number.MAX_SAFE_INTEGER : total + encoded;
      }, 0);
      return coverage.bytesTotal <= MAX_MEMORY_FILE_BYTES
        && addedBytes <= MAX_MEMORY_FILE_BYTES - coverage.bytesTotal;
    },
  };
  try {
    return operation(transaction);
  } finally {
    if (releaseTripleLock(lock)) {
      // Sweep legacy claims only after the canonical lock is verified absent.
      // Recovery never depends on finding or deleting one.
      pruneDeadReclaimClaims(lock.path);
    }
  }
}

export function recordFailure(cmd: string, exitCode: number, stderr: string): FailureRecord {
  const identity = commandIdentity(cmd);
  const ts = Date.now();
  const rec: FailureRecord = {
    kind: "failure", id: randomUUID(), ts, cwd: process.cwd(), cmd, exitCode,
    fingerprint: fingerprint(stderr, cmd, exitCode), fingerprintV: FINGERPRINT_ALGORITHM_VERSION,
    signature: signatureLines(stderr), excerpt: lastLines(stderr, 4),
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
    fingerprint: fingerprint(stderr, cmd, exitCode), fingerprintV: FINGERPRINT_ALGORITHM_VERSION,
    signature: signatureLines(stderr), excerpt: lastLines(stderr, 4), origin: "watch",
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
  // Fix attribution proves absence/resolution from the whole snapshot. A
  // capped, skipped, or raced read may still accept new failure/note evidence,
  // but it must never append a FixRecord based on partial knowledge.
  if (!transaction.complete || !isCompleteMemoryCoverage(transaction.coverage)) return {};
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
  }
  const pending = [
    ...(fix === undefined ? [] : [fix]),
    ...(association === undefined ? [] : [association]),
  ];
  // Never append then discover that the reload would be capped. This keeps
  // read/modify/write fail-closed without disabling append-only new evidence.
  if (!transaction.canAppendComplete(pending)) return {};
  for (const record of pending) transaction.append(record);
  return {
    ...(fix === undefined ? {} : { fix }),
    ...(association === undefined ? {} : { association }),
  };
}

export function recordFix(cmd: string, links: readonly UnresolvedLink[], cwd = process.cwd()): FixRecord | AssociationRecord {
  return withMemoryTransaction((transaction) => {
    const eligible = links.filter((link) => link.failure.ts <= transaction.now);
    const written = appendFixRecordsUnlocked(transaction, cmd, eligible, cwd, transaction.now);
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
    if (!transaction.complete || !isCompleteMemoryCoverage(transaction.coverage)) {
      // No definitive fix or pending deletion from an incomplete snapshot.
      // New failure/note/triple append paths remain available independently.
      return { confirmedResolved: 0, possibleAssociated: 0 };
    }
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
      // The append was preflighted against the bounded snapshot. A hostile
      // external replacement can still race the reload; retain pending and
      // return the durable attribution rather than append-then-throw.
      try {
        const latest = transaction.reload();
        reconcilePendingUnlocked(latest, transaction.paths, windowMs, now);
      } catch {
        // Explicit degraded mode: FixRecord remains evidence, pending remains
        // present until a complete future read can reconcile it.
      }
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
  return records.some((record) => record.kind === "failure" && !record.resolvedBy && record.ts >= cutoff && record.ts <= now);
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
    if (!transaction.complete || !isCompleteMemoryCoverage(transaction.coverage)) return;
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
    fingerprint: commandFingerprint(cmd, exitCode), fingerprintV: FINGERPRINT_ALGORITHM_VERSION,
    signature: [normalizeLine(cmd)], excerpt: `exit ${exitCode}`, origin: "hook",
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

export function recordBriefRun(input: { sinceTs: number; commits: number; files: number; cwd?: string }): BriefRunRecord {
  if (!isSafeNonNegativeInteger(input.sinceTs) || !isSafeNonNegativeInteger(input.commits) || !isSafeNonNegativeInteger(input.files)) {
    throw new Error("Rocky brief_run evidence requires safe non-negative integers");
  }
  const ts = Date.now();
  const rec: BriefRunRecord = {
    v: 1, kind: "brief_run", id: randomUUID(), ts, cwd: input.cwd ?? process.cwd(),
    sinceTs: input.sinceTs, commits: input.commits, files: input.files,
  };
  withMemoryTransaction((transaction) => { transaction.append(rec); }, resolveRockyPaths(), { now: ts });
  return rec;
}

export function recordInvariantTouch(input: { invariant: string; path: string; cwd?: string }): InvariantTouchRecord {
  const ts = Date.now();
  const invariant = input.invariant.slice(0, 512);
  const path = input.path.slice(0, 512);
  if (invariant.length === 0 || path.length === 0) {
    throw new Error("Rocky invariant_touch evidence requires non-empty invariant and path");
  }
  const rec: InvariantTouchRecord = {
    v: 1, kind: "invariant_touch", id: randomUUID(), ts, cwd: input.cwd ?? process.cwd(),
    invariant, path,
  };
  withMemoryTransaction((transaction) => { transaction.append(rec); }, resolveRockyPaths(), { now: ts });
  return rec;
}

function safeTripleTimestamp(value: unknown): number {
  return isSafeNonNegativeInteger(value) ? value : Date.now();
}

function safeTriplePlatform(value: unknown): NodeJS.Platform {
  return isKnownPathPlatform(value) ? value : process.platform;
}

export function recordTriple(
  input: Omit<TripleRecord, "kind" | "id" | "ts" | "schemaV" | "origin"> & { ts?: number },
  paths?: RockyPaths,
): TripleRecord {
  const platform = safeTriplePlatform(input.platform);
  const boundedMechanism = boundTripleMechanism(input.mechanism, { platform, cwd: input.cwd });
  const durableMechanism: TripleRecord["mechanism"] = {
    ...boundedMechanism,
    // `boundTripleMechanism` keeps identity witnesses non-enumerable for the
    // normalized reader shape. Re-materialize them only for the JSONL write;
    // otherwise redacted cwd/collision identities would vanish on reload.
    files: boundedMechanism.files.map((file) => file.identityHash === undefined
      ? file
      : { ...file, identityHash: file.identityHash }),
  };
  const rec: TripleRecord = {
    kind: "triple",
    id: randomUUID(),
    ts: safeTripleTimestamp(input.ts),
    schemaV: 1,
    origin: "agent-hook",
    agent: input.agent,
    platform,
    cwd: input.cwd,
    ...(input.intent === undefined ? {} : { intent: input.intent }),
    ...(input.rationale === undefined ? {} : { rationale: input.rationale }),
    mechanism: durableMechanism,
  };
  withMemoryTransaction((transaction) => transaction.append(rec), paths ?? resolveRockyPaths());
  return { ...rec, mechanism: boundTripleMechanism(rec.mechanism, { platform: rec.platform ?? "unknown", cwd: rec.cwd }) };
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
    if (!transaction.complete || !isCompleteMemoryCoverage(transaction.coverage)) {
      throw new Error("Rocky triple claim requires complete memory coverage");
    }
    const existing = transaction.records.find((record): record is TripleRecord => record.kind === "triple" && record.id === id);
    if (existing) return { record: existing, appended: false };

    const platform = safeTriplePlatform(input.platform);
    const boundedMechanism = boundTripleMechanism(input.mechanism, { platform, cwd: input.cwd });
    const durableMechanism: TripleRecord["mechanism"] = {
      ...boundedMechanism,
      files: boundedMechanism.files.map((file) => file.identityHash === undefined
        ? file
        : { ...file, identityHash: file.identityHash }),
    };
    const rec: TripleRecord = {
      kind: "triple",
      id,
      ts: safeTripleTimestamp(input.ts),
      schemaV: 1,
      origin: "agent-hook",
      agent: input.agent,
      platform,
      cwd: input.cwd,
      ...(input.intent === undefined ? {} : { intent: input.intent }),
      ...(input.rationale === undefined ? {} : { rationale: input.rationale }),
      mechanism: durableMechanism,
    };
    if (!transaction.canAppendComplete([rec])) {
      throw new Error("Rocky triple claim exceeds bounded memory envelope");
    }
    transaction.append(rec);
    return {
      record: { ...rec, mechanism: boundTripleMechanism(rec.mechanism, { platform: rec.platform ?? "unknown", cwd: rec.cwd }) },
      appended: true,
    };
  }, target);
}

export const MAX_RATIONALE_EXCERPT_BYTES = 1200;

/** Redact secrets, flatten control characters, and cap head+tail by bytes. */
export function boundRationaleExcerpt(text: string): string {
  const clean = redactSecretsAtBoundary(text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " "));
  if (Buffer.byteLength(clean, "utf8") <= MAX_RATIONALE_EXCERPT_BYTES) return clean;
  const half = Math.floor((MAX_RATIONALE_EXCERPT_BYTES - 5) / 2);
  const head = utf8Slice(clean, 0, half);
  const tail = utf8SliceFromEnd(clean, half);
  return `${head} … ${tail}`;
}

/** Bound the optional notify-lane files list: cap count and entry length, drop junk entries. */
function boundedRationaleFiles(files: string[] | undefined): { files: string[] } | undefined {
  if (!Array.isArray(files)) return undefined;
  const bounded = files
    .filter((f): f is string => typeof f === "string" && plausibleFilePath(f))
    .map((f) => f.slice(0, MAX_RATIONALE_FILE_CHARS))
    .slice(0, MAX_RATIONALE_FILES);
  return bounded.length === 0 ? undefined : { files: bounded };
}

function boundGitAnchor(input: GitAnchor | undefined): { git?: GitAnchor } {
  if (input === undefined) return {};
  const git: GitAnchor = {};
  if (typeof input.base === "string" && input.base.length > 0) git.base = input.base.slice(0, 256);
  if (typeof input.dirty === "boolean") git.dirty = input.dirty;
  if (typeof input.snapshot === "string" && input.snapshot.trim().length > 0) {
    const rawBounded = input.snapshot.length > MAX_GIT_SNAPSHOT_PRE_REDACT_CHARS
      ? input.snapshot.slice(0, MAX_GIT_SNAPSHOT_PRE_REDACT_CHARS)
      : input.snapshot;
    git.snapshot = redactSecretsAtBoundary(rawBounded).slice(0, MAX_GIT_SNAPSHOT_CHARS);
  }
  if (git.base === undefined && git.dirty === undefined && git.snapshot === undefined) return {};
  return { git };
}

export function recordRationale(
  input: Omit<RationaleRecord, "kind" | "id" | "ts" | "v" | "excerpt"> & { text: string; ts?: number; git?: GitAnchor },
  paths?: RockyPaths,
): RationaleRecord {
  const ts = input.ts ?? Date.now();
  const rec: RationaleRecord = {
    kind: "rationale",
    id: randomUUID(),
    ts,
    v: 1,
    cwd: input.cwd,
    agent: input.agent,
    rationale_fidelity: input.rationale_fidelity,
    source: input.source,
    excerpt: boundRationaleExcerpt(input.text),
    ...(input.pointer === undefined ? {} : { pointer: input.pointer }),
    ...(input.links === undefined ? {} : { links: input.links }),
    ...(boundedRationaleFiles(input.files) ?? {}),
    ...boundGitAnchor(input.git),
  };
  withMemoryTransaction((transaction) => { transaction.append(rec); }, paths ?? resolveRockyPaths(), { now: ts });
  return rec;
}

/** Normalize then hash a hunk for content-keyed lookup. */
export function explainContentHash(snippet: string): string {
  const normalized = snippet.replace(/\s+/gu, " ").trim();
  return createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 32);
}

export function recordExplain(
  input: { cwd: string; path: string; source: string; code: string; business: string; snippet?: string; git?: GitAnchor; ts?: number },
  paths: RockyPaths = resolveRockyPaths(),
): ExplainRecord {
  const record: ExplainRecord = {
    kind: "explain", id: randomUUID(), ts: input.ts ?? Date.now(), v: 1,
    cwd: input.cwd,
    path: input.path.slice(0, MAX_RATIONALE_FILE_CHARS),
    source: input.source,
    code: boundRationaleExcerpt(input.code),
    business: boundRationaleExcerpt(input.business),
    ...boundGitAnchor(input.git),
  };
  if (input.snippet !== undefined && input.snippet.length > 0) {
    record.snippet = boundRationaleExcerpt(input.snippet);
    record.contentHash = explainContentHash(input.snippet);
  }
  withMemoryTransaction((t) => t.append(record), paths);
  return record;
}

export function recordAlias(
  input: { alias: string; concept: string; action: "add" | "retract"; ts?: number },
  paths?: RockyPaths,
): AliasRecord {
  const ts = input.ts ?? Date.now();
  const rec: AliasRecord = {
    kind: "alias",
    id: randomUUID(),
    ts,
    v: 1,
    alias: input.alias,
    concept: input.concept,
    action: input.action,
  };
  withMemoryTransaction((transaction) => { transaction.append(rec); }, paths ?? resolveRockyPaths(), { now: ts });
  return rec;
}
