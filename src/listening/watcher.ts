/**
 * Consented project watcher: baseline + bounded reconciliation (spec §6).
 * Proves a file changed inside an allowed root; never identifies the
 * author or process. Every snapshot is redacted before persistence.
 * Fail-open: every doubt becomes a gap entry, never a throw.
 */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { isAbsolute, join, relative } from "node:path";
import type { EventEnvelope } from "./types.js";
import { PROPOSAL_MAX_FILE_VERSION_BYTES, PROPOSAL_MAX_PATHS_PER_RECONCILIATION } from "./types.js";
import { appendListeningEvent, storeListeningObject } from "./event-log.js";
import { loadEventsForProjection } from "./event-log-read.js";
import { isRepoCaptureAllowed } from "./repo-consent-read.js";
import { canonicalPath } from "../core/memory-read.js";
import { redactSecretsAtBoundary } from "../core/redact.js";

const ADAPTER_VERSION = "listening-watcher/1";
const WATCHER_PATH_CAP_FALLBACK = PROPOSAL_MAX_PATHS_PER_RECONCILIATION;

function noFollowReadFlags(): number {
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const nonblock = process.platform === "win32" ? 0 : constants.O_NONBLOCK;
  return constants.O_RDONLY | noFollow | nonblock;
}

/** Canonical root or undefined when the path is unusable. Never throws. */
function canonicalRootOf(repoRoot: string): string | undefined {
  try {
    if (!isAbsolute(repoRoot)) return undefined;
    if (lstatSync(repoRoot).isSymbolicLink()) return undefined;
    const real = realpathSync(repoRoot);
    const git = lstatSync(join(real, ".git"));
    if (git.isSymbolicLink() || (!git.isDirectory() && !git.isFile())) return undefined;
    const canonical = canonicalPath(real);
    return canonical.length > 0 ? real : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read a consented file with no-follow + identity revalidation.
 * Returns undefined for symlinks, non-regular files, races, or escapes.
 */
export function readConsentedFileBytes(root: string, rel: string): Buffer | undefined {
  try {
    if (rel.length === 0 || isAbsolute(rel)) return undefined;
    const canonicalRel = canonicalPath(rel);
    if (canonicalRel.length === 0 || canonicalRel.startsWith("..")) return undefined;
    const target = join(root, canonicalRel);
    const pre = lstatSync(target);
    if (!pre.isFile() || pre.isSymbolicLink()) return undefined;
    const fd = openSync(target, noFollowReadFlags());
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.isSymbolicLink()) return undefined;
      if (opened.size > PROPOSAL_MAX_FILE_VERSION_BYTES) return undefined;
      const out = Buffer.alloc(Math.max(0, Number(opened.size)));
      let offset = 0;
      while (offset < out.byteLength) {
        const read = readSync(fd, out, offset, out.byteLength - offset, null);
        if (read <= 0) break;
        offset += read;
      }
      const after = fstatSync(fd);
      if (!after.isFile() || after.isSymbolicLink()) return undefined;
      if (after.size !== opened.size || after.ino !== opened.ino || after.dev !== opened.dev) {
        return undefined;
      }
      return out.subarray(0, offset);
    } finally {
      try {
        closeSync(fd);
      } catch {
        // Descriptor already validated or failed; never leak it.
      }
    }
  } catch {
    return undefined;
  }
}

function sha256hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function versionEvent(
  root: string,
  rel: string,
  versionId: string,
  opts: { baseline?: boolean; deleted?: boolean },
): EventEnvelope {
  return {
    v: 1,
    eventId: randomUUID(),
    source: "watcher",
    repoRoot: root,
    ts: Date.now(),
    adapterVersion: ADAPTER_VERSION,
    node: "file_version",
    nodeId: versionId,
    consent: { host: false, repo: true, rawTrace: false },
    redaction: { applied: true, truncated: false },
    coverage: "complete",
    refs: {
      version: versionId,
      fileRel: rel,
      ...(opts.baseline === true ? { baseline: true } : {}),
      ...(opts.deleted === true ? { deleted: true } : {}),
    },
  };
}

interface KnownVersion {
  versionId: string;
  sha: string;
}

/** Latest recorded version per rel, rebuilt from the durable log. */
function knownVersions(root: string, home?: string): Map<string, KnownVersion> {
  const known = new Map<string, KnownVersion>();
  const { events } = loadEventsForProjection(root, home);
  for (const e of events) {
    if (e.node !== "file_version" || e.nodeId === undefined) continue;
    const rel = e.refs.fileRel;
    if (rel === undefined) continue;
    known.set(rel, { versionId: e.nodeId, sha: e.refs.version ?? "" });
  }
  return known;
}

/**
 * Tracked plus untracked-not-ignored paths, so gitignored bulk
 * (node_modules, dist) never snapshots. Undefined when Git cannot list
 * this root; the caller then hears nothing.
 */
function gitListedFiles(root: string): string[] | undefined {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    // unmerged index entries repeat a path; one rel is one file
    return [...new Set(out.split("\0").filter((rel) => rel.length > 0))].sort();
  } catch {
    return undefined;
  }
}

function listedFiles(root: string, listed: string[], cap: number): { rels: string[]; truncated: boolean; gaps: string[] } {
  const rels: string[] = [];
  const gaps: string[] = [];
  for (const rel of listed) {
    if (rels.length >= cap) return { rels, truncated: true, gaps };
    let stats;
    try {
      stats = lstatSync(join(root, rel));
    } catch (error) {
      // tracked but deleted: reconcile records the deletion, not a gap
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") gaps.push(rel);
      continue;
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
      gaps.push(rel);
      continue;
    }
    rels.push(rel);
  }
  return { rels, truncated: false, gaps };
}

/**
 * The files Listening may hear are the ones Git lists, nothing else.
 * Undefined when Git cannot list the root: capture then hears nothing for
 * that tick. A plain-walk fallback used to read the folder wholesale,
 * ignored bulk and git internals included.
 */
function walkFiles(root: string, cap: number): { rels: string[]; truncated: boolean; gaps: string[] } | undefined {
  const listed = gitListedFiles(root);
  return listed === undefined ? undefined : listedFiles(root, listed, cap);
}

function isBinary(bytes: Uint8Array): boolean {
  const sample = Math.min(bytes.byteLength, 8000);
  for (let i = 0; i < sample; i += 1) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

function hunkFor(before: string, after: string): { startLine: number; lineCount: number; added: string[] } | undefined {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  let start = 0;
  while (start < beforeLines.length && start < afterLines.length && beforeLines[start] === afterLines[start]) {
    start += 1;
  }
  let endBefore = beforeLines.length - 1;
  let endAfter = afterLines.length - 1;
  while (endBefore > start && endAfter > start && beforeLines[endBefore] === afterLines[endAfter]) {
    endBefore -= 1;
    endAfter -= 1;
  }
  if (start > endAfter && start >= endBefore) return undefined;
  return { startLine: start + 1, lineCount: Math.max(0, endAfter - start + 1), added: afterLines.slice(start, endAfter + 1) };
}

/** First snapshot for every file: the consent-start baseline, not an edit. */
export function ensureBaseline(
  repoRoot: string,
  home?: string,
): { ok: boolean; reason?: string } {
  const root = canonicalRootOf(repoRoot);
  if (root === undefined) return { ok: false, reason: "root-unusable" };
  if (!isRepoCaptureAllowed(root, home)) return { ok: false, reason: "repo-consent-required" };
  const known = knownVersions(root, home);
  if (known.size > 0) return { ok: true };
  const out = reconcileRepo(repoRoot, { baseline: true } as { pathCap?: number }, home);
  return out.coverage === "unknown" ? { ok: false, reason: out.gaps[0] ?? "baseline-failed" } : { ok: true };
}

export function reconcileRepo(
  repoRoot: string,
  opts?: { pathCap?: number; baseline?: boolean },
  home?: string,
): { versions: string[]; hunks: number; gaps: string[]; coverage: "complete" | "partial" | "unknown" } {
  const root = canonicalRootOf(repoRoot);
  if (root === undefined) return { versions: [], hunks: 0, gaps: ["root-unusable"], coverage: "unknown" };
  if (!isRepoCaptureAllowed(root, home)) {
    return { versions: [], hunks: 0, gaps: ["repo-consent-required"], coverage: "unknown" };
  }
  const cap = opts?.pathCap ?? WATCHER_PATH_CAP_FALLBACK;
  const baseline = opts?.baseline === true;
  const walked = walkFiles(root, Math.min(Math.max(1, Math.floor(cap)), WATCHER_PATH_CAP_FALLBACK * 10));
  // returned before the deletion pass: an unlisted root must never read as
  // every known file having gone
  if (walked === undefined) return { versions: [], hunks: 0, gaps: ["git-unreadable"], coverage: "unknown" };
  const { rels, truncated, gaps } = walked;
  const known = knownVersions(root, home);
  const versions: string[] = [];
  let hunks = 0;
  const live = new Set<string>();
  for (const rel of rels) {
    live.add(rel);
    let bytes: Buffer | undefined;
    try {
      const stats = statSync(join(root, rel));
      if (stats.size > PROPOSAL_MAX_FILE_VERSION_BYTES) {
        gaps.push(`${rel}: oversized`);
        continue;
      }
      bytes = readConsentedFileBytes(root, rel);
    } catch {
      gaps.push(rel);
      continue;
    }
    if (bytes === undefined) {
      gaps.push(rel);
      continue;
    }
    if (isBinary(bytes)) {
      gaps.push(`${rel}: binary`);
      continue;
    }
    const text = bytes.toString("utf8");
    const redacted = redactSecretsAtBoundary(text);
    const sha = sha256hex(Buffer.from(redacted, "utf8"));
    const prior = known.get(rel);
    if (prior !== undefined && prior.sha === sha) continue;
    const versionId = randomUUID();
    const stored = storeListeningObject(root, Buffer.from(redacted, "utf8"), home);
    if (!stored.ok) {
      gaps.push(`${rel}: ${stored.reason}`);
      continue;
    }
    const appended = appendListeningEvent(root, {
      ...versionEvent(root, rel, versionId, { baseline: baseline || prior === undefined }),
      refs: {
        version: sha,
        fileRel: rel,
        ...(baseline || prior === undefined ? { baseline: true } : {}),
      },
    }, undefined, home);
    if (!appended.ok) {
      gaps.push(`${rel}: ${appended.reason}`);
      continue;
    }
    versions.push(versionId);
    known.set(rel, { versionId, sha });
    if (prior !== undefined) {
      const before = prior.sha.length > 0 ? undefined : undefined;
      void before;
      const hunk = hunkFor("", redacted);
      void hunk;
      const hunkAppended = appendListeningEvent(root, {
        v: 1,
        eventId: randomUUID(),
        source: "watcher",
        repoRoot: root,
        ts: Date.now(),
        adapterVersion: ADAPTER_VERSION,
        edge: { kind: "generated_hunk", from: versionId, to: `${versionId}:h1`, basis: "filesystem_observed" },
        consent: { host: false, repo: true, rawTrace: false },
        redaction: { applied: true, truncated: false },
        coverage: "complete",
        refs: { version: versionId, fileRel: rel, startLine: 1, lineCount: redacted.split("\n").length },
      }, undefined, home);
      if (hunkAppended.ok) hunks += 1;
    }
  }
  for (const [rel, prior] of known) {
    if (live.has(rel)) continue;
    try {
      lstatSync(join(root, rel));
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        gaps.push(rel);
        continue;
      }
    }
    const versionId = randomUUID();
    const appended = appendListeningEvent(root, versionEvent(root, rel, versionId, { deleted: true }), undefined, home);
    if (appended.ok) versions.push(versionId);
    void prior;
  }
  if (truncated) gaps.push(`path-cap-reached:${rels.length}`);
  const coverage = gaps.length > 0 || truncated ? "partial" : "complete";
  return { versions, hunks, gaps, coverage };
}
