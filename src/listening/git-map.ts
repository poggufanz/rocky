/**
 * Exact Git mapping lane (spec §6). Maps file_version / diff_hunk to a
 * commit only when path + content + revision match exactly. Anything else
 * — rebase, rename, squash, missing baseline, redaction mismatch — is
 * unknown, with a bounded temporal candidate offered separately.
 * Fail-open: git failures yield unknown, never throw.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { FileVersionObject } from "./types.js";
import { canonicalPath } from "../core/memory-read.js";
import { readConsentedFileBytes } from "./watcher.js";

const GIT_TIMEOUT_MS = 5000;
const GIT_MAX_BYTES = 2 * 1024 * 1024;

function runGit(
  args: readonly string[],
  cwd: string,
): { code: number; stdout: Buffer } {
  try {
    const result = spawnSync("git", [...args], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "buffer",
      maxBuffer: GIT_MAX_BYTES,
      timeout: GIT_TIMEOUT_MS,
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
      cwd,
    });
    const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from([]);
    if (result.error !== undefined) return { code: 1, stdout: Buffer.from([]) };
    return { code: result.status ?? 1, stdout };
  } catch {
    return { code: 1, stdout: Buffer.from([]) };
  }
}

function safeRel(rel: string): string | undefined {
  if (typeof rel !== "string" || rel.length === 0 || isAbsolute(rel)) return undefined;
  const canonical = canonicalPath(rel);
  if (canonical.length === 0 || canonical === "." || canonical.startsWith("..")) return undefined;
  return canonical;
}

function isHex40(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** HEAD sha, or undefined when git is unavailable / outside a repo. */
export function headCommit(root: string): string | undefined {
  const parsed = runGit(["rev-parse", "HEAD"], root);
  if (parsed.code !== 0) return undefined;
  const sha = parsed.stdout.toString("utf8").trim();
  return isHex40(sha) ? sha : undefined;
}

/** Exact committed bytes for root:rel at HEAD. Undefined on any failure. */
export function committedBytes(root: string, rel: string): Buffer | undefined {
  const safe = safeRel(rel);
  if (safe === undefined) return undefined;
  const parsed = runGit(["show", `HEAD:${safe}`], root);
  if (parsed.code !== 0) return undefined;
  return parsed.stdout;
}

/**
 * Map a stored file version to HEAD only when the committed bytes hash
 * equals the version hash exactly. A redacted version (bytes altered by
 * redaction) can never match: that is unknown by design, never fuzzy.
 */
export function mapVersionToCommit(
  v: FileVersionObject,
  opts: { root: string },
): { basis: "content_mapped" | "unknown"; commit?: string; reason: string } {
  const safe = safeRel(v.rel);
  if (safe === undefined) return { basis: "unknown", reason: "bad-rel" };
  if (typeof opts.root !== "string" || opts.root.length === 0) return { basis: "unknown", reason: "bad-root" };
  if (v.redacted) {
    const committed = committedBytes(opts.root, safe);
    if (committed === undefined) return { basis: "unknown", reason: "git-unavailable" };
    const committedSha = createHash("sha256").update(committed).digest("hex");
    if (committedSha !== v.sha256) return { basis: "unknown", reason: "redaction-mismatch" };
  }
  const committed = committedBytes(opts.root, safe);
  if (committed === undefined) return { basis: "unknown", reason: "not-committed" };
  const committedSha = createHash("sha256").update(committed).digest("hex");
  if (committedSha !== v.sha256) return { basis: "unknown", reason: "content-differs" };
  const head = headCommit(opts.root);
  if (head === undefined) return { basis: "unknown", reason: "git-unavailable" };
  return { basis: "content_mapped", commit: head, reason: "exact" };
}

/**
 * Map a hunk's added lines to HEAD only when they appear verbatim in the
 * committed blob. Otherwise unknown; callers may surface a separate
 * bounded temporal candidate, never a promoted mapping.
 */
export function mapHunkToCommit(
  hunkId: string,
  opts: { root: string; rel: string; addedLines: string[]; versionCommit?: string },
): { basis: "content_mapped" | "candidate_link" | "unknown"; commit?: string; reason: string } {
  if (typeof hunkId !== "string" || hunkId.length === 0) return { basis: "unknown", reason: "bad-hunk-id" };
  const safe = safeRel(opts.rel);
  if (safe === undefined) return { basis: "unknown", reason: "bad-rel" };
  const added = opts.addedLines.filter((line) => line.length > 0);
  if (added.length === 0) return { basis: "unknown", reason: "empty-hunk" };
  if (opts.versionCommit !== undefined && !/^[0-9a-f]{4,128}$/.test(opts.versionCommit)) {
    return { basis: "unknown", reason: "bad-version-commit" };
  }
  const committed = committedBytes(opts.root, safe);
  if (committed === undefined) {
    const live = readConsentedFileBytes(opts.root, safe);
    if (live === undefined) return { basis: "unknown", reason: "not-committed" };
    const text = live.toString("utf8");
    const exact = added.every((line) => text.includes(line));
    if (!exact) return { basis: "unknown", reason: "content-differs" };
    return { basis: "candidate_link", reason: "uncommitted-exact-live" };
  }
  const text = committed.toString("utf8");
  const exact = added.every((line) => text.includes(line));
  if (!exact) return { basis: "unknown", reason: "content-differs" };
  const head = headCommit(opts.root);
  if (head === undefined) return { basis: "unknown", reason: "git-unavailable" };
  if (opts.versionCommit !== undefined && !head.startsWith(opts.versionCommit) && head !== opts.versionCommit) {
    return { basis: "candidate_link", commit: head, reason: "revision-differs" };
  }
  return { basis: "content_mapped", commit: head, reason: "exact" };
}

/** Read a fixture file for tests without importing node:fs there. */
export function readRepoFile(root: string, rel: string): Buffer | undefined {
  try {
    const safe = safeRel(rel);
    if (safe === undefined) return undefined;
    return readFileSync(join(root, safe));
  } catch {
    return undefined;
  }
}
