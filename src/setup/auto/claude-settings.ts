import { dirname } from "node:path";
import {
  hasOwnedAgentHooks,
  hasOwnedGateGroup,
  mergeClaudeHooks,
  ownedClaudeHookProjection,
  prepareMutation,
  removeClaudeHooks,
  rockyGateHookCommand,
  rockyHookCommand,
  writeMutation,
  type AgentHooksOperationResult,
  type CurrentConfig,
} from "../agent-hooks.js";
import {
  DESK_HOOK_ASYNC,
  deskHookCommand,
  hasOwnedDeskHooks,
  mergeDeskHooks,
  ownedDeskHookProjection,
  removeDeskHooks,
} from "../desk-hooks.js";
import { readJsonObject, recoverJsonTransaction, type JsonReadResult } from "../json-config.js";
import { pathExists } from "../file-transaction.js";
import type { AutoState, AutoTargetReport, AutoKind, Paths } from "./types.js";

const HARNESS = "claude-code";
const MISSING_DESK_BINARY = "desk hooks are installed but the rocky-hook binary is missing";

export interface ApplyClaudeSettingsOptions {
  /** Test seam forwarded to the transactional writer; runs before the write lands. */
  beforeWrite?: () => void;
}

function report(kind: AutoKind, path: string, state: AutoState, detail?: string): AutoTargetReport {
  return detail === undefined
    ? { harness: HARNESS, kind, path, state }
    : { harness: HARNESS, kind, path, state, detail };
}

function refusedReports(path: string, includeDesk: boolean, detail: string | undefined): AutoTargetReport[] {
  const reports = [report("agent-hooks", path, "refused", detail)];
  if (includeDesk) reports.push(report("desk-hooks", path, "refused", detail));
  return reports;
}

function messageOf(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

/** Whether the file still holds the snapshot the failed write compared against. */
function untouched(current: CurrentConfig, after: JsonReadResult): boolean {
  if (after.status !== current.read.status) return false;
  if (after.status !== "valid" || current.read.status !== "valid") return true;
  if (!after.bytes.equals(current.read.bytes)) return false;
  return after.identity !== undefined
    && current.read.identity !== undefined
    && after.identity.dev === current.read.identity.dev
    && after.identity.ino === current.read.identity.ino;
}

function stateOf(
  settingsPath: string,
  current: CurrentConfig,
  result: AgentHooksOperationResult,
): { state: AutoState; detail?: string } {
  if (result.status === "written") return { state: "written", detail: result.detail };
  if (result.status === "unchanged") return { state: "ok" };
  if (!untouched(current, readJsonObject(settingsPath))) return { state: "changed" };
  return { state: "error", detail: result.detail };
}

/** Read-only plan for the Claude Code settings file; never recovers or writes. */
export function inspectClaudeSettings(settingsPath: string, paths: Paths): AutoTargetReport[] {
  const { deskHookBin } = paths;
  let value: Record<string, unknown>;
  try {
    value = prepareMutation(settingsPath).read.value;
  } catch (error) {
    return refusedReports(settingsPath, deskHookBin !== undefined, messageOf(error));
  }
  try {
    const ownedGate = hasOwnedGateGroup(value);
    const gateCommand = ownedGate ? rockyGateHookCommand(paths.nodePath, paths.entryPath) : undefined;
    const agentMerged = mergeClaudeHooks(
      value,
      rockyHookCommand("claude-code", paths.nodePath, paths.entryPath),
      gateCommand,
    );
    const agentState: AutoState = JSON.stringify(ownedClaudeHookProjection(value))
        === JSON.stringify(ownedClaudeHookProjection(agentMerged))
      ? "ok"
      : hasOwnedAgentHooks(value) || ownedGate ? "stale" : "missing";
    const reports = [report("agent-hooks", settingsPath, agentState)];
    if (deskHookBin !== undefined) {
      let deskState: AutoState;
      let deskDetail: string | undefined;
      try {
        const deskMerged = mergeDeskHooks(value, deskHookCommand(deskHookBin), DESK_HOOK_ASYNC);
        deskState = JSON.stringify(ownedDeskHookProjection(value)) === JSON.stringify(ownedDeskHookProjection(deskMerged))
          ? "ok"
          : hasOwnedDeskHooks(value) ? "stale" : "missing";
      } catch (error) {
        deskState = "refused";
        deskDetail = messageOf(error);
      }
      reports.push(report("desk-hooks", settingsPath, deskState, deskDetail));
    } else if (hasOwnedDeskHooks(value)) {
      reports.push(report("desk-hooks", settingsPath, "stale", MISSING_DESK_BINARY));
    }
    return reports;
  } catch (error) {
    return refusedReports(settingsPath, deskHookBin !== undefined || hasOwnedDeskHooks(value), messageOf(error));
  }
}

/**
 * Write Rocky's agent hooks, a kept rationale gate, and desk hooks in one
 * transaction. A pending transaction is recovered first, and the existing
 * PreToolUse gate is refreshed only when it is already Rocky's.
 */
export function applyClaudeSettings(
  settingsPath: string,
  paths: Paths,
  options: ApplyClaudeSettingsOptions = {},
): AutoTargetReport[] {
  const { deskHookBin } = paths;
  let desk: { status: "ready"; command: string } | { status: "refused"; detail: string } | undefined;
  if (deskHookBin !== undefined) {
    try {
      desk = { status: "ready", command: deskHookCommand(deskHookBin) };
    } catch (error) {
      desk = { status: "refused", detail: messageOf(error) ?? "desk hook path is unusable" };
    }
  }

  let current: CurrentConfig;
  try {
    recoverJsonTransaction(settingsPath);
    current = prepareMutation(settingsPath);
  } catch (error) {
    return refusedReports(settingsPath, desk !== undefined, messageOf(error));
  }

  let state: AutoState;
  let detail: string | undefined;
  try {
    const gateCommand = hasOwnedGateGroup(current.read.value)
      ? rockyGateHookCommand(paths.nodePath, paths.entryPath)
      : undefined;
    const merged = mergeClaudeHooks(
      current.read.value,
      rockyHookCommand("claude-code", paths.nodePath, paths.entryPath),
      gateCommand,
    );
    const withDesk = desk?.status === "ready" ? mergeDeskHooks(merged, desk.command, DESK_HOOK_ASYNC) : merged;
    ({ state, detail } = stateOf(
      settingsPath,
      current,
      writeMutation(settingsPath, current, withDesk, options, "agent hooks"),
    ));
  } catch (error) {
    state = "refused";
    detail = messageOf(error);
  }

  const reports = [report("agent-hooks", settingsPath, state, detail)];
  if (desk?.status === "refused") reports.push(report("desk-hooks", settingsPath, "refused", desk.detail));
  else if (desk?.status === "ready") reports.push(report("desk-hooks", settingsPath, state, detail));
  else if (hasOwnedDeskHooks(current.read.value)) {
    reports.push(report("desk-hooks", settingsPath, "stale", MISSING_DESK_BINARY));
  }
  return reports;
}

/** Remove every Rocky-owned hook group from both families in one write. */
export function removeClaudeSettings(settingsPath: string): AutoTargetReport[] {
  // Nothing to remove is a success for removal; an unsafe topology still
  // refuses through prepareMutation below.
  if (!pathExists(dirname(settingsPath))) {
    return [report("agent-hooks", settingsPath, "ok"), report("desk-hooks", settingsPath, "ok")];
  }
  let current: CurrentConfig;
  try {
    // Removal must work after an interrupted write, so settle the target's
    // transaction before the pending check inside prepareMutation runs.
    recoverJsonTransaction(settingsPath);
    current = prepareMutation(settingsPath);
  } catch (error) {
    return refusedReports(settingsPath, true, messageOf(error));
  }
  if (current.read.status === "missing") {
    return [report("agent-hooks", settingsPath, "ok"), report("desk-hooks", settingsPath, "ok")];
  }
  let result: AgentHooksOperationResult;
  try {
    result = writeMutation(settingsPath, current, removeDeskHooks(removeClaudeHooks(current.read.value)), {}, "agent hooks");
  } catch (error) {
    return refusedReports(settingsPath, true, messageOf(error));
  }
  const { state, detail } = stateOf(settingsPath, current, result);
  return [report("agent-hooks", settingsPath, state, detail), report("desk-hooks", settingsPath, state, detail)];
}

/** Paste-ready settings values for the manual setup path. */
export function claudeSettingsSnippets(paths: Paths, keptGate: boolean): string[] {
  const snippets = [JSON.stringify(rockyHookCommand("claude-code", paths.nodePath, paths.entryPath))];
  if (keptGate) snippets.push(JSON.stringify(rockyGateHookCommand(paths.nodePath, paths.entryPath)));
  if (paths.deskHookBin !== undefined) {
    // A refused desk target (unsafe or vanished binary) writes no bytes, and
    // callers still need the agent snippets; the target report carries why.
    try {
      snippets.push(JSON.stringify(deskHookCommand(paths.deskHookBin)));
    } catch {
      // Omitted on purpose: there is no desk command to expect.
    }
  }
  return snippets;
}
