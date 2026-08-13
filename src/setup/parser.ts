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
    if (argument !== "--" && argument.startsWith("--")) {
      throw new SetupUsageError(`unknown setup option: ${argument}`);
    }
    throw new SetupUsageError(`setup does not accept positional input: ${argument}`);
  }

  if (mode !== "configure" && (replace || exposureProvided)) {
    throw new SetupUsageError("--replace and --mcp-exposure are valid only in configure mode");
  }

  if (agentHooksAction !== undefined) {
    if (modeOption !== undefined || replace || exposureProvided || voiceSkill) {
      throw new SetupUsageError("agent hook actions cannot combine with MCP or voice-skill options");
    }
    return { mode, exposure, replace, yes, voiceSkill, agentHooksAction };
  }

  return { mode, exposure, replace, yes, voiceSkill };
}
