import { createHash } from "node:crypto";
import {
  batchKey,
  MAX_COVERAGE_PATHS,
  parseAgentEvent,
  type AgentEvent,
  type RationaleEvent,
} from "../schema.js";
import { canonicalPath } from "../../core/memory-read.js";
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

function changedPaths(command: string): { paths: string[]; invalid: boolean } {
  // Codex's apply_patch input is patch text, not a shell command. Match only
  // patch marker lines so arbitrary command text is never interpreted.
  const paths: string[] = [];
  let markerSeen = false;
  let invalid = false;
  const marker = /^[ \t]*\*\*\*[ \t]+(?:Update[ \t]+File|Add[ \t]+File|Delete[ \t]+File|Move[ \t]+to):(?:[ \t]*(.*))?$/u;
  const markerStart = /^[ \t]*\*\*\*[ \t]+(?:(?:Update|Add|Delete)[ \t]+File|Move[ \t]+to)(?=$|[ \t:])/u;
  for (const line of command.split(/\r?\n/u)) {
    // Treat a recognizable marker label as a marker even when its colon or
    // path is malformed.  This keeps a bad line from falling through to the
    // permissive unified-diff fallback and accidentally claiming complete
    // coverage for a different path.
    if (!markerStart.test(line)) continue;
    markerSeen = true;
    const match = marker.exec(line);
    const rawPath = match?.[1]?.trim() ?? "";
    if (!match || !rawPath || rawPath.startsWith("@@") || /[\u0000-\u001f\u007f-\u009f]/u.test(rawPath)) {
      invalid = true;
      continue;
    }
    const path = canonicalPath(rawPath, { platform: process.platform });
    if (!path) {
      invalid = true;
      continue;
    }
    if (!paths.includes(path)) paths.push(path);
  }
  if (markerSeen) return { paths, invalid };

  // A conservative fallback for clients that send a unified git diff.
  const diff = /^\s*diff --git a\/([^\s]+) b\/([^\s]+)\s*$/gmu;
  for (const match of command.matchAll(diff)) {
    const path = match[2] === undefined ? "" : canonicalPath(match[2]);
    if (path && !paths.includes(path)) paths.push(path);
  }
  return { paths, invalid: false };
}

function allEdits(input: PlainRecord, tool: string): { edits: PlainRecord[]; invalid: boolean } {
  if (tool !== "MultiEdit") return { edits: [input], invalid: false };
  for (const key of ["edits", "changes", "operations"]) {
    const edits = input[key];
    if (Array.isArray(edits)) {
      const output: PlainRecord[] = [];
      let invalid = false;
      const boundedLength = Math.min(edits.length, MAX_COVERAGE_PATHS * 2);
      if (edits.length > boundedLength) invalid = true;
      for (let index = 0; index < boundedLength; index += 1) {
        const edit = edits[index];
        if (!isPlainRecord(edit)) {
          invalid = true;
          continue;
        }
        output.push(edit);
      }
      return { edits: output, invalid };
    }
  }
  return { edits: [], invalid: true };
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
      const editBatch = allEdits(input, tool);
      const edits = editBatch.edits;
      if (edits.length === 0) return undefined;
      const command = firstString(input.command, input.patch, edits[0]?.command, edits[0]?.patch);
      const patchResult = tool === "apply_patch" && command ? changedPaths(command) : { paths: [], invalid: false };
      const patchPaths = patchResult.paths;
      const candidates: Array<{ path: string; edit: PlainRecord; excerpt?: string }> = [];
      let invalidCoverage = editBatch.invalid || patchResult.invalid;
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
            ...(tool === "MultiEdit" ? [] : [
              input.file_path,
              input.filePath,
              input.path,
              input.filename,
              input.notebook_path,
            ]),
            ...(tool === "MultiEdit" ? [] : [
              payload.file_path,
              payload.filePath,
              payload.path,
              payload.filename,
            ]),
          );
          const display = canonicalPath(directPath ?? "", { platform: process.platform });
          const identity = canonicalPath(directPath ?? "", { platform: process.platform, cwd });
          if (!display || !identity) {
            invalidCoverage = true;
            continue;
          }
          candidates.push({ path: display, edit });
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
        if (candidate.path.length > 1024) {
          invalidCoverage = true;
          continue;
        }
        const display = canonicalPath(candidate.path, { platform: process.platform });
        const identity = canonicalPath(candidate.path, { platform: process.platform, cwd });
        if (!display || !identity) continue;
        if (display.length > 1024 || identity.length > 1024) {
          invalidCoverage = true;
          continue;
        }
        const event = parseAgentEvent({
          v: 1, agent: "codex", kind: "mechanism", ts: now, tool,
          path: display, excerpt, provenance: "tool-observed",
        });
        if (event) byPath.set(identity, event);
      }
      const bounded = [...byPath.values()].slice(0, MAX_ADAPTER_EVENTS);
      if (bounded.length === 0) return undefined;
      const truncatedFiles = Math.max(0, byPath.size - bounded.length);
      const coveragePaths = [...byPath.values()].slice(0, MAX_COVERAGE_PATHS)
        .filter((event): event is Extract<AgentEvent, { kind: "mechanism" }> => event.kind === "mechanism")
        .map((event) => event.path);
      const coveragePathsComplete = !invalidCoverage && byPath.size <= MAX_COVERAGE_PATHS;
      const markedEvents = bounded.map((event, index) => index === 0
        ? {
          ...event,
          ...(truncatedFiles > 0 ? { truncatedFiles } : {}),
          coveragePaths,
          coveragePathsComplete,
        }
        : event);
      return {
        action: "append", key, events: markedEvents,
        event: markedEvents[0]!,
        ...(truncatedFiles > 0 ? { truncatedFiles } : {}),
        coveragePaths,
        coveragePathsComplete,
        coverageCwd: cwd,
        coverageDigest: createHash("sha256").update(JSON.stringify([...byPath.keys()].sort()), "utf8").digest("hex"),
        coverageCandidateCount: byPath.size,
        coverageCandidateCountExact: !invalidCoverage,
        coveragePlatform: process.platform,
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
