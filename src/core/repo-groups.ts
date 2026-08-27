/**
 * Which repo a heard file belongs to. Memory hears files from every cwd, so
 * the answer cannot come from the launch root: it walks up from the file
 * until a directory carries a `.git` (a directory, or the file a worktree
 * points through), and the nearest one wins. A file with no `.git` ancestor
 * is non-repo. Results cache per directory -- a dash holds many files of the
 * same few repos.
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";

export type RepoCache = Map<string, string | null>;

async function hasGit(dir: string): Promise<boolean> {
  try {
    await stat(join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

export async function repoForPath(filePath: string, cache: RepoCache = new Map()): Promise<string | null> {
  const norm = filePath.replace(/\\/g, "/");
  const visited: string[] = [];
  // start from the containing directory, and stop before the drive/root
  let dir = norm.includes("/") ? norm.slice(0, norm.lastIndexOf("/")) : "";
  while (dir.includes("/")) {
    if (cache.has(dir)) {
      const hit = cache.get(dir) ?? null;
      for (const d of visited) cache.set(d, hit);
      return hit;
    }
    visited.push(dir);
    if (await hasGit(dir)) {
      const name = dir.slice(dir.lastIndexOf("/") + 1);
      for (const d of visited) cache.set(d, name);
      return name;
    }
    dir = dir.slice(0, dir.lastIndexOf("/"));
  }
  for (const d of visited) cache.set(d, null);
  return null;
}
