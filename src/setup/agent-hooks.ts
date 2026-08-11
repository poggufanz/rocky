import { chmodSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import {
  atomicWriteJsonIfUnchanged,
  inspectJsonTransaction,
  readJsonObject,
} from "./json-config.js";
import type { JsonMutationGuard, JsonReadResult } from "./json-config.js";
import { createPromptPort } from "./prompt.js";

const CLAUDE_MARKER = "hook agent-event claude-code";
const POST_TOOL_MATCHER = "Edit|Write|MultiEdit|NotebookEdit";
const AGENT_HOOK_CONFIRMATION = "install ears for claude code, question";
const GENERIC_ERROR = "Claude Code agent hooks update cannot complete";

export interface AgentHooksTarget {
  settingsPath: string;
}

export type AgentHooksAction = "install" | "uninstall" | "status";

export interface AgentHooksConfirmation {
  confirm(message: string): Promise<boolean>;
}

export interface AgentHooksRuntimeOptions {
  /** Supply the already validated command from setup's injected paths. */
  command?: string;
  nodePath?: string;
  entryPath?: string;
  home?: string;
  confirmation?: AgentHooksConfirmation;
  detail?: (message: string) => void;
  /** Test seam for proving the transactional writer refuses a late race. */
  beforeWrite?: () => void;
  /** Test seam for rebinding a missing parent immediately before creation. */
  beforeCreateParent?: () => void;
}

export interface AgentHooksOperationResult {
  status: "written" | "unchanged" | "declined" | "error";
  detail?: string;
}

export interface AgentHooksStatusResult {
  claudeCode: "installed" | "absent" | "unreadable";
}

interface JsonObject {
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
  /** Missing parent components in creation order, nearest root first. */
  missing: readonly string[];
}

interface CurrentConfig {
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

function requireSafeAbsolutePath(value: string, label: string): string {
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
    .replaceAll("\"", "\\\"")
    .replaceAll("!", "\\!")}"`;
}

function quoteWindowsPath(value: string): string {
  // Claude Code stores a command line. Reject cmd.exe expansion characters
  // instead of trying to make a shell escape that changes across hosts.
  if (/["%!]/.test(value)) throw new Error("path is unsafe for Windows command line");
  const trailing = value.match(/\\+$/)?.[0] ?? "";
  const body = trailing.length === 0 ? value : value.slice(0, -trailing.length);
  return `"${body}${trailing.replaceAll("\\", "\\\\")}"`;
}

function quotePath(value: string): string {
  return win32.isAbsolute(value) && !posix.isAbsolute(value)
    ? quoteWindowsPath(value)
    : quotePosixPath(value);
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

/** Build the exact Claude Code event groups owned by Rocky. */
export function buildClaudeHookEntries(command: string): Record<string, unknown> {
  if (typeof command !== "string" || command.length === 0 || hasControl(command)) {
    throw new Error("hook command is invalid");
  }
  return {
    UserPromptSubmit: [{ hooks: [{ type: "command", command }] }],
    PostToolUse: [{ matcher: POST_TOOL_MATCHER, hooks: [{ type: "command", command }] }],
    Stop: [{ hooks: [{ type: "command", command }] }],
  };
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

function validateHooks(root: JsonObject): JsonObject | undefined {
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
  return hookCommand(value)?.includes(CLAUDE_MARKER) === true;
}

function stripRockyGroups(groups: readonly unknown[]): unknown[] {
  const kept: unknown[] = [];
  for (const groupValue of groups) {
    const group = groupValue as JsonObject;
    if (group.hooks === undefined || !Array.isArray(group.hooks)) {
      kept.push(groupValue);
      continue;
    }
    const hooks = group.hooks as unknown[];
    const foreignHooks = hooks.filter((hookValue) => !isRockyHook(hookValue as JsonObject));
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

function withHookArrays(root: JsonObject, callback: (hooks: JsonObject) => void): Record<string, unknown> {
  const existingHooks = validateHooks(root);
  const result: JsonObject = { ...root };
  const hooks: JsonObject = existingHooks === undefined ? {} : { ...existingHooks };
  callback(hooks);
  if (Object.keys(hooks).length === 0) delete result.hooks;
  else result.hooks = hooks;
  return result;
}

/**
 * Remove old Rocky groups and append exactly one current group per event.
 * Foreign root keys, events, groups, and nested hooks retain their order.
 */
export function mergeClaudeHooks(existing: Record<string, unknown>, command: string): Record<string, unknown> {
  if (!isObject(existing)) throw new Error("Claude settings root must be an object");
  const entries = buildClaudeHookEntries(command);
  return withHookArrays(existing, (hooks) => {
    for (const event of ["UserPromptSubmit", "PostToolUse", "Stop"] as const) {
      const current = hooks[event];
      const groups = current === undefined ? [] : current;
      if (!Array.isArray(groups)) throw new Error("hook event must be an array");
      const clean = stripRockyGroups(groups);
      const entry = entries[event];
      if (!Array.isArray(entry) || entry.length !== 1) throw new Error("hook entry shape is invalid");
      clean.push(entry[0]);
      hooks[event] = clean;
    }
  });
}

/** Remove Rocky-owned groups while preserving all foreign configuration. */
export function removeClaudeHooks(existing: Record<string, unknown>): Record<string, unknown> {
  if (!isObject(existing)) throw new Error("Claude settings root must be an object");
  return withHookArrays(existing, (hooks) => {
    for (const event of Object.keys(hooks)) {
      const groups = hooks[event];
      if (!Array.isArray(groups)) throw new Error("hook event must be an array");
      const hadRocky = groups.some((groupValue) => {
        const group = groupValue as JsonObject;
        return isObject(group) && Array.isArray(group.hooks)
          && (group.hooks as unknown[]).some((hook) => isObject(hook) && isRockyHook(hook));
      });
      const clean = stripRockyGroups(groups);
      if (hadRocky && clean.length === 0) delete hooks[event];
      else if (hadRocky) hooks[event] = clean;
    }
  });
}

function targetFor(home = homedir()): AgentHooksTarget {
  return { settingsPath: join(home, ".claude", "settings.json") };
}

function resolveTarget(target: AgentHooksTarget | undefined, options: AgentHooksRuntimeOptions): AgentHooksTarget {
  const resolved = target ?? targetFor(options.home);
  requireSafeAbsolutePath(resolved.settingsPath, "Claude settings");
  return resolved;
}

function errorCode(error: unknown): string | undefined {
  return isObject(error) && typeof error.code === "string" ? error.code : undefined;
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

function sameTopologyDirectories(expected: readonly PathIdentity[], actual: Topology): boolean {
  return expected.every((entry) => actual.directories.some((observed) =>
    observed.path === entry.path
      && observed.dev === entry.dev
      && observed.ino === entry.ino));
}

function createPrivateParent(
  targetPath: string,
  initial: Topology,
  beforeCreateParent?: () => void,
): Topology {
  beforeCreateParent?.();
  try {
    const expectedDirectories: PathIdentity[] = [...initial.directories];
    for (const parent of initial.missing) {
      try {
        lstatSync(parent);
        // Every path in initial.missing was absent during the authorized
        // snapshot. If another actor wins the name before our mkdir, do not
        // adopt its directory as Rocky's creation baseline.
        throw new Error(GENERIC_ERROR);
      } catch (error) {
        if (error instanceof Error && error.message === GENERIC_ERROR) throw error;
        if (errorCode(error) !== "ENOENT") throw new Error(GENERIC_ERROR);
      }

      const container = dirname(parent);
      let containerBefore: ReturnType<typeof lstatSync>;
      let entriesBefore: string[];
      try {
        containerBefore = lstatSync(container);
        if (!containerBefore.isDirectory() || containerBefore.isSymbolicLink()) {
          throw new Error(GENERIC_ERROR);
        }
        entriesBefore = readdirSync(container);
      } catch (error) {
        if (error instanceof Error && error.message === GENERIC_ERROR) throw error;
        if (errorCode(error) !== "ENOENT") throw new Error(GENERIC_ERROR);
        throw new Error(GENERIC_ERROR);
      }

      if (entriesBefore.includes(basename(parent))) throw new Error(GENERIC_ERROR);
      mkdirSync(parent, { mode: 0o700 });
      const metadata = lstatSync(parent);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(GENERIC_ERROR);
      const containerAfter = lstatSync(container);
      if (!containerAfter.isDirectory()
        || containerAfter.isSymbolicLink()
        || containerAfter.dev !== containerBefore.dev
        || containerAfter.ino !== containerBefore.ino) {
        throw new Error(GENERIC_ERROR);
      }
      const entriesAfter = readdirSync(container);
      const expectedEntries = [...entriesBefore, basename(parent)].sort();
      entriesAfter.sort();
      if (entriesAfter.length !== expectedEntries.length
        || entriesAfter.some((entry, index) => entry !== expectedEntries[index])) {
        throw new Error(GENERIC_ERROR);
      }
      // Retain identity for every component that was absent in the initial
      // snapshot. A later ancestor rebind must not become the new guard
      // baseline merely because final inspection observes it first.
      expectedDirectories.push({ path: parent, dev: metadata.dev, ino: metadata.ino });
      // mkdir mode is subject to umask. Ensure every component Rocky owns
      // is private even when the invoking shell has a permissive umask.
      chmodSync(parent, 0o700);
    }
    const after = inspectTopology(targetPath);
    if (after.targetExists || after.missing.length !== 0 || !sameTopologyDirectories(expectedDirectories, after)) {
      throw new Error(GENERIC_ERROR);
    }
    return after;
  } catch {
    throw new Error(GENERIC_ERROR);
  }
}

function inspectCurrent(path: string): CurrentConfig {
  let topology: Topology;
  try {
    topology = inspectTopology(path);
  } catch {
    throw new Error(GENERIC_ERROR);
  }
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

function prepareMutation(path: string, options: AgentHooksRuntimeOptions): CurrentConfig {
  let topology = inspectTopology(path);
  if (!topology.targetExists) {
    topology = createPrivateParent(path, topology, options.beforeCreateParent);
  }
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

function printEntries(command: string, options: AgentHooksRuntimeOptions): void {
  (options.detail ?? ((message: string) => process.stderr.write(`${message}\n`)))
    (JSON.stringify(buildClaudeHookEntries(command), null, 2));
}

function writeMutation(
  path: string,
  current: CurrentConfig,
  value: Record<string, unknown>,
  options: AgentHooksRuntimeOptions,
): AgentHooksOperationResult {
  if (sameJson(current.read.value, value)) return { status: "unchanged" };
  try {
    options.beforeWrite?.();
    const result = atomicWriteJsonIfUnchanged(path, value, current.read, topologyGuard(current.topology));
    if (result.status === "written") {
      return result.recoveryPath === undefined
        ? { status: "written" }
        : {
          status: "written",
          detail: `Claude Code agent hooks previous config retained; manual recovery: ${result.recoveryPath}`,
        };
    }
    return {
      status: "error",
      detail: result.recoveryPath === undefined
        ? GENERIC_ERROR
        : `${GENERIC_ERROR}; manual recovery: ${result.recoveryPath}`,
    };
  } catch {
    return { status: "error", detail: GENERIC_ERROR };
  }
}

function defaultConfirmation(): AgentHooksConfirmation {
  const prompt = createPromptPort(process.stdin, process.stderr);
  return {
    confirm(message): Promise<boolean> { return prompt.confirm(message); },
  };
}

/** Consent-gated Claude Code settings update. */
export async function installClaudeAgentHooks(
  target?: AgentHooksTarget,
  options: AgentHooksRuntimeOptions = {},
): Promise<AgentHooksOperationResult> {
  let resolved: AgentHooksTarget;
  let command: string;
  try {
    resolved = resolveTarget(target, options);
    command = commandFor(options);
    // Validate pending transactions, target topology, and JSON before any
    // display or consent. Missing parent/config is readable and remains
    // untouched until explicit consent authorizes parent creation.
    inspectCurrent(resolved.settingsPath);
    printEntries(command, options);
  } catch {
    return { status: "error", detail: GENERIC_ERROR };
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
    const current = prepareMutation(resolved.settingsPath, options);
    const merged = mergeClaudeHooks(current.read.value, command);
    return writeMutation(resolved.settingsPath, current, merged, options);
  } catch {
    return { status: "error", detail: GENERIC_ERROR };
  }
}

/** Remove only Rocky-owned Claude Code groups. */
export async function uninstallClaudeAgentHooks(
  target?: AgentHooksTarget,
  options: AgentHooksRuntimeOptions = {},
): Promise<Exclude<AgentHooksOperationResult, { status: "declined" }>> {
  try {
    const resolved = resolveTarget(target, options);
    const current = inspectCurrent(resolved.settingsPath);
    if (current.read.status === "missing") return { status: "unchanged" };
    const removed = removeClaudeHooks(current.read.value);
    return writeMutation(resolved.settingsPath, current, removed, options);
  } catch {
    return { status: "error", detail: GENERIC_ERROR };
  }
}

function matchesCurrentGroup(value: unknown, event: "UserPromptSubmit" | "PostToolUse" | "Stop", command: string): boolean {
  if (!isObject(value) || !Array.isArray(value.hooks)) return false;
  const hooks = value.hooks;
  if (hooks.length !== 1 || !isObject(hooks[0]) || hooks[0].type !== "command" || hooks[0].command !== command) return false;
  if (event === "PostToolUse") return value.matcher === POST_TOOL_MATCHER;
  return value.matcher === undefined;
}

function hasCurrentHooks(value: Record<string, unknown>, command: string): boolean {
  const hooks = validateHooks(value);
  if (hooks === undefined) return false;
  const requiredEvents = new Set(["UserPromptSubmit", "PostToolUse", "Stop"]);
  for (const [event, groupsValue] of Object.entries(hooks)) {
    if (!Array.isArray(groupsValue)) return false;
    const ownedGroups = groupsValue.filter((groupValue) => {
      if (!isObject(groupValue) || !Array.isArray(groupValue.hooks)) return false;
      return (groupValue.hooks as unknown[]).some((hookValue) =>
        isObject(hookValue) && isRockyHook(hookValue));
    }).length;
    if (ownedGroups > 0 && !requiredEvents.has(event)) return false;
  }
  for (const event of ["UserPromptSubmit", "PostToolUse", "Stop"] as const) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) return false;
    const owned = groups.filter((groupValue) => {
      if (!isObject(groupValue) || !Array.isArray(groupValue.hooks)) return false;
      return (groupValue.hooks as unknown[]).some((hookValue) =>
        isObject(hookValue) && isRockyHook(hookValue));
    });
    if (owned.length !== 1 || !matchesCurrentGroup(owned[0], event, command)) return false;
  }
  return true;
}

/** Read-only status; missing/partial/stale/malformed settings are absent/unreadable. */
export function agentHooksStatus(
  target?: AgentHooksTarget,
  options: AgentHooksRuntimeOptions = {},
): AgentHooksStatusResult {
  try {
    const resolved = resolveTarget(target, options);
    const current = inspectCurrent(resolved.settingsPath);
    if (current.read.status === "missing") return { claudeCode: "absent" };
    const command = commandFor(options);
    try {
      return hasCurrentHooks(current.read.value, command)
        ? { claudeCode: "installed" }
        : { claudeCode: "absent" };
    } catch {
      return { claudeCode: "unreadable" };
    }
  } catch {
    return { claudeCode: "unreadable" };
  }
}

export function defaultAgentHooksTarget(home = homedir()): AgentHooksTarget {
  return targetFor(home);
}

export function defaultAgentHooksEntryPath(): string {
  return defaultEntryPath();
}

export { CLAUDE_MARKER as claudeHookMarker };
