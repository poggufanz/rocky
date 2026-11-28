import { parseClaudeHookPayload } from "../../agent/adapters/claude-code.js";
import type { CanonicalRationaleEvent } from "../../agent/logs/types.js";
import { isSafeSessionId } from "../../core/agent-session.js";
import { parseExitCodeHeader, TOOL_RESULT_STDIN_CAP_BYTES } from "../../core/tool-result.js";
import { capSyncResponse } from "../projections/to-tool-result.js";
import {
  asFields, field, parseFields, readListeningFields, rememberPending, textField, transcriptTimestamp, type Fields,
} from "../shared/field-extract.js";
import { editOutcome, exitCodeField, resultText, withExitEvidence, withShellSkip } from "../shared/tool-outcome.js";
import type { DecodedHookInput, HarnessDecoder, NormalizedToolOutcome, TranscriptContext, TranscriptEvent, TranscriptReducer } from "../types.js";

function readShellOutcome(raw: Fields, eventName: "PostToolUse" | "PostToolUseFailure"): NormalizedToolOutcome | undefined {
  const input = asFields(field(raw, "tool_input"));
  const response = asFields(field(raw, "tool_response"));
  const failure = eventName === "PostToolUseFailure";
  const rawError = field(raw, "error");
  const error = resultText(rawError);
  const header = failure && error !== undefined ? parseExitCodeHeader(error) : undefined;
  const malformedError = failure && rawError !== undefined && error === undefined;
  const outcome = withExitEvidence({
    command: textField(input, TOOL_RESULT_STDIN_CAP_BYTES, "command"),
    cwd: textField(raw, TOOL_RESULT_STDIN_CAP_BYTES, "cwd"),
    exitCodeSource: "unknown",
    ...(header !== undefined || malformedError ? { errorExitHeader: header ?? null } : {}),
    output: error ?? resultText(field(response, "stderr")),
    isError: failure,
    toolUseId: textField(raw, 256, "tool_use_id"),
    agentId: textField(raw, 256, "agent_id"),
    interrupted: (failure ? field(raw, "is_interrupt") : field(response, "interrupted")) === true,
    background: field(input, "run_in_background") === true,
    edits: [],
    // Claude's own Bash/PowerShell success hook is an explicit success signal.
  }, exitCodeField(response) ?? (failure ? undefined : 0), header);
  const classified = withShellSkip(outcome);
  if (malformedError && classified.skipReason === "no-exit-header") {
    return undefined;
  }
  return classified;
}

function decodeHook(raw: unknown, now = Date.now()): DecodedHookInput | undefined {
  const record = asFields(raw);
  if (!record) return undefined;
  const sessionId = textField(record, 256, "session_id", "sessionId");
  const eventName = textField(record, 256, "hook_event_name", "hookEventName");
  const listening = readListeningFields(record, sessionId);
  const toolName = textField(record, 256, "tool_name", "toolName");
  const shellTool = toolName === "Bash" || toolName === "PowerShell";
  const readAgent = () => parseClaudeHookPayload(record, now);
  return {
    harnessId: "claude-code", eventName, sessionId, shellTool, listening,
    get agent() { return readAgent(); },
    get outcome() {
      if (eventName !== "PostToolUse" && eventName !== "PostToolUseFailure") return undefined;
      if (shellTool) {
        // The installed Claude shell hook uses the native event, tool, and session fields.
        const event = field(record, "hook_event_name");
        const tool = field(record, "tool_name");
        if ((event !== "PostToolUse" && event !== "PostToolUseFailure")
          || (tool !== "Bash" && tool !== "PowerShell")
          || !isSafeSessionId(field(record, "session_id"))) return undefined;
        return readShellOutcome(record, event);
      }
      return eventName === "PostToolUse" ? editOutcome(readAgent()) : undefined;
    },
  };
}

interface PendingCall {
  toolName: string;
  input: Fields | undefined;
  cwd?: string;
  turnRef?: string;
}

function transcriptOutput(content: unknown): string | undefined {
  if (!Array.isArray(content)) return resultText(content);
  const text = content.flatMap((value) => {
    const part = asFields(value);
    const text = field(part, "type") === "text" ? resultText(field(part, "text")) : undefined;
    return text === undefined ? [] : [text];
  });
  return text.length ? text.join("\n") : undefined;
}

/** Tool names whose `input.file_path` counts as a structural file touch. */
const FILE_TOOL_NAMES: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit"]);

/**
 * Files touched by Edit/Write/MultiEdit tool_use entries in one turn's
 * content array, for structural correlation downstream. Returns undefined
 * (not empty) when the turn touched no files, matching the canonical
 * event's optional field.
 */
function touchedFilesIn(content: readonly Record<string, unknown>[]): string[] | undefined {
  const files: string[] = [];
  for (const entry of content) {
    if (entry.type !== "tool_use") continue;
    if (typeof entry.name !== "string" || !FILE_TOOL_NAMES.has(entry.name)) continue;
    const filePath = field(asFields(entry.input), "file_path");
    if (typeof filePath === "string" && filePath.length > 0) files.push(filePath);
  }
  return files.length > 0 ? files : undefined;
}

function claudeTranscriptRationales(
  obj: Record<string, unknown>, logPath: string, cwd?: string,
): CanonicalRationaleEvent[] {
  if (obj.type !== "assistant") return [];
  const parts = field(asFields(obj.message), "content");
  if (!Array.isArray(parts)) return [];
  const content = parts.map(asFields).filter((entry) => entry !== undefined);
  const hasThinking = content.some((entry) =>
    entry.type === "thinking" && typeof entry.thinking === "string" && entry.thinking.length > 0);
  const parsedTs = typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : Number.NaN;
  const touchedFiles = touchedFilesIn(content);
  const common = {
    agent: "claude-code" as const,
    sessionId: typeof obj.sessionId === "string" ? obj.sessionId : "",
    turnRef: typeof obj.uuid === "string" ? obj.uuid : "",
    ts: Number.isNaN(parsedTs) ? 0 : parsedTs,
    cwd,
    logPath,
    ...(touchedFiles === undefined ? {} : { touchedFiles }),
  };
  const events: CanonicalRationaleEvent[] = [];
  for (const entry of content) {
    if (entry.type === "thinking" && typeof entry.thinking === "string" && entry.thinking.length > 0) {
      events.push({ ...common, text: entry.thinking, fidelity: "raw", source: "log-thinking" });
    } else if (!hasThinking && entry.type === "text" && typeof entry.text === "string" && entry.text.length > 0) {
      events.push({ ...common, text: entry.text, fidelity: "summary", source: "log-response" });
    }
  }
  return events;
}

export function createClaudeTranscriptReducer(ctx: TranscriptContext = {}): TranscriptReducer & {
  consumeRecord(value: unknown): TranscriptEvent[];
} {
  const pending = new Map<string, PendingCall>();
  function consumeRecord(value: unknown): TranscriptEvent[] {
    const row = asFields(value);
    if (!row || (row.type !== "assistant" && row.type !== "user")) return [];
    const sessionId = textField(row, 256, "sessionId") ?? ctx.sessionId;
    const cwd = textField(row, 4096, "cwd");
    const turnRef = textField(row, 256, "uuid");
    const content = field(asFields(row.message), "content");
    if (!Array.isArray(content)) return [];
    const events: TranscriptEvent[] = claudeTranscriptRationales(row, ctx.logPath ?? "", cwd)
      .map((event) => ({ kind: "rationale", ...event }));
    for (const value of content) {
      const part = asFields(value);
      if (!part) continue;
      if (row.type === "assistant" && part.type === "tool_use") {
        const id = textField(part, 256, "id");
        const toolName = textField(part, 256, "name");
        if (id && toolName) {
          rememberPending(pending, JSON.stringify([sessionId, id]), {
            toolName, input: asFields(part.input), cwd, turnRef,
          });
        }
      }
      if (row.type !== "user" || part.type !== "tool_result") continue;
      const id = textField(part, 256, "tool_use_id");
      if (!id) continue;
      const key = JSON.stringify([sessionId, id]);
      const call = pending.get(key);
      if (!call) continue;
      pending.delete(key);
      const resultCwd = call.cwd ?? cwd;
      const output = transcriptOutput(part.content);
      const isError = typeof part.is_error === "boolean" ? part.is_error : undefined;
      const ts = transcriptTimestamp(row.timestamp);
      const edit = isError === false ? editOutcome(parseClaudeHookPayload({
        hook_event_name: "PostToolUse", session_id: sessionId, prompt_id: call.turnRef,
        cwd: resultCwd, tool_name: call.toolName, tool_input: call.input,
      }, ts)) : undefined;
      events.push({
        kind: "tool-outcome", agent: "claude-code", toolName: call.toolName,
        sessionId, turnRef: call.turnRef, ts, cwd: resultCwd, logPath: ctx.logPath,
        outcome: withExitEvidence({
          ...edit, edits: edit?.edits ?? [], cwd: resultCwd, toolUseId: id,
          command: textField(call.input, 1024 * 1024, "command"),
          exitCodeSource: "unknown", output, isError,
        }, exitCodeField(part), isError === true && output !== undefined ? parseExitCodeHeader(output) : undefined),
      });
    }
    return events;
  }
  return {
    consume: (line) => consumeRecord(parseFields(line)),
    consumeRecord,
    finish() {
      pending.clear();
      return [];
    },
  };
}

export const claudeCodeDecoder: HarnessDecoder = {
  id: "claude-code",
  decodeHook,
  createTranscriptReducer: createClaudeTranscriptReducer,
  renderSyncResponse(noteText) {
    return capSyncResponse(JSON.stringify({
      hookSpecificOutput: { hookEventName: "PostToolUseFailure", additionalContext: noteText },
    }));
  },
};
