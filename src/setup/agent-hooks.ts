import { lstatSync, readFileSync } from "node:fs";
import hostPath, { dirname, join, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveClaudeCodeUserConfig } from "./claude-code.js";
import {
  atomicWriteJsonIfUnchanged,
  inspectJsonTransaction,
  readJsonObject,
} from "./json-config.js";
import type { JsonMutationGuard, JsonReadResult } from "./json-config.js";
import { createPromptPort } from "./prompt.js";
import { detail, heading, say } from "../ui/rocky.js";

const CLAUDE_MARKER = "hook agent-event claude-code";
const SESSION_MARKER = "hook session-start claude-code";
const TOOL_RESULT_MARKER = "hook tool-result claude-code";
const GATE_MARKER = "hook gate-event claude-code";
const POST_TOOL_MATCHER = "Edit|Write|MultiEdit|NotebookEdit";
const COMMAND_TOOL_MATCHER = "Bash|PowerShell";
/** Tools the gate dispatcher actually enforces on; see agent/gate.ts GATED_TOOLS. */
const GATE_MATCHER = "Edit|Write|MultiEdit";
const AGENT_HOOK_CONFIRMATION = "Install agent hooks for Claude Code now?";
const GENERIC_ERROR = "Claude Code agent hooks update cannot complete";
const GENERIC_ERROR_NOUN: HookErrorNoun = "agent hooks";

/** Which hook family names the user-facing error detail. No default: every caller chooses. */
export type HookErrorNoun = "agent hooks" | "desk hooks";

function genericError(noun: HookErrorNoun): string {
  return noun === "agent hooks" ? GENERIC_ERROR : "Claude Code desk hooks update cannot complete";
}

function retainedConfigDetail(noun: HookErrorNoun, recoveryPath: string): string {
  const head = noun === "agent hooks"
    ? "Claude Code agent hooks previous config retained"
    : "Claude Code desk hooks previous config retained";
  return `${head}; manual recovery: ${recoveryPath}`;
}
const MISSING_PARENT_PROTECTION = process.platform === "win32" ? "private ACL" : "mode 0700";
const MISSING_PARENT_ERROR = `Claude Code settings parent missing; create private directory for Claude settings with ${MISSING_PARENT_PROTECTION}, then rerun setup`;

export const CLAUDE_CAPTURE_CAPABILITY_NOTICE =
  "Claude Code capture requires hook payload field `prompt_id`; without `prompt_id`, Rocky records nothing and never merges turns.";

export interface AgentHooksTarget {
  settingsPath: string;
}

/** The settings file setup may write, or the reason it must not guess one. */
export type AgentHooksTargetResolution =
  | { status: "resolved"; target: AgentHooksTarget }
  | { status: "refused"; reason: "empty" | "unusable" };

export type AgentHooksAction = "install" | "uninstall" | "status";

export interface AgentHooksConfirmation {
  confirm(message: string): Promise<boolean>;
}

export interface AgentHooksRuntimeOptions {
  /** Supply the already validated command from setup's injected paths. */
  command?: string;
  /** Supply the already validated SessionStart command from setup's injected paths. */
  sessionCommand?: string;
  /** Supply the already validated tool-result command from setup's injected paths. */
  toolResultCommand?: string;
  /**
   * The rationale-gate PreToolUse command. Install/uninstall treat this as
   * an explicit on/off switch: undefined means no gate entry, full stop, no
   * fallback derivation. Status treats a missing value as "derive the
   * canonical gate command" instead, since status must validate whichever
   * shape (with or without a gate) is actually on disk.
   */
  gateCommand?: string;
  nodePath?: string;
  entryPath?: string;
  confirmation?: AgentHooksConfirmation;
  detail?: (message: string) => void;
  /** Test seam for proving the transactional writer refuses a late race. */
  beforeWrite?: () => void;
  /**
   * Test seam: runs right after a write lands and before the retained-copy
   * report is decided. Receives the retained copy's path, when one exists.
   */
  afterWrite?: (recoveryPath: string | undefined) => void;
}

export interface AgentHooksOperationResult {
  status: "written" | "unchanged" | "declined" | "error";
  detail?: string;
}

export interface AgentHooksStatusResult {
  claudeCode: "installed" | "absent" | "unreadable";
}

export interface JsonObject {
  [key: string]: unknown;
}

interface PathIdentity {
  path: string;
  dev: number;
  ino: number;
}

interface Topology {
  targetExists: boolean;
  targetIdentity?: { dev: number; ino: number };
  directories: readonly PathIdentity[];
  /** Missing parent components, nearest root first. */
  missing: readonly string[];
}

export interface CurrentConfig {
  read: ReadableJsonResult;
  topology: Topology;
}

type ReadableJsonResult = Extract<JsonReadResult, { status: "missing" | "valid" }>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbsolutePortable(value: string): boolean {
  return posix.isAbsolute(value) || win32.isAbsolute(value);
}

function hasControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function isEphemeralPath(value: string): boolean {
  const segments = value
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
  return segments.includes("_npx")
    || segments.includes("_cacache")
    || segments.includes(".cache")
    || segments.includes("npm-cache")
    || (segments.includes("node_modules") && segments.includes("cache"));
}

export function requireSafeAbsolutePath(value: string, label: string): string {
  if (!isAbsolutePortable(value)) throw new Error(`${label} path must be absolute`);
  if (hasControl(value)) throw new Error(`${label} path is unsafe`);
  if (isEphemeralPath(value)) throw new Error(`${label} path is ephemeral`);
  return value;
}

function quotePosixPath(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll("$", "\\$")
    .replaceAll("`", "\\`")
    .replaceAll("\"", "\\\"")}"`;
}

function quoteWindowsPath(value: string): string {
  // Claude Code stores a command line. Reject cmd.exe expansion characters
  // instead of trying to make a shell escape that changes across hosts.
  if (/["%!]/.test(value)) throw new Error("path is unsafe for Windows command line");
  const trailing = value.match(/\\+$/)?.[0] ?? "";
  const body = trailing.length === 0 ? value : value.slice(0, -trailing.length);
  return `"${body}${trailing.replaceAll("\\", "\\\\")}"`;
}

export function quotePath(value: string): string {
  return win32.isAbsolute(value) && !posix.isAbsolute(value)
    ? quoteWindowsPath(value)
    : quotePosixPath(value);
}

function quoteLegacyPosixPath(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll("$", "\\$")
    .replaceAll("`", "\\`")
    .replaceAll("\"", "\\\"")
    .replaceAll("!", "\\!")}"`;
}

function defaultEntryPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "index.js");
}

/** Build one absolute, safely quoted Rocky hook command. */
export function rockyHookCommand(
  adapter: "claude-code" | "codex",
  execPath = process.execPath,
  scriptPath = defaultEntryPath(),
): string {
  const executable = requireSafeAbsolutePath(execPath, "Node");
  const script = requireSafeAbsolutePath(scriptPath, "entry");
  return `${quotePath(executable)} ${quotePath(script)} hook agent-event ${adapter}`;
}

/** Build one absolute, safely quoted Rocky rationale-gate PreToolUse command. */
export function rockyGateHookCommand(
  execPath = process.execPath,
  scriptPath = defaultEntryPath(),
): string {
  const executable = requireSafeAbsolutePath(execPath, "Node");
  const script = requireSafeAbsolutePath(scriptPath, "entry");
  return `${quotePath(executable)} ${quotePath(script)} ${GATE_MARKER}`;
}

/** Build one absolute, safely quoted Rocky SessionStart hook command. */
export function rockySessionStartHookCommand(
  execPath = process.execPath,
  scriptPath = defaultEntryPath(),
): string {
  const executable = requireSafeAbsolutePath(execPath, "Node");
  const script = requireSafeAbsolutePath(scriptPath, "entry");
  return `${quotePath(executable)} ${quotePath(script)} ${SESSION_MARKER}`;
}

/** Build one absolute, safely quoted Rocky tool-result hook command. */
export function rockyToolResultHookCommand(
  execPath = process.execPath,
  scriptPath = defaultEntryPath(),
): string {
  const executable = requireSafeAbsolutePath(execPath, "Node");
  const script = requireSafeAbsolutePath(scriptPath, "entry");
  return `${quotePath(executable)} ${quotePath(script)} ${TOOL_RESULT_MARKER}`;
}

export interface ClaudeHookCommands {
  agent: string;
  session: string;
  toolResult: string;
  gate: string | undefined;
}

interface HookCommandPaths {
  executable: string;
  script: string;
}

function isWindowsCommandPath(raw: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("\\\\");
}

function decodeWindowsCommandPath(raw: string): string {
  const trailing = raw.match(/\\+$/)?.[0];
  if (trailing === undefined) return raw;
  if (trailing.length % 2 !== 0) throw new Error("Windows hook path has malformed trailing escape");
  return `${raw.slice(0, -trailing.length)}${"\\".repeat(trailing.length / 2)}`;
}

function decodePosixCommandPath(raw: string, allowLegacyBang = false): string {
  let value = "";
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (character !== "\\") {
      value += character;
      continue;
    }
    const escaped = raw[index + 1];
    const allowedEscapes = ["\\", "$", "`", '"', ...(allowLegacyBang ? ["!"] : [])];
    if (escaped === undefined || !allowedEscapes.includes(escaped)) {
      throw new Error("POSIX hook path has ambiguous escape");
    }
    value += escaped;
    index += 1;
  }
  return value;
}

function decodeCommandPath(raw: string, allowLegacyBang = false): string {
  return isWindowsCommandPath(raw)
    ? decodeWindowsCommandPath(raw)
    : decodePosixCommandPath(raw, allowLegacyBang);
}

export function parseQuotedCommandPath(
  command: string,
  start: number,
  allowLegacyBang = false,
): { value: string; next: number } {
  if (command[start] !== '"') throw new Error("hook command must quote executable paths");
  let raw = "";
  for (let index = start + 1; index < command.length; index += 1) {
    const character = command[index];
    if (character === '"') {
      let slashes = 0;
      for (let cursor = raw.length - 1; cursor >= 0 && raw[cursor] === "\\"; cursor -= 1) slashes += 1;
      if (slashes % 2 === 0) return { value: decodeCommandPath(raw, allowLegacyBang), next: index + 1 };
    }
    raw += character;
  }
  throw new Error("hook command has unterminated path");
}

function parseCodexHookCommand(command: string): HookCommandPaths {
  if (typeof command !== "string" || command.length === 0 || hasControl(command)) {
    throw new Error("hook command is invalid");
  }
  const first = parseQuotedCommandPath(command, 0);
  let index = first.next;
  if (command[index] !== " ") throw new Error("hook command must separate executable paths");
  while (command[index] === " ") index += 1;
  const second = parseQuotedCommandPath(command, index);
  if (command.slice(second.next) !== " hook agent-event codex") {
    throw new Error("hook command is not a Codex agent hook");
  }
  const executable = requireSafeAbsolutePath(first.value, "Node");
  const script = requireSafeAbsolutePath(second.value, "entry");
  if (rockyHookCommand("codex", executable, script) !== command) {
    throw new Error("hook command is not canonical");
  }
  return { executable, script };
}

/**
 * Recognize the exact Claude command shape Rocky writes, including the old
 * quoted-path spelling and the historical bare `rocky` command. A marker in
 * an argument or an otherwise unrelated shell command is foreign.
 */
function isRockyClaudeHookCommand(command: string): boolean {
  if (typeof command !== "string" || command.length === 0 || hasControl(command)) return false;
  if (command === `rocky ${CLAUDE_MARKER}`) return true;
  const suffix = ` ${CLAUDE_MARKER}`;
  if (!command.endsWith(suffix)) return false;
  const paths = command.slice(0, -suffix.length);
  try {
    const first = parseQuotedCommandPath(paths, 0, true);
    if (paths[first.next] !== " ") return false;
    const second = parseQuotedCommandPath(paths, first.next + 1, true);
    if (second.next !== paths.length) return false;
    requireSafeAbsolutePath(first.value, "Node");
    requireSafeAbsolutePath(second.value, "entry");
    try {
      if (rockyHookCommand("claude-code", first.value, second.value) === command) return true;
    } catch {
      // A command is only legacy-compatible when its exact old POSIX spelling
      // can be reproduced below. Unsafe/noncanonical Windows paths stay foreign.
    }
    if (isWindowsCommandPath(first.value) || isWindowsCommandPath(second.value)) return false;
    return `${quoteLegacyPosixPath(first.value)} ${quoteLegacyPosixPath(second.value)} ${CLAUDE_MARKER}` === command;
  } catch {
    return false;
  }
}

/**
 * Recognize the canonical `"<node>" "<entry>" <marker>` command shape Rocky
 * writes for hook families that have no legacy bare-`rocky` or pre-canonical
 * spelling to stay compatible with. Marker has no default: every caller chooses.
 */
function isCanonicalRockyHookCommand(command: string, marker: string): boolean {
  if (typeof command !== "string" || command.length === 0 || hasControl(command)) return false;
  if (marker.length === 0) return false;
  const suffix = ` ${marker}`;
  if (!command.endsWith(suffix)) return false;
  const paths = command.slice(0, -suffix.length);
  try {
    const first = parseQuotedCommandPath(paths, 0, true);
    if (paths[first.next] !== " ") return false;
    const second = parseQuotedCommandPath(paths, first.next + 1, true);
    if (second.next !== paths.length) return false;
    const executable = requireSafeAbsolutePath(first.value, "Node");
    const script = requireSafeAbsolutePath(second.value, "entry");
    return `${quotePath(executable)} ${quotePath(script)} ${marker}` === command;
  } catch {
    return false;
  }
}

/**
 * Recognize the exact gate command Rocky writes for the PreToolUse
 * rationale-gate entry. The gate is new in v0.7, so unlike the agent-event
 * marker above it has no legacy bare-`rocky` or pre-canonical spelling to
 * stay compatible with - only the current `rockyGateHookCommand` shape.
 */
function isRockyGateHookCommand(command: string): boolean {
  return isCanonicalRockyHookCommand(command, GATE_MARKER);
}

/**
 * Recognize the exact SessionStart command Rocky writes. Accepts only the
 * current `rockySessionStartHookCommand` shape.
 */
function isRockySessionHookCommand(command: string): boolean {
  return isCanonicalRockyHookCommand(command, SESSION_MARKER);
}

/**
 * Recognize the exact tool-result command Rocky writes. Accepts only the
 * current `rockyToolResultHookCommand` shape.
 */
function isRockyToolResultHookCommand(command: string): boolean {
  return isCanonicalRockyHookCommand(command, TOOL_RESULT_MARKER);
}

function tomlBasicString(value: string): string {
  return JSON.stringify(value);
}

function tomlCommandString(command: string): string {
  // Literal TOML strings preserve the command's shell quoting, including
  // Windows separators. Paths containing an apostrophe use a basic string so
  // the resulting snippet remains valid TOML rather than truncating the hook.
  return command.includes("'") ? tomlBasicString(command) : `'${command}'`;
}

/** Build paste-ready Codex config.toml entries without touching user config. */
export function codexConfigSnippet(command: string): string {
  const paths = parseCodexHookCommand(command);
  const argv = [paths.executable, paths.script, "hook", "agent-event", "codex"];
  const lifecycle = (event: "UserPromptSubmit" | "PostToolUse" | "Stop", matcher?: string): string[] => [
    `[[hooks.${event}]]`,
    ...(matcher === undefined ? [] : [`matcher = ${tomlBasicString(matcher)}`]),
    "",
    `[[hooks.${event}.hooks]]`,
    'type = "command"',
    `command = ${tomlCommandString(command)}`,
  ];
  return [
    `notify = [${argv.map(tomlBasicString).join(", ")}]`,
    "",
    ...lifecycle("UserPromptSubmit"),
    "",
    ...lifecycle("PostToolUse", "^apply_patch$"),
    "",
    ...lifecycle("Stop"),
    "",
  ].join("\n");
}

/** Print Codex's manual setup guidance; no Codex config file is read or written. */
export function printCodexAgentHooks(command = rockyHookCommand("codex")): void {
  heading("Codex agent hooks");
  detail(codexConfigSnippet(command));
  say("Codex config is TOML, and rocky does not edit it. Paste the snippet above into your Codex config yourself.");
  detail("Trust warning: review and trust changed command hooks through Codex /hooks before they run.");
  detail("The advisory PreToolUse hook needs Claude Code hooks. Other agents use the notify lane.");
}

/** Build the exact Claude Code event groups owned by Rocky. */
export function buildClaudeHookEntries(
  commands: Omit<ClaudeHookCommands, "gate">,
): Record<string, unknown> {
  if (typeof commands.agent !== "string" || commands.agent.length === 0 || hasControl(commands.agent)) {
    throw new Error("hook command is invalid");
  }
  if (typeof commands.session !== "string" || commands.session.length === 0 || hasControl(commands.session)) {
    throw new Error("session hook command is invalid");
  }
  if (typeof commands.toolResult !== "string" || commands.toolResult.length === 0 || hasControl(commands.toolResult)) {
    throw new Error("tool-result hook command is invalid");
  }
  return {
    SessionStart: [{ hooks: [{ type: "command", command: commands.session }] }],
    UserPromptSubmit: [{ hooks: [{ type: "command", command: commands.agent }] }],
    PostToolUse: [
      { matcher: POST_TOOL_MATCHER, hooks: [{ type: "command", command: commands.agent }] },
      { matcher: COMMAND_TOOL_MATCHER, hooks: [{ type: "command", command: commands.toolResult, async: true }] },
    ],
    PostToolUseFailure: [
      { matcher: COMMAND_TOOL_MATCHER, hooks: [{ type: "command", command: commands.toolResult, timeout: 5 }] },
    ],
    Stop: [{ hooks: [{ type: "command", command: commands.agent }] }],
  };
}

/** Build the Rocky-owned PreToolUse rationale-gate group. Opt-in, so callers add it themselves. */
function buildGateHookGroup(command: string): Record<string, unknown> {
  return { matcher: GATE_MATCHER, hooks: [{ type: "command", command }] };
}

function validateHookItem(value: unknown): asserts value is JsonObject {
  if (!isObject(value)) throw new Error("hook entry must be an object");
  if (value.type !== undefined && typeof value.type !== "string") {
    throw new Error("hook type must be a string");
  }
  if (value.command !== undefined && typeof value.command !== "string") {
    throw new Error("hook command must be a string");
  }
}

function validateGroup(value: unknown): asserts value is JsonObject {
  if (!isObject(value)) throw new Error("hook group must be an object");
  if (!Array.isArray(value.hooks)) throw new Error("hook group hooks must be an array");
  for (const hook of value.hooks) validateHookItem(hook);
}

export function validateHooks(root: JsonObject): JsonObject | undefined {
  if (root.hooks === undefined) return undefined;
  if (!isObject(root.hooks)) throw new Error("hooks must be an object");
  for (const value of Object.values(root.hooks)) {
    if (!Array.isArray(value)) throw new Error("hook event must be an array");
    for (const group of value) validateGroup(group);
  }
  return root.hooks;
}

function hookCommand(value: JsonObject): string | undefined {
  return typeof value.command === "string" ? value.command : undefined;
}

function isRockyHook(value: JsonObject): boolean {
  const command = hookCommand(value);
  return command !== undefined
    && (
      isRockyClaudeHookCommand(command)
      || isRockyGateHookCommand(command)
      || isRockySessionHookCommand(command)
      || isRockyToolResultHookCommand(command)
    );
}

function isRockyAgentHook(value: JsonObject): boolean {
  const command = hookCommand(value);
  return command !== undefined && isRockyClaudeHookCommand(command);
}

export function stripOwnedGroups(groups: readonly unknown[], isOwned: (hook: JsonObject) => boolean): unknown[] {
  const kept: unknown[] = [];
  for (const groupValue of groups) {
    const group = groupValue as JsonObject;
    if (group.hooks === undefined || !Array.isArray(group.hooks)) {
      kept.push(groupValue);
      continue;
    }
    const hooks = group.hooks as unknown[];
    const foreignHooks = hooks.filter((hookValue) => !isOwned(hookValue as JsonObject));
    if (foreignHooks.length === 0) {
      if (hooks.length === 0) kept.push(groupValue);
      // A group containing only Rocky hooks disappears. A foreign hook in a
      // mixed group remains in its original group and original order.
      continue;
    }
    if (foreignHooks.length === hooks.length) {
      kept.push(groupValue);
    } else {
      kept.push({ ...group, hooks: foreignHooks });
    }
  }
  return kept;
}

export function withHookArrays(root: JsonObject, callback: (hooks: JsonObject) => void): Record<string, unknown> {
  const existingHooks = validateHooks(root);
  const result: JsonObject = { ...root };
  const hooks: JsonObject = existingHooks === undefined ? {} : { ...existingHooks };
  callback(hooks);
  if (Object.keys(hooks).length === 0) delete result.hooks;
  else result.hooks = hooks;
  return result;
}

/**
 * Remove old Rocky groups and append the current Rocky groups for each event.
 * Foreign root keys, events, groups, and nested hooks retain their order.
 */
export function mergeClaudeHooks(
  existing: Record<string, unknown>,
  commands: ClaudeHookCommands,
): Record<string, unknown> {
  if (!isObject(existing)) throw new Error("Claude settings root must be an object");
  const entries = buildClaudeHookEntries({
    agent: commands.agent,
    session: commands.session,
    toolResult: commands.toolResult,
  });
  return withHookArrays(existing, (hooks) => {
    for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "PostToolUseFailure", "Stop"] as const) {
      const current = hooks[event];
      const groups = current === undefined ? [] : current;
      if (!Array.isArray(groups)) throw new Error("hook event must be an array");
      const clean = stripOwnedGroups(groups, isRockyHook);
      const entry = entries[event];
      if (!Array.isArray(entry) || entry.length === 0) throw new Error("hook entry shape is invalid");
      clean.push(...entry);
      hooks[event] = clean;
    }
    // PreToolUse (the advisory PreToolUse hook) is opt-in: rewritten from scratch like
    // the five events above, but only re-added when a gate command is
    // supplied. A rerun with no gate command strips a previously installed
    // gate entry instead of leaving it stale.
    const currentPreToolUse = hooks.PreToolUse;
    const preToolUseGroups = currentPreToolUse === undefined ? [] : currentPreToolUse;
    if (!Array.isArray(preToolUseGroups)) throw new Error("hook event must be an array");
    const cleanPreToolUse = stripOwnedGroups(preToolUseGroups, isRockyHook);
    if (commands.gate !== undefined) cleanPreToolUse.push(buildGateHookGroup(commands.gate));
    if (cleanPreToolUse.length === 0) delete hooks.PreToolUse;
    else hooks.PreToolUse = cleanPreToolUse;
  });
}

/** Remove owned groups while preserving all foreign configuration. */
export function removeOwnedHooks(
  existing: Record<string, unknown>,
  isOwned: (hook: JsonObject) => boolean,
): Record<string, unknown> {
  if (!isObject(existing)) throw new Error("Claude settings root must be an object");
  return withHookArrays(existing, (hooks) => {
    for (const event of Object.keys(hooks)) {
      const groups = hooks[event];
      if (!Array.isArray(groups)) throw new Error("hook event must be an array");
      const hadOwned = groups.some((groupValue) => {
        const group = groupValue as JsonObject;
        return isObject(group) && Array.isArray(group.hooks)
          && (group.hooks as unknown[]).some((hook) => isObject(hook) && isOwned(hook));
      });
      const clean = stripOwnedGroups(groups, isOwned);
      if (hadOwned && clean.length === 0) delete hooks[event];
      else if (hadOwned) hooks[event] = clean;
    }
  });
}

/** Remove Rocky-owned groups while preserving all foreign configuration. */
export function removeClaudeHooks(existing: Record<string, unknown>): Record<string, unknown> {
  return removeOwnedHooks(existing, isRockyHook);
}

/** Remove Rocky agent-event groups while preserving the gate and all foreign configuration. */
export function removeAgentEventHooks(existing: Record<string, unknown>): Record<string, unknown> {
  return removeOwnedHooks(existing, isRockyAgentHook);
}

function ownedHookGroupsByEvent(
  root: Record<string, unknown>,
  isOwned: (hook: JsonObject) => boolean,
): JsonObject {
  const hooks = validateHooks(root) ?? {};
  const owned: JsonObject = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = groups.filter((groupValue) => isObject(groupValue)
      && Array.isArray(groupValue.hooks)
      && (groupValue.hooks as unknown[]).some((hookValue) => isObject(hookValue) && isOwned(hookValue)));
    if (kept.length > 0) owned[event] = kept;
  }
  return owned;
}

/**
 * True when any hook group holds a command `isOwned` accepts. Malformed hook
 * containers hold nothing readable and report false; a merge or removal
 * refuses them on its own.
 */
export function hasOwnedHookCommand(
  root: Record<string, unknown>,
  isOwned: (command: string) => boolean,
  events?: readonly string[],
): boolean {
  let owned: JsonObject;
  try {
    owned = ownedHookGroupsByEvent(root, (hook) => {
      const command = hookCommand(hook);
      return command !== undefined && isOwned(command);
    });
  } catch {
    return false;
  }
  return (events ?? Object.keys(owned)).some((event) => owned[event] !== undefined);
}

/** True when any event holds a Rocky agent-event hook, wherever its paths point. */
export function hasOwnedAgentHooks(root: Record<string, unknown>): boolean {
  return hasOwnedHookCommand(root, isRockyClaudeHookCommand);
}

/** True when a PreToolUse group holds a Rocky rationale-gate hook, wherever its paths point. */
export function hasOwnedGateGroup(root: Record<string, unknown>): boolean {
  return hasOwnedHookCommand(root, isRockyGateHookCommand, ["PreToolUse"]);
}

/**
 * The hook groups `isOwned` accepts, keyed by event, in file order. Every
 * other group and root key is dropped, so two families sharing an event can
 * be compared without one family's order deciding the other's result.
 */
export function ownedHookProjection(
  root: Record<string, unknown>,
  isOwned: (hook: JsonObject) => boolean,
): Record<string, unknown> {
  return { hooks: ownedHookGroupsByEvent(root, isOwned) };
}

/** Projection of the agent-event, session-start, tool-result, and gate families; desk groups are foreign here. */
export function ownedClaudeHookProjection(root: Record<string, unknown>): Record<string, unknown> {
  return ownedHookProjection(root, isRockyHook);
}

export function resolveTarget(target: AgentHooksTarget, options: AgentHooksRuntimeOptions): AgentHooksTarget {
  requireSafeAbsolutePath(target.settingsPath, "Claude settings");
  return target;
}

function errorCode(error: unknown): string | undefined {
  return isObject(error) && typeof error.code === "string" ? error.code : undefined;
}

export function operationDetail(error: unknown, noun: HookErrorNoun): string {
  return error instanceof Error && error.message === MISSING_PARENT_ERROR
    ? MISSING_PARENT_ERROR
    : genericError(noun);
}

function inspectTopology(path: string): Topology {
  const directories: PathIdentity[] = [];
  const missing: string[] = [];
  let targetExists = false;
  let targetIdentity: { dev: number; ino: number } | undefined;
  try {
    const target = lstatSync(path);
    if (!target.isFile() || target.isSymbolicLink()) throw new Error(GENERIC_ERROR);
    targetExists = true;
    targetIdentity = { dev: target.dev, ino: target.ino };
  } catch (error) {
    if (error instanceof Error && error.message === GENERIC_ERROR) throw error;
    if (errorCode(error) !== "ENOENT") throw new Error(GENERIC_ERROR);
  }

  let current = dirname(path);
  while (true) {
    try {
      const metadata = lstatSync(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(GENERIC_ERROR);
      directories.push({ path: current, dev: metadata.dev, ino: metadata.ino });
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    } catch (error) {
      if (error instanceof Error && error.message === GENERIC_ERROR) throw error;
      if (errorCode(error) !== "ENOENT") throw new Error(GENERIC_ERROR);
      missing.push(current);
      const parent = dirname(current);
      if (parent === current) throw new Error(GENERIC_ERROR);
      current = parent;
    }
  }
  return { targetExists, targetIdentity, directories, missing: missing.reverse() };
}

function topologyGuard(topology: Topology): JsonMutationGuard {
  return Object.freeze({
    unchanged() {
      try {
        return topology.directories.every((expected) => {
          const actual = lstatSync(expected.path);
          return actual.isDirectory()
            && !actual.isSymbolicLink()
            && actual.dev === expected.dev
            && actual.ino === expected.ino;
        });
      } catch {
        return false;
      }
    },
  });
}

function targetSnapshotMatches(topology: Topology, read: ReadableJsonResult): boolean {
  if (topology.targetExists !== (read.status === "valid")) return false;
  if (!topology.targetExists || read.status !== "valid") return true;
  return topology.targetIdentity !== undefined
    && read.identity !== undefined
    && topology.targetIdentity.dev === read.identity.dev
    && topology.targetIdentity.ino === read.identity.ino;
}

export function inspectCurrent(path: string, requireParent = false): CurrentConfig {
  let topology: Topology;
  try {
    topology = inspectTopology(path);
  } catch {
    throw new Error(GENERIC_ERROR);
  }
  if (requireParent && topology.missing.length > 0) throw new Error(MISSING_PARENT_ERROR);
  if (inspectJsonTransaction(path).status === "pending") throw new Error(GENERIC_ERROR);
  const read = readJsonObject(path);
  if (read.status === "invalid") throw new Error(GENERIC_ERROR);
  if (!targetSnapshotMatches(topology, read)) throw new Error(GENERIC_ERROR);
  // Validate Claude's hook containers before any caller displays proposed
  // entries or asks for consent. A malformed existing settings file must
  // never be silently replaced by a merge.
  validateHooks(read.value);
  return { read, topology };
}

export function prepareMutation(path: string): CurrentConfig {
  const topology = inspectTopology(path);
  if (topology.missing.length > 0) throw new Error(MISSING_PARENT_ERROR);
  if (inspectJsonTransaction(path).status === "pending") throw new Error(GENERIC_ERROR);
  const read = readJsonObject(path);
  if (read.status === "invalid") throw new Error(GENERIC_ERROR);
  if (!targetSnapshotMatches(topology, read)) throw new Error(GENERIC_ERROR);
  return { read, topology };
}

function sameJson(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function commandFor(options: AgentHooksRuntimeOptions): string {
  const command = options.command ?? rockyHookCommand("claude-code", options.nodePath, options.entryPath);
  if (!command.includes(CLAUDE_MARKER)) throw new Error("hook command is not Rocky-owned");
  return command;
}

function sessionCommandFor(options: AgentHooksRuntimeOptions): string {
  const sessionCommand = options.sessionCommand ?? rockySessionStartHookCommand(options.nodePath, options.entryPath);
  if (!isRockySessionHookCommand(sessionCommand)) throw new Error("session hook command is not Rocky-owned");
  return sessionCommand;
}

function toolResultCommandFor(options: AgentHooksRuntimeOptions): string {
  const toolResultCommand = options.toolResultCommand
    ?? rockyToolResultHookCommand(options.nodePath, options.entryPath);
  if (!isRockyToolResultHookCommand(toolResultCommand)) {
    throw new Error("tool-result hook command is not Rocky-owned");
  }
  return toolResultCommand;
}

/** Always resolvable, for status validation: absence of a gate entry on disk is still valid. */
function gateCommandFor(options: AgentHooksRuntimeOptions): string {
  const gateCommand = options.gateCommand ?? rockyGateHookCommand(options.nodePath, options.entryPath);
  if (!gateCommand.includes(GATE_MARKER)) throw new Error("gate hook command is not Rocky-owned");
  return gateCommand;
}

/** Explicit on/off switch for install: undefined means no gate entry, never a derived default. */
function requestedGateCommand(options: AgentHooksRuntimeOptions): string | undefined {
  return options.gateCommand === undefined ? undefined : gateCommandFor(options);
}

function printEntries(
  commands: ClaudeHookCommands,
  options: AgentHooksRuntimeOptions,
): void {
  const entries: Record<string, unknown> = {
    ...buildClaudeHookEntries({
      agent: commands.agent,
      session: commands.session,
      toolResult: commands.toolResult,
    }),
  };
  if (commands.gate !== undefined) entries.PreToolUse = [buildGateHookGroup(commands.gate)];
  (options.detail ?? ((message: string) => process.stderr.write(`${message}\n`)))
    (JSON.stringify(entries, null, 2));
}

/**
 * True only when the file at `recoveryPath` reads back byte-for-byte equal to
 * `priorBytes`. Any read error is false, so a caller that skips its report on
 * `true` errs toward showing it.
 */
export function retainedCopyMatches(recoveryPath: string, priorBytes: Buffer): boolean {
  try {
    return readFileSync(recoveryPath).equals(priorBytes);
  } catch {
    return false;
  }
}

export function writeMutation(
  path: string,
  current: CurrentConfig,
  value: Record<string, unknown>,
  options: AgentHooksRuntimeOptions,
  noun: HookErrorNoun,
): AgentHooksOperationResult {
  if (sameJson(current.read.value, value)) return { status: "unchanged" };
  try {
    options.beforeWrite?.();
    const result = atomicWriteJsonIfUnchanged(path, value, current.read, topologyGuard(current.topology));
    if (result.status === "written") {
      options.afterWrite?.(result.recoveryPath);
      // The transaction engine still keeps the displaced copy on disk; only the report is conditional.
      if (result.recoveryPath === undefined
        || (current.read.status === "valid" && retainedCopyMatches(result.recoveryPath, current.read.bytes))) {
        return { status: "written" };
      }
      return { status: "written", detail: retainedConfigDetail(noun, result.recoveryPath) };
    }
    return {
      status: "error",
      detail: result.recoveryPath === undefined
        ? genericError(noun)
        : `${genericError(noun)}; manual recovery: ${result.recoveryPath}`,
    };
  } catch {
    return { status: "error", detail: genericError(noun) };
  }
}

export function defaultConfirmation(): AgentHooksConfirmation {
  const prompt = createPromptPort(process.stdin, process.stderr);
  return {
    confirm(message): Promise<boolean> { return prompt.confirm(message); },
  };
}

/** Consent-gated Claude Code settings update. */
export async function installClaudeAgentHooks(
  target: AgentHooksTarget,
  options: AgentHooksRuntimeOptions = {},
): Promise<AgentHooksOperationResult> {
  let resolved: AgentHooksTarget;
  let commands: ClaudeHookCommands;
  try {
    resolved = resolveTarget(target, options);
    commands = {
      agent: commandFor(options),
      session: sessionCommandFor(options),
      toolResult: toolResultCommandFor(options),
      gate: requestedGateCommand(options),
    };
    // Validate pending transactions, target topology, and JSON before any
    // display or consent. A missing parent is rejected before any proposed
    // JSON or prompt; an existing parent with missing settings stays writable
    // only after explicit consent.
    inspectCurrent(resolved.settingsPath, true);
    printEntries(commands, options);
  } catch (error) {
    return { status: "error", detail: operationDetail(error, GENERIC_ERROR_NOUN) };
  }

  const confirmation = options.confirmation ?? defaultConfirmation();
  let allowed = false;
  try {
    allowed = await confirmation.confirm(AGENT_HOOK_CONFIRMATION);
  } catch {
    return { status: "error", detail: GENERIC_ERROR };
  }
  if (!allowed) return { status: "declined" };

  try {
    // Re-read after the prompt. This is deliberate: user or another setup
    // process may have changed settings while consent was pending.
    const current = prepareMutation(resolved.settingsPath);
    const merged = mergeClaudeHooks(current.read.value, commands);
    return writeMutation(resolved.settingsPath, current, merged, options, GENERIC_ERROR_NOUN);
  } catch (error) {
    return { status: "error", detail: operationDetail(error, GENERIC_ERROR_NOUN) };
  }
}

/** Remove only Rocky-owned Claude Code groups. */
export async function uninstallClaudeAgentHooks(
  target: AgentHooksTarget,
  options: AgentHooksRuntimeOptions = {},
): Promise<Exclude<AgentHooksOperationResult, { status: "declined" }>> {
  try {
    const resolved = resolveTarget(target, options);
    const current = inspectCurrent(resolved.settingsPath);
    if (current.read.status === "missing") return { status: "unchanged" };
    const removed = removeClaudeHooks(current.read.value);
    return writeMutation(resolved.settingsPath, current, removed, options, GENERIC_ERROR_NOUN);
  } catch {
    return { status: "error", detail: GENERIC_ERROR };
  }
}

const REQUIRED_CLAUDE_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
] as const;

function matchesCurrentGroup(actual: unknown, expected: JsonObject): boolean {
  if (!isObject(actual) || !Array.isArray(actual.hooks) || !Array.isArray(expected.hooks)) return false;
  if (actual.matcher !== expected.matcher) return false;
  const actualHooks = actual.hooks;
  const expectedHooks = expected.hooks;
  if (actualHooks.length !== expectedHooks.length) return false;
  return expectedHooks.every((expectedHook, index) => {
    const actualHook = actualHooks[index];
    if (!isObject(actualHook) || !isObject(expectedHook)) return false;
    return actualHook.type === expectedHook.type
      && actualHook.command === expectedHook.command
      && actualHook.timeout === expectedHook.timeout
      && actualHook.async === expectedHook.async;
  });
}

function matchesGateGroup(value: unknown, gateCommand: string): boolean {
  if (!isObject(value) || !Array.isArray(value.hooks)) return false;
  const hooks = value.hooks;
  if (hooks.length !== 1 || !isObject(hooks[0]) || hooks[0].type !== "command" || hooks[0].command !== gateCommand) return false;
  return value.matcher === GATE_MATCHER;
}

function ownedGroupsOf(groups: readonly unknown[]): unknown[] {
  return groups.filter((groupValue) => {
    if (!isObject(groupValue) || !Array.isArray(groupValue.hooks)) return false;
    return (groupValue.hooks as unknown[]).some((hookValue) =>
      isObject(hookValue) && isRockyHook(hookValue));
  });
}

function hasCurrentHooks(
  value: Record<string, unknown>,
  commands: ClaudeHookCommands,
): boolean {
  const hooks = validateHooks(value);
  if (hooks === undefined) return false;
  // Events a Rocky-owned group is allowed to appear under. PreToolUse (the
  // opt-in advisory PreToolUse hook) belongs here so an owned PreToolUse group never
  // makes an otherwise-current config report "not current" - whether or not
  // this install chose the gate. This is a separate job from the
  // must-be-present loop below; do not fold the two back into one list.
  const ownableEvents = new Set([
    "SessionStart",
    "UserPromptSubmit",
    "PostToolUse",
    "PostToolUseFailure",
    "Stop",
    "PreToolUse",
  ]);
  for (const [event, groupsValue] of Object.entries(hooks)) {
    if (!Array.isArray(groupsValue)) return false;
    if (ownedGroupsOf(groupsValue).length > 0 && !ownableEvents.has(event)) return false;
  }
  // Each required event's owned groups must match the expected groups in order.
  // Deliberately excludes PreToolUse: the gate is opt-in, not required.
  const expectedEntries = buildClaudeHookEntries({
    agent: commands.agent,
    session: commands.session,
    toolResult: commands.toolResult,
  });
  for (const event of REQUIRED_CLAUDE_HOOK_EVENTS) {
    const groups = hooks[event];
    const expected = expectedEntries[event];
    if (!Array.isArray(groups) || !Array.isArray(expected)) return false;
    const owned = ownedGroupsOf(groups);
    if (owned.length !== expected.length) return false;
    if (!expected.every((expectedGroup, index) => isObject(expectedGroup) && matchesCurrentGroup(owned[index], expectedGroup))) {
      return false;
    }
  }
  // PreToolUse: absent is current (gate not installed this run); present
  // must be exactly one owned group matching the canonical gate entry.
  const preToolUseGroups = hooks.PreToolUse;
  const ownedPreToolUse = Array.isArray(preToolUseGroups) ? ownedGroupsOf(preToolUseGroups) : [];
  if (ownedPreToolUse.length > 1) return false;
  if (ownedPreToolUse.length === 1 && (commands.gate === undefined || !matchesGateGroup(ownedPreToolUse[0], commands.gate))) {
    return false;
  }
  return true;
}

/** Read-only status; missing/partial/stale/malformed settings are absent/unreadable. */
export function agentHooksStatus(
  target: AgentHooksTarget,
  options: AgentHooksRuntimeOptions = {},
): AgentHooksStatusResult {
  try {
    const resolved = resolveTarget(target, options);
    const current = inspectCurrent(resolved.settingsPath);
    if (current.read.status === "missing") return { claudeCode: "absent" };
    const commands: ClaudeHookCommands = {
      agent: commandFor(options),
      session: sessionCommandFor(options),
      toolResult: toolResultCommandFor(options),
      gate: gateCommandFor(options),
    };
    try {
      return hasCurrentHooks(current.read.value, commands)
        ? { claudeCode: "installed" }
        : { claudeCode: "absent" };
    } catch {
      return { claudeCode: "unreadable" };
    }
  } catch {
    return { claudeCode: "unreadable" };
  }
}

/**
 * The settings file Claude Code loads: `$CLAUDE_CONFIG_DIR/settings.json` when
 * that variable names a canonical absolute directory, `<home>/.claude/settings.json`
 * when it is unset. Anything else is refused instead of guessed, because hooks
 * written to a file no session loads fail silently. `env` and `cwd` change the
 * answer, so neither has a default.
 */
export function defaultAgentHooksTarget(
  home: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): AgentHooksTargetResolution {
  const config = resolveClaudeCodeUserConfig({ home, cwd, env, path: hostPath });
  if (config.status === "resolved" && config.mutationSafe) {
    return { status: "resolved", target: { settingsPath: join(config.policyRoot, "settings.json") } };
  }
  if (config.status === "resolved" && config.override === "empty") {
    return { status: "refused", reason: "empty" };
  }
  return { status: "refused", reason: "unusable" };
}

export function defaultAgentHooksEntryPath(): string {
  return defaultEntryPath();
}

export { CLAUDE_MARKER as claudeHookMarker };
