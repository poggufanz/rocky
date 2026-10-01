import type { Exposure } from "../core/config-read.js";
import { HARNESS_IDS, isHarnessId, type HarnessId } from "./harness-registry.js";

export { HARNESS_IDS, isHarnessId };
export type { HarnessId };
export type RepoCaptureAction = "allow-capture" | "revoke-capture" | "check-capture" | "purge-capture";

export interface McpRegistration {
  name: "rocky";
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
}

export type SetupMode = "configure" | "check" | "remove";

export type AgentHooksAction = "install" | "uninstall" | "status";

export interface SetupOptions {
  mode: SetupMode;
  exposure: Exposure;
  replace: boolean;
  yes: boolean;
  voiceSkill: boolean;
  agentHooksAction?: AgentHooksAction;
  /** Only meaningful alongside agentHooksAction "install"; default true. */
  rationaleGate?: boolean;
  /** Explicit harness targets, deduped in first-seen order; [] = legacy path. */
  harnesses: readonly HarnessId[];
  /** Feature selectors; both false at parse output means MCP-only default. */
  mcp: boolean;
  listening: boolean;
  /** Absolute path for standalone repo-consent actions. */
  repo?: string;
  repoAction?: RepoCaptureAction;
  /** P0 parses + validates only; grant storage is out of scope. */
  rawTrace: boolean;
  /**
   * Listening-side alias for {@link SetupOptions.harnesses}.
   * Present only when the parser populates it; kept in sync by the parser.
   */
  readonly harness?: readonly HarnessId[];
}

export type SetupClientId =
  | "codex" | "claude-code" | "claude-desktop"
  | "opencode" | "gemini-cli" | "copilot-cli";

export type SetupStatus =
  | "configured"
  | "already-configured"
  | "removed"
  | "not-configured"
  | "healthy"
  | "skipped"
  | "requires-confirmation"
  | "blocked-by-policy"
  | "failed";

export interface SetupResult {
  client: SetupClientId;
  status: SetupStatus;
  detail?: string;
  manualRegistration?: McpRegistration;
  healthRegistration?: McpRegistration;
}

export interface InspectionResult {
  state: "absent" | "identical" | "conflict" | "unreadable" | "blocked";
  detail?: string;
  snapshot?: unknown;
}

export interface SetupClientAdapter {
  readonly id: SetupClientId;
  inspect(registration: McpRegistration): Promise<InspectionResult>;
  configure(registration: McpRegistration, replace: boolean): Promise<SetupResult>;
  remove(registration: McpRegistration): Promise<SetupResult>;
  check(registration: McpRegistration): Promise<SetupResult>;
}
