/**
 * Write-only repo-consent grants. The read side lives
 * in repo-consent-read.ts, which MCP may import. This module MCP must
 * never import: it mutates the consent store. GUI Add/Revoke and the setup
 * CLI share this backend; opening or selecting a repo never grants.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { isPathInside } from "../desk/cards-record.js";
import { resolveRockyPaths } from "../core/state-paths.js";
import { canonicalPath } from "../core/memory-read.js";
import { cardsFilePath } from "./cards-path.js";
import { scrubRepoCards } from "./cards-scrub.js";
import { consentsPath, listeningHome, repoDir } from "./store-paths.js";
import { listAllRepoDecisions, mainRepoRootOf, normalizeRepoRoot, readRepoDecision } from "./repo-consent-read.js";
import { purgeListeningStore } from "./event-log.js";

function isGitRoot(canonicalRoot: string): boolean {
  try {
    const gitDir = lstatSync(join(canonicalRoot, ".git"));
    if (gitDir.isSymbolicLink()) return false;
    if (!gitDir.isDirectory() && !gitDir.isFile()) return false;
  } catch {
    return false;
  }
  // A .git is only a root when Git itself reads it as one. A stub Git cannot
  // read used to pass, and capture then walked the folder wholesale; a stray
  // .git inside a repo names a subfolder, never a root.
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: canonicalRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
      windowsHide: true,
    }).trim();
    // .native on both sides: the JS realpath keeps 8.3 short names
    // (C:\Users\RUNNER~1) while Git reports the long one, so a real root failed.
    return top.length > 0 && canonicalPath(realpathSync.native(top)) === canonicalPath(realpathSync.native(canonicalRoot));
  } catch {
    return false;
  }
}

/**
 * Grant or revoke capture for one canonical Git root. `yes` is the explicit
 * consent switch: without it the call reports requires-confirmation and
 * writes nothing. Revoke stops future capture; history stays on disk.
 * `onRevoke: "delete"` forgets the repo, while `"decline"` remembers the
 * refusal as `false` so a later grant of another repo cannot erase it.
 */
export function setRepoCapture(
  canonicalRoot: string,
  allow: boolean,
  opts: { yes: boolean; actor: "cli" | "gui" | "desk"; onRevoke: "delete" | "decline" },
  home?: string,
): { ok: boolean; root?: string; reason?: string } {
  if (opts.yes !== true) return { ok: false, reason: "requires-confirmation" };
  if (typeof canonicalRoot !== "string" || !isAbsolute(canonicalRoot)) {
    return { ok: false, reason: "path-must-be-absolute" };
  }
  // Only a grant needs a live, real Git root. A revoke must still clear a
  // consent whose folder moved, vanished, or lost its .git.
  let real: string;
  try {
    real = realpathSync(canonicalRoot);
  } catch {
    if (allow) return { ok: false, reason: "path-unresolvable" };
    real = canonicalRoot;
  }
  if (allow) {
    try {
      if (lstatSync(canonicalRoot).isSymbolicLink()) return { ok: false, reason: "symlink-rejected" };
    } catch {
      return { ok: false, reason: "path-unresolvable" };
    }
  }
  const root = canonicalPath(real);
  if (root.length === 0) return { ok: false, reason: "path-unresolvable" };
  if (allow && !isGitRoot(real)) return { ok: false, reason: "not-a-git-root" };
  let current: Record<string, unknown> = {};
  try {
    const raw = readFileSync(consentsPath(home), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      current = parsed as Record<string, unknown>;
    }
  } catch {
    current = {};
  }
  const next: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(current)) {
    if ((value === true || value === false) && key.length > 0) next[normalizeRepoRoot(key)] = value;
  }
  // A linked worktree has no decision of its own: the main repo's key is what
  // lets capture run. Revoking here must clear that key too, or capture keeps
  // running through the inherited grant and purge never passes revoke-first.
  const decisionRoot = allow ? root : normalizeRepoRoot(mainRepoRootOf(real) ?? root);
  if (allow) {
    next[root] = true;
  } else if (opts.onRevoke === "decline") {
    next[root] = false;
    next[decisionRoot] = false;
  } else {
    delete next[root];
    delete next[decisionRoot];
  }
  void opts.actor;
  try {
    mkdirSync(listeningHome(home), { recursive: true, mode: 0o700 });
    const tmp = join(listeningHome(home), `repo-consents.${process.pid}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, consentsPath(home));
  } catch {
    return { ok: false, reason: "store-unavailable" };
  }
  return { ok: true, root: decisionRoot };
}

/**
 * Unlink one repo's change card file if present; missing files count as zero
 * freed bytes and any other failure reports an unremovable path.
 */
function deleteCardsFile(path: string): { ok: true; freedBytes: number } | { ok: false } {
  try {
    const stats = lstatSync(path);
    const size = stats.isFile() && !stats.isSymbolicLink() ? stats.size : 0;
    unlinkSync(path);
    return { ok: true, freedBytes: size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, freedBytes: 0 };
    return { ok: false };
  }
}

export type CardsScrubSkipped = "unsafe-root" | "unknown-repo";

/** A filesystem root, drive root (`X:/`) or UNC host or share root. */
function isFilesystemRoot(path: string): boolean {
  const trimmed = path.replace(/\\/g, "/").replace(/\/+$/, "");
  if (trimmed === "") return true;
  if (/^[a-z]:$/i.test(trimmed)) return true;
  return /^\/\/[^/]+(\/[^/]+)?$/.test(trimmed);
}

function realOrSelf(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/** True when the path is a root, or equals or contains the OS home or the Rocky home. */
function isUnsafeScrubRoot(spellings: readonly string[], rockyHome: string, userHome: string): boolean {
  const homes = [...new Set([userHome, rockyHome, realOrSelf(userHome), realOrSelf(rockyHome)])];
  return spellings.some(
    (spelling) => isFilesystemRoot(spelling) || homes.some((home) => isPathInside(home, spelling)),
  );
}

function hasGitEntry(root: string): boolean {
  try {
    lstatSync(join(root, ".git"));
    return true;
  } catch {
    return false;
  }
}

/** Rocky knew the repo when it holds a consent decision, its own cards or store, or the path is a Git root now. */
function repoWasKnown(target: string, spellings: readonly string[], home: string | undefined): boolean {
  const decisions = listAllRepoDecisions(home);
  for (const spelling of spellings) {
    if (decisions.has(spelling) || readRepoDecision(spelling, home).decision !== "undecided") return true;
    if (existsSync(cardsFilePath(spelling, home)) || existsSync(repoDir(spelling, home))) return true;
  }
  return hasGitEntry(realOrSelf(target));
}

/**
 * Stop capture and delete one repo's Listening history and change cards; the
 * setup CLI and the GUI share it. Revoke always runs first (idempotent, and it
 * clears a key stored under the realpath spelling), so no writer starts again.
 * The target's own store and card file are deleted under both the typed and
 * the realpath spelling, which can hash to different names; a worktree keeps
 * its own history and cards even when the revoke names its main repo.
 *
 * Other repos' card logs are scrubbed only for a path Rocky knew as a repo and
 * that is not a root or a parent of a home folder; the scrub decision is made
 * before the revoke because the revoke erases the consent key.
 */
export function purgeRepoCapture(
  target: string,
  opts: { yes: boolean; actor: "cli" | "gui" | "desk"; onRevoke: "delete" | "decline" },
  home?: string,
  env: { userHome?: string } = {},
): {
  ok: boolean;
  freedBytes: number;
  root?: string;
  reason?: string;
  cardsIncomplete?: string[];
  cardsScrubSkipped?: CardsScrubSkipped;
} {
  if (opts.yes !== true) return { ok: false, freedBytes: 0, reason: "requires-confirmation" };
  const typed = normalizeRepoRoot(target);
  if (typed.length === 0) return { ok: false, freedBytes: 0, reason: "path-unresolvable" };
  let own = typed;
  try {
    own = canonicalPath(realpathSync(target));
  } catch {
    own = typed;
  }
  const spellings = [...new Set([typed, own])];
  const rockyHome = home ?? resolveRockyPaths().home;
  const userHome = env.userHome ?? homedir();
  const skipped: CardsScrubSkipped | undefined = isUnsafeScrubRoot(spellings, rockyHome, userHome)
    ? "unsafe-root"
    : repoWasKnown(target, spellings, home)
      ? undefined
      : "unknown-repo";
  const revoked = setRepoCapture(target, false, opts, home);
  if (!revoked.ok) return { ok: false, freedBytes: 0, reason: revoked.reason };
  const root = revoked.root ?? typed;
  let freedBytes = 0;
  for (const spelling of spellings) {
    const purged = purgeListeningStore(spelling, home);
    if (!purged.ok) return { ok: false, freedBytes, reason: purged.reason };
    freedBytes += purged.freedBytes;
  }
  for (const spelling of spellings) {
    const removed = deleteCardsFile(cardsFilePath(spelling, home));
    if (!removed.ok) return { ok: false, freedBytes, reason: "cards-delete-failed" };
    freedBytes += removed.freedBytes;
  }
  if (skipped !== undefined) return { ok: true, freedBytes, root, cardsScrubSkipped: skipped };
  const scrubbed = scrubCardsAcrossLogs(spellings, home, env.userHome);
  freedBytes += scrubbed.freedBytes;
  return scrubbed.incomplete.length > 0
    ? { ok: true, freedBytes, root, cardsIncomplete: scrubbed.incomplete }
    : { ok: true, freedBytes, root };
}

/**
 * Remove this repo's change cards from every other card log. A failure never
 * undoes the purge: the repo's own data is already gone, so the caller gets
 * the logs that still need another pass.
 */
function scrubCardsAcrossLogs(
  spellings: string[],
  home: string | undefined,
  userHome: string | undefined,
): { freedBytes: number; incomplete: string[] } {
  try {
    const scrubbed = scrubRepoCards(spellings, {
      ...(home === undefined ? {} : { rockyHome: home }),
      ...(userHome === undefined ? {} : { userHome }),
    });
    if (!scrubbed.ok && scrubbed.incomplete.length === 0) {
      return { freedBytes: scrubbed.freedBytes, incomplete: [dirname(cardsFilePath(spellings[0] ?? "", home))] };
    }
    return { freedBytes: scrubbed.freedBytes, incomplete: scrubbed.incomplete };
  } catch {
    return { freedBytes: 0, incomplete: [dirname(cardsFilePath(spellings[0] ?? "", home))] };
  }
}
