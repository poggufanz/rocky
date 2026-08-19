import { closeSync, openSync, readSync } from "node:fs";
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
 * the file is never loaded whole. On any I/O error the original `fromOffset`
 * is returned unchanged; this surface never throws on bad user data.
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
    } finally {
      closeSync(fd);
      fd = undefined;
    }
    return position - (carry !== undefined ? carry.length : 0);
  } catch {
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

/** Persist per-log byte offsets, capped at MAX_LOG_OFFSETS entries (oldest drops first). */
export function writeAdapterOffsets(offsets: Record<string, number>): void {
  const state = readState();
  const entries = Object.entries(offsets)
    .filter(([, offset]) => Number.isSafeInteger(offset) && offset >= 0)
    .slice(-MAX_LOG_OFFSETS);
  const logOffsets: Record<string, number> = {};
  for (const [path, offset] of entries) logOffsets[path] = offset;
  writeState({ ...state, logOffsets });
}
