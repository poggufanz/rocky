import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import { resolveRockyPaths, type RockyPaths } from "../core/state-paths.js";
import { dirname } from "node:path";
import { canonicalPath } from "../core/memory-read.js";
import { filesystemIdentity, NO_BLOCK_FLAG, NO_FOLLOW_FLAG, regularDescriptorSafe, sameFilesystemIdentity } from "../core/fs-safety.js";
import { isSafeNonNegativeInteger } from "../core/memory-read.js";
import { recordTripleOnce } from "../core/memory.js";
import type { TripleFile, TripleRecord } from "../core/memory.js";
import { isCompleteMemoryCoverage, loadMemory, loadMemoryChecked, MAX_TRIPLE_FILES, pathIdentityHash, rememberTripleFileIdentity } from "../core/memory-read.js";
import { digestBuckets } from "../core/dictionary.js";
import { loadConfig, type ConfigLoadResult } from "../core/config-read.js";
import { redactSecretsAtBoundary, replaceAnsiAndControls, stripInvisibleControls } from "../core/redact.js";
import { annotatePortFromConfig, parseAnnotateOutput, type AnnotatePort, type AnnotateOutput } from "../ai/annotate.js";
import { MAX_ADAPTER_EVENTS } from "./adapters/claude-code.js";
import {
  MAX_EXCERPT_CHARS,
  MAX_INTENT_CHARS,
  MAX_RATIONALE_CHARS,
  MAX_COVERAGE_PATHS,
  type FileProvenance,
  type AgentName,
  type IntentEvent,
} from "./schema.js";
import {
  acquireAnnotationLease,
  claimBatch,
  listOrphanBatches,
  listOrphanClaims,
  prepareClaim,
  readClaimResult,
  releaseAnnotationLease,
  removeClaim,
  readClaimCoverage,
  removeClaimCoverage,
  type AnnotationLease,
  type BatchClaim,
  MAX_BATCH_BYTES,
} from "./spool.js";

export { MAX_TRIPLE_FILES } from "../core/memory-read.js";

// A full transient batch may have silently rejected its last append at the
// spool cap.  Keep a conservative margin so annotation never calls such a
// batch complete merely because its surviving unique paths fit the triple cap.
const SPOOL_COMPLETENESS_MARGIN_BYTES = 8 * 1024;

const MAX_LABEL_LINES = 10;
const MAX_LABEL_CHARS = 400;
const MAX_LABEL_FILE_BYTES = 64 * 1024;
const MAX_PATH_CHARS = 1024;
const MAX_HEAD_CHARS = 256;
const MAX_CWD_CHARS = 4096;
const PROP_RE = /([a-zA-Z-]{2,})\s*:/g;
// Internal sentinel: redactSecretsAtBoundary removes it while recording the
// boundary restored by stripping ANSI/C0/C1 controls.
const BOUNDARY_MARKER = "\u2065";
const NO_FOLLOW = NO_FOLLOW_FLAG;
const NO_BLOCK = NO_BLOCK_FLAG;
const WEEK_MS = 7n * 24n * 60n * 60n * 1_000n;
const DIGEST_HINT_LEASE_KEY = "__rocky_digest_hint__";

export interface AnnotateDeps {
  paths?: RockyPaths;
  now?: () => number;
  git?: (args: string[], cwd: string) => string | undefined;
  ai?: AnnotatePort;
  loadConfig?: (path: string) => ConfigLoadResult;
  queueLabel?: (line: string, paths: RockyPaths) => void;
  /** Internal recovery hooks keep claim and lease ownership in one transaction. */
  claim?: BatchClaim;
  lease?: AnnotationLease;
  afterPersist?: (record: TripleRecord, appended: boolean) => void;
}

function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // Best effort at this private boundary.
  }
}

function prefixUtf8(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return "";
  let offset = 0;
  let used = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (used + bytes > maximumBytes) break;
    used += bytes;
    offset += character.length;
  }
  return offset === value.length ? value : value.slice(0, offset);
}

function cleanText(value: string, maximum: number): string {
  const bounded = prefixUtf8(value, Math.max(1, maximum) * 4);
  const stripped = replaceAnsiAndControls(bounded, BOUNDARY_MARKER);
  return redactSecretsAtBoundary(stripped, {
    mayBeTruncated: value.length >= maximum || bounded.length < value.length,
  }).replace(/\s+/g, " ").trim().slice(0, maximum);
}

function operationalText(value: string, maximum: number): string {
  return stripInvisibleControls(replaceAnsiAndControls(prefixUtf8(value, Math.max(1, maximum) * 4), "", " "))
    .replace(/[\r\n\t]/g, " ");
}

function safeLabel(value: string): string | undefined {
  const line = cleanText(value, MAX_LABEL_CHARS);
  return line.length === 0 ? undefined : line;
}

function ensureHomeDirectory(home: string): boolean {
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const stats = lstatSync(home, { bigint: true });
    return stats.isDirectory() && !stats.isSymbolicLink() && filesystemIdentity(stats) !== undefined;
  } catch {
    return false;
  }
}

function readLabelLines(path: string): string[] | undefined {
  const initial = (() => {
    try {
      return lstatSync(path, { bigint: true });
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : null;
    }
  })();
  if (initial === null) return undefined;
  if (initial === undefined) return [];
  if (!regularDescriptorSafe(initial) || !sameFilesystemIdentity(initial, initial) || initial.size > BigInt(MAX_LABEL_FILE_BYTES)) return undefined;

  let fd = -1;
  try {
    fd = openSync(path, constants.O_RDONLY | NO_FOLLOW);
    const opened = fstatSync(fd, { bigint: true });
    if (!regularDescriptorSafe(opened) || !sameFilesystemIdentity(initial, opened)
        || opened.size > BigInt(MAX_LABEL_FILE_BYTES)) return undefined;
    const bytes = Buffer.alloc(MAX_LABEL_FILE_BYTES + 1);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    const after = fstatSync(fd, { bigint: true });
    if (!regularDescriptorSafe(after) || !sameFilesystemIdentity(initial, after)
        || BigInt(count) !== after.size || count > MAX_LABEL_FILE_BYTES) return undefined;
    return bytes.subarray(0, count).toString("utf8").split(/\r?\n/).filter(Boolean)
      .map((line) => safeLabel(line)).filter((line): line is string => line !== undefined);
  } catch {
    return undefined;
  } finally {
    if (fd >= 0) closeQuietly(fd);
  }
}

function writeLabelLines(path: string, lines: readonly string[]): void {
  let fd = -1;
  let temporary: string | undefined;
  try {
    const parent = dirname(path);
    const parentIdentity = lstatSync(parent, { bigint: true });
    if (!parentIdentity.isDirectory() || parentIdentity.isSymbolicLink() || filesystemIdentity(parentIdentity) === undefined) return;
    let before: BigIntStats | undefined;
    try {
      before = lstatSync(path, { bigint: true });
      if (!regularDescriptorSafe(before) || !sameFilesystemIdentity(before, before)) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
    }
    temporary = `${path}.tmp.${process.pid}.${randomBytes(8).toString("hex")}`;
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, 0o600);
    const stats = fstatSync(fd, { bigint: true });
    if (!regularDescriptorSafe(stats) || !sameFilesystemIdentity(stats, stats)) return;
    try {
      fchmodSync(fd, 0o600);
    } catch {
      // File mode is best effort on platforms without chmod support.
    }
    const encoded = Buffer.from(lines.join("\n") + "\n", "utf8");
    if (encoded.byteLength > MAX_LABEL_FILE_BYTES) return;
    let offset = 0;
    while (offset < encoded.byteLength) {
      const written = writeSync(fd, encoded, offset, encoded.byteLength - offset);
      if (written <= 0) return;
      offset += written;
    }
    const after = fstatSync(fd, { bigint: true });
    if (!regularDescriptorSafe(after) || !sameFilesystemIdentity(stats, after)) return;
    closeQuietly(fd);
    fd = -1;
    let current: BigIntStats | null | undefined;
    try { current = lstatSync(path, { bigint: true }); } catch (error) {
      current = (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : null;
    }
    if (current === null || (before === undefined ? current !== undefined : current === undefined
      || !sameFilesystemIdentity(before, current))) return;
    const beforeRenameParent = lstatSync(parent, { bigint: true });
    if (!beforeRenameParent.isDirectory() || beforeRenameParent.isSymbolicLink()
        || !sameFilesystemIdentity(parentIdentity, beforeRenameParent)) return;
    renameSync(temporary, path);
    temporary = undefined;
    const afterRenameParent = lstatSync(parent, { bigint: true });
    if (!afterRenameParent.isDirectory() || afterRenameParent.isSymbolicLink()
        || !sameFilesystemIdentity(parentIdentity, afterRenameParent)) return;
  } finally {
    if (fd >= 0) closeQuietly(fd);
    if (temporary !== undefined) {
      try { unlinkSync(temporary); } catch { /* best effort cleanup */ }
    }
  }
}

export function defaultQueueLabel(line: string, paths: RockyPaths): void {
  try {
    if (!ensureHomeDirectory(paths.home)) return;
    const safe = safeLabel(line);
    if (!safe) return;
    const existing = readLabelLines(paths.labels);
    if (existing === undefined) return;
    writeLabelLines(paths.labels, [...existing, safe].slice(-MAX_LABEL_LINES));
  } catch {
    // Labels are best effort and never affect durable memory.
  }
}

function digestLstat(path: string): BigIntStats {
  return lstatSync(path, { bigint: true });
}

function digestFstat(fd: number): BigIntStats {
  return fstatSync(fd, { bigint: true });
}

function exactTimeMs(timeMs: number): bigint | undefined {
  return Number.isSafeInteger(timeMs) ? BigInt(timeMs) : undefined;
}

function usableFileIdentity(stats: { dev: bigint; ino: bigint }): boolean {
  return typeof stats.dev === "bigint" && typeof stats.ino === "bigint"
    && stats.dev >= 0n && stats.ino >= 0n && (stats.dev !== 0n || stats.ino !== 0n);
}

function sameFileIdentity(left: { dev: bigint; ino: bigint }, right: { dev: bigint; ino: bigint }): boolean {
  return usableFileIdentity(left) && usableFileIdentity(right)
    && left.dev === right.dev && left.ino === right.ino;
}

function validDigestDescriptor(stats: {
  dev: bigint;
  ino: bigint;
  nlink: bigint;
  isFile: () => boolean;
  isSymbolicLink: () => boolean;
}): boolean {
  return stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1n && usableFileIdentity(stats);
}

type DigestHintState = "missing" | "recent" | "stale" | "unsafe";

function digestHintState(path: string, now: number): DigestHintState {
  const nowMs = exactTimeMs(now);
  if (nowMs === undefined) return "unsafe";
  let initial: BigIntStats;
  try {
    initial = digestLstat(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unsafe";
  }
  if (!validDigestDescriptor(initial)) return "unsafe";

  let fd = -1;
  try {
    fd = openSync(path, constants.O_RDONLY | NO_FOLLOW | NO_BLOCK);
    const opened = digestFstat(fd);
    if (!validDigestDescriptor(opened) || !sameFileIdentity(initial, opened)) return "unsafe";
    const after = digestFstat(fd);
    if (!validDigestDescriptor(after) || !sameFileIdentity(opened, after)) return "unsafe";
    return nowMs - after.mtimeMs < WEEK_MS ? "recent" : "stale";
  } catch {
    return "unsafe";
  } finally {
    if (fd >= 0) closeQuietly(fd);
  }
}

function writeDigestHint(path: string, value: string, now: number): boolean {
  const nowMs = exactTimeMs(now);
  if (nowMs === undefined) return false;
  let fd = -1;
  try {
    const state = digestHintState(path, now);
    if (state === "recent" || state === "unsafe") return false;

    let expected: BigIntStats;
    if (state === "missing") {
      fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW | NO_BLOCK, 0o600);
      expected = digestFstat(fd);
      if (!validDigestDescriptor(expected)) return false;
    } else {
      const initial = digestLstat(path);
      if (!validDigestDescriptor(initial)) return false;
      fd = openSync(path, constants.O_RDWR | NO_FOLLOW | NO_BLOCK);
      const opened = digestFstat(fd);
      if (!validDigestDescriptor(opened) || !sameFileIdentity(initial, opened)
        || nowMs - opened.mtimeMs < WEEK_MS) return false;
      expected = opened;
    }

    try {
      fchmodSync(fd, 0o600);
    } catch {
      if (process.platform !== "win32") return false;
    }
    if (process.platform !== "win32" && (digestFstat(fd).mode & 0o777n) !== 0o600n) return false;
    const encoded = Buffer.from(value, "utf8");
    const beforeWritePath = digestLstat(path);
    const beforeWriteDescriptor = digestFstat(fd);
    if (!validDigestDescriptor(beforeWritePath)
      || !validDigestDescriptor(beforeWriteDescriptor)
      || !sameFileIdentity(expected, beforeWritePath)
      || !sameFileIdentity(expected, beforeWriteDescriptor)) return false;
    ftruncateSync(fd, 0);
    let offset = 0;
    while (offset < encoded.byteLength) {
      const written = writeSync(fd, encoded, offset, encoded.byteLength - offset);
      if (written <= 0) return false;
      offset += written;
    }
    const after = digestFstat(fd);
    if (!validDigestDescriptor(after)
      || !sameFileIdentity(expected, after)
      || after.size !== BigInt(encoded.byteLength)) return false;
    const publicPath = digestLstat(path);
    if (!validDigestDescriptor(publicPath) || !sameFileIdentity(after, publicPath)) return false;
    return true;
  } catch {
    // Digest hints are advisory and never affect annotation success.
    return false;
  } finally {
    if (fd >= 0) closeQuietly(fd);
  }
}

export function maybeQueueDigestHint(paths: RockyPaths, now = Date.now()): void {
  let lease: AnnotationLease | undefined;
  try {
    if (!Number.isFinite(now)) return;
    if (!ensureHomeDirectory(paths.home)) return;
    lease = acquireAnnotationLease(DIGEST_HINT_LEASE_KEY, paths);
    if (!lease) return;
    const state = digestHintState(paths.digestHint, now);
    if (state === "recent" || state === "unsafe") return;
    const loaded = loadMemoryChecked(paths.memory, now);
    if (!isCompleteMemoryCoverage(loaded.coverage) || digestBuckets(loaded.records, now).length === 0) return;
    if (!writeDigestHint(paths.digestHint, String(now), now)) return;
    defaultQueueLabel("week of work in memory. rocky digest, question", paths);
  } catch {
    // Hinting is best effort and never affects annotation success or cleanup.
  } finally {
    if (lease) {
      try {
        releaseAnnotationLease(lease, paths);
      } catch {
        // Lease release is best effort at this fail-open boundary.
      }
    }
  }
}

function defaultGit(args: string[], cwd: string): string | undefined {
  try {
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      shell: false,
      windowsHide: true,
    });
    if (result.error || result.status !== 0 || (result.signal !== null && result.signal !== undefined)) return undefined;
    return typeof result.stdout === "string" ? result.stdout.trim() : undefined;
  } catch {
    return undefined;
  }
}

function runGit(git: (args: string[], cwd: string) => string | undefined, args: string[], cwd: string): string | undefined {
  try {
    return git(args, cwd);
  } catch {
    return undefined;
  }
}

function parseNumstat(value: string | undefined): [number, number] | undefined {
  const match = value?.match(/^\s*(\d+|-)\t(\d+|[-])(?:\t|$)/m);
  if (!match) return undefined;
  if (match[1] === "-" || match[2] === "-") return undefined;
  const added = Number(match[1]);
  const removed = Number(match[2]);
  return isSafeNonNegativeInteger(added) && isSafeNonNegativeInteger(removed) ? [added, removed] : undefined;
}

function safeCountSum(left: number, right: number): [number, boolean] {
  if (!isSafeNonNegativeInteger(left) || !isSafeNonNegativeInteger(right)) return [0, false];
  const value = left + right;
  return [isSafeNonNegativeInteger(value) ? value : 0, isSafeNonNegativeInteger(value)];
}

function pathIdentity(value: string, cwd?: string, platform: NodeJS.Platform | "unknown" = process.platform): string {
  if (typeof value !== "string" || value.length > MAX_PATH_CHARS) return "";
  return canonicalPath(operationalText(value, MAX_PATH_CHARS), { cwd, platform });
}

interface DiffEntry {
  path: string;
  plusMinus: [number, number];
  statsKnown: boolean;
}

function parseNumstatEntries(
  value: string | undefined,
  cwd?: string,
  platform: NodeJS.Platform | "unknown" = process.platform,
): DiffEntry[] | undefined {
  if (value === undefined) return undefined;
  const entries: DiffEntry[] = [];
  const seen = new Set<string>();
  for (const line of value.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    const match = /^\s*(\d+|-)\t(\d+|-)\t(.+?)\s*$/u.exec(line);
    if (!match) return undefined;
    const rawPath = match[3] === undefined ? "" : match[3];
    const path = pathIdentity(rawPath, cwd, platform);
    const displayPath = canonicalPath(rawPath, { platform });
    if (!path || !displayPath) return undefined;
    if (seen.has(path)) continue;
    const plusMinus: [number, number] = [
      match[1] === "-" ? 0 : Number(match[1]),
      match[2] === "-" ? 0 : Number(match[2]),
    ];
    if (!isSafeNonNegativeInteger(plusMinus[0]) || !isSafeNonNegativeInteger(plusMinus[1])) continue;
    seen.add(path);
    entries.push({ path: displayPath, plusMinus, statsKnown: match[1] !== "-" && match[2] !== "-" });
  }
  return entries;
}

function parseUntrackedEntries(
  value: string | undefined,
  cwd?: string,
  platform: NodeJS.Platform | "unknown" = process.platform,
): DiffEntry[] | undefined {
  if (value === undefined) return undefined;
  const entries: DiffEntry[] = [];
  for (const line of value.split(/\r?\n/u)) {
    const rawPath = line.trim();
    if (!rawPath) continue;
    const path = pathIdentity(rawPath, cwd, platform);
    const displayPath = canonicalPath(rawPath, { platform });
    if (!path || !displayPath) return undefined;
    entries.push({ path: displayPath, plusMinus: [0, 0], statsKnown: false });
  }
  return entries;
}

function mergeDiffEntries(
  sources: Array<DiffEntry[] | undefined>,
  cwd?: string,
  platform: NodeJS.Platform | "unknown" = process.platform,
): DiffEntry[] | undefined {
  if (sources.some((source) => source === undefined)) return undefined;
  const merged = new Map<string, { path: string; plusMinus: [number, number]; statsKnown: boolean }>();
  for (const source of sources) {
    for (const entry of source ?? []) {
      const path = pathIdentity(entry.path, cwd, platform);
      if (!path) continue;
      const prior = merged.get(path);
      const [added, addedOk] = prior === undefined
        ? [entry.plusMinus[0], true] as [number, boolean]
        : safeCountSum(prior.plusMinus[0], entry.plusMinus[0]);
      const [removed, removedOk] = prior === undefined
        ? [entry.plusMinus[1], true] as [number, boolean]
        : safeCountSum(prior.plusMinus[1], entry.plusMinus[1]);
      merged.set(path, prior === undefined
        ? { path: entry.path, plusMinus: [...entry.plusMinus] as [number, number], statsKnown: entry.statsKnown }
        : {
          path: prior.path,
          plusMinus: [added, removed],
          statsKnown: prior.statsKnown && entry.statsKnown && addedOk && removedOk,
        });
    }
  }
  return [...merged.values()];
}

function baselineMap(
  intent: IntentEvent | undefined,
  cwd?: string,
  platform: NodeJS.Platform | "unknown" = process.platform,
): Map<string, [number, number]> | undefined {
  const baseline = intent?.baseline;
  if (baseline?.status !== "captured") return undefined;
  const mapped = new Map<string, [number, number]>();
  for (const file of baseline.files ?? []) {
    const path = pathIdentity(file.path, cwd, platform);
    if (!path) continue;
    const previous = mapped.get(path);
    if (!isSafeNonNegativeInteger(file.plusMinus[0]) || !isSafeNonNegativeInteger(file.plusMinus[1])) return undefined;
    if (previous === undefined) {
      mapped.set(path, [...file.plusMinus] as [number, number]);
      continue;
    }
    const [added, addedOk] = safeCountSum(previous[0], file.plusMinus[0]);
    const [removed, removedOk] = safeCountSum(previous[1], file.plusMinus[1]);
    if (!addedOk || !removedOk) return undefined;
    mapped.set(path, [added, removed]);
  }
  return mapped;
}

function propsFromExcerpt(excerpt: string | undefined): string[] {
  if (!excerpt) return [];
  const found = new Set<string>();
  for (const match of excerpt.matchAll(new RegExp(PROP_RE.source, "g"))) {
    const prop = match[1];
    if (prop !== undefined) found.add(prop);
    if (found.size >= 5) break;
  }
  return [...found].slice(0, 5);
}

export function degradedLabel(intent: string | undefined, files: readonly TripleFile[]): string | undefined {
  const cleanIntent = intent === undefined ? undefined : cleanText(intent, MAX_INTENT_CHARS);
  if (!cleanIntent || files.length === 0) return undefined;
  const first = files[0];
  if (!first) return undefined;
  const subject = cleanText(first.props[0] ?? first.path, 160);
  if (!subject) return undefined;
  const short = cleanIntent.length > 60 ? `${cleanIntent.slice(0, 57)}...` : cleanIntent;
  return safeLabel(`you say "${short}". it is ${subject}. I think. check, question`);
}

export async function annotateBatch(key: string, deps: AnnotateDeps = {}): Promise<TripleRecord | undefined> {
  const paths = deps.paths ?? resolveRockyPaths();
  const git = deps.git ?? defaultGit;
  const lease = deps.lease ?? acquireAnnotationLease(key, paths);
  if (!lease) return undefined;
  let claim: BatchClaim | undefined;
  try {
    claim = deps.claim === undefined ? claimBatch(key, paths) : prepareClaim(deps.claim, paths);
    if (!claim) return undefined;
    const claimRead = readClaimResult(claim, paths);
    if (!claimRead.ok) return undefined;
    const spoolMayBeTruncated = claim.stats.size >= MAX_BATCH_BYTES - SPOOL_COMPLETENESS_MARGIN_BYTES;
    const events = claimRead.events;
    const agent: AgentName = events[0]?.agent ?? "claude-code";
    const batchEvents = events.filter((event) => event.agent === agent);
    const intentEvent = batchEvents.find((event): event is Extract<typeof event, { kind: "intent" }> => event.kind === "intent");
    const rawCwd = intentEvent?.kind === "intent" && intentEvent.cwd ? intentEvent.cwd : process.cwd();
    const operationalCwd = operationalText(rawCwd, MAX_CWD_CHARS);
    const gitCwd = operationalCwd.trim() ? operationalCwd : process.cwd();
    // Keep redaction on persisted/display values only.  Path identity must use
    // the operational cwd, otherwise a secret-shaped directory can split an
    // absolute tool path from its relative spelling after reload.
    const identityCwd = operationalCwd.trim() ? operationalCwd : process.cwd();
    const cwd = cleanText(rawCwd, MAX_CWD_CHARS) || process.cwd();
    const byPath = new Map<string, {
      path: string;
      gitPath?: string;
      excerpt?: string;
      provenance?: FileProvenance;
      plusMinus?: [number, number];
    }>();
    const coverageCandidates = new Map<string, string>();
    // A claim is an immutable generation. Never read the live sidecar here:
    // late appends may have already created the next generation under the
    // same key.
    const coverageSnapshot = readClaimCoverage(claim, paths);
    // A sidecar without a persisted cwd was produced without a trusted root.
    // Keep event/sidecar identity hashing in that same root-less namespace;
    // falling back to the annotator's process cwd would make every relative
    // witness appear contradictory after a lost append.  When the sidecar
    // carries cwd, it remains the authoritative operational root.
    const coverageIdentityCwd = coverageSnapshot === undefined ? identityCwd : coverageSnapshot.cwd;
    const coveragePlatform = coverageSnapshot?.platform ?? "unknown";
    // A claim sidecar is the origin authority for path case/root policy.  Do
    // not re-hash its events with the annotator's reader platform after a
    // cross-platform reload; an unknown sidecar stays conservative and is
    // reconciled only in its unknown namespace.
    const mechanismPlatform = coverageSnapshot === undefined ? process.platform : coveragePlatform;
    const identityPlatform = mechanismPlatform === "unknown" ? process.platform : mechanismPlatform;
    // Mechanism events must use the same root namespace as a trusted sidecar
    // while they are reconciled.  A root-less sidecar cannot safely be joined
    // to the annotator's process cwd, but relative witnesses can still be
    // reconciled with one another without manufacturing a contradiction.
    const mechanismIdentityCwd = coverageSnapshot === undefined ? identityCwd : coverageIdentityCwd;
    const materializedEventIdentities = new Set<string>();
    let coverageMetadataSeen = false;
    let coverageMetadataComplete = true;
    let coverageMetadataContradiction = false;
    let adapterMaxTruncatedFiles = 0;
    let adapterTruncationMarkers = 0;
    const markerSignatures = new Set<string>();
    const coverageExpectedCounts: number[] = [];
    let coverageExpectedCountUnknown = false;
    let coverageCapProof = false;
    let snapshotExpectedCount: number | undefined;
    const snapshotIdentitySet = coverageSnapshot?.identityHashes === undefined
      ? undefined
      : new Set(coverageSnapshot.identityHashes);
    if (coverageSnapshot) {
      coverageMetadataSeen = true;
      if (coverageSnapshot.cwdConflict === true) {
        coverageMetadataComplete = false;
        coverageMetadataContradiction = true;
      }
      const snapshotIdentityCount = coverageSnapshot.identityHashes?.length ?? coverageSnapshot.paths.length;
      if (coverageSnapshot.identityHashes === undefined) coverageMetadataComplete = false;
      if (!coverageSnapshot.candidateCountExact || coverageSnapshot.candidateCount === undefined) {
        coverageExpectedCountUnknown = true;
      } else {
        // A complete witness is re-counted after cwd-aware canonicalization;
        // absolute/relative aliases must not consume two durable slots.
        snapshotExpectedCount = coverageSnapshot.candidateCount;
        // A single adapter payload can retain an exact count while its
        // bounded identity witness is capped at 256 paths. The compact sidecar
        // stores only eight display witnesses but retains all identities.
        coverageCapProof = !coverageSnapshot.pathsComplete
          && coverageSnapshot.payloads === 1
          && coverageSnapshot.cappedDigestProof === true
          && coverageSnapshot.candidateCount > snapshotIdentityCount
          && snapshotIdentityCount >= MAX_COVERAGE_PATHS;
        if (!coverageSnapshot.pathsComplete && !coverageCapProof) coverageMetadataComplete = false;
      }
      if (!coverageSnapshot.pathsComplete && coverageSnapshot.candidateCountExact !== true) coverageMetadataComplete = false;
      for (const candidate of coverageSnapshot.paths) {
        const candidateGitPath = pathIdentity(candidate, coverageIdentityCwd, mechanismPlatform);
        const candidatePath = canonicalPath(cleanText(candidate, MAX_PATH_CHARS));
        if (!candidateGitPath || !candidatePath) {
          coverageMetadataComplete = false;
          coverageMetadataContradiction = true;
          continue;
        }
        if (coverageCandidates.has(candidateGitPath)) continue;
        coverageCandidates.set(candidateGitPath, candidatePath);
      }
      if (snapshotExpectedCount !== undefined) {
        // Compact sidecars retain exact identity count separately from their
        // eight display witnesses. Never substitute witness length for the
        // durable candidate total.
        coverageExpectedCounts.push(snapshotExpectedCount);
      }
    }
    for (const event of batchEvents) {
      if (event.kind !== "mechanism") continue;
      if (event.coveragePaths !== undefined || event.coveragePathsComplete !== undefined) {
        coverageMetadataSeen = true;
        if (event.coveragePathsComplete !== true || event.coveragePaths === undefined) {
          coverageMetadataComplete = false;
        }
        const eventPath = pathIdentity(event.path, mechanismIdentityCwd, mechanismPlatform);
        const eventCandidates = new Set<string>();
        for (const candidate of event.coveragePaths ?? []) {
          const candidateGitPath = pathIdentity(candidate, mechanismIdentityCwd, mechanismPlatform);
          const candidatePath = canonicalPath(cleanText(candidate, MAX_PATH_CHARS));
          if (!candidateGitPath || !candidatePath || eventCandidates.has(candidateGitPath)) {
            coverageMetadataComplete = false;
            coverageMetadataContradiction = true;
            continue;
          }
          eventCandidates.add(candidateGitPath);
          if (snapshotIdentitySet !== undefined) {
            const identity = canonicalPath(candidate, { platform: coveragePlatform, cwd: coverageIdentityCwd });
            const hash = identity ? pathIdentityHash(identity, { canonical: true }) : undefined;
            if (hash === undefined || !snapshotIdentitySet.has(hash)) {
              coverageMetadataComplete = false;
              coverageMetadataContradiction = true;
            }
          }
          coverageCandidates.set(candidateGitPath, candidatePath);
        }
        if (event.coveragePathsComplete === true && (!eventPath || !eventCandidates.has(eventPath))) {
          coverageMetadataComplete = false;
          coverageMetadataContradiction = true;
        }
        if (event.truncatedFiles !== undefined && event.coveragePaths !== undefined &&
            (!isSafeNonNegativeInteger(event.truncatedFiles) || eventCandidates.size < event.truncatedFiles + 1)) {
          coverageMetadataComplete = false;
          coverageMetadataContradiction = true;
        }
      }
      const gitPath = pathIdentity(event.path, mechanismIdentityCwd, mechanismPlatform);
      const gitDisplayPath = canonicalPath(operationalText(event.path, MAX_PATH_CHARS));
      const path = canonicalPath(cleanText(event.path, MAX_PATH_CHARS)) || cleanText(event.path, MAX_PATH_CHARS);
      if (!path || !gitPath || !gitDisplayPath) continue;
      materializedEventIdentities.add(pathIdentityHash(event.path, {
        platform: coverageSnapshot === undefined ? identityPlatform : mechanismPlatform,
        cwd: coverageIdentityCwd,
      }));
      const excerpt = event.excerpt === undefined ? undefined : cleanText(event.excerpt, MAX_EXCERPT_CHARS) || undefined;
      if (event.truncatedFiles !== undefined) {
        if (!isSafeNonNegativeInteger(event.truncatedFiles)) coverageMetadataContradiction = true;
        const markerSignature = `${event.truncatedFiles}\u0000${(event.coveragePaths ?? []).join("\u0000")}`;
        if (!markerSignatures.has(markerSignature)) {
          markerSignatures.add(markerSignature);
          if (!coverageSnapshot) {
            adapterMaxTruncatedFiles = Math.max(adapterMaxTruncatedFiles, event.truncatedFiles);
            adapterTruncationMarkers += 1;
          }
          // A marker is an adapter event-cap omission count.  It is exact
          // only when the bounded witness itself is complete or explicitly
          // capped at MAX_COVERAGE_PATHS.
          if (!coverageSnapshot && isSafeNonNegativeInteger(event.truncatedFiles) && event.coveragePaths !== undefined) {
            coverageExpectedCounts.push(MAX_ADAPTER_EVENTS + event.truncatedFiles);
            if (event.coveragePathsComplete === false && event.coveragePaths.length === MAX_COVERAGE_PATHS) coverageCapProof = true;
            else if (event.coveragePathsComplete !== true) coverageExpectedCountUnknown = true;
          }
        }
      }
      byPath.set(gitPath, {
        path,
        gitPath: gitDisplayPath,
        excerpt,
        ...(event.provenance === undefined ? {} : { provenance: event.provenance }),
      });
    }
    if (coverageSnapshot?.candidateCountExact === true && snapshotIdentitySet !== undefined) {
      const snapshotIdentities = snapshotIdentitySet;
      if (materializedEventIdentities.size > (coverageSnapshot.candidateCount ?? snapshotIdentities.size)
          || [...materializedEventIdentities].some((hash) => !snapshotIdentities.has(hash))) {
        coverageMetadataComplete = false;
        coverageMetadataContradiction = true;
      }
    }
    let rationaleEvent: Extract<(typeof events)[number], { kind: "rationale" }> | undefined;
    let rationaleText: string | undefined;
    for (const event of batchEvents) {
      if (event.kind !== "rationale") continue;
      const text = cleanText(event.text, MAX_RATIONALE_CHARS);
      if (text) {
        rationaleEvent = event;
        rationaleText = text;
      }
    }

    const intentText = intentEvent?.kind === "intent" ? cleanText(intentEvent.text, MAX_INTENT_CHARS) || undefined : undefined;

    const headRaw = runGit(git, ["rev-parse", "HEAD"], gitCwd);
    const head = headRaw === undefined ? undefined : cleanText(headRaw, MAX_HEAD_CHARS) || undefined;
    const baseline = intentEvent?.baseline;
    const baselineByPath = baselineMap(intentEvent, identityCwd, identityPlatform);
    const currentEntries = baselineByPath === undefined
      ? undefined
      : mergeDiffEntries([
        parseNumstatEntries(runGit(git, ["diff", "--numstat"], gitCwd), gitCwd, identityPlatform),
        parseNumstatEntries(runGit(git, ["diff", "--cached", "--numstat"], gitCwd), gitCwd, identityPlatform),
        parseUntrackedEntries(runGit(git, ["ls-files", "--others", "--exclude-standard"], gitCwd), gitCwd, identityPlatform),
      ], gitCwd, identityPlatform);
    // Legacy/manual batches may have no intent baseline at all.  Persist an
    // explicit unknown marker rather than making a current diff look proven.
    let baselineStatus: "captured" | "unknown" = baseline?.status ?? "unknown";
    if (baselineByPath !== undefined && (!baseline?.head || head === undefined)) baselineStatus = "unknown";
    if (baselineByPath !== undefined && currentEntries === undefined) baselineStatus = "unknown";
    if (spoolMayBeTruncated) baselineStatus = "unknown";
    const inferred = new Map<string, {
      path: string;
      gitPath?: string;
      plusMinus: [number, number];
      provenance: FileProvenance;
    }>();
    if (baselineByPath !== undefined && currentEntries !== undefined) {
      for (const entry of currentEntries) {
        const gitPath = pathIdentity(entry.path, identityCwd, identityPlatform);
        const prior = baselineByPath.get(gitPath);
        const delta: [number, number] | undefined = prior === undefined
          ? entry.plusMinus
          : (isSafeNonNegativeInteger(entry.plusMinus[0]) && isSafeNonNegativeInteger(entry.plusMinus[1]) &&
            isSafeNonNegativeInteger(prior[0]) && isSafeNonNegativeInteger(prior[1])
            ? [Math.max(0, entry.plusMinus[0] - prior[0]), Math.max(0, entry.plusMinus[1] - prior[1])]
            : undefined);
        const cleanPath = canonicalPath(cleanText(entry.path, MAX_PATH_CHARS), { platform: identityPlatform }) || cleanText(entry.path, MAX_PATH_CHARS);
        if (!cleanPath || !gitPath) continue;
        if (delta === undefined) {
          baselineStatus = "unknown";
          continue;
        }
        const observed = byPath.get(gitPath);
        if (observed) {
          // Tool evidence keeps its stronger provenance while the baseline
          // supplies the turn delta for plus/minus accounting.
          if (!entry.statsKnown) baselineStatus = "unknown";
          // Aggregate numstat is a repository total, not a turn ledger.  A
          // tool-observed path already dirty at baseline remains ambiguous,
          // including same-count and decreasing edits.
          if (prior !== undefined) baselineStatus = "unknown";
          // Aggregate numstat cannot prove a turn delta when an observed path
          // was already dirty by the same amount, or when its aggregate shrank.
          observed.plusMinus = delta;
          byPath.set(gitPath, observed);
          continue;
        }
        // A zero-stat path absent from baseline is still meaningful: it is
        // commonly a newly-created untracked file reported by ls-files.
        if (delta[0] === 0 && delta[1] === 0 && prior !== undefined) continue;
        // For a shell-only path that overlaps a dirty baseline, even a
        // positive aggregate delta may belong to unrelated work.
        if (prior !== undefined) baselineStatus = "unknown";
        if (!entry.statsKnown) baselineStatus = "unknown";
        inferred.set(gitPath, { path: cleanPath, gitPath: entry.path, plusMinus: delta, provenance: "git-diff-inferred" });
      }
    }
    // A commit can land between Stop and detached annotation. Compare the
    // baseline head to current head when both are known; do not claim a delta
    // when provenance is unavailable.
    if (baselineByPath !== undefined && baseline?.head && head && baseline.head !== head) {
      const committed = parseNumstatEntries(runGit(git, ["diff", "--numstat", `${baseline.head}..${head}`], gitCwd), gitCwd, identityPlatform);
      if (committed === undefined) baselineStatus = "unknown";
      for (const entry of committed ?? []) {
        const gitPath = pathIdentity(entry.path, identityCwd, identityPlatform);
        const cleanPath = canonicalPath(cleanText(entry.path, MAX_PATH_CHARS), { platform: identityPlatform }) || cleanText(entry.path, MAX_PATH_CHARS);
        if (!gitPath || !cleanPath) continue;
        const prior = baselineByPath.get(gitPath);
        const delta: [number, number] | undefined = prior === undefined
          ? entry.plusMinus
          : (isSafeNonNegativeInteger(entry.plusMinus[0]) && isSafeNonNegativeInteger(entry.plusMinus[1]) &&
            isSafeNonNegativeInteger(prior[0]) && isSafeNonNegativeInteger(prior[1])
            ? [Math.max(0, entry.plusMinus[0] - prior[0]), Math.max(0, entry.plusMinus[1] - prior[1])]
            : undefined);
        if (delta === undefined) {
          baselineStatus = "unknown";
          continue;
        }
        const observed = byPath.get(gitPath);
        if (observed) {
          if (!entry.statsKnown) baselineStatus = "unknown";
          if (prior !== undefined) baselineStatus = "unknown";
          const current = observed.plusMinus ?? [0, 0];
          const [added, addedOk] = safeCountSum(current[0], delta[0]);
          const [removed, removedOk] = safeCountSum(current[1], delta[1]);
          if (!addedOk || !removedOk) baselineStatus = "unknown";
          observed.plusMinus = [added, removed];
          byPath.set(gitPath, observed);
          continue;
        }
        const inferredValue = inferred.get(gitPath);
        if (inferredValue) {
          if (!entry.statsKnown) baselineStatus = "unknown";
          const [added, addedOk] = safeCountSum(inferredValue.plusMinus[0], delta[0]);
          const [removed, removedOk] = safeCountSum(inferredValue.plusMinus[1], delta[1]);
          if (!addedOk || !removedOk) baselineStatus = "unknown";
          inferredValue.plusMinus = [added, removed];
          inferred.set(gitPath, inferredValue);
          continue;
        }
        if (delta[0] === 0 && delta[1] === 0) continue;
        if (prior !== undefined) baselineStatus = "unknown";
        if (!entry.statsKnown) baselineStatus = "unknown";
        inferred.set(gitPath, { path: cleanPath, gitPath: entry.path, plusMinus: delta, provenance: "git-diff-inferred" });
      }
    }
    for (const [gitPath, value] of inferred) {
      byPath.set(gitPath, value);
    }
    // A complete adapter witness is stronger than the surviving individual
    // event appends. Materialize bounded, conservative tool-observed entries
    // for identities whose event append was lost so persisted files and the
    // counted coverage union cannot disagree.
    if (coverageMetadataSeen && coverageMetadataComplete && !coverageMetadataContradiction) {
      for (const [gitPath, path] of coverageCandidates) {
        if (!byPath.has(gitPath)) {
          byPath.set(gitPath, { path, plusMinus: [0, 0], provenance: "tool-observed" });
        }
      }
    }
    if (byPath.size === 0 && !(intentText !== undefined && rationaleText !== undefined) && !coverageSnapshot) {
      if (removeClaim(claim, paths)) removeClaimCoverage(claim, paths);
      return undefined;
    }
    const allMechanisms = coverageMetadataSeen && coverageMetadataComplete && !coverageMetadataContradiction
      ? [
        ...[...coverageCandidates.keys()].filter((gitPath) => byPath.has(gitPath)).map((gitPath) => [gitPath, byPath.get(gitPath)!] as const),
        ...[...byPath.entries()].filter(([gitPath]) => !coverageCandidates.has(gitPath)),
      ]
      : [...byPath.entries()];
    // Coverage identities are unioned before applying the durable eight-file
    // cap.  A count-only legacy marker can prove one adapter overflow, but
    // multiple markers may overlap, so those remain explicitly unknown.
    for (const [gitPath, value] of allMechanisms) {
      coverageCandidates.set(gitPath, value.path);
    }
    const distinctExpectedCounts = [...new Set(coverageExpectedCounts)];
    const expectedCountAmbiguous = distinctExpectedCounts.length > 1;
    const expectedCount = distinctExpectedCounts.length === 1 ? distinctExpectedCounts[0]! : undefined;
    const candidateCount = Math.max(coverageCandidates.size, expectedCount ?? 0,
      !coverageMetadataSeen && adapterTruncationMarkers === 1 ? MAX_ADAPTER_EVENTS + adapterMaxTruncatedFiles : 0);
    const boundedCountProof = !coverageExpectedCountUnknown
      && !expectedCountAmbiguous
      && (coverageCapProof || (coverageExpectedCounts.length > 0 && coverageMetadataComplete));
    const coverageUnknown = spoolMayBeTruncated
      || (allMechanisms.length === 0 && intentText !== undefined && rationaleText !== undefined)
      || (!coverageMetadataSeen && allMechanisms.length > 0)
      || coverageMetadataContradiction
      || (coverageMetadataSeen && !coverageMetadataComplete && !boundedCountProof)
      || coverageExpectedCountUnknown
      || expectedCountAmbiguous
      || (!coverageMetadataSeen && adapterTruncationMarkers > 0 && !boundedCountProof);
    const truncatedFiles = Math.max(0, candidateCount - MAX_TRIPLE_FILES);
    const coverageStatus = coverageUnknown
      ? "unknown" as const
      : truncatedFiles > 0
        ? "truncated" as const
        : "complete" as const;
    const files: TripleFile[] = allMechanisms.slice(0, MAX_TRIPLE_FILES).map(([gitPath, value]) => {
      const excerpt = value?.excerpt;
      const knownDelta = value.plusMinus;
      const gitPathForQuery = value.gitPath ?? value.path;
      const numstatRaw = knownDelta === undefined ? runGit(git, ["diff", "--numstat", "--", gitPathForQuery], gitCwd) : undefined;
      const numstat = knownDelta ?? parseNumstat(numstatRaw);
      if (knownDelta === undefined && numstat === undefined) baselineStatus = "unknown";
      const result: TripleFile = {
        path: value.path,
        plusMinus: numstat ?? [0, 0],
        props: propsFromExcerpt(excerpt),
        ...(excerpt === undefined ? {} : { excerpt }),
        ...(value.provenance === undefined ? {} : { provenance: value.provenance }),
        // Keep an opaque operational identity for every witness. Display paths
        // may be redacted (including cwd secrets); the discriminator lets a
        // durable reload/query recover the original absolute-vs-relative
        // identity without persisting raw operational text.
        identityHash: pathIdentityHash(gitPath, { platform: identityPlatform, canonical: true }),
      };
      rememberTripleFileIdentity(result, gitPath);
      return result;
    });

    let port = deps.ai;
    if (port === undefined) {
      try {
        const readConfig = deps.loadConfig ?? loadConfig;
        port = annotatePortFromConfig(readConfig(paths.config));
      } catch {
        port = undefined;
      }
    }

    let aiOutput: AnnotateOutput | undefined;
    if (port !== undefined) {
      try {
        const input = {
          ...(intentText === undefined ? {} : { intent: intentText }),
          ...(rationaleText === undefined ? {} : { rationaleRaw: rationaleText }),
          files: files.map((file) => file.excerpt === undefined
            ? { path: file.path }
            : { path: file.path, excerpt: file.excerpt }),
        };
        const output = await port.run(input, AbortSignal.timeout(15_000));
        aiOutput = parseAnnotateOutput(output);
      } catch {
        aiOutput = undefined;
      }
    }

    const rationale = rationaleEvent && rationaleText
      ? {
        text: cleanText(aiOutput?.summary ?? rationaleText, MAX_RATIONALE_CHARS),
        tags: (aiOutput === undefined ? [] : aiOutput.tags)
          .map((tag) => cleanText(tag, 80)).filter(Boolean).slice(0, 5),
        source: rationaleEvent.source,
      }
      : undefined;
    const now = deps.now?.();
    const ts = now !== undefined && Number.isFinite(now) ? now : undefined;
    const persisted = recordTripleOnce({
      ...(ts === undefined ? {} : { ts }),
      agent,
      cwd,
      ...(intentText === undefined ? {} : { intent: { text: intentText } }),
      ...(rationale === undefined ? {} : { rationale }),
      mechanism: {
        ...(head === undefined ? {} : { head }),
        files,
        truncatedFiles,
        coverageStatus,
        ...(baselineStatus === undefined ? {} : { baseline: baselineStatus }),
      },
    }, `${claim.key}:${claim.id}`, paths);
    deps.afterPersist?.(persisted.record, persisted.appended);

    if (persisted.appended) {
      const label = aiOutput?.label ?? degradedLabel(intentText, files);
      if (label) {
        try {
          const enqueue = deps.queueLabel ?? defaultQueueLabel;
          const safe = safeLabel(label);
          if (safe) enqueue(safe, paths);
        } catch {
          // A broken label queue cannot turn a successful append into a retry.
        }
      }
    }
    if (removeClaim(claim, paths)) removeClaimCoverage(claim, paths);
    return persisted.record;
  } finally {
    releaseAnnotationLease(lease, paths);
  }
}

export async function annotateCommand(key: string): Promise<number> {
  try {
    const paths = resolveRockyPaths();
    if (key) await annotateBatch(key, { paths });
    for (const claim of listOrphanClaims(Date.now(), paths)) {
      try {
        await annotateBatch(claim.key, { paths, claim });
      } catch {
        // One broken claim must not prevent the next eligible claim.
      }
    }
    for (const orphan of listOrphanBatches(Date.now(), paths)) {
      try { await annotateBatch(orphan, { paths }); } catch {
        // One broken orphan must not prevent the next eligible batch.
      }
    }
    maybeQueueDigestHint(paths);
  } catch {
    // Hidden detached command is never allowed to affect the shell.
  }
  return 0;
}
