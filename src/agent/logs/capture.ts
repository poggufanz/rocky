import type { CanonicalRationaleEvent, LogAdapter } from "./types.js";
import { claudeCodeLogAdapter } from "./claude-code.js";
import { dshLogAdapter } from "./dsh.js";
import { SCAN_MAX_BYTES, readAdapterOffsets, writeAdapterOffsets } from "./scan.js";
import { loadMemory, canonicalPath } from "../../core/memory-read.js";
import type { FailureRecord, FixRecord, MemoryRecord, RationaleLinks, TripleRecord } from "../../core/memory-read.js";
import { recordRationale } from "../../core/memory.js";

export interface CaptureResult { written: number; unlinked: number; skipped: string[] }

/**
 * Weak-link window: an event weak-links to the nearest failure/fix in the
 * same cwd within this many ms of the event's timestamp. Exported so other
 * lanes (e.g. the notify capture path) reuse this exact rule instead of
 * re-deriving it — see the Task 12 brief.
 */
export const WEAK_LINK_WINDOW_MS = 10 * 60 * 1000;

/** Structural-link window: a touched file matching a recorded triple's file within this many ms. */
const STRUCTURAL_LINK_WINDOW_MS = 30 * 60 * 1000;

/** Never correlate against more than this many recent same-cwd triple/fix/failure records. */
const MAX_CORRELATION_RECORDS = 500;

const ADAPTERS: readonly LogAdapter[] = [claudeCodeLogAdapter, dshLogAdapter];

export interface CaptureDeps {
  /** Test seam: substitute the adapter list. Production scans claude-code + dsh. */
  adapters?: readonly LogAdapter[];
}

type CorrelationRecord = TripleRecord | FixRecord | FailureRecord;

function isCorrelationRecord(record: MemoryRecord): record is CorrelationRecord {
  return record.kind === "triple" || record.kind === "fix" || record.kind === "failure";
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizedTouchedFiles(files: readonly string[] | undefined): Set<string> | undefined {
  if (files === undefined || files.length === 0) return undefined;
  const normalized = new Set<string>();
  for (const file of files) {
    const canonical = canonicalPath(file);
    if (canonical.length > 0) normalized.add(canonical);
  }
  return normalized.size > 0 ? normalized : undefined;
}

/**
 * Same-turn touched file matching a recorded triple's `mechanism.files`,
 * within `STRUCTURAL_LINK_WINDOW_MS` of the event. Nearest triple in time
 * wins on multiple matches. Undefined when the event carries no touched
 * files or none matches — never a guess.
 */
function structuralLinkFor(
  records: readonly CorrelationRecord[],
  event: CanonicalRationaleEvent,
  cwd: string,
  now: number,
): RationaleLinks | undefined {
  const touched = normalizedTouchedFiles(event.touchedFiles);
  if (touched === undefined) return undefined;
  let best: { tripleId: string; distance: number } | undefined;
  for (const record of records) {
    if (record.kind !== "triple" || record.cwd !== cwd || record.ts > now) continue;
    const distance = Math.abs(record.ts - event.ts);
    if (distance > STRUCTURAL_LINK_WINDOW_MS) continue;
    const matches = record.mechanism.files.some((file) => touched.has(canonicalPath(file.path)));
    if (!matches) continue;
    if (best === undefined || distance < best.distance) best = { tripleId: record.id, distance };
  }
  return best === undefined ? undefined : { tripleId: best.tripleId };
}

/**
 * Nearest failure/fix in `cwd`, within `WEAK_LINK_WINDOW_MS` of `ts`, using
 * only evidence at or before `now`. Exported so Task 12's notify lane
 * reuses this exact window rule instead of re-deriving it.
 */
export function weakLinkFor(
  records: readonly MemoryRecord[],
  ts: number,
  cwd: string,
  now: number = Date.now(),
): RationaleLinks | undefined {
  let best: { link: RationaleLinks; distance: number } | undefined;
  for (const record of records) {
    if (record.kind !== "failure" && record.kind !== "fix") continue;
    if (record.cwd !== cwd || record.ts > now) continue;
    const distance = Math.abs(record.ts - ts);
    if (distance > WEAK_LINK_WINDOW_MS) continue;
    if (best === undefined || distance < best.distance) {
      best = { link: record.kind === "failure" ? { failureId: record.id } : { fixId: record.id }, distance };
    }
  }
  return best?.link;
}

/** Fixed, conservative correlation order: structural, then weak, else unlinked. Never guesses. */
function correlate(
  records: readonly CorrelationRecord[],
  event: CanonicalRationaleEvent,
  cwd: string,
  now: number,
): RationaleLinks | undefined {
  return structuralLinkFor(records, event, cwd, now) ?? weakLinkFor(records, event.ts, cwd, now);
}

/**
 * Scan every agent log adapter for `repoCwd`, correlate each event to
 * remembered evidence, and write one `rationale` record per event.
 * Pull-only (no daemon, no watcher), bounded (byte-capped scans, capped
 * correlation set), and dedupes across calls via persisted byte/seq
 * offsets. Advances a log's offset only after every write for that log
 * succeeds, so a mid-batch crash re-reads that log next time rather than
 * silently losing evidence — duplicate rationale records on retry are the
 * accepted cost of never losing one. Adapter, scan, or write failures push
 * a one-line reason into `skipped` and capture continues; this function
 * never throws.
 */
export function captureRationales(repoCwd: string, now: number = Date.now(), deps: CaptureDeps = {}): CaptureResult {
  const adapters = deps.adapters ?? ADAPTERS;
  const result: CaptureResult = { written: 0, unlinked: 0, skipped: [] };
  try {
    let records: readonly MemoryRecord[];
    try {
      records = loadMemory();
    } catch (error) {
      result.skipped.push(`memory load failed: ${errorReason(error)}`);
      return result;
    }
    const correlationRecords = records
      .filter(isCorrelationRecord)
      .filter((record) => record.cwd === repoCwd)
      .sort((a, b) => a.ts - b.ts)
      .slice(-MAX_CORRELATION_RECORDS);

    let offsets: Record<string, number>;
    try {
      offsets = readAdapterOffsets();
    } catch (error) {
      result.skipped.push(`offset read failed: ${errorReason(error)}`);
      return result;
    }
    const nextOffsets = { ...offsets };
    let offsetsChanged = false;

    for (const adapter of adapters) {
      let logPaths: string[];
      try {
        logPaths = adapter.discover(repoCwd);
      } catch (error) {
        result.skipped.push(`${adapter.agent} discover failed: ${errorReason(error)}`);
        continue;
      }
      for (const logPath of logPaths) {
        const fromOffset = offsets[logPath] ?? 0;
        let events: CanonicalRationaleEvent[];
        let nextOffset: number;
        try {
          const scanned = adapter.scan(repoCwd, logPath, fromOffset, SCAN_MAX_BYTES);
          events = scanned.events;
          nextOffset = scanned.nextOffset;
        } catch (error) {
          result.skipped.push(`${adapter.agent} scan failed for ${logPath}: ${errorReason(error)}`);
          continue;
        }
        let fileFailed = false;
        for (const event of events) {
          try {
            const links = correlate(correlationRecords, event, repoCwd, now);
            recordRationale({
              cwd: repoCwd,
              agent: event.agent,
              rationale_fidelity: event.fidelity,
              source: event.source,
              text: event.text,
              ts: event.ts,
              pointer: { logPath: event.logPath, sessionId: event.sessionId, turnRef: event.turnRef },
              ...(links === undefined ? {} : { links }),
            });
            result.written += 1;
            if (links === undefined) result.unlinked += 1;
          } catch (error) {
            result.skipped.push(`${adapter.agent} write failed for ${logPath}: ${errorReason(error)}`);
            fileFailed = true;
            break;
          }
        }
        if (!fileFailed && nextOffset !== fromOffset) {
          nextOffsets[logPath] = nextOffset;
          offsetsChanged = true;
        }
      }
    }

    if (offsetsChanged) {
      try {
        writeAdapterOffsets(nextOffsets);
      } catch (error) {
        result.skipped.push(`offset persist failed: ${errorReason(error)}`);
      }
    }
    return result;
  } catch (error) {
    result.skipped.push(`capture failed: ${errorReason(error)}`);
    return result;
  }
}
