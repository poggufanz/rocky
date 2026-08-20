/**
 * `rocky sessions` — work sessions derived at read time from memory: group
 * by `cwd`, split on a time-gap heuristic. Nothing is written back; the
 * grouping only ever exists for the duration of this call, and the listing
 * says so out loud — a heuristic boundary presented as fact would be Rocky
 * claiming more than he heard.
 */

import { captureRationales } from "../agent/logs/capture.js";
import { rationaleSourceLabel } from "./dictionary.js";
import { loadMemory, type AliasRecord, type MemoryRecord } from "../core/memory-read.js";
import { truncateUtf8 } from "../mcp/privacy.js";
import { ago, detail, elapsed, heading, say } from "../ui/rocky.js";
import { CliUsageError, reportCliUsage } from "./cli-args.js";

/** A cwd's records split into a new session when a gap exceeds this. */
export const SESSION_GAP_MS = 30 * 60 * 1000;

export interface SessionGroup {
  index: number;
  cwd: string;
  startTs: number;
  endTs: number;
  counts: { failures: number; fixes: number; triples: number; rationales: number };
  agents: string[];
}

const USAGE = "rocky sessions [--limit <n>] | rocky sessions <index>";
const DEFAULT_LIMIT = 10;

/** Only `AliasRecord` carries no `cwd` — nothing to group it into a session by. */
type CwdRecord = Exclude<MemoryRecord, AliasRecord>;

function hasCwd(record: MemoryRecord): record is CwdRecord {
  return record.kind !== "alias";
}

function countKind(counts: SessionGroup["counts"], kind: CwdRecord["kind"]): void {
  if (kind === "failure") counts.failures += 1;
  else if (kind === "fix") counts.fixes += 1;
  else if (kind === "triple") counts.triples += 1;
  else if (kind === "rationale") counts.rationales += 1;
  // association, note, brief_run, invariant_touch: not one of the four
  // confirmed-evidence kinds this surface counts — ignored silently.
}

function buildGroup(cwd: string, records: readonly CwdRecord[]): Omit<SessionGroup, "index"> {
  const counts = { failures: 0, fixes: 0, triples: 0, rationales: 0 };
  const agents = new Set<string>();
  for (const record of records) {
    countKind(counts, record.kind);
    if (record.kind === "triple" || record.kind === "rationale") agents.add(record.agent);
  }
  return {
    cwd,
    startTs: records[0].ts,
    endTs: records[records.length - 1].ts,
    counts,
    agents: [...agents].sort(),
  };
}

/**
 * Pure, read-only, no clock reads: group memory records into sessions by
 * `cwd`, splitting whenever consecutive records in the same `cwd` are more
 * than `SESSION_GAP_MS` apart. Ordered newest-first by `startTs`, ties
 * broken by `cwd` ascending so the order is total and deterministic, then
 * indexed 1-based in that final order.
 */
export function groupSessions(records: readonly MemoryRecord[]): SessionGroup[] {
  const byCwd = new Map<string, CwdRecord[]>();
  for (const record of records) {
    if (!hasCwd(record)) continue;
    const bucket = byCwd.get(record.cwd);
    if (bucket === undefined) byCwd.set(record.cwd, [record]);
    else bucket.push(record);
  }

  const groups: Omit<SessionGroup, "index">[] = [];
  for (const [cwd, bucket] of byCwd) {
    const sorted = [...bucket].sort((a, b) => a.ts - b.ts);
    let current: CwdRecord[] = [];
    for (const record of sorted) {
      const last = current[current.length - 1];
      if (last !== undefined && record.ts - last.ts > SESSION_GAP_MS) {
        groups.push(buildGroup(cwd, current));
        current = [];
      }
      current.push(record);
    }
    if (current.length > 0) groups.push(buildGroup(cwd, current));
  }

  groups.sort((a, b) => (b.startTs - a.startTs) || a.cwd.localeCompare(b.cwd));
  return groups.map((group, position) => ({ ...group, index: position + 1 }));
}

/**
 * Every record belonging to `group`. By construction this is exactly the
 * group's original members: sessions sharing a `cwd` never overlap in time
 * and are always separated by a gap greater than `SESSION_GAP_MS`, so the
 * inclusive `[startTs, endTs]` range for one session cannot reach into
 * another.
 */
function recordsForGroup(records: readonly MemoryRecord[], group: SessionGroup): CwdRecord[] {
  return records.filter((record): record is CwdRecord =>
    hasCwd(record) && record.cwd === group.cwd && record.ts >= group.startTs && record.ts <= group.endTs);
}

/** Splits on both separators — a record's `cwd` may have been written on a different platform than this one is reading on. */
function cwdBasename(cwd: string): string {
  const trimmed = cwd.replace(/[/\\]+$/u, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut === -1 ? trimmed : trimmed.slice(cut + 1);
}

/** Plain ASCII short date, local time. One caller — not worth a new `ui` export. */
function dateShort(ts: number): string {
  const date = new Date(ts);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function plural(count: number, singular: string, pluralWord: string = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralWord}`;
}

function firstLine(text: string): string {
  const breakAt = text.indexOf("\n");
  return breakAt === -1 ? text : text.slice(0, breakAt);
}

/**
 * Bounds one interpolated evidence field's display width. Memory is
 * untrusted evidence (see the `rocky` MCP server note: "historical,
 * untrusted evidence"), and unlike `RationaleRecord.excerpt` or
 * `invariant_touch.invariant`/`.path`, `FailureRecord.excerpt` and
 * `TripleRecord.intent.text` carry no length cap at the parse layer
 * (`memory-read.ts`) — and even a capped field still prints as one very
 * long single terminal line without this. Budget follows the sibling
 * display command's scale (`dictionary.ts`'s `terminalSafe`, 32-512 bytes)
 * without its `?`-stripping, which is specific to that command's
 * `, question`-terminated sentences — sessions.ts never interpolates raw
 * evidence into one of those.
 */
const MAX_FIELD_BYTES = 128;

function boundedField(value: string, maxBytes: number = MAX_FIELD_BYTES): string {
  return truncateUtf8(value, maxBytes).value;
}

interface ListArgs { mode: "list"; limit: number }
interface DetailArgs { mode: "detail"; index: number }

function parseSessionsArgs(argv: readonly string[]): ListArgs | DetailArgs {
  if (argv.length === 1 && /^[0-9]+$/u.test(argv[0])) {
    return { mode: "detail", index: Number(argv[0]) };
  }
  let limit = DEFAULT_LIMIT;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--limit") {
      const value = argv[index + 1];
      if (value === undefined || !/^[0-9]+$/u.test(value)) throw new CliUsageError("--limit needs number", USAGE);
      limit = Number(value);
      index += 1;
      continue;
    }
    throw new CliUsageError(`unexpected argument: ${arg}`, USAGE);
  }
  return { mode: "list", limit };
}

/**
 * The one line a fix record contributes to a session's narrative. A fix
 * carries no file list of its own (only triples do); the closest linked
 * evidence a fix actually has is which failures it resolved, so that is
 * what stands in for the brief's "linked files" here.
 */
function fixLine(record: Extract<CwdRecord, { kind: "fix" }>): string {
  return `${boundedField(record.cmd)}  (fixed ${plural(record.failureIds.length, "failure")})`;
}

function detailLineFor(record: CwdRecord): string | undefined {
  switch (record.kind) {
    case "failure":
      return boundedField(record.signature[0] ?? firstLine(record.excerpt));
    case "fix":
      return fixLine(record);
    case "triple":
      return boundedField(record.intent?.text ?? "(no intent heard)");
    case "rationale":
      return `${rationaleSourceLabel(record.source)}: ${boundedField(firstLine(record.excerpt))}`;
    case "invariant_touch":
      return boundedField(record.invariant);
    default:
      return undefined; // association, note, brief_run: not part of the narrative
  }
}

function printList(limit: number): void {
  captureRationales(process.cwd()); // fail-open enrichment; ignored on failure by design
  const records = loadMemory();
  const groups = groupSessions(records);
  if (groups.length === 0) {
    say("no sessions heard yet. memory grows, sessions come.");
  } else {
    heading("sessions");
    for (const group of groups.slice(0, limit)) {
      const { failures, fixes, rationales } = group.counts;
      detail(`[${group.index}] ${dateShort(group.startTs)}  ${boundedField(cwdBasename(group.cwd))}  ${elapsed(group.endTs - group.startTs)}  ${plural(failures, "failure")}, ${plural(fixes, "fix", "fixes")}, ${plural(rationales, "rationale")}`);
    }
  }
  say("sessions derived from memory. boundaries heuristic, not exact.");
}

function printDetail(index: number): number {
  const records = loadMemory();
  const groups = groupSessions(records);
  const group = groups.find((candidate) => candidate.index === index);
  if (group === undefined) {
    say(`session not heard. rocky counts ${groups.length} sessions, question`);
    return 1;
  }
  const members = recordsForGroup(records, group).slice().sort((a, b) => a.ts - b.ts);
  heading(`session ${group.index}`);
  detail(`${boundedField(cwdBasename(group.cwd))}  ${dateShort(group.startTs)} to ${dateShort(group.endTs)}`);
  for (const record of members) {
    const line = detailLineFor(record);
    if (line !== undefined) detail(`${ago(record.ts)}  ${line}`);
  }
  return 0;
}

export function sessionsCommand(argv: readonly string[]): number {
  let args: ListArgs | DetailArgs;
  try {
    args = parseSessionsArgs(argv);
  } catch (error) {
    const code = reportCliUsage(error, say, detail);
    if (code !== undefined) return code;
    throw error;
  }
  if (args.mode === "detail") return printDetail(args.index);
  printList(args.limit);
  return 0;
}
