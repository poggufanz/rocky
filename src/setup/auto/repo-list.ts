/**
 * Read-only repo listing for `rocky setup --auto repo list --json`: every
 * repo with a stored capture decision, its store size and its linked worktrees.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { listAllRepoDecisions, mainRepoRootOf, normalizeRepoRoot } from "../../listening/repo-consent-read.js";
import { repoDir } from "../../listening/store-paths.js";

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BYTES = 2 * 1024 * 1024;
const WORKTREE_PREFIX = "worktree ";

export interface WorktreeEntry {
  root: string;
  bytes: number;
  exists: boolean;
}

export interface RepoListEntry {
  key: string;
  main: string;
  name: string;
  decision: "allowed" | "declined";
  bytes: number;
  worktrees: WorktreeEntry[];
}

/** Total file size under a directory; 0 when it is missing or unreadable. */
function directoryBytes(dir: string): number {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += directoryBytes(full);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      total += statSync(full).size;
    } catch {
      // A file removed mid-walk adds nothing.
    }
  }
  return total;
}

/** Linked worktree roots of a main repo, main excluded; any Git failure is `[]`. */
function linkedWorktreeRoots(main: string): string[] {
  try {
    const result = spawnSync("git", ["-C", main, "worktree", "list", "--porcelain"], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      maxBuffer: GIT_MAX_BYTES,
      timeout: GIT_TIMEOUT_MS,
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
    if (result.error !== undefined || result.status !== 0 || typeof result.stdout !== "string") return [];
    const mainKey = normalizeRepoRoot(main);
    return result.stdout
      .split(/\r?\n/u)
      .filter((line) => line.startsWith(WORKTREE_PREFIX))
      .map((line) => line.slice(WORKTREE_PREFIX.length).trim())
      .filter((root) => root.length > 0 && normalizeRepoRoot(root) !== mainKey);
  } catch {
    return [];
  }
}

export function listRepos(home: string): RepoListEntry[] {
  const decisions = listAllRepoDecisions(home);
  const entries: RepoListEntry[] = [];
  for (const [key, allowed] of decisions) {
    // A worktree whose own key is stored is shown under its main repo.
    const owner = mainRepoRootOf(key);
    if (owner !== undefined && decisions.has(normalizeRepoRoot(owner))) continue;
    entries.push({
      key,
      main: key,
      name: basename(key),
      decision: allowed ? "allowed" : "declined",
      bytes: directoryBytes(repoDir(key, home)),
      worktrees: linkedWorktreeRoots(key).map((root) => ({
        root,
        bytes: directoryBytes(repoDir(root, home)),
        exists: existsSync(root),
      })),
    });
  }
  return entries;
}
