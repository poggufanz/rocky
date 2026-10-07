import type { HarnessId } from "./harness-registry.js";
import type { SetupClientAdapter } from "./clients.js";
import type { PlatformServices } from "./platform.js";
import type { ProcessRunner } from "./process.js";
import { createHarnessClaudeCodeAdapter } from "./harness-claude-code.js";
import { createHarnessCodexAdapter } from "./harness-codex.js";
import { createHarnessOpencodeAdapter } from "./harness-opencode.js";
import { createHarnessGeminiAdapter } from "./harness-gemini-cli.js";
import { createHarnessCopilotAdapter } from "./harness-copilot-cli.js";

export interface HarnessMcpDispatchDeps {
  runner: ProcessRunner;
  platform: PlatformServices;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/** Hosts with an MCP adapter; the setup picker offers only these. */
export const MCP_HARNESS_IDS: readonly HarnessId[] = [
  "claude-code",
  "codex",
  "opencode",
  "gemini-cli",
  "copilot-cli",
];

export function createHarnessMcpAdapters(
  ids: readonly HarnessId[],
  deps: HarnessMcpDispatchDeps,
): SetupClientAdapter[] {
  const seen = new Set<HarnessId>();
  const adapters: SetupClientAdapter[] = [];
  for (const id of ids) {
    if (seen.has(id) || !MCP_HARNESS_IDS.includes(id)) continue;
    seen.add(id);
    switch (id) {
      case "claude-code":
        adapters.push(createHarnessClaudeCodeAdapter(deps));
        break;
      case "codex":
        adapters.push(createHarnessCodexAdapter(deps));
        break;
      case "opencode":
        adapters.push(createHarnessOpencodeAdapter(deps));
        break;
      case "gemini-cli":
        adapters.push(createHarnessGeminiAdapter(deps));
        break;
      case "copilot-cli":
        adapters.push(createHarnessCopilotAdapter(deps));
        break;
    }
  }
  return adapters;
}
