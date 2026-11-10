/**
 * Read-only repo-consent checks. This module is MCP-safe: it
 * imports only node:fs READ functions plus pure helpers. The write path
 * lives in consent.ts, which MCP must never import. See also
 * src/test/mcp-import-boundary.test.ts.
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { canonicalPath } from "../core/memory-read.js";
import { consentsPath } from "./store-paths.js";

/** Normalize a repo root for identity comparison. NOT a consent grant. */
export function normalizeRepoRoot(value: string): string {
  return canonicalPath(value);
}

/** Both stored answers. `false` is a remembered decline, not an absent key. */
function readRawConsents(home?: string): Record<string, boolean> {
  try {
    if (home !== undefined && !isAbsolute(home)) return {};
    const raw = readFileSync(consentsPath(home), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if ((value === true || value === false) && key.length > 0) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function readConsents(home?: string): Record<string, true> {
  const out: Record<string, true> = {};
  for (const [key, value] of Object.entries(readRawConsents(home))) {
    if (value) out[key] = true;
  }
  return out;
}

// Git itself treats the `.git`/`worktrees` spelling case-insensitively on
// Windows, and so does canonicalPath for every other root key here.
const SEGMENTS_CASE_INSENSITIVE = process.platform === "win32";

/**
 * Main repository root behind a linked worktree, or undefined. The `.git`
 * here is a file naming a gitdir inside `<main>/.git/worktrees/<name>`;
 * submodules (`<main>/.git/modules/<name>`) and junk name no main repo.
 * Parsed from disk because this module may never run Git.
 */
export function mainRepoRootOf(root: string): string | undefined {
  try {
    const entry = lstatSync(join(root, ".git"));
    if (!entry.isFile()) return undefined;
    const firstLine = (readFileSync(join(root, ".git"), "utf8").split("\n", 1)[0] ?? "").trim();
    const match = /^gitdir:\s*(.+)$/u.exec(firstLine);
    if (match === null) return undefined;
    const gitDir = match[1].trim();
    if (gitDir.length === 0) return undefined;
    const segments = (isAbsolute(gitDir) ? gitDir : resolve(root, gitDir)).replaceAll("\\", "/").split("/");
    const compared = SEGMENTS_CASE_INSENSITIVE ? segments.map((segment) => segment.toLowerCase()) : segments;
    for (let index = 0; index + 1 < compared.length; index += 1) {
      if (compared[index] !== ".git" || compared[index + 1] !== "worktrees") continue;
      const holder = segments.slice(0, index).join("/");
      if (holder.length === 0) return undefined;
      // Same spelling the caller would see for the main root; the folder can
      // be gone while the gitdir file survives, so fall back to the parsed path.
      try {
        return realpathSync.native(resolve(holder));
      } catch {
        return resolve(holder);
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** One repo's stored answer, reported against the root that owns the decision. */
export function readRepoDecision(
  root: string,
  home?: string,
): { key: string; main: string; decision: "allowed" | "declined" | "undecided" } {
  const main = mainRepoRootOf(root) ?? root;
  const key = normalizeRepoRoot(main);
  if (key.length === 0) return { key, main, decision: "undecided" };
  const raw = readRawConsents(home);
  // The collector allows capture through the root's own grant or the main
  // repo's, so status reports the same answer.
  const own = normalizeRepoRoot(root);
  if (own.length > 0 && raw[own] === true) return { key, main, decision: "allowed" };
  const value = raw[key];
  return { key, main, decision: value === true ? "allowed" : value === false ? "declined" : "undecided" };
}

/** Fail-closed: corrupt/missing store means no consent. A linked worktree
 *  inherits the main repository's grant, never a decline. */
export function isRepoCaptureAllowed(canonicalRoot: string, home?: string): boolean {
  const normalized = normalizeRepoRoot(canonicalRoot);
  if (normalized.length === 0) return false;
  const consents = readConsents(home);
  if (consents[normalized] === true) return true;
  const main = mainRepoRootOf(canonicalRoot);
  if (main === undefined) return false;
  const mainKey = normalizeRepoRoot(main);
  return mainKey.length > 0 && consents[mainKey] === true;
}

export function getRepoConsentDetail(
  canonicalRoot: string,
  home?: string,
): { allowed: boolean; root: string } {
  const root = normalizeRepoRoot(canonicalRoot);
  if (root.length === 0) return { allowed: false, root: "" };
  // A worktree is allowed through its main repo's key, so the check command
  // and the GUI card must report the same decision the collector obeys.
  return { allowed: isRepoCaptureAllowed(canonicalRoot, home), root };
}
/** Read-only list of canonical roots with capture consent. Listing names
 *  grants nothing and starts no capture: it only lets the GUI suggest. */
export function listConsentedRepos(home?: string): string[] {
  return Object.keys(readConsents(home));
}

export function consentStoreExists(home?: string): boolean {
  try {
    return existsSync(consentsPath(home));
  } catch {
    return false;
  }
}
