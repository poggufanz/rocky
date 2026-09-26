import type { Exposure } from "../core/config-read.js";
import type { AgentHooksAction, HarnessId, SetupMode, SetupOptions } from "./clients.js";
import { isHarnessId } from "./clients.js";

export class SetupUsageError extends Error {
  readonly exitCode = 2;

  constructor(message: string) {
    super(message);
    this.name = "SetupUsageError";
  }
}

export function parseSetupArgs(argv: readonly string[]): SetupOptions {
  let mode: SetupMode = "configure";
  let modeOption: "--check" | "--remove" | undefined;
  let exposure: Exposure = "sanitized";
  let exposureProvided = false;
  let replace = false;
  let yes = false;
  let voiceSkill = false;
  let agentHooksAction: AgentHooksAction | undefined;
  let rationaleGate = true;
  let rationaleGateProvided = false;
  let repo: string | undefined;
  let repoAction: SetupOptions["repoAction"];
  let harness: HarnessId[] | undefined;
  let mcp: boolean | undefined;
  let listening: boolean | undefined;
  let rawTrace = false;

  const takeValue = (flag: string, index: number): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new SetupUsageError(`${flag} requires a value`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check" || argument === "--remove") {
      if (modeOption !== undefined && modeOption !== argument) {
        throw new SetupUsageError("--check and --remove are mutually exclusive");
      }
      modeOption = argument;
      mode = argument === "--check" ? "check" : "remove";
      continue;
    }
    if (argument === "--replace") {
      replace = true;
      continue;
    }
    if (argument === "--yes") {
      yes = true;
      continue;
    }
    if (argument === "--voice-skill") {
      voiceSkill = true;
      continue;
    }
    if (argument === "--no-rationale-gate") {
      rationaleGate = false;
      rationaleGateProvided = true;
      continue;
    }
    if (argument === "--agent-hooks" || argument === "--uninstall-agent-hooks" || argument === "--status") {
      const selected: AgentHooksAction = argument === "--agent-hooks"
        ? "install"
        : argument === "--uninstall-agent-hooks"
          ? "uninstall"
          : "status";
      if (agentHooksAction !== undefined) {
        throw new SetupUsageError("agent hook actions are mutually exclusive");
      }
      agentHooksAction = selected;
      continue;
    }
    if (argument === "--mcp-exposure") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new SetupUsageError("--mcp-exposure requires a value: sanitized or raw");
      }
      if (value !== "sanitized" && value !== "raw") {
        throw new SetupUsageError("--mcp-exposure must be sanitized or raw");
      }
      exposure = value;
      exposureProvided = true;
      index += 1;
      continue;
    }
    if (argument === "--repo") {
      if (repo !== undefined) {
        throw new SetupUsageError("--repo accepts one path only");
      }
      repo = takeValue("--repo", index);
      index += 1;
      continue;
    }
    if (argument === "--allow-capture" || argument === "--revoke-capture" || argument === "--check-capture") {
      if (repoAction !== undefined) {
        throw new SetupUsageError("capture actions are mutually exclusive");
      }
      repoAction = argument === "--allow-capture"
        ? "allow-capture"
        : argument === "--revoke-capture"
          ? "revoke-capture"
          : "check-capture";
      continue;
    }
    if (argument === "--harness") {
      const value = takeValue("--harness", index);
      index += 1;
      if (!isHarnessId(value)) {
        throw new SetupUsageError(`unknown harness id: ${value}`);
      }
      harness = [...(harness ?? []), value];
      continue;
    }
    if (argument === "--mcp") {
      mcp = true;
      continue;
    }
    if (argument === "--listening") {
      listening = true;
      continue;
    }
    if (argument === "--raw-trace") {
      rawTrace = true;
      continue;
    }
    if (argument !== "--" && argument.startsWith("--")) {
      throw new SetupUsageError(`unknown setup option: ${argument}`);
    }
    throw new SetupUsageError(`setup does not accept positional input: ${argument}`);
  }

  // Repo capture actions are standalone: never mixed with host/feature work.
  if (repo !== undefined || repoAction !== undefined) {
    if (repo === undefined) {
      throw new SetupUsageError("--allow-capture, --revoke-capture, and --check-capture need --repo <absolute-path>");
    }
    if (repoAction === undefined) {
      throw new SetupUsageError("--repo needs one action: --allow-capture, --revoke-capture, or --check-capture");
    }
    if (modeOption !== undefined || replace || exposureProvided || voiceSkill
      || agentHooksAction !== undefined || rationaleGateProvided
      || harness !== undefined || mcp !== undefined || listening !== undefined || rawTrace) {
      throw new SetupUsageError("--repo capture actions cannot combine with host or feature flags");
    }
    return { mode, exposure, replace, yes, voiceSkill, repo, repoAction };
  }

  if (rawTrace) {
    if (listening !== true) {
      throw new SetupUsageError("--raw-trace needs --listening");
    }
    const count = harness === undefined ? 0 : harness.length;
    if (count !== 1) {
      throw new SetupUsageError("--raw-trace needs exactly one --harness <id>");
    }
  }

  if ((mcp !== undefined || listening !== undefined) && (agentHooksAction !== undefined || voiceSkill)) {
    throw new SetupUsageError("--mcp and --listening cannot combine with voice-skill or agent-hook actions");
  }

  if (mode !== "configure" && (replace || exposureProvided)) {
    throw new SetupUsageError("--replace and --mcp-exposure are valid only in configure mode");
  }

  if (replace && listening === true && mcp !== true) {
    throw new SetupUsageError("--replace cannot combine with --listening alone");
  }

  if (exposureProvided && listening === true && mcp !== true) {
    throw new SetupUsageError("--mcp-exposure needs MCP in scope");
  }

  if (agentHooksAction !== undefined) {
    if (modeOption !== undefined || replace || exposureProvided || voiceSkill
      || harness !== undefined || mcp !== undefined || listening !== undefined || rawTrace) {
      throw new SetupUsageError("agent hook actions cannot combine with MCP or voice-skill options");
    }
    if (rationaleGateProvided && agentHooksAction !== "install") {
      throw new SetupUsageError("--no-rationale-gate is valid only with --agent-hooks");
    }
    return { mode, exposure, replace, yes, voiceSkill, agentHooksAction, rationaleGate };
  }

  if (rationaleGateProvided) {
    throw new SetupUsageError("--no-rationale-gate is valid only with --agent-hooks");
  }

  const deduped = harness === undefined ? undefined : [...new Set(harness)];
  return {
    mode, exposure, replace, yes, voiceSkill,
    ...(deduped === undefined ? {} : { harness: deduped }),
    ...(mcp === undefined ? {} : { mcp }),
    ...(listening === undefined ? {} : { listening }),
    ...(rawTrace ? { rawTrace } : {}),
  };
}
