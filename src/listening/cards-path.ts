import { join } from "node:path";
import { resolveRockyPaths } from "../core/state-paths.js";
import { repoSlug } from "./store-paths.js";

/**
 * Pure change-card log path for one canonical repository root.
 * Zero node:fs imports so read-side callers can reuse it without side effects.
 */
export function cardsFilePath(canonicalRoot: string, home?: string): string {
  return join(home ?? resolveRockyPaths().home, "desk", "cards", `${repoSlug(canonicalRoot)}.jsonl`);
}
