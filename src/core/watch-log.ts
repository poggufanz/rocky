/**
 * Retained stderr-tail log for `rocky watch`. One file per watched command
 * run, written with owner-only permissions and pruned to the newest
 * WATCH_LOG_RETENTION files. Never a source of truth for fingerprinting —
 * best-effort disk evidence only, so every entry point here swallows its own
 * errors rather than throwing.
 */

import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

export const WATCH_LOG_RETENTION = 20;

/** Pure, deterministic: "<iso-with-dashes>-<8 hex of cmd>.log". */
export function watchLogName(ts: number, cmd: string): string {
  const iso = new Date(ts).toISOString().replace(/[:.]/g, "-");
  const hash = createHash("sha1").update(cmd).digest("hex").slice(0, 8);
  return `${iso}-${hash}.log`;
}

/**
 * Writes mode 0600, prunes to the newest WATCH_LOG_RETENTION, returns the
 * path it wrote, or undefined when the directory is not writable. Never
 * throws.
 */
export function writeWatchLog(dir: string, name: string, lines: readonly string[]): string | undefined {
  try {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, lines.join("\n") + "\n", { mode: 0o600 });
    pruneWatchLogs(dir);
    return path;
  } catch {
    return undefined;
  }
}

/**
 * Sorts .log names ascending — the leading ISO-ish timestamp makes name
 * order chronological order, so no per-file stat is needed — and unlinks
 * all but the newest `keep`. Ignores unlink failures individually; never
 * throws, including when `dir` doesn't exist.
 */
export function pruneWatchLogs(dir: string, keep: number = WATCH_LOG_RETENTION): void {
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((name) => name.endsWith(".log"))
      .sort();
  } catch {
    return;
  }
  const excess = names.length - keep;
  if (excess <= 0) return;
  for (const name of names.slice(0, excess)) {
    try {
      unlinkSync(join(dir, name));
    } catch {
      // best-effort: ignore individual unlink failures
    }
  }
}
