import { parseClaudeHookPayload } from "../../agent/adapters/claude-code.js";
import { claudeTranscriptRationales } from "../../agent/logs/claude-code.js";
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
  const outcome = withExitEvidence({
    command: textField(input, 1024 * 1024, "command"),
    cwd: textField(raw, 4096, "cwd"),
    exitCodeSource: "unknown",
    output: error ?? resultText(field(response, "stderr")),
    isError: failure,
    toolUseId: textField(raw, 256, "tool_use_id"),
    agentId: textField(raw, 256, "agent_id"),
    interrupted: (failure ? field(raw, "is_interrupt") : field(response, "interrupted")) === true,
    background: field(input, "run_in_background") === true,
    edits: [],
    // Claude's own Bash/PowerShell success hook is an explicit success signal.
  }, exitCodeField(response) ?? (failure ? undefined : 0), failure ? error : undefined);
  const classified = withShellSkip(outcome);
  if (failure && rawError !== undefined && error === undefined && classified.skipReason === "no-exit-header") {
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
      if (shellTool) return readShellOutcome(record, eventName);
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

function createTranscriptReducer(ctx: TranscriptContext = {}): TranscriptReducer {
  const pending = new Map<string, PendingCall>();
  return {
    consume(line) {
      const row = parseFields(line);
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
          }, exitCodeField(part), isError === true ? output : undefined),
        });
      }
      return events;
    },
    finish() {
      pending.clear();
      return [];
    },
  };
}

export const claudeCodeDecoder: HarnessDecoder = {
  id: "claude-code",
  decodeHook,
  createTranscriptReducer,
  renderSyncResponse(noteText) {
    return capSyncResponse(JSON.stringify({
      hookSpecificOutput: { hookEventName: "PostToolUseFailure", additionalContext: noteText },
    }));
  },
};
