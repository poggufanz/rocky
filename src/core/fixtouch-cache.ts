import {
  closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync,
  renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { NO_BLOCK_FLAG, NO_FOLLOW_FLAG, regularDescriptorSafe, sameFilesystemIdentity } from "./fs-safety.js";
import type { FixRecord } from "./memory-read.js";
import { sanitizeTestimony } from "./redact.js";

export const FIXTOUCH_CACHE_MAX_BYTES = 256 * 1024;
export const FIXTOUCH_CACHE_MAX_AGE_MS = 7 * 86_400_000;
export const FIXTOUCH_FUTURE_SKEW_MS = 60_000;
export const FIXTOUCH_WINDOW_MS = 30 * 86_400_000;
export const FIXTOUCH_PATH_MAX = 160;
export const FIXTOUCH_CMD_MAX = 80;
export const FIXTOUCH_SIGNATURE_MAX = 120;
const ROOT_MAX = 1024;
const YEAR_10000_UTC = Date.UTC(10000, 0, 1);

export interface FixTouchEntry { root: string; path: string; cmd: string; signature: string; ts: number }
export interface FixTouchCache { v: 1; builtAt: number; entries: FixTouchEntry[] }

export function fixTouchEnabled(home: string): boolean {
  return existsSync(join(home, "fixtouch-on"));
}

export function fixTouchCachePath(home: string): string {
  return join(home, "derived", "attempts-hot.json");
}

/** Walk parent directories for a .git marker, including for files not written yet. */
export function fileGitRoot(absPath: string): string | undefined {
  let dir = dirname(resolve(absPath));
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Rebuild the fix-touch cache after a FixRecord write. A no-op unless a fix
 * was written and `<home>/fixtouch-on` exists. Never throws.
 */
export async function refreshFixTouchAfterFix(
  fix: FixRecord | undefined,
  deps: { home: string; now: number },
): Promise<void> {
  if (fix === undefined) return;
  try {
    if (!fixTouchEnabled(deps.home)) return;
    const { rebuildFixTouchCache } = await import("../commands/fixtouch-refresh.js");
    if (!fixTouchEnabled(deps.home)) return;
    rebuildFixTouchCache({ home: deps.home, now: deps.now });
  } catch {
    // Best-effort; a stale or missing cache only makes the gate silent.
  }
}

export function boundCodePoints(text: string, max: number): string {
  return Array.from(text).slice(0, max).join("");
}

export function sanitizeField(text: string, max: number): string {
  return boundCodePoints(sanitizeTestimony(text).replace(/[\u2028\u2029]/g, " "), max);
}

export function rootKey(root: string, platform: NodeJS.Platform = process.platform): string {
  const normalized = root.replaceAll("\\", "/");
  const trimmed = normalized.replace(/\/+$/, "") || normalized;
  return platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

export function fixTouchPathKey(path: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? path.replaceAll("\\", "/").toLowerCase() : path;
}

function isRelativeCachePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !/^[a-z]:/i.test(path) &&
    !path.startsWith("..") && !path.split("/").includes("..");
}

function sanitizeEntry(entry: FixTouchEntry, oldestTs: number, newestTs: number): FixTouchEntry | undefined {
  const { root, path, cmd, signature, ts } = entry;
  if (root.length === 0 || Array.from(root).length > ROOT_MAX ||
      !Number.isFinite(ts) || ts < 0 || ts >= YEAR_10000_UTC ||
      ts < oldestTs || ts > newestTs) return undefined;

  const normalizedPath = path.replaceAll("\\", "/");
  if (!isRelativeCachePath(normalizedPath) || Array.from(normalizedPath).length > FIXTOUCH_PATH_MAX ||
      sanitizeField(normalizedPath, FIXTOUCH_PATH_MAX) !== normalizedPath) return undefined;

  const firstSignatureLine = signature.split(/\r\n|[\n\r\u2028\u2029]/, 1)[0];
  return {
    root,
    path: normalizedPath,
    cmd: sanitizeField(cmd, FIXTOUCH_CMD_MAX),
    signature: boundCodePoints(sanitizeTestimony(firstSignatureLine).replaceAll('"', "'"), FIXTOUCH_SIGNATURE_MAX),
    ts,
  };
}

function readEntry(value: unknown, oldestTs: number, newestTs: number): FixTouchEntry | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { root, path, cmd, signature, ts } = value as Partial<FixTouchEntry>;
  if (typeof root !== "string" || typeof path !== "string" || typeof cmd !== "string" ||
      typeof signature !== "string" || typeof ts !== "number") return undefined;
  if (Array.from(cmd).length > FIXTOUCH_CMD_MAX || Array.from(signature).length > FIXTOUCH_SIGNATURE_MAX) return undefined;
  return sanitizeEntry({ root, path, cmd, signature, ts }, oldestTs, newestTs);
}

/** Read cache or shown-state text. Null means absent, and undefined means unsafe or oversized. */
export function readFixTouchFile(file: string, maxBytes: number): string | null | undefined {
  const parent = dirname(file);
  const statOptions = { bigint: true, throwIfNoEntry: false } as const;
  const directory = lstatSync(parent, statOptions);
  if (directory === undefined) return null;
  if (!directory.isDirectory() || directory.isSymbolicLink()) return undefined;

  const listed = lstatSync(file, statOptions);
  if (listed === undefined) {
    return sameFilesystemIdentity(directory, lstatSync(parent, statOptions)) ? null : undefined;
  }
  const limit = BigInt(maxBytes);
  if (!regularDescriptorSafe(listed) || listed.size > limit) return undefined;

  const fd = openSync(file, constants.O_RDONLY | NO_FOLLOW_FLAG | NO_BLOCK_FLAG);
  try {
    const opened = fstatSync(fd, { bigint: true });
    const stillListed = () =>
      sameFilesystemIdentity(directory, lstatSync(parent, statOptions)) &&
      sameFilesystemIdentity(opened, lstatSync(file, statOptions));
    if (!regularDescriptorSafe(opened) || !sameFilesystemIdentity(listed, opened) ||
        opened.size > limit || !stillListed()) return undefined;

    const size = Number(opened.size);
    const buffer = Buffer.allocUnsafe(size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const bytes = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (bytes === 0) break;
      offset += bytes;
    }
    if (offset !== size) return undefined;
    const after = fstatSync(fd, { bigint: true });
    if (after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || !stillListed()) return undefined;
    return buffer.toString("utf8", 0, offset);
  } finally {
    closeSync(fd);
  }
}

export function readFixTouchCache(file: string, now: number): FixTouchCache | undefined {
  try {
    const text = readFixTouchFile(file, FIXTOUCH_CACHE_MAX_BYTES);
    if (typeof text !== "string") return undefined;
    const cache = JSON.parse(text) as Partial<FixTouchCache> | null;
    if (cache?.v !== 1 || typeof cache.builtAt !== "number" || !Number.isFinite(cache.builtAt) ||
        cache.builtAt < now - FIXTOUCH_CACHE_MAX_AGE_MS ||
        cache.builtAt > now + FIXTOUCH_FUTURE_SKEW_MS || !Array.isArray(cache.entries)) return undefined;

    const oldestTs = now - FIXTOUCH_WINDOW_MS;
    const newestTs = now + FIXTOUCH_FUTURE_SKEW_MS;
    const entries = cache.entries.map((entry) => readEntry(entry, oldestTs, newestTs))
      .filter((entry) => entry !== undefined);
    return { v: 1, builtAt: cache.builtAt, entries };
  } catch {
    return undefined;
  }
}

export function writeFixTouchCache(file: string, cache: FixTouchCache, opts?: { beforePublish?: () => boolean }): boolean {
  let temp: string | undefined;
  try {
    if (cache.v !== 1 || !Number.isFinite(cache.builtAt)) return false;
    const oldestTs = cache.builtAt - FIXTOUCH_WINDOW_MS;
    const newestTs = cache.builtAt + FIXTOUCH_FUTURE_SKEW_MS;
    const entries = cache.entries.map((entry) => sanitizeEntry(entry, oldestTs, newestTs))
      .filter((entry) => entry !== undefined);
    entries.sort((a, b) => b.ts - a.ts);
    const envelope = { v: 1, builtAt: cache.builtAt, entries };
    let text = JSON.stringify(envelope);
    while (Buffer.byteLength(text, "utf8") > FIXTOUCH_CACHE_MAX_BYTES) {
      entries.length = Math.floor(entries.length / 2);
      text = JSON.stringify(envelope);
    }

    const parent = dirname(file);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const directory = lstatSync(parent, { bigint: true });
    if (!directory.isDirectory() || directory.isSymbolicLink()) return false;
    const tempPath = `${file}.${process.pid}.tmp`;
    const descriptor = openSync(tempPath, "wx", 0o600);
    temp = tempPath;
    try {
      writeFileSync(descriptor, text, "utf8");
    } finally {
      closeSync(descriptor);
    }
    if (!sameFilesystemIdentity(directory, lstatSync(parent, { bigint: true }))) return false;
    if (opts?.beforePublish && !opts.beforePublish()) return false;
    renameSync(tempPath, file);
    temp = undefined;
    return true;
  } catch {
    return false;
  } finally {
    if (temp !== undefined) {
      try { unlinkSync(temp); } catch { /* Best effort when publication does not complete. */ }
    }
  }
}

export function findFixTouchEntry(
  cache: FixTouchCache | undefined,
  root: string,
  path: string,
  platform: NodeJS.Platform,
): FixTouchEntry | undefined {
  if (cache === undefined) return undefined;
  const targetRoot = rootKey(root, platform);
  const targetPath = fixTouchPathKey(path, platform);
  let newest: FixTouchEntry | undefined;
  for (const entry of cache.entries) {
    if (rootKey(entry.root, platform) === targetRoot && fixTouchPathKey(entry.path, platform) === targetPath &&
        (newest === undefined || entry.ts > newest.ts)) newest = entry;
  }
  return newest;
}
