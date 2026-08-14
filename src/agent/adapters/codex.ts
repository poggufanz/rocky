import {
  batchKey,
  MAX_COVERAGE_PATHS,
  parseAgentEvent,
  type AgentEvent,
  type RationaleEvent,
} from "../schema.js";
import { MAX_ADAPTER_EVENTS, type ParsedHookPayload } from "./claude-code.js";

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

function changedPaths(command: string): string[] {
  // Codex's apply_patch input is patch text, not a shell command. Match only
  // patch marker lines so arbitrary command text is never interpreted.
  const paths: string[] = [];
  const marker = /^\s*\*\*\*\s+(?:Update|Add|Delete)\s+File:\s*(.+?)\s*$/gmu;
  for (const match of command.matchAll(marker)) {
    const path = match[1]?.trim();
    if (path && !paths.includes(path)) paths.push(path);
  }
  if (paths.length > 0) return paths;

  // A conservative fallback for clients that send a unified git diff.
  const diff = /^\s*diff --git a\/([^\s]+) b\/([^\s]+)\s*$/gmu;
  for (const match of command.matchAll(diff)) {
    const path = match[2]?.trim();
    if (path && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

function allEdits(input: PlainRecord, tool: string): PlainRecord[] {
  if (tool !== "MultiEdit") return [input];
  for (const key of ["edits", "changes", "operations"]) {
    const edits = input[key];
    if (Array.isArray(edits)) {
      return edits.filter(isPlainRecord);
    }
  }
  return [];
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
      return event ? { action: "append", key, events: [event], event } : undefined;
    }
    case "PostToolUse": {
      const tool = firstString(payload.tool_name, payload.toolName, payload.tool);
      if (!tool || !EDIT_TOOLS.has(tool)) return undefined;
      const input = editInput(payload);
      if (!input) return undefined;
      const edits = allEdits(input, tool);
      if (edits.length === 0) return undefined;
      const command = firstString(input.command, input.patch, edits[0]?.command, edits[0]?.patch);
      const patchPaths = tool === "apply_patch" && command ? changedPaths(command) : [];
      const candidates: Array<{ path: string; edit: PlainRecord; excerpt?: string }> = [];
      if (patchPaths.length > 0) {
        for (const path of patchPaths) candidates.push({ path, edit: edits[0] ?? input });
      } else {
        for (const edit of edits) {
          const directPath = firstString(
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
          if (!directPath) continue;
          candidates.push({ path: directPath, edit });
        }
      }
      const byPath = new Map<string, AgentEvent>();
      for (const candidate of candidates) {
        const edit = candidate.edit;
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
          v: 1, agent: "codex", kind: "mechanism", ts: now, tool,
          path: candidate.path, excerpt, provenance: "tool-observed",
        });
        if (event) byPath.set(candidate.path, event);
      }
      const bounded = [...byPath.values()].slice(0, MAX_ADAPTER_EVENTS);
      if (bounded.length === 0) return undefined;
      const truncatedFiles = byPath.size - bounded.length;
      const coveragePaths = truncatedFiles > 0 ? [...byPath.keys()].slice(0, MAX_COVERAGE_PATHS) : undefined;
      const coveragePathsComplete = coveragePaths === undefined ? undefined : byPath.size <= MAX_COVERAGE_PATHS;
      const markedEvents = bounded.map((event, index) => index === 0
        ? {
          ...event,
          ...(truncatedFiles > 0 ? { truncatedFiles } : {}),
          ...(coveragePaths === undefined ? {} : { coveragePaths }),
          ...(coveragePathsComplete === undefined ? {} : { coveragePathsComplete }),
        }
        : event);
      return {
        action: "append", key, events: markedEvents,
        event: markedEvents[0]!,
        ...(truncatedFiles > 0 ? { truncatedFiles } : {}),
        ...(coveragePaths === undefined ? {} : {
          coveragePaths,
          coveragePathsComplete: byPath.size <= MAX_COVERAGE_PATHS,
        }),
      };
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
