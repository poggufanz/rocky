import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { Buffer } from "node:buffer";
import { MAX_LOG_OFFSETS, readState, writeState } from "../../core/brief-state.js";

/** Per-call byte budget for one adapter scan; never reads more than this. */
export const SCAN_MAX_BYTES = 4 * 1024 * 1024;

const SCAN_CHUNK_BYTES = 64 * 1024;
const NEWLINE = 0x0a;

/**
 * Incrementally scan a JSONL log by BYTE offsets. Reads at most `maxBytes`
 * starting at `fromOffset`, invokes `onLine` with each parsed complete line,
 * and skips corrupt lines. Returns the byte offset where the trailing
 * unfinished line begins (or end of scanned data), so a later call resumes
 * exactly there. Line boundaries are found in raw bytes, so a multi-byte
 * UTF-8 character split across a chunk boundary is never mis-decoded, and
 * the file is never loaded whole. A file that shrank below `fromOffset`
 * (truncation/rotation) restarts at 0. On any I/O error the original
 * `fromOffset` is returned unchanged; this surface never throws on bad
 * user data.
 */
export function scanJsonlLines(
  logPath: string,
  fromOffset: number,
  maxBytes: number,
  onLine: (obj: unknown) => void,
): number {
  if (!Number.isSafeInteger(fromOffset) || fromOffset < 0) return 0;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return fromOffset;
  let fd: number | undefined;
  try {
    fd = openSync(logPath, "r");
    // A file smaller than the remembered offset was truncated or rotated at
    // the same path; the stale offset could never make progress, so restart
    // from the beginning of the new content.
    if (fstatSync(fd).size < fromOffset) fromOffset = 0;
    const buffer = Buffer.allocUnsafe(Math.min(SCAN_CHUNK_BYTES, maxBytes));
    let position = fromOffset;
    let scanned = 0;
    // Bytes of the current unfinished line, always ending at `position`.
    let carry: Buffer | undefined;
    try {
      while (scanned < maxBytes) {
        const want = Math.min(buffer.length, maxBytes - scanned);
        const bytesRead = readSync(fd, buffer, 0, want, position);
        if (bytesRead <= 0) break;
        scanned += bytesRead;
        position += bytesRead;
        const chunk = buffer.subarray(0, bytesRead);
        let start = 0;
        let newline = chunk.indexOf(NEWLINE, start);
        while (newline !== -1) {
          const line = carry !== undefined
            ? Buffer.concat([carry, chunk.subarray(start, newline)])
            : chunk.subarray(start, newline);
          carry = undefined;
          const text = line.toString("utf8");
          if (text.trim().length > 0) {
            try {
              onLine(JSON.parse(text));
            } catch {
              // Corrupt lines are skipped, never fatal.
            }
          }
          start = newline + 1;
          newline = chunk.indexOf(NEWLINE, start);
        }
        if (start < bytesRead) {
          // Copy: `buffer` is reused by the next readSync.
          const rest = Buffer.from(chunk.subarray(start));
          carry = carry !== undefined ? Buffer.concat([carry, rest]) : rest;
        }
      }
      // A single unfinished line spanning the whole byte budget would return
      // an offset at or before `fromOffset` and re-read the same bytes
      // forever. Oversized lines are skipped instead: scan ahead, bounded by
      // one more maxBytes, for the terminating newline and resume just past
      // it, emitting nothing for the giant line; bytes after that newline
      // are left unread for the next call. When the newline never shows up
      // within the extra bound, give up at the position already reached so
      // subsequent lines are not held hostage by one pathological line.
      if (carry !== undefined && scanned >= maxBytes && position - carry.length <= fromOffset) {
        let extra = 0;
        let skippedPast = -1;
        while (extra < maxBytes) {
          const want = Math.min(buffer.length, maxBytes - extra);
          const bytesRead = readSync(fd, buffer, 0, want, position);
          if (bytesRead <= 0) break;
          extra += bytesRead;
          position += bytesRead;
          const newline = buffer.subarray(0, bytesRead).indexOf(NEWLINE);
          if (newline !== -1) {
            skippedPast = position - bytesRead + newline + 1;
            break;
          }
        }
        return skippedPast !== -1 ? skippedPast : position;
      }
    } finally {
      closeSync(fd);
      fd = undefined;
    }
    return position - (carry !== undefined ? carry.length : 0);
  } catch {
    // I/O errors land here — and so does a throwing `onLine` callback: in
    // that case the original offset is returned and the next call rescans
    // from `fromOffset`. That full-rescan fallback is the deliberate
    // never-throws policy of this surface, not an accident.
    try {
      if (fd !== undefined) closeSync(fd);
    } catch {
      // Nothing more to do; the offset fallback below still applies.
    }
    return fromOffset;
  }
}

/** Stored per-log byte offsets from state.json key `logOffsets`. */
export function readAdapterOffsets(): Record<string, number> {
  return { ...readState().logOffsets };
}

/**
 * Persist per-log byte offsets, capped at MAX_LOG_OFFSETS entries (oldest drops first).
 * The argument REPLACES the whole `logOffsets` map: callers must read-modify-write
 * (`writeAdapterOffsets({ ...readAdapterOffsets(), [path]: next })`) or offsets
 * belonging to other logs are lost.
 */
export function writeAdapterOffsets(offsets: Record<string, number>): void {
  const state = readState();
  const entries = Object.entries(offsets)
    .filter(([, offset]) => Number.isSafeInteger(offset) && offset >= 0)
    .slice(-MAX_LOG_OFFSETS);
  const logOffsets: Record<string, number> = {};
  for (const [path, offset] of entries) logOffsets[path] = offset;
  writeState({ ...state, logOffsets });
}
