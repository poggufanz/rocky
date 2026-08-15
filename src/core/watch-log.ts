/**
 * Retained stderr-tail log for `rocky watch`. One file per watched command
 * run, written with owner-only permissions and pruned to the newest
 * WATCH_LOG_RETENTION files. Never a source of truth for fingerprinting —
 * best-effort disk evidence only, so every entry point here swallows its own
 * errors rather than throwing.
 */

import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { filesystemIdentity, NO_FOLLOW_FLAG, regularDescriptorSafe, sameFilesystemIdentity } from "./fs-safety.js";

export const WATCH_LOG_RETENTION = 20;
const WATCH_LOG_MAX_BYTES = 64 * 1024;
const NO_FOLLOW = NO_FOLLOW_FLAG;

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
  let descriptor = -1;
  let temporary: string | undefined;
  try {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    const directory = lstatSync(dir, { bigint: true });
    if (!directory.isDirectory() || directory.isSymbolicLink() || filesystemIdentity(directory) === undefined) return undefined;
    const bytes = Buffer.from(lines.join("\n") + "\n", "utf8");
    if (bytes.byteLength > WATCH_LOG_MAX_BYTES) return undefined;
    temporary = `${path}.tmp.${process.pid}.${randomBytes(8).toString("hex")}`;
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, 0o600);
    const opened = fstatSync(descriptor, { bigint: true });
    if (!regularDescriptorSafe(opened) || !sameFilesystemIdentity(opened, opened)) return undefined;
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
      if (written <= 0) return undefined;
      offset += written;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (!regularDescriptorSafe(after) || !sameFilesystemIdentity(opened, after) || after.size !== BigInt(bytes.byteLength)) return undefined;
    closeSync(descriptor);
    descriptor = -1;
    // Never replace an existing log through a raced pathname. A unique
    // timestamp/hash name is expected; a collision is a fail-closed write.
    try {
      const existing = lstatSync(path, { bigint: true });
      if (!regularDescriptorSafe(existing) || !sameFilesystemIdentity(existing, existing)) return undefined;
      return undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
    }
    const beforePublishDirectory = lstatSync(dir, { bigint: true });
    if (!beforePublishDirectory.isDirectory() || beforePublishDirectory.isSymbolicLink()
        || !sameFilesystemIdentity(directory, beforePublishDirectory)) return undefined;
    renameSync(temporary, path);
    temporary = undefined;
    const published = lstatSync(path, { bigint: true });
    if (!regularDescriptorSafe(published) || !sameFilesystemIdentity(opened, published)) return undefined;
    const afterPublishDirectory = lstatSync(dir, { bigint: true });
    if (!afterPublishDirectory.isDirectory() || afterPublishDirectory.isSymbolicLink()
        || !sameFilesystemIdentity(directory, afterPublishDirectory)) return undefined;
    pruneWatchLogs(dir);
    return path;
  } catch {
    return undefined;
  } finally {
    if (descriptor >= 0) {
      try { closeSync(descriptor); } catch { /* best effort */ }
    }
    if (temporary !== undefined) {
      try { unlinkSync(temporary); } catch { /* best effort */ }
    }
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
    const path = join(dir, name);
    try {
      const initial = lstatSync(path, { bigint: true });
      if (!regularDescriptorSafe(initial) || !sameFilesystemIdentity(initial, initial)) continue;
      const checked = lstatSync(path, { bigint: true });
      if (!regularDescriptorSafe(checked) || !sameFilesystemIdentity(initial, checked)) continue;
      unlinkSync(path);
    } catch {
      // best-effort: ignore individual unlink failures
    }
  }
}
