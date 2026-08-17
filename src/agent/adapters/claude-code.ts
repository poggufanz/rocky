import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type BigIntStats,
} from "node:fs";
import { createHash } from "node:crypto";
import {
  batchKey,
  MAX_COVERAGE_PATHS,
  MAX_RATIONALE_CHARS,
  parseAgentEvent,
  type AgentEvent,
  type RationaleEvent,
} from "../schema.js";
import { canonicalPath } from "../../core/memory-read.js";
import { NO_FOLLOW_FLAG, regularDescriptorSafe, sameFilesystemIdentity } from "../../core/fs-safety.js";

export type ParsedHookPayload =
  | {
    action: "append";
    key: string;
    events: AgentEvent[];
    event: AgentEvent;
    truncatedFiles?: number;
    coveragePaths?: string[];
    coveragePathsComplete?: boolean;
    /** Exact unique candidate count before bounded witness storage. */
    coverageCandidateCount?: number;
    coverageCandidateCountExact?: boolean;
    coverageCwd?: string;
    coveragePlatform?: NodeJS.Platform | "unknown";
    coverageDigest?: string;
  }
  | { action: "close"; key: string; rationale?: RationaleEvent }
  | undefined;

const EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
export const MAX_ADAPTER_EVENTS = 64;
const TRANSCRIPT_TAIL_BYTES = 64 * 1024;

type PlainRecord = Record<string, unknown>;

function isPlainRecord(value: unknown): value is PlainRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function rationaleFromLine(line: string): string | undefined {
  if (!line.trim()) return undefined;
  try {
    const decoded: unknown = JSON.parse(line);
    if (!isPlainRecord(decoded) || decoded.type !== "assistant") return undefined;
    const message = decoded.message;
    if (!isPlainRecord(message)) return undefined;
    const content = message.content;
    if (typeof content === "string") return nonEmptyString(content)?.slice(0, MAX_RATIONALE_CHARS);
    if (!Array.isArray(content)) return undefined;
    for (let index = content.length - 1; index >= 0; index -= 1) {
      const part = content[index];
      if (!isPlainRecord(part) || part.type !== "text") continue;
      const text = nonEmptyString(part.text);
      if (text) return text.slice(0, MAX_RATIONALE_CHARS);
    }
  } catch {
    // A partial tail line or an unrelated transcript record is not fatal.
  }
  return undefined;
}

function rationaleFromTail(tail: string): string | undefined {
  const lines = tail.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const rationale = rationaleFromLine(lines[index]);
    if (rationale) return rationale;
  }
  return undefined;
}

/** Read only a bounded transcript tail and treat every transcript surprise as best effort. */
export function rationaleFromTranscript(transcriptPath: string): string | undefined {
  let fd: number | undefined;
  try {
    if (typeof transcriptPath !== "string" || transcriptPath.length === 0) return undefined;

    // Check before opening, then use O_NOFOLLOW where available to avoid following a link race.
    const listed = lstatSync(transcriptPath, { bigint: true });
    if (!regularDescriptorSafe(listed) || !sameFilesystemIdentity(listed, listed)) return undefined;
    fd = openSync(transcriptPath, constants.O_RDONLY | NO_FOLLOW_FLAG);
    const opened = fstatSync(fd, { bigint: true });
    if (!regularDescriptorSafe(opened) || !sameFilesystemIdentity(listed, opened)
        || opened.size <= 0n) return undefined;

    const length = Number(opened.size > BigInt(TRANSCRIPT_TAIL_BYTES) ? BigInt(TRANSCRIPT_TAIL_BYTES) : opened.size);
    const start = Number(opened.size - BigInt(length));
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const bytesRead = readSync(fd, buffer, offset, length - offset, start + offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
    }
    if (offset === 0) return undefined;
    const after = fstatSync(fd, { bigint: true });
    if (!regularDescriptorSafe(after) || !sameFilesystemIdentity(listed, after)) return undefined;
    return rationaleFromTail(buffer.subarray(0, offset).toString("utf8"));
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Closing a best-effort read must not affect hook handling.
      }
    }
  }
}

function rationaleEvent(text: string | undefined, now: number): RationaleEvent | undefined {
  if (!text) return undefined;
  const parsed = parseAgentEvent({
    v: 1,
    agent: "claude-code",
    kind: "rationale",
    ts: now,
    source: "transcript",
    text,
  });
  return parsed?.kind === "rationale" ? parsed : undefined;
}

function appendPayload(
  key: string,
  events: AgentEvent[],
  coveragePaths?: readonly string[],
  coverageCompleteOverride?: boolean,
  coverageCwd?: string,
): ParsedHookPayload {
  const bounded = events.slice(0, MAX_ADAPTER_EVENTS);
  const originPlatform = process.platform;
  const semanticPaths: Array<{ display: string; identity: string }> = [];
  const semanticSeen = new Set<string>();
  for (const value of coveragePaths ?? []) {
    if (typeof value !== "string" || value.length === 0 || value.length > 1024 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) continue;
    const display = canonicalPath(value, { platform: originPlatform });
    const identity = canonicalPath(value, { platform: originPlatform, cwd: coverageCwd });
    if (!display || !identity || semanticSeen.has(identity)) continue;
    semanticSeen.add(identity);
    semanticPaths.push({ display, identity });
  }
  const omitted = coveragePaths === undefined ? events.length - bounded.length : Math.max(0, semanticPaths.length - bounded.length);
  const truncatedFiles = omitted > 0 ? omitted : undefined;
  const hasOverflow = omitted > 0;
  const boundedCoverage = coveragePaths !== undefined
    ? semanticPaths.slice(0, MAX_COVERAGE_PATHS).map(({ display }) => display)
    : undefined;
  const coverageComplete = boundedCoverage === undefined ? undefined
    : (coverageCompleteOverride ?? true) && semanticPaths.length <= MAX_COVERAGE_PATHS && semanticPaths.length > 0;
  const attachCoverage = boundedCoverage !== undefined || hasOverflow;
  const firstMechanismIndex = attachCoverage ? bounded.findIndex((event) => event.kind === "mechanism") : -1;
  const markedEvents = bounded.map((event, index) => index === firstMechanismIndex && event.kind === "mechanism"
    ? {
      ...event,
      ...(truncatedFiles === undefined ? {} : { truncatedFiles }),
      ...(boundedCoverage === undefined ? {} : { coveragePaths: boundedCoverage }),
      ...(coverageComplete === undefined ? {} : { coveragePathsComplete: coverageComplete }),
    }
    : event);
  const digestPaths = semanticPaths.map(({ identity }) => identity).sort();
  return {
    action: "append",
    key,
    events: markedEvents,
    // `event` is retained as a compatibility alias for older internal users;
    // new callers must consume the bounded list.
    event: markedEvents[0]!,
    ...(truncatedFiles === undefined ? {} : { truncatedFiles }),
    ...(boundedCoverage === undefined ? {} : {
      coveragePaths: boundedCoverage,
      coveragePathsComplete: coverageComplete,
    }),
    ...(coveragePaths === undefined ? {} : {
      coverageCandidateCount: digestPaths.length,
      // Candidate count is the parser's unique-path total even when the
      // bounded event witness is capped. The witness completeness bit carries
      // the separate omission fact.
      coverageCandidateCountExact: coverageCompleteOverride !== false,
      ...(coverageCwd === undefined ? {} : { coverageCwd }),
      coveragePlatform: originPlatform,
      coverageDigest: createHash("sha256").update(JSON.stringify(digestPaths), "utf8").digest("hex"),
    }),
  };
}

export function parseClaudeHookPayload(raw: unknown, now = Date.now()): ParsedHookPayload {
  try {
    if (!isPlainRecord(raw)) return undefined;
    const session = nonEmptyString(raw.session_id);
    const turn = nonEmptyString(raw.prompt_id);
    // A missing prompt identity must not merge unrelated turns into one batch.
    if (!session || !turn) return undefined;

    const key = batchKey("claude-code", session, turn);
    const cwd = nonEmptyString(raw.cwd);

    switch (raw.hook_event_name) {
      case "UserPromptSubmit": {
        const text = nonEmptyString(raw.prompt);
        if (!text) return undefined;
        const event = parseAgentEvent({ v: 1, agent: "claude-code", kind: "intent", ts: now, cwd, text });
        return event ? appendPayload(key, [event]) : undefined;
      }
      case "PostToolUse": {
        const tool = nonEmptyString(raw.tool_name);
        if (!tool || !EDIT_TOOLS.has(tool)) return undefined;
        const input = raw.tool_input;
        if (!isPlainRecord(input)) return undefined;

        let invalidCoverage = false;
        let edits: PlainRecord[];
        if (tool === "MultiEdit") {
          const rawEdits = input.edits;
          if (!Array.isArray(rawEdits)) return undefined;
          edits = [];
          const rawLength = rawEdits.length;
          const boundedLength = Math.min(rawLength, MAX_COVERAGE_PATHS * 2);
          if (rawLength > boundedLength) invalidCoverage = true;
          for (let index = 0; index < boundedLength; index += 1) {
            const edit = rawEdits[index];
            if (!isPlainRecord(edit)) {
              invalidCoverage = true;
              continue;
            }
            edits.push(edit);
          }
        } else {
          edits = [input];
        }
        if (edits.length === 0) return undefined;
        const byPath = new Map<string, AgentEvent>();
        for (const edit of edits) {
          const path = nonEmptyString(edit.file_path)
            ?? nonEmptyString(edit.notebook_path)
            ?? (tool === "MultiEdit" ? undefined : nonEmptyString(input.file_path))
            ?? (tool === "MultiEdit" ? undefined : nonEmptyString(input.notebook_path));
          if (!path) {
            invalidCoverage = true;
            continue;
          }
          const excerpt = nonEmptyString(edit.new_string)
            ?? nonEmptyString(edit.new_source)
            ?? nonEmptyString(edit.file_text)
            ?? nonEmptyString(edit.content)
            ?? nonEmptyString(input.new_string)
            ?? nonEmptyString(input.new_source)
            ?? nonEmptyString(input.file_text)
            ?? nonEmptyString(input.content);
          if (path.length > 1024) {
            invalidCoverage = true;
            continue;
          }
          const display = canonicalPath(path, { platform: process.platform });
          const identity = canonicalPath(path, { platform: process.platform, cwd });
          if (!display || !identity) continue;
          if (display.length > 1024 || identity.length > 1024) {
            invalidCoverage = true;
            continue;
          }
          const event = parseAgentEvent({
            v: 1, agent: "claude-code", kind: "mechanism", ts: now, tool, path: display, excerpt,
            provenance: "tool-observed",
          });
          if (event) byPath.set(identity, event);
        }
        return byPath.size === 0 ? undefined : appendPayload(
          key,
          [...byPath.values()],
          [...byPath.keys()],
          invalidCoverage ? false : true,
          cwd,
        );
      }
      case "Stop": {
        const direct = nonEmptyString(raw.last_assistant_message);
        const transcriptPath = nonEmptyString(raw.transcript_path);
        const text = direct ?? (transcriptPath ? rationaleFromTranscript(transcriptPath) : undefined);
        const rationale = rationaleEvent(text, now);
        return rationale ? { action: "close", key, rationale } : { action: "close", key };
      }
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}
