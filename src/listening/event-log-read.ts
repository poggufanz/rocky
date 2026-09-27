/**
 * Read-only listening log access (spec §7). MCP-safe: imports only
 * node:fs READ functions plus pure helpers. No writer-named imports.
 */
import { readFileSync } from "node:fs";
import type { EventEnvelope, HarnessId } from "./types.js";
import { isHarnessId } from "./types.js";
import { parseListeningEventLine } from "./event-codec.js";
import { eventsPath, hostEventsPath } from "./store-paths.js";

function readLines(path: string): string[] {
  try {
    return readFileSync(path, "utf8").split("\n");
  } catch {
    return [];
  }
}

function parseAll(lines: string[]): { events: EventEnvelope[]; malformed: number } {
  const events: EventEnvelope[] = [];
  let malformed = 0;
  for (const line of lines) {
    if (line.length === 0) continue;
    const parsed = parseListeningEventLine(line);
    if (parsed === undefined) {
      malformed += 1;
      continue;
    }
    events.push(parsed);
  }
  return { events, malformed };
}

/** Newest-first tail page. Malformed lines are skipped, never thrown. */
export function readListeningTail(
  repoRoot: string,
  opts: { limit: number; cursor?: string; newest?: boolean },
  home?: string,
): { events: EventEnvelope[]; nextCursor: string; coverage: string } {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit)), 200);
  const { events, malformed } = parseAll(readLines(eventsPath(repoRoot, home)));
  let start = 0;
  // newest: the last `limit` events, for a live view that re-reads each poll
  if (opts.newest === true) {
    start = Math.max(0, events.length - limit);
  } else if (opts.cursor !== undefined && opts.cursor.length > 0) {
    const at = events.findIndex((e) => e.eventId === opts.cursor);
    start = at < 0 ? 0 : at + 1;
  }
  const page = events.slice(start, start + limit);
  const nextCursor = page.length > 0 ? page[page.length - 1].eventId : (opts.cursor ?? "");
  const tombstoned = events.some((e) => typeof e.gapEvicted === "number");
  const coverage = tombstoned || malformed > 0 ? "partial" : "complete";
  return { events: page, nextCursor, coverage };
}

/** Full ordered load for projection rebuild. Truncation is disclosed. */
export function loadEventsForProjection(
  repoRoot: string,
  home?: string,
): { events: EventEnvelope[]; truncated: boolean; malformed: number } {
  const { events, malformed } = parseAll(readLines(eventsPath(repoRoot, home)));
  return { events, truncated: events.some((e) => typeof e.gapEvicted === "number"), malformed };
}

/** Host-scoped events for one harness id. Empty when the id is unknown. */
export function loadHostEvents(
  harnessId: HarnessId,
  home?: string,
): { events: EventEnvelope[]; malformed: number } {
  if (!isHarnessId(harnessId)) return { events: [], malformed: 0 };
  return parseAll(readLines(hostEventsPath(harnessId, home)));
}
