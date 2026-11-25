import {
  closeSync, constants, existsSync, mkdirSync, openSync, readSync,
  renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
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

function sanitizeEntry(entry: FixTouchEntry, oldestTs: number): FixTouchEntry | undefined {
  const { root, path, cmd, signature, ts } = entry;
  if (root.length === 0 || Array.from(root).length > ROOT_MAX ||
      !Number.isFinite(ts) || ts < oldestTs) return undefined;

  const normalizedPath = path.replaceAll("\\", "/");
  if (!isRelativeCachePath(normalizedPath)) return undefined;
  const safePath = sanitizeField(normalizedPath, FIXTOUCH_PATH_MAX);
  if (!isRelativeCachePath(safePath)) return undefined;

  const firstSignatureLine = signature.split(/\r\n|[\n\r\u2028\u2029]/, 1)[0];
  return {
    root,
    path: safePath,
    cmd: sanitizeField(cmd, FIXTOUCH_CMD_MAX),
    signature: boundCodePoints(sanitizeTestimony(firstSignatureLine).replaceAll('"', "'"), FIXTOUCH_SIGNATURE_MAX),
    ts,
  };
}

function readEntry(value: unknown, oldestTs: number): FixTouchEntry | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { root, path, cmd, signature, ts } = value as Partial<FixTouchEntry>;
  if (typeof root !== "string" || typeof path !== "string" || typeof cmd !== "string" ||
      typeof signature !== "string" || typeof ts !== "number") return undefined;
  if (Array.from(path).length > FIXTOUCH_PATH_MAX || Array.from(cmd).length > FIXTOUCH_CMD_MAX ||
      Array.from(signature).length > FIXTOUCH_SIGNATURE_MAX) return undefined;
  return sanitizeEntry({ root, path, cmd, signature, ts }, oldestTs);
}

function readCacheText(file: string): string | undefined {
  const stat = statSync(file);
  if (!stat.isFile() || stat.size > FIXTOUCH_CACHE_MAX_BYTES) return undefined;

  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    // The file can change between stat and open. Bound the read independently.
    const buffer = Buffer.allocUnsafe(FIXTOUCH_CACHE_MAX_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(descriptor, buffer, offset, buffer.length - offset, null);
      if (read === 0) return buffer.toString("utf8", 0, offset);
      offset += read;
    }
    return undefined;
  } finally {
    closeSync(descriptor);
  }
}

export function readFixTouchCache(file: string, now: number): FixTouchCache | undefined {
  try {
    const text = readCacheText(file);
    if (text === undefined) return undefined;
    const cache = JSON.parse(text) as Partial<FixTouchCache> | null;
    if (cache?.v !== 1 || typeof cache.builtAt !== "number" || !Number.isFinite(cache.builtAt) ||
        cache.builtAt < now - FIXTOUCH_CACHE_MAX_AGE_MS ||
        cache.builtAt > now + FIXTOUCH_FUTURE_SKEW_MS || !Array.isArray(cache.entries)) return undefined;

    const oldestTs = now - FIXTOUCH_WINDOW_MS;
    const entries = cache.entries.map((entry) => readEntry(entry, oldestTs)).filter((entry) => entry !== undefined);
    return { v: 1, builtAt: cache.builtAt, entries };
  } catch {
    return undefined;
  }
}

export function writeFixTouchCache(file: string, cache: FixTouchCache): boolean {
  let temp: string | undefined;
  try {
    if (cache.v !== 1 || !Number.isFinite(cache.builtAt)) return false;
    const oldestTs = cache.builtAt - FIXTOUCH_WINDOW_MS;
    const entries = cache.entries.map((entry) => sanitizeEntry(entry, oldestTs)).filter((entry) => entry !== undefined);
    entries.sort((a, b) => b.ts - a.ts);
    const envelope = { v: 1, builtAt: cache.builtAt, entries };
    let text = JSON.stringify(envelope);
    while (Buffer.byteLength(text, "utf8") > FIXTOUCH_CACHE_MAX_BYTES) {
      entries.length = Math.floor(entries.length / 2);
      text = JSON.stringify(envelope);
    }

    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tempPath = `${file}.${process.pid}.tmp`;
    const descriptor = openSync(tempPath, "wx", 0o600);
    temp = tempPath;
    try {
      writeFileSync(descriptor, text, "utf8");
    } finally {
      closeSync(descriptor);
    }
    renameSync(tempPath, file);
    return true;
  } catch {
    if (temp !== undefined) {
      try { unlinkSync(temp); } catch { /* Best effort after a failed write or rename. */ }
    }
    return false;
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
