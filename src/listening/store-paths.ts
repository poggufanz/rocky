import { createHash } from "node:crypto";
import { join } from "node:path";
import { resolveRockyPaths } from "../core/state-paths.js";

/**
 * Pure listening store-path derivation (spec §7). Zero node:fs imports:
 * computing a path never touches the disk. eviction/compaction lives in
 * event-log.ts; reads live in event-log-read.ts.
 */

export function listeningHome(home?: string): string {
  if (home !== undefined) return join(home, "listening");
  return join(resolveRockyPaths().home, "listening");
}

/** Stable per-repo directory name. Hash, never the raw root (no traversal). */
export function repoSlug(canonicalRoot: string): string {
  return createHash("sha256").update(canonicalRoot, "utf8").digest("hex").slice(0, 32);
}

export function repoDir(canonicalRoot: string, home?: string): string {
  return join(listeningHome(home), "repos", repoSlug(canonicalRoot));
}

export function eventsPath(canonicalRoot: string, home?: string): string {
  return join(repoDir(canonicalRoot, home), "events.jsonl");
}

export function objectsDir(canonicalRoot: string, home?: string): string {
  return join(repoDir(canonicalRoot, home), "objects");
}

export function collectorPath(canonicalRoot: string, home?: string): string {
  return join(repoDir(canonicalRoot, home), "collector.json");
}

export function hostEventsPath(harnessId: string, home?: string): string {
  const safe = harnessId.replace(/[^a-z0-9-]/g, "");
  return join(listeningHome(home), "hosts", `${safe}.jsonl`);
}

export function consentsPath(home?: string): string {
  return join(listeningHome(home), "repo-consents.json");
}
