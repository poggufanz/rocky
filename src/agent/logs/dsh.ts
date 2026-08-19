import { readdirSync, readFileSync, statSync } from "node:fs";
import { Buffer } from "node:buffer";
import { homedir } from "node:os";
import { join, basename, dirname } from "node:path";
import * as zlib from "node:zlib";
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

/** Never discover more than this many session files per repo. */
const MAX_DISCOVERED_FILES = 5;

/** True when the runtime Node build ships zstd (>= 22.15). Never throws. */
export function zstdAvailable(): boolean {
  return typeof zlibMaybeZstd.zstdDecompressSync === "function";
}

function isRecord(obj: unknown): obj is Record<string, unknown> {
  return typeof obj === "object" && obj !== null && !Array.isArray(obj);
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
 * Only events with `seq > fromOffset` are emitted. Seq gaps warn-and-continue;
 * the capture layer discloses coverage. Malformed lines are skipped. Never
 * throws.
 */
function scan(_repoCwd: string, logPath: string, fromOffset: number, maxBytes: number): { events: CanonicalRationaleEvent[]; nextOffset: number } {
  const none = { events: [] as CanonicalRationaleEvent[], nextOffset: fromOffset };
  try {
    if (!zstdAvailable() || !zlibMaybeZstd.zstdDecompressSync) return none;
    const size = isFileWithSize(logPath);
    if (size === undefined || size > MAX_COMPRESSED_BYTES) return none;
    const compressed = readFileSync(logPath);
    let text: string;
    try {
      // maxBytes doubles as the decompressed-size budget; an over-budget
      // frame throws here and the file is skipped rather than parsed halfway.
      text = zlibMaybeZstd.zstdDecompressSync(compressed, { maxOutputLength: Math.max(maxBytes, 1) }).toString("utf8");
    } catch {
      return none;
    }
    const events: CanonicalRationaleEvent[] = [];
    let sessionId = basename(dirname(logPath)); // <session> path segment fallback
    let highestSeq = fromOffset;
    let previousSeq: number | undefined;
    let firstLine = true;
    for (const rawLine of text.split("\n")) {
      const trimmed = rawLine.trim();
      if (trimmed.length === 0) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue; // corrupt line skipped, never fatal
      }
      if (firstLine) {
        firstLine = false;
        // SessionHeader: tolerant; only the session id is taken from it.
        if (isRecord(obj) && typeof obj.session === "string" && obj.session.length > 0) {
          sessionId = obj.session;
        }
        continue;
      }
      if (!isRecord(obj)) continue;
      const seq = obj.seq;
      if (typeof seq !== "number" || !Number.isFinite(seq)) continue;
      if (previousSeq !== undefined && seq !== previousSeq + 1) {
        // Seq gap: events were lost between records. Warn-and-continue —
        // coverage disclosure is the capture layer's job, not a hard fail.
        process.stderr.write(`rocky: dsh log ${logPath}: seq gap ${previousSeq} -> ${seq}\n`);
      }
      previousSeq = seq;
      if (seq > highestSeq) highestSeq = seq;
      if (seq <= fromOffset) continue; // already captured in an earlier scan
      const data = isRecord(obj.data) ? obj.data : undefined;
      const text2 = data && typeof data.text === "string" ? data.text
        : data && typeof data.reasoning === "string" ? data.reasoning
        : undefined;
      const isReasoning = obj.type === "reasoning" || (data !== undefined && typeof data.reasoning === "string");
      if (!isReasoning || text2 === undefined || text2.length === 0) continue;
      events.push({
        agent: "dsh",
        sessionId,
        turnRef: String(seq),
        ts: typeof obj.time === "number" && Number.isFinite(obj.time) ? obj.time : 0,
        text: text2,
        fidelity: "raw",
        source: "log-thinking",
        logPath,
      });
    }
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
