import { isHarnessId, type HarnessId } from "./harness-registry.js";
 import type { Exposure } from "../core/config-read.js";
 import type { AgentHooksAction, SetupMode, SetupOptions } from "./clients.js";

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
  const harnesses: HarnessId[] = [];
  let mcp = false;
  let listening = false;
  let repo: string | undefined;
  let repoAction: SetupOptions["repoAction"];
  let rawTrace = false;

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
    if (argument === "--harness") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new SetupUsageError("--harness requires a value: one of the 11 registry ids");
      }
      if (!isHarnessId(value)) {
        throw new SetupUsageError(`unknown harness id: ${value}`);
      }
      if (!harnesses.includes(value)) harnesses.push(value);
      index += 1;
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
    if (argument === "--repo") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new SetupUsageError("--repo requires an absolute path value");
      }
      repo = value;
      index += 1;
      continue;
    }
    if (argument === "--allow-capture" || argument === "--revoke-capture" || argument === "--check-capture") {
      if (repoAction !== undefined) {
        throw new SetupUsageError("--repo action flags --allow-capture, --revoke-capture, and --check-capture are mutually exclusive");
      }
      repoAction = argument === "--allow-capture"
        ? "allow-capture"
        : argument === "--revoke-capture"
          ? "revoke-capture"
          : "check-capture";
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

  if (repo !== undefined || repoAction !== undefined) {
    if (repo === undefined || repoAction === undefined) {
      throw new SetupUsageError("--repo requires exactly one of --allow-capture, --revoke-capture, --check-capture");
    }
    if (
      harnesses.length > 0 || mcp || listening || rawTrace || voiceSkill
      || modeOption !== undefined || replace || exposureProvided
      || agentHooksAction !== undefined || rationaleGateProvided
    ) {
      throw new SetupUsageError("--repo actions are standalone and cannot combine with host or feature flags");
    }
    return { mode, exposure, replace, yes, voiceSkill, harnesses, harness: [...harnesses], mcp: true, listening: false, repo, repoAction, rawTrace: false };
  }

  if (rawTrace) {
    const rawTraceModeOk = modeOption === undefined || modeOption === "--check" || modeOption === "--remove";
    if (!listening || harnesses.length !== 1 || !rawTraceModeOk || agentHooksAction !== undefined) {
      throw new SetupUsageError("--raw-trace requires --listening and exactly one --harness on setup, --check, or --remove");
    }
  }

  if (agentHooksAction === "status" && (mcp || listening)) {
    throw new SetupUsageError("--status accepts --harness but not --mcp or --listening");
  }
  if ((mcp || listening) && (voiceSkill || agentHooksAction !== undefined || rationaleGateProvided)) {
    throw new SetupUsageError("--mcp and --listening only scope setup, --check, and --remove; they cannot combine with voice-skill or agent hook actions");
  }
  if (replace && listening && !mcp) {
    throw new SetupUsageError("--replace only replaces MCP state; --replace with --listening requires --mcp");
  }
  if (exposureProvided && !mcp && (listening || harnesses.length > 0)) {
    throw new SetupUsageError("--mcp-exposure applies to MCP registration only; pass --mcp to select it");
  }

  if (mode !== "configure" && (replace || exposureProvided)) {
    throw new SetupUsageError("--replace and --mcp-exposure are valid only in configure mode");
  }

  if (agentHooksAction !== undefined) {
    if (modeOption !== undefined || replace || exposureProvided || voiceSkill) {
      throw new SetupUsageError("agent hook actions cannot combine with MCP or voice-skill options");
    }
    if (rationaleGateProvided && agentHooksAction !== "install") {
      throw new SetupUsageError("--no-rationale-gate is valid only with --agent-hooks");
    }
    return { mode, exposure, replace, yes, voiceSkill, agentHooksAction, rationaleGate, harnesses, harness: [...harnesses], mcp: false, listening: false, rawTrace: false };
  }

  if (rationaleGateProvided) {
    throw new SetupUsageError("--no-rationale-gate is valid only with --agent-hooks");
  }

  return { mode, exposure, replace, yes, voiceSkill, harnesses, harness: [...harnesses], mcp: mcp || !listening, listening, rawTrace };
}
