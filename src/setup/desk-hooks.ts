import { existsSync } from "node:fs";
import { basename } from "node:path";
import {
  defaultConfirmation,
  inspectCurrent,
  operationDetail,
  parseQuotedCommandPath,
  prepareMutation,
  quotePath,
  requireSafeAbsolutePath,
  removeOwnedHooks,
  resolveTarget,
  stripOwnedGroups,
  withHookArrays,
  writeMutation,
  type AgentHooksOperationResult,
  type AgentHooksRuntimeOptions,
  type AgentHooksTarget,
  type JsonObject,
} from "./agent-hooks.js";

/** Ownership marker for the experimental desk hooks; the exact `rocky-hook` suffix. */
export const DESK_MARKER = "desk-hook claude-code";

/** The 12 Claude Code events the desk hook subscribes to. */
export const DESK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "StopFailure",
  "SessionEnd",
] as const;

/**
 * Whether the desk hook entries carry `"async": true`. False until the §4.5
 * fixture proves Claude Code supports async hooks.
 */
export const DESK_HOOK_ASYNC = false;

const DESK_HOOK_CONFIRMATION = "Install desk hooks for Claude Code now?";
const GENERIC_ERROR = operationDetail(new Error("desk hooks"), "desk hooks");
/** The two tool events carry a wildcard matcher; the rest carry none. */

/**
 * Build the `rocky-hook` command line for one validated binary path. Reject
 * anything that is not an existing, safe, absolute `rocky-hook` binary.
 */
export function deskHookCommand(hookBin: string, fileExists: (path: string) => boolean = existsSync): string {
  const bin = requireSafeAbsolutePath(hookBin, "desk hook");
  if (/["%!]/.test(bin)) throw new Error("desk hook path is unsafe for command line");
  if (!fileExists(bin)) throw new Error("desk hook path does not exist");
  const name = process.platform === "win32" ? basename(bin).toLowerCase() : basename(bin);
  if (name !== "rocky-hook" && name !== "rocky-hook.exe") {
    throw new Error("desk hook path must be the rocky-hook binary");
  }
  return `${quotePath(bin)} ${DESK_MARKER}`;
}

/**
 * Recognize the exact desk command shape Rocky writes: one quoted path plus
 * the marker. A marker in an argument or an unrelated command is foreign.
 */
export function isRockyDeskHookCommand(command: string): boolean {
  if (typeof command !== "string" || command.length === 0) return false;
  if (!command.endsWith(` ${DESK_MARKER}`)) return false;
  try {
    const parsed = parseQuotedCommandPath(command, 0);
    if (command.slice(parsed.next) !== ` ${DESK_MARKER}`) return false;
    return deskHookCommand(parsed.value, () => true) === command;
  } catch {
    return false;
  }
}

function isRockyDeskHook(value: JsonObject): boolean {
  return typeof value.command === "string" && isRockyDeskHookCommand(value.command);
}

/** Build the exact Claude Code event entries owned by the desk hook. */
export function buildDeskHookEntries(command: string, asyncHooks: boolean): Record<string, unknown> {
  if (typeof command !== "string" || command.length === 0 || !isRockyDeskHookCommand(command)) {
    throw new Error("desk hook command is invalid");
  }
  const entries: Record<string, unknown> = {};
  for (const event of DESK_EVENTS) {
    const hook: Record<string, unknown> = { type: "command", command, timeout: 5 };
    if (asyncHooks) hook.async = true;
    const scoped = event === "PreToolUse" || event === "PostToolUse";
    entries[event] = scoped
      ? [{ matcher: "*", hooks: [hook] }]
      : [{ hooks: [hook] }];
  }
  return entries;
}

/**
 * Remove old desk groups and append exactly one current group per event.
 * Foreign root keys, events, groups, and nested hooks retain their order.
 */
export function mergeDeskHooks(existing: Record<string, unknown>, command: string, asyncHooks: boolean): Record<string, unknown> {
  if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
    throw new Error("Claude settings root must be an object");
  }
  const entries = buildDeskHookEntries(command, asyncHooks);
  return withHookArrays(existing, (hooks) => {
    for (const event of DESK_EVENTS) {
      const current = hooks[event];
      const groups = current === undefined ? [] : current;
      if (!Array.isArray(groups)) throw new Error("hook event must be an array");
      const clean = stripOwnedGroups(groups, isRockyDeskHook);
      const entry = entries[event];
      if (!Array.isArray(entry) || entry.length !== 1) throw new Error("hook entry shape is invalid");
      clean.push(entry[0]);
      hooks[event] = clean;
    }
  });
}

/** Remove desk-owned groups while preserving all foreign configuration. */
export function removeDeskHooks(existing: Record<string, unknown>): Record<string, unknown> {
  return removeOwnedHooks(existing, isRockyDeskHook);
}

export interface DeskHooksRuntimeOptions extends AgentHooksRuntimeOptions {
  hookBin?: string;
  fileExists?: (path: string) => boolean;
}

function commandFor(options: DeskHooksRuntimeOptions): string {
  if (options.hookBin === undefined) throw new Error("desk hook path is missing");
  return deskHookCommand(options.hookBin, options.fileExists);
}

function describeFailure(error: unknown): string {
  return operationDetail(error, "desk hooks");
}

/** Consent-gated Claude Code desk hooks update. */
export async function installDeskHooks(
  target?: AgentHooksTarget,
  options: DeskHooksRuntimeOptions = {},
): Promise<AgentHooksOperationResult> {
  let resolved: AgentHooksTarget;
  let command: string;
  try {
    resolved = resolveTarget(target, options);
    command = commandFor(options);
    inspectCurrent(resolved.settingsPath, true);
    (options.detail ?? ((message: string) => process.stderr.write(`${message}\n`)))
      (JSON.stringify(buildDeskHookEntries(command, DESK_HOOK_ASYNC), null, 2));
  } catch (error) {
    return { status: "error", detail: describeFailure(error) };
  }

  const confirmation = options.confirmation ?? defaultConfirmation();
  let allowed = false;
  try {
    allowed = await confirmation.confirm(DESK_HOOK_CONFIRMATION);
  } catch {
    return { status: "error", detail: GENERIC_ERROR };
  }
  if (!allowed) return { status: "declined" };

  try {
    const current = prepareMutation(resolved.settingsPath);
    const merged = mergeDeskHooks(current.read.value, command, DESK_HOOK_ASYNC);
    return writeMutation(resolved.settingsPath, current, merged, options, "desk hooks");
  } catch (error) {
    return { status: "error", detail: describeFailure(error) };
  }
}

/** Remove only desk-owned Claude Code groups. */
export async function uninstallDeskHooks(
  target?: AgentHooksTarget,
  options: DeskHooksRuntimeOptions = {},
): Promise<Exclude<AgentHooksOperationResult, { status: "declined" }>> {
  try {
    const resolved = resolveTarget(target, options);
    const current = inspectCurrent(resolved.settingsPath);
    if (current.read.status === "missing") return { status: "unchanged" };
    const removed = removeDeskHooks(current.read.value);
    return writeMutation(resolved.settingsPath, current, removed, options, "desk hooks");
  } catch {
    return { status: "error", detail: GENERIC_ERROR };
  }
}
