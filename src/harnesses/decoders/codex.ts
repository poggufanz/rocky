import { parseCodexHookPayload } from "../../agent/adapters/codex.js";
import { codexRolloutExit, hasNoCodexNamespace, isSuccessfulCodexPatch, resolveCodexPath } from "../shared/codex-rollout.js";
import {
  asFields, field, parseFields, readListeningFields, rememberPending, textField, transcriptTimestamp, type Fields,
} from "../shared/field-extract.js";
import { editOutcome, exitCodeField, resultText, withExitEvidence, withShellSkip } from "../shared/tool-outcome.js";
import type { DecodedHookInput, HarnessDecoder, NormalizedToolOutcome, TranscriptContext, TranscriptEvent, TranscriptReducer } from "../types.js";

const EXEC_TOOLS = new Set(["exec_command", "functions.exec_command"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell", "shell_command", ...EXEC_TOOLS]);

function readCwd(raw: Fields | undefined): string | undefined {
  return textField(raw, 4096, "cwd", "working_directory", "workingDirectory", "workdir");
}

function readCommand(raw: Fields | undefined): string | undefined {
  return textField(raw, 1024 * 1024, "command", "cmd");
}

function readToolCwd(input: Fields | undefined, sessionCwd: string | undefined): string | undefined {
  const workdir = textField(input, 4096, "workdir");
  const inputCwd = textField(input, 4096, "cwd", "working_directory", "workingDirectory");
  const base = inputCwd === undefined ? sessionCwd : resolveCodexPath(inputCwd, sessionCwd);
  return workdir === undefined ? base : resolveCodexPath(workdir, base ?? sessionCwd);
}

function readOutput(raw: Fields | undefined): string | undefined {
  return resultText(field(raw, "output"))
    ?? resultText(field(raw, "aggregated_output"))
    ?? resultText(field(raw, "stderr"))
    ?? resultText(field(raw, "stdout"));
}

function readShellOutcome(raw: Fields): NormalizedToolOutcome {
  const input = asFields(field(raw, "tool_input") ?? field(raw, "toolInput") ?? field(raw, "arguments"));
  const result = field(raw, "tool_response") ?? field(raw, "toolResponse");
  const response = asFields(result);
  const error = resultText(field(raw, "error"));
  const output = readOutput(response) ?? resultText(result) ?? error;
  return withShellSkip(withExitEvidence({
    command: readCommand(input),
    cwd: readToolCwd(input, readCwd(raw)),
    exitCodeSource: "unknown",
    output,
    toolUseId: textField(raw, 256, "tool_use_id", "toolUseId", "call_id", "callId"),
    agentId: textField(raw, 256, "agent_id", "agentId"),
    interrupted: field(raw, "is_interrupt") === true || field(response, "interrupted") === true,
    background: field(input, "run_in_background") === true || field(input, "runInBackground") === true,
    edits: [],
  }, exitCodeField(response) ?? exitCodeField(raw)));
}

function decodeHook(raw: unknown, now = Date.now()): DecodedHookInput | undefined {
  const record = asFields(raw);
  if (!record) return undefined;
  const sessionId = textField(record, 256, "session_id", "sessionId", "session-id", "thread_id", "threadId", "thread-id",
    "conversation_id", "conversationId", "conversation-id");
  const eventName = textField(record, 256, "hook_event_name", "hookEventName", "hook-event-name",
    "event_name", "eventName", "event", "type");
  const listening = readListeningFields(record, sessionId);
  const toolName = textField(record, 256, "tool_name", "toolName", "tool");
  const shellTool = toolName !== undefined && SHELL_TOOLS.has(toolName);
  const readAgent = () => parseCodexHookPayload(record, now);
  return {
    harnessId: "codex", eventName, sessionId, shellTool, listening,
    get agent() { return readAgent(); },
    get outcome() {
      if (eventName !== "PostToolUse" && eventName !== "PostToolUseFailure") return undefined;
      return shellTool ? readShellOutcome(record) : editOutcome(readAgent());
    },
  };
}

function createTranscriptReducer(ctx: TranscriptContext = {}): TranscriptReducer {
  const items = new Map<string, Fields>();
  const calls = new Map<string, { toolName: string; input?: Fields; unnamespaced: boolean; outputType: string }>();
  let sessionId = ctx.sessionId;
  let cwd: string | undefined;

  function toolEvent(
    row: Fields,
    toolName: string,
    outcome: NormalizedToolOutcome,
    turnRef?: string,
  ): TranscriptEvent[] {
    return [{
      kind: "tool-outcome", agent: "codex", sessionId, turnRef,
      ts: transcriptTimestamp(row.timestamp), cwd: outcome.cwd, logPath: ctx.logPath,
      toolName, outcome,
    }];
  }

  function consumeItem(row: Fields): TranscriptEvent[] {
    const item = asFields(row.item);
    const id = textField(item, 256, "id");
    if (!item || !id) return [];
    const merged = { ...items.get(id), ...item };
    if (row.type !== "item.completed") {
      rememberPending(items, id, merged);
      return [];
    }
    items.delete(id);
    if (merged.type !== "command_execution") return [];
    const output = readOutput(merged);
    return toolEvent(row, "exec_command", withExitEvidence({
      command: readCommand(merged), cwd: readCwd(merged) ?? cwd,
      exitCodeSource: "unknown", output, toolUseId: id, edits: [],
    }, exitCodeField(merged)), textField(row, 256, "turn_id", "turnId"));
  }

  function consumeRollout(row: Fields): TranscriptEvent[] {
    const payload = asFields(row.payload);
    if (!payload) return [];
    if (row.type === "session_meta") {
      const nextSession = textField(payload, 256, "id");
      if (nextSession && nextSession !== sessionId) {
        items.clear();
        calls.clear();
        sessionId = nextSession;
      }
      cwd = readCwd(payload) ?? cwd;
      return [];
    }
    const id = textField(payload, 256, "call_id");
    if (!id) return [];
    if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      const toolName = textField(payload, 256, "name");
      const args = payload.arguments;
      const patch = payload.type === "custom_tool_call" ? resultText(payload.input) : undefined;
      const input = patch !== undefined ? { command: patch } : typeof args === "string" ? parseFields(args) : asFields(args);
      const outputType = payload.type === "function_call" ? "function_call_output" : "custom_tool_call_output";
      if (toolName) rememberPending(calls, id, { toolName, input, unnamespaced: hasNoCodexNamespace(payload), outputType });
      return [];
    }
    if (payload.type !== "function_call_output" && payload.type !== "custom_tool_call_output") return [];
    const call = calls.get(id);
    if (!call || call.outputType !== payload.type) return [];
    calls.delete(id);
    const output = resultText(payload.output);
    const toolCwd = readToolCwd(call.input, cwd);
    const unnamespaced = call.unnamespaced && hasNoCodexNamespace(payload);
    const edit = unnamespaced && call.toolName === "apply_patch" && payload.type === "custom_tool_call_output"
      && isSuccessfulCodexPatch(payload, output) ? editOutcome(parseCodexHookPayload({
        hook_event_name: "PostToolUse", session_id: sessionId, turn_id: id, cwd: toolCwd,
        tool_name: call.toolName, tool_input: call.input,
      }, transcriptTimestamp(row.timestamp))) : undefined;
    const builtinExec = unnamespaced && EXEC_TOOLS.has(call.toolName) && payload.type === "function_call_output";
    return toolEvent(row, call.toolName, codexRolloutExit({
      ...edit, command: SHELL_TOOLS.has(call.toolName) ? readCommand(call.input) : undefined,
      cwd: toolCwd, exitCodeSource: "unknown", output, toolUseId: id, edits: edit?.edits ?? [],
    }, payload, builtinExec));
  }

  return {
    consume(line) {
      const row = parseFields(line);
      if (!row) return [];
      switch (row.type) {
        case "item.started":
        case "item.updated":
        case "item.completed":
          return consumeItem(row);
        case "session_meta":
        case "response_item":
          return consumeRollout(row);
        default:
          return [];
      }
    },
    finish() {
      items.clear();
      calls.clear();
      return [];
    },
  };
}

export const codexDecoder: HarnessDecoder = { id: "codex", decodeHook, createTranscriptReducer };
