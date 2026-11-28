import { closeSync, fstatSync, openSync, readdirSync, readFileSync, statSync } from "node:fs";
import { Buffer } from "node:buffer";
import { homedir } from "node:os";
import { join } from "node:path";
import * as zlib from "node:zlib";
import { createDshTranscriptReducer } from "../../harnesses/decoders/dsh.js";
import { appendTranscriptRationales } from "./scan.js";
import type { CanonicalRationaleEvent, LogAdapter } from "./types.js";

/**
 * @types/node here predates zstd typings, so every zstd touch goes through
 * this structural cast. The functions exist only on Node >= 22.15; the
 * feature check below is the only gate.
 */
const zlibMaybeZstd = zlib as unknown as {
  zstdDecompressSync?: (buffer: Buffer, options?: { maxOutputLength?: number }) => Buffer;
};

/** Compressed-size cap: larger session files are skipped, never parsed. */
const MAX_COMPRESSED_BYTES = 32 * 1024 * 1024;

/**
 * Decompressed-size cap: the zip-bomb guard for `maxOutputLength`. Deliberately
 * independent of the scan's `maxBytes` — that budget is per-scan, while a
 * healthy session log decompresses whole and can legitimately exceed it.
 */
const MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;

/** Never discover more than this many session files per repo. */
const MAX_DISCOVERED_FILES = 5;

/** True when the runtime Node build ships zstd (>= 22.15). Never throws. */
export function zstdAvailable(): boolean {
  return typeof zlibMaybeZstd.zstdDecompressSync === "function";
}

function isFileWithSize(path: string): number | undefined {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat.size : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Candidate DSH session logs: the explicit DSH_SESSION_JSONL override when
 * set, else `~/.dsh/sessions/<project>/<session>/session.jsonl.zstd` newest
 * first, capped at MAX_DISCOVERED_FILES. Returns [] when zstd is unavailable.
 * Never throws.
 */
function discover(_repoCwd: string): string[] {
  try {
    if (!zstdAvailable()) return [];
    const override = process.env.DSH_SESSION_JSONL;
    if (override !== undefined && override.length > 0) {
      return isFileWithSize(override) !== undefined ? [override] : [];
    }
    const sessionsRoot = join(homedir(), ".dsh", "sessions");
    const found: { path: string; mtimeMs: number }[] = [];
    for (const project of readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      const projectDir = join(sessionsRoot, project.name);
      let sessions;
      try {
        sessions = readdirSync(projectDir, { withFileTypes: true });
      } catch {
        continue; // unreadable dir is skipped, never fatal
      }
      for (const session of sessions) {
        if (!session.isDirectory()) continue;
        const logPath = join(projectDir, session.name, "session.jsonl.zstd");
        try {
          const stat = statSync(logPath);
          if (stat.isFile()) found.push({ path: logPath, mtimeMs: stat.mtimeMs });
        } catch {
          continue;
        }
      }
    }
    found.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return found.slice(0, MAX_DISCOVERED_FILES).map((f) => f.path);
  } catch {
    return [];
  }
}

/**
 * Scan a zstd-compressed DSH session log. Zstd frames are not line-seekable,
 * so the whole frame is decompressed (bounded twice: 32MB compressed cap up
 * front, `maxOutputLength` during decompress as the zip-bomb guard) and
 * `fromOffset`/`nextOffset` carry the last-seen event `seq`, not bytes.
 * Only events with `seq > fromOffset` are emitted. A poisoned or oversized
 * file returns `fromOffset` unchanged — the file may simply be mid-write, so
 * it is retried on every scan by design and coverage disclosure is the
 * capture layer's responsibility. Malformed lines are skipped. Never throws.
 */
function scan(_repoCwd: string, logPath: string, fromOffset: number, maxBytes: number): { events: CanonicalRationaleEvent[]; nextOffset: number } {
  void maxBytes; // not line-seekable: the whole frame is always decompressed
  const none = { events: [] as CanonicalRationaleEvent[], nextOffset: fromOffset };
  try {
    if (!zstdAvailable() || !zlibMaybeZstd.zstdDecompressSync) return none;
    // One fd for the size cap and the read: a replaced file cannot slip a
    // larger payload past the 32MB cap between stat and read.
    let fd: number | undefined;
    let compressed: Buffer;
    try {
      fd = openSync(logPath, "r");
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_COMPRESSED_BYTES) return none;
      compressed = readFileSync(fd);
    } catch {
      return none;
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // Nothing more to do.
        }
      }
    }
    let text: string;
    try {
      // MAX_DECOMPRESSED_BYTES is the decompressed-size budget; an over-budget
      // frame throws here and the file is skipped rather than parsed halfway.
      text = zlibMaybeZstd.zstdDecompressSync(compressed, { maxOutputLength: MAX_DECOMPRESSED_BYTES }).toString("utf8");
    } catch {
      return none;
    }
    const events: CanonicalRationaleEvent[] = [];
    // Legacy scans accept any nonempty session string from the header.
    const reducer = createDshTranscriptReducer({ logPath }, ({ session }) =>
      typeof session === "string" && session.length > 0 ? session : undefined);
    let highestSeq = fromOffset;
    let previousNewSeq: number | undefined;
    for (const rawLine of text.split("\n")) {
      const trimmed = rawLine.trim();
      if (trimmed.length === 0) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue; // corrupt line skipped, never fatal
      }
      const { seq, events: batch } = reducer.consumeRecord(obj, fromOffset);
      if (seq === undefined) continue;
      if (seq > highestSeq) highestSeq = seq;
      if (seq <= fromOffset) continue; // already captured in an earlier scan
      if (previousNewSeq !== undefined && seq > previousNewSeq + 1) {
        // Gap among newly captured events: records were lost since the last
        // scan. Warn-and-continue — disclosure is the capture layer's job.
        // Duplicates and out-of-order seqs are not gaps and stay silent.
        process.stderr.write(`rocky: dsh log ${logPath}: seq gap ${previousNewSeq} -> ${seq}\n`);
      }
      previousNewSeq = seq;
      appendTranscriptRationales(events, batch);
    }
    appendTranscriptRationales(events, reducer.finish());
    return { events, nextOffset: highestSeq };
  } catch {
    return none;
  }
}

export const dshLogAdapter: LogAdapter = {
  agent: "dsh",
  discover,
  scan,
};
