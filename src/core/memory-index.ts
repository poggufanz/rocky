/**
 * Advisory fingerprint sidecar for Rocky's append-only memory.
 *
 * `memory.jsonl` stays the source of truth. This module maintains one
 * derived text file next to it (`memory.idx.jsonl`) that maps a failure
 * fingerprint to the file byte offsets where that fingerprint was seen:
 *
 *   header { kind, version, fpVersion, createdAt, bytesTotal, mtimeNs,
 *            ctimeNs, hasLegacy, count, skipped, complete }
 *   rows   { fp, offset, id, ts, hasFix }
 *
 * The sidecar is ADVISORY. Any mismatch (size, mtime/ctime, version,
 * truncated envelope) or any corrupt line discards it and falls back to a
 * full scan with the existing `MemoryCoverage` disclosure. It never decides
 * a mutation and never changes exit codes, stderr streaming, or stdout.
 *
 * Boring on purpose: JSONL text only (no binary format), synchronous
 * `node:fs` only, tmp -> fsync -> rename publish, `wx` lock reuse, mode
 * 0600, `O_NOFOLLOW` reads, no daemon, no thread, no egress.
 */

import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { basename, dirname, join } from "node:path";
import { NO_BLOCK_FLAG, NO_FOLLOW_FLAG, regularDescriptorSafe } from "./fs-safety.js";
import { FINGERPRINT_ALGORITHM_VERSION } from "./fingerprint.js";
import {
  MAX_MEMORY_FILE_BYTES,
  MAX_SUPPORTED_MEMORY_RECORDS,
  MEMORY_FORMAT_VERSION,
  loadMemoryChecked,
  parseMemoryRecord,
} from "./memory-read.js";
import type { FailureRecord, MemoryCoverage, MemoryRecord } from "./memory-read.js";
import { findByFingerprint, isHexFingerprint, matchFailureFingerprint, parseFingerprintLookup } from "./memory-query.js";
import type { FingerprintLookup } from "./memory-query.js";
import { resolveRockyPaths } from "./state-paths.js";

export const MEMORY_INDEX_KIND = "memory-index" as const;
/** Header-only fast check avoids a full sidecar scan on every load. */
const SIDECAR_READ_CHUNK_BYTES = 64 * 1024;
/** A sidecar larger than this is treated as corrupt (50k tiny rows fit in ~6MB). */
const SIDECAR_MAX_BYTES = 8 * 1024 * 1024;
/** One sidecar line is tiny; anything larger is corruption, never a row. */
const SIDECAR_MAX_LINE_BYTES = 16 * 1024;
/** Memory lines keep their own 1MB envelope; positional reads honor it. */
const MEMORY_LINE_CAP_BYTES = 1024 * 1024;
/** Stale sidecar lock age before a loader may sweep its own rebuild guard. */
const SIDECAR_LOCK_STALE_MS = 60_000;

export interface MemoryIndexExpected {
  version: number;
  fpVersion: number;
  maxBytes: number;
  maxRecords: number;
}

export interface MemoryIndexHeader {
  kind: typeof MEMORY_INDEX_KIND;
  version: number;
  fpVersion: number;
  createdAt: number;
  bytesTotal: number;
  mtimeNs: string;
  ctimeNs: string;
  hasLegacy: boolean;
  count: number;
  scanned: number;
  skipped: number;
  complete: boolean;
}

export interface MemoryIndexRow {
  fp: string;
  offset: number;
  id: string;
  ts: number;
  hasFix: boolean;
}

export interface MemoryIndexMap {
  header: MemoryIndexHeader;
  byFp: Map<string, MemoryIndexRow[]>;
}

let indexRebuildCount = 0;
let indexRebuildSkipCount = 0;
let indexHitCount = 0;
let indexMissCount = 0;
let indexFallbackCount = 0;
let indexDiscardCount = 0;

/** Small observable counters for tests and the bounded-reader scorecard. */
export function memoryIndexMetrics(): {
  rebuilds: number;
  rebuildSkips: number;
  hits: number;
  misses: number;
  fallbacks: number;
  discards: number;
} {
  return {
    rebuilds: indexRebuildCount,
    rebuildSkips: indexRebuildSkipCount,
    hits: indexHitCount,
    misses: indexMissCount,
    fallbacks: indexFallbackCount,
    discards: indexDiscardCount,
  };
}

/** `~/.rocky/memory.idx.jsonl` next to `~/.rocky/memory.jsonl`. */
export function indexPathForMemory(memoryPath: string): string {
  const dir = dirname(memoryPath);
  const base = basename(memoryPath);
  if (base === "memory.jsonl") return join(dir, "memory.idx.jsonl");
  return `${memoryPath}.idx.jsonl`;
}

function sidecarReadFlags(): number {
  return constants.O_RDONLY | NO_FOLLOW_FLAG | NO_BLOCK_FLAG;
}

function statBytes(value: bigint): number {
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
}

function isRecordId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function isFpString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f-\u009f\n]/u.test(value);
}

function parseHeader(value: unknown, expected: MemoryIndexExpected): MemoryIndexHeader | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind !== MEMORY_INDEX_KIND) return undefined;
  if (record.version !== expected.version || record.fpVersion !== expected.fpVersion) return undefined;
  if (!Number.isSafeInteger(record.createdAt) || (record.createdAt as number) < 0) return undefined;
  if (!Number.isSafeInteger(record.bytesTotal) || (record.bytesTotal as number) < 0) return undefined;
  if (typeof record.mtimeNs !== "string" || typeof record.ctimeNs !== "string") return undefined;
  if (!/^[0-9]+$/u.test(record.mtimeNs) || !/^[0-9]+$/u.test(record.ctimeNs)) return undefined;
  if (typeof record.hasLegacy !== "boolean") return undefined;
  if (!Number.isSafeInteger(record.count) || (record.count as number) < 0) return undefined;
  if (!Number.isSafeInteger(record.scanned) || (record.scanned as number) < 0) return undefined;
  if (!Number.isSafeInteger(record.skipped) || (record.skipped as number) < 0) return undefined;
  if (typeof record.complete !== "boolean") return undefined;
  return {
    kind: MEMORY_INDEX_KIND,
    version: record.version as number,
    fpVersion: record.fpVersion as number,
    createdAt: record.createdAt as number,
    bytesTotal: record.bytesTotal as number,
    mtimeNs: record.mtimeNs,
    ctimeNs: record.ctimeNs,
    hasLegacy: record.hasLegacy,
    count: record.count as number,
    scanned: record.scanned as number,
    skipped: record.skipped as number,
    complete: record.complete,
  };
}

function parseRow(value: unknown): MemoryIndexRow | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!isFpString(record.fp)) return undefined;
  if (!Number.isSafeInteger(record.offset) || (record.offset as number) < 0) return undefined;
  if (!isRecordId(record.id)) return undefined;
  if (!Number.isSafeInteger(record.ts) || (record.ts as number) < 0) return undefined;
  if (typeof record.hasFix !== "boolean") return undefined;
  return {
    fp: record.fp as string,
    offset: record.offset as number,
    id: record.id as string,
    ts: record.ts as number,
    hasFix: record.hasFix as boolean,
  };
}

function headerMatchesStats(header: MemoryIndexHeader, stats: BigIntStats): boolean {
  if (statBytes(stats.size) !== header.bytesTotal) return false;
  if (stats.mtimeNs.toString() !== header.mtimeNs) return false;
  try {
    if (stats.ctimeNs.toString() !== header.ctimeNs) return false;
  } catch {
    return false;
  }
  return true;
}

/**
 * Read one bounded text line starting at `position` (without the newline).
 * Returns undefined when the line exceeds `capBytes`, the offset is beyond
 * EOF, or any I/O check fails. Never throws.
 */
function readLineAt(path: string, position: number, capBytes: number): string | undefined {
  if (!Number.isSafeInteger(position) || position < 0) return undefined;
  let descriptor: number | undefined;
  try {
    const listed = lstatSync(path, { bigint: true });
    if (!regularDescriptorSafe(listed)) return undefined;
    descriptor = openSync(path, sidecarReadFlags());
    const opened = fstatSync(descriptor, { bigint: true });
    if (!regularDescriptorSafe(opened)) return undefined;
    if (position >= statBytes(opened.size)) return undefined;
    const chunks: Buffer[] = [];
    let total = 0;
    let cursor = position;
    const buffer = Buffer.alloc(Math.min(SIDECAR_READ_CHUNK_BYTES, capBytes + 1));
    for (;;) {
      const requested = Math.min(buffer.byteLength, capBytes + 1 - total);
      if (requested <= 0) return undefined;
      const count = readSync(descriptor, buffer, 0, requested, cursor);
      if (count <= 0) break;
      const newline = buffer.subarray(0, count).indexOf(0x0a);
      if (newline >= 0) {
        chunks.push(Buffer.from(buffer.subarray(0, newline)));
        total += newline;
        if (total > capBytes) return undefined;
        break;
      }
      chunks.push(Buffer.from(buffer.subarray(0, count)));
      total += count;
      if (total > capBytes) return undefined;
      cursor += count;
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* best effort */ }
    }
  }
}

/**
 * Header-only freshness check: reads at most the first line of the sidecar.
 * True means the sidecar claims the exact current memory bytes; any I/O
 * failure, version mismatch, or stat mismatch returns false (stale).
 */
export function isSidecarCurrent(
  memoryPath: string,
  memoryStats: BigIntStats,
  expected: MemoryIndexExpected,
): boolean {
  try {
    const indexPath = indexPathForMemory(memoryPath);
    const listed = lstatSync(indexPath, { bigint: true });
    if (!regularDescriptorSafe(listed) || statBytes(listed.size) > SIDECAR_MAX_BYTES) return false;
    const first = readLineAt(indexPath, 0, SIDECAR_MAX_LINE_BYTES);
    if (first === undefined || first.trim().length === 0) return false;
    let header: MemoryIndexHeader | undefined;
    try {
      header = parseHeader(JSON.parse(first), expected);
    } catch {
      return false;
    }
    if (header === undefined) return false;
    if (header.count > expected.maxRecords) return false;
    if (header.bytesTotal > expected.maxBytes) return false;
    return headerMatchesStats(header, memoryStats);
  } catch {
    return false;
  }
}

/**
 * Load and validate the full sidecar map. Returns undefined on any staleness
 * or corruption so callers fall back to a full scan. Never throws.
 */
export function tryLoadSidecarMap(
  memoryPath: string,
  memoryStats: BigIntStats,
  expected: MemoryIndexExpected,
): MemoryIndexMap | undefined {
  let descriptor: number | undefined;
  try {
    const indexPath = indexPathForMemory(memoryPath);
    let listed: BigIntStats;
    try {
      listed = lstatSync(indexPath, { bigint: true });
    } catch {
      indexMissCount += 1;
      return undefined;
    }
    if (!regularDescriptorSafe(listed) || statBytes(listed.size) > SIDECAR_MAX_BYTES) {
      indexDiscardCount += 1;
      return undefined;
    }
    descriptor = openSync(indexPath, sidecarReadFlags());
    const opened = fstatSync(descriptor, { bigint: true });
    if (!regularDescriptorSafe(opened) || statBytes(opened.size) > SIDECAR_MAX_BYTES) {
      indexDiscardCount += 1;
      return undefined;
    }
    const total = statBytes(opened.size);
    const buffer = Buffer.alloc(Math.min(SIDECAR_READ_CHUNK_BYTES, Math.max(1, total)));
    let bytesRead = 0;
    const chunks: Buffer[] = [];
    while (bytesRead < total) {
      const requested = Math.min(buffer.byteLength, total - bytesRead);
      const count = readSync(descriptor, buffer, 0, requested, bytesRead);
      if (count <= 0) {
        indexDiscardCount += 1;
        return undefined;
      }
      chunks.push(Buffer.from(buffer.subarray(0, count)));
      bytesRead += count;
    }
    const text = Buffer.concat(chunks, bytesRead).toString("utf8");
    const lines = text.split("\n");
    if (lines.length === 0) {
      indexDiscardCount += 1;
      return undefined;
    }
    let header: MemoryIndexHeader | undefined;
    try {
      header = parseHeader(JSON.parse((lines[0] ?? "").trim()), expected);
    } catch {
      indexDiscardCount += 1;
      return undefined;
    }
    if (header === undefined || header.count > expected.maxRecords ||
      header.bytesTotal > expected.maxBytes || !headerMatchesStats(header, memoryStats)) {
      if (header !== undefined && !headerMatchesStats(header, memoryStats)) indexMissCount += 1;
      else indexDiscardCount += 1;
      indexFallbackCount += 1;
      return undefined;
    }
    const byFp = new Map<string, MemoryIndexRow[]>();
    let rows = 0;
    for (let index = 1; index < lines.length; index += 1) {
      const line = (lines[index] ?? "").trim();
      if (!line) continue;
      if (line.length > SIDECAR_MAX_LINE_BYTES) {
        indexDiscardCount += 1;
        indexFallbackCount += 1;
        return undefined;
      }
      let row: MemoryIndexRow | undefined;
      try {
        row = parseRow(JSON.parse(line));
      } catch {
        indexDiscardCount += 1;
        indexFallbackCount += 1;
        return undefined;
      }
      if (row === undefined || row.offset >= header.bytesTotal) {
        indexDiscardCount += 1;
        indexFallbackCount += 1;
        return undefined;
      }
      rows += 1;
      const bucket = byFp.get(row.fp);
      if (bucket === undefined) byFp.set(row.fp, [row]);
      else bucket.push(row);
    }
    if (rows !== header.count) {
      indexDiscardCount += 1;
      indexFallbackCount += 1;
      return undefined;
    }
    indexHitCount += 1;
    return { header, byFp };
  } catch {
    indexDiscardCount += 1;
    indexFallbackCount += 1;
    return undefined;
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* best effort */ }
    }
  }
}

/** Positional read of one memory line for sidecar-directed exact lookup. */
export function readMemoryLineAt(memoryPath: string, offset: number): string | undefined {
  return readLineAt(memoryPath, offset, MEMORY_LINE_CAP_BYTES);
}

function sidecarLockPath(indexPath: string): string {
  return `${indexPath}.lock`;
}

function tryAcquireSidecarLock(indexPath: string): { path: string; token: string } | undefined {
  const lockPath = sidecarLockPath(indexPath);
  try {
    const current = lstatSync(lockPath);
    if (current.isSymbolicLink() || !current.isFile()) return undefined;
    if (Date.now() - current.mtimeMs < SIDECAR_LOCK_STALE_MS) return undefined;
    try { unlinkSync(lockPath); } catch { return undefined; }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
  }
  try {
    const token = randomBytes(16).toString("hex");
    const fd = openSync(lockPath, "wx", 0o600);
    try {
      const payload = Buffer.from(JSON.stringify({ pid: process.pid, token }), "utf8");
      let offset = 0;
      while (offset < payload.byteLength) {
        const written = writeSync(fd, payload, offset, payload.byteLength - offset);
        if (written <= 0) return undefined;
        offset += written;
      }
      try {
        if (process.platform !== "win32") chmodSync(lockPath, 0o600);
      } catch { /* best effort on Windows */ }
    } finally {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    return { path: lockPath, token };
  } catch {
    return undefined;
  }
}

function releaseSidecarLock(lock: { path: string; token: string } | undefined): void {
  if (lock === undefined) return;
  try {
    const raw = readLineAt(lock.path, 0, SIDECAR_MAX_LINE_BYTES);
    if (raw !== undefined) {
      try {
        const value = JSON.parse(raw) as { pid?: unknown; token?: unknown };
        if (value.pid !== process.pid || value.token !== lock.token) return;
      } catch {
        return;
      }
    }
    unlinkSync(lock.path);
  } catch { /* best effort */ }
}

/**
 * Best-effort atomic sidecar publish. Never throws; returns false when the
 * rebuild was skipped (lock held, over-cap envelope) or failed. Callers keep
 * their load result either way.
 */
export function writeSidecarBestEffort(
  memoryPath: string,
  memoryStats: BigIntStats,
  rows: readonly MemoryIndexRow[],
  meta: { version: number; fpVersion: number; scanned: number; skipped: number; complete: boolean; hasLegacy: boolean; maxBytes: number; maxRecords: number },
): boolean {
  let lock: { path: string; token: string } | undefined;
  try {
    if (rows.length > meta.maxRecords || statBytes(memoryStats.size) > meta.maxBytes) {
      indexRebuildSkipCount += 1;
      return false;
    }
    const indexPath = indexPathForMemory(memoryPath);
    const dir = dirname(indexPath);
    try {
      const dirStats = lstatSync(dir);
      if (!dirStats.isDirectory() || dirStats.isSymbolicLink()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        try {
          mkdirSync(dir, { recursive: true, mode: 0o700 });
        } catch {
          return false;
        }
      } else {
        return false;
      }
    }
    if (isSidecarCurrent(memoryPath, memoryStats, {
      version: meta.version,
      fpVersion: meta.fpVersion,
      maxBytes: meta.maxBytes,
      maxRecords: meta.maxRecords,
    })) {
      indexRebuildSkipCount += 1;
      return false;
    }
    lock = tryAcquireSidecarLock(indexPath);
    if (lock === undefined) {
      indexRebuildSkipCount += 1;
      return false;
    }
    const header: MemoryIndexHeader = {
      kind: MEMORY_INDEX_KIND,
      version: meta.version,
      fpVersion: meta.fpVersion,
      createdAt: Date.now(),
      bytesTotal: statBytes(memoryStats.size),
      mtimeNs: memoryStats.mtimeNs.toString(),
      ctimeNs: memoryStats.ctimeNs.toString(),
      hasLegacy: meta.hasLegacy,
      count: rows.length,
      scanned: meta.scanned,
      skipped: meta.skipped,
      complete: meta.complete,
    };
    const lines = new Array<string>(rows.length + 1);
    lines[0] = JSON.stringify(header);
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      lines[index + 1] = JSON.stringify({ fp: row.fp, offset: row.offset, id: row.id, ts: row.ts, hasFix: row.hasFix });
    }
    const payload = Buffer.from(`${lines.join("\n")}\n`, "utf8");
    if (payload.byteLength > SIDECAR_MAX_BYTES) {
      indexRebuildSkipCount += 1;
      return false;
    }
    const tmpPath = `${indexPath}.tmp.${process.pid}.${randomBytes(8).toString("hex")}`;
    let fd = -1;
    try {
      fd = openSync(tmpPath, "wx", 0o600);
      let offset = 0;
      while (offset < payload.byteLength) {
        const written = writeSync(fd, payload, offset, payload.byteLength - offset);
        if (written <= 0) return false;
        offset += written;
      }
      try {
        if (process.platform !== "win32") chmodSync(tmpPath, 0o600);
      } catch { /* best effort on Windows */ }
      try {
        fsyncSync(fd);
      } catch {
        return false;
      }
    } finally {
      if (fd >= 0) {
        try { closeSync(fd); } catch { /* best effort */ }
      }
    }
    try {
      const written = lstatSync(tmpPath);
      if (!written.isFile() || written.isSymbolicLink() || Number(written.size) !== payload.byteLength) {
        try { unlinkSync(tmpPath); } catch { /* best effort */ }
        return false;
      }
    } catch {
      return false;
    }
    try {
      renameSync(tmpPath, indexPath);
    } catch {
      try { unlinkSync(tmpPath); } catch { /* best effort */ }
      return false;
    }
    try {
      if (process.platform !== "win32") chmodSync(indexPath, 0o600);
    } catch { /* best effort on Windows */ }
    try {
      const dirFd = openSync(dir, constants.O_RDONLY);
      try {
        fsyncSync(dirFd);
      } finally {
        try { closeSync(dirFd); } catch { /* best effort */ }
      }
    } catch { /* directory fsync is best effort, notably on Windows */ }
    indexRebuildCount += 1;
    return true;
  } catch {
    return false;
  } finally {
    releaseSidecarLock(lock);
  }
}

export interface FingerprintOnDiskResult {
  hits: FailureRecord[];
  coverage: MemoryCoverage;
  via: "sidecar" | "scan";
}

/**
 * Writer-side cross-process exact lookup (NOT imported by the MCP read
 * graph). When the advisory sidecar matches the current memory bytes, only
 * the hit lines are read positionally (O(hits)); any staleness, corruption,
 * legacy-singleton, or over-cap envelope falls back to a full scan whose
 * coverage is disclosed. Never throws.
 */
export function findByFingerprintOnDisk(
  fp: FingerprintLookup,
  memoryPath?: string,
  now = Date.now(),
): FingerprintOnDiskResult {
  const path = memoryPath ?? resolveRockyPaths().memory;
  const candidates = parseFingerprintLookup(fp);
  const fallback = (): FingerprintOnDiskResult => {
    const loaded = loadMemoryChecked(path, now);
    return { hits: findByFingerprint(loaded.records, fp, now), coverage: loaded.coverage, via: "scan" };
  };
  try {
    const stats = lstatSync(path, { bigint: true });
    if (stats.isSymbolicLink() || !stats.isFile()) return fallback();
    if (stats.size > BigInt(MAX_MEMORY_FILE_BYTES)) return fallback();
    const expected = {
      version: MEMORY_FORMAT_VERSION,
      fpVersion: FINGERPRINT_ALGORITHM_VERSION,
      maxBytes: MAX_MEMORY_FILE_BYTES,
      maxRecords: MAX_SUPPORTED_MEMORY_RECORDS,
    };
    const sidecar = tryLoadSidecarMap(path, stats, expected);
    if (sidecar === undefined) return fallback();
    if (sidecar.header.hasLegacy && candidates.size === 1) {
      const only = [...candidates][0]!;
      if (isHexFingerprint(only)) return fallback();
    }
    if (sidecar.header.count > MAX_SUPPORTED_MEMORY_RECORDS) return fallback();
    const rows: { offset: number; id: string; fp: string }[] = [];
    for (const candidate of candidates) {
      const bucket = sidecar.byFp.get(candidate);
      if (bucket === undefined) continue;
      for (const row of bucket) rows.push(row);
    }
    if (rows.length === 0) {
      const coverage: MemoryCoverage = Object.freeze({
        version: MEMORY_FORMAT_VERSION,
        scanned: sidecar.header.scanned,
        skipped: sidecar.header.skipped,
        truncated: 0,
        bytesScanned: sidecar.header.bytesTotal,
        bytesTotal: sidecar.header.bytesTotal,
        complete: sidecar.header.complete,
      });
      return { hits: [], coverage, via: "sidecar" };
    }
    rows.sort((left, right) => left.offset - right.offset);
    const seen = new Set<string>();
    const hits: FailureRecord[] = [];
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      const line = readMemoryLineAt(path, row.offset);
      if (line === undefined || line.trim().length === 0) return fallback();
      let parsed: MemoryRecord | undefined;
      try {
        parsed = parseMemoryRecord(JSON.parse(line));
      } catch {
        return fallback();
      }
      if (parsed === undefined || parsed.kind !== "failure" || parsed.id !== row.id || parsed.fingerprint !== row.fp) {
        return fallback();
      }
      if (parsed.ts > now) continue;
      if (matchFailureFingerprint(parsed, candidates)) hits.push(parsed);
    }
    const coverage: MemoryCoverage = Object.freeze({
      version: MEMORY_FORMAT_VERSION,
      scanned: sidecar.header.scanned,
      skipped: sidecar.header.skipped,
      truncated: 0,
      bytesScanned: sidecar.header.bytesTotal,
      bytesTotal: sidecar.header.bytesTotal,
      complete: sidecar.header.complete,
    });
    return { hits, coverage, via: "sidecar" };
  } catch {
    return fallback();
  }
}
