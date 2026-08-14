import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import {
  batchKey,
  MAX_COVERAGE_PATHS,
  MAX_RATIONALE_CHARS,
  parseAgentEvent,
  type AgentEvent,
  type RationaleEvent,
} from "../schema.js";
import { canonicalPath } from "../../core/memory-read.js";

export type ParsedHookPayload =
  | {
    action: "append";
    key: string;
    events: AgentEvent[];
    event: AgentEvent;
    truncatedFiles?: number;
    coveragePaths?: string[];
    coveragePathsComplete?: boolean;
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
    const listed = lstatSync(transcriptPath);
    if (!listed.isFile()) return undefined;
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    fd = openSync(transcriptPath, constants.O_RDONLY | noFollow);
    const opened = fstatSync(fd);
    if (!opened.isFile() || !Number.isSafeInteger(opened.size) || opened.size <= 0) return undefined;

    const length = Math.min(TRANSCRIPT_TAIL_BYTES, opened.size);
    const start = opened.size - length;
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const bytesRead = readSync(fd, buffer, offset, length - offset, start + offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
    }
    if (offset === 0) return undefined;
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

function appendPayload(key: string, events: AgentEvent[], coveragePaths?: readonly string[]): ParsedHookPayload {
  const bounded = events.slice(0, MAX_ADAPTER_EVENTS);
  const truncatedFiles = coveragePaths === undefined ? events.length - bounded.length : coveragePaths.length - bounded.length;
  const hasOverflow = truncatedFiles > 0;
  const boundedCoverage = hasOverflow && coveragePaths !== undefined
    ? coveragePaths.slice(0, MAX_COVERAGE_PATHS)
    : undefined;
  const coverageComplete = boundedCoverage === undefined ? undefined : coveragePaths!.length <= MAX_COVERAGE_PATHS;
  const firstMechanismIndex = hasOverflow ? bounded.findIndex((event) => event.kind === "mechanism") : -1;
  const markedEvents = bounded.map((event, index) => index === firstMechanismIndex && event.kind === "mechanism"
    ? {
      ...event,
      ...(hasOverflow ? { truncatedFiles } : {}),
      ...(boundedCoverage === undefined ? {} : { coveragePaths: boundedCoverage }),
      ...(coverageComplete === undefined ? {} : { coveragePathsComplete: coverageComplete }),
    }
    : event);
  return {
    action: "append",
    key,
    events: markedEvents,
    // `event` is retained as a compatibility alias for older internal users;
    // new callers must consume the bounded list.
    event: markedEvents[0]!,
    ...(hasOverflow ? { truncatedFiles } : {}),
    ...(boundedCoverage === undefined ? {} : {
      coveragePaths: boundedCoverage,
      coveragePathsComplete: coverageComplete,
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

        const edits: PlainRecord[] = tool === "MultiEdit"
          ? (Array.isArray(input.edits) ? input.edits.filter(isPlainRecord) : [])
          : [input];
        if (edits.length === 0) return undefined;
        const byPath = new Map<string, AgentEvent>();
        for (const edit of edits) {
          const path = nonEmptyString(edit.file_path)
            ?? nonEmptyString(edit.notebook_path)
            ?? nonEmptyString(input.file_path)
            ?? nonEmptyString(input.notebook_path);
          if (!path) continue;
          const excerpt = nonEmptyString(edit.new_string)
            ?? nonEmptyString(edit.new_source)
            ?? nonEmptyString(edit.file_text)
            ?? nonEmptyString(edit.content)
            ?? nonEmptyString(input.new_string)
            ?? nonEmptyString(input.new_source)
            ?? nonEmptyString(input.file_text)
            ?? nonEmptyString(input.content);
          const identity = canonicalPath(path);
          if (!identity) continue;
          const event = parseAgentEvent({
            v: 1, agent: "claude-code", kind: "mechanism", ts: now, tool, path: identity, excerpt,
            provenance: "tool-observed",
          });
          if (event) byPath.set(identity, event);
        }
        return byPath.size === 0 ? undefined : appendPayload(key, [...byPath.values()], [...byPath.keys()]);
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
