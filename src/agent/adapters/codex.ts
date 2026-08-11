import {
  batchKey,
  parseAgentEvent,
  type RationaleEvent,
} from "../schema.js";
import type { ParsedHookPayload } from "./claude-code.js";

type PlainRecord = Record<string, unknown>;

const EDIT_TOOLS: ReadonlySet<string> = new Set([
  "apply_patch",
  "Edit",
  "Write",
  "MultiEdit",
  "write_file",
  "edit_file",
]);

function isPlainRecord(value: unknown): value is PlainRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

function modernSession(payload: PlainRecord): string | undefined {
  return firstString(
    payload.session_id,
    payload.sessionId,
    payload["session-id"],
    payload.thread_id,
    payload.threadId,
    payload["thread-id"],
    payload.conversation_id,
    payload.conversationId,
    payload["conversation-id"],
  );
}

function turnId(payload: PlainRecord): string | undefined {
  return firstString(
    payload.turn_id,
    payload.turnId,
    payload["turn-id"],
    payload.prompt_id,
    payload.promptId,
    payload["prompt-id"],
  );
}

function notifyThread(payload: PlainRecord): string | undefined {
  return firstString(
    payload["thread-id"],
    payload.thread_id,
    payload.threadId,
  );
}

function notifyTurn(payload: PlainRecord): string | undefined {
  return firstString(payload["turn-id"], payload.turn_id, payload.turnId);
}

function eventName(payload: PlainRecord): string | undefined {
  return firstString(
    payload.hook_event_name,
    payload.hookEventName,
    payload["hook-event-name"],
    payload.event_name,
    payload.eventName,
    payload.event,
    payload.type,
  );
}

function rationaleEvent(text: string | undefined, now: number): RationaleEvent | undefined {
  if (!text) return undefined;
  const event = parseAgentEvent({
    v: 1,
    agent: "codex",
    kind: "rationale",
    ts: now,
    source: "notify",
    text,
  });
  return event?.kind === "rationale" ? event : undefined;
}

function changedPath(command: string): string | undefined {
  // Codex's apply_patch input is patch text, not a shell command. Match only
  // patch marker lines so arbitrary command text is never interpreted.
  const marker = /^\s*\*\*\*\s+(?:Update|Add|Delete)\s+File:\s*(.+?)\s*$/m.exec(command);
  if (marker?.[1]) return marker[1];

  // A conservative fallback for clients that send a unified git diff.
  const diff = /^\s*diff --git a\/([^\s]+) b\/([^\s]+)\s*$/m.exec(command);
  return diff?.[2];
}

function firstEdit(input: PlainRecord, tool: string): PlainRecord | undefined {
  if (tool !== "MultiEdit") return input;
  for (const key of ["edits", "changes", "operations"]) {
    const edits = input[key];
    if (Array.isArray(edits)) {
      return isPlainRecord(edits[0]) ? edits[0] : undefined;
    }
  }
  return undefined;
}

function editInput(payload: PlainRecord): PlainRecord | undefined {
  const input = payload.tool_input ?? payload.toolInput ?? payload.arguments;
  return isPlainRecord(input) ? input : undefined;
}

function parseModern(payload: PlainRecord, now: number): ParsedHookPayload {
  const session = modernSession(payload);
  const turn = turnId(payload);
  // Never merge events into shared literal fallback keys when a vendor omits identity.
  if (!session || !turn) return undefined;

  const key = batchKey("codex", session, turn);
  const cwd = firstString(payload.cwd, payload.working_directory, payload.workingDirectory);
  const name = eventName(payload);

  switch (name) {
    case "UserPromptSubmit": {
      const text = firstString(payload.prompt, payload.input, payload.user_prompt, payload.message);
      if (!text) return undefined;
      const event = parseAgentEvent({ v: 1, agent: "codex", kind: "intent", ts: now, cwd, text });
      return event ? { action: "append", key, event } : undefined;
    }
    case "PostToolUse": {
      const tool = firstString(payload.tool_name, payload.toolName, payload.tool);
      if (!tool || !EDIT_TOOLS.has(tool)) return undefined;
      const input = editInput(payload);
      if (!input) return undefined;
      const edit = firstEdit(input, tool);
      if (!edit) return undefined;

      const command = firstString(input.command, input.patch, edit.command, edit.patch);
      const path = tool === "apply_patch" && command
        ? changedPath(command)
        : undefined;
      const directPath = firstString(
        path,
        edit.file_path,
        edit.filePath,
        edit.path,
        edit.filename,
        edit.notebook_path,
        input.file_path,
        input.filePath,
        input.path,
        input.filename,
        input.notebook_path,
        payload.file_path,
        payload.filePath,
        payload.path,
        payload.filename,
      );
      if (!directPath) return undefined;

      const excerpt = firstString(
        edit.new_string,
        edit.newString,
        edit.new_source,
        edit.newSource,
        edit.file_text,
        edit.fileText,
        edit.content,
        edit.patch,
        input.new_string,
        input.newString,
        input.new_source,
        input.newSource,
        input.file_text,
        input.fileText,
        input.content,
        input.patch,
        command,
      );
      const event = parseAgentEvent({
        v: 1,
        agent: "codex",
        kind: "mechanism",
        ts: now,
        tool,
        path: directPath,
        excerpt,
      });
      return event ? { action: "append", key, event } : undefined;
    }
    case "Stop": {
      const text = firstString(
        payload.last_assistant_message,
        payload.lastAssistantMessage,
        payload["last-assistant-message"],
      );
      const rationale = rationaleEvent(text, now);
      return rationale ? { action: "close", key, rationale } : { action: "close", key };
    }
    default:
      return undefined;
  }
}

function parseNotify(payload: PlainRecord, now: number): ParsedHookPayload {
  const thread = notifyThread(payload);
  const turn = notifyTurn(payload);
  if (!thread || !turn) return undefined;
  const key = batchKey("codex", thread, turn);
  const text = firstString(
    payload["last-assistant-message"],
    payload.last_assistant_message,
    payload.lastAssistantMessage,
  );
  const rationale = rationaleEvent(text, now);
  return rationale ? { action: "close", key, rationale } : { action: "close", key };
}

export function parseCodexHookPayload(raw: unknown, now = Date.now()): ParsedHookPayload {
  try {
    if (!isPlainRecord(raw)) return undefined;
    if (raw.type === "agent-turn-complete") return parseNotify(raw, now);
    return parseModern(raw, now);
  } catch {
    return undefined;
  }
}
