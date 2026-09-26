import type { Exposure } from "../core/config-read.js";

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
  repo?: string;
  repoAction?: RepoCaptureAction;
  harness?: HarnessId[];
  mcp?: boolean;
  listening?: boolean;
  rawTrace?: boolean;
  /** Only meaningful alongside agentHooksAction "install"; default true. */
  rationaleGate?: boolean;
}

export type SetupClientId = "codex" | "claude-code" | "claude-desktop";

/** Closed Listening registry: exactly 11 local harness IDs. Mirrors listening/types.ts. */
export type HarnessId =
  | "claude-code" | "codex" | "opencode" | "antigravity" | "cursor"
  | "devin" | "omp" | "dsh" | "vscode" | "copilot-cli" | "gemini-cli";

export const HARNESS_IDS: readonly HarnessId[] = Object.freeze([
  "claude-code", "codex", "opencode", "antigravity", "cursor",
  "devin", "omp", "dsh", "vscode", "copilot-cli", "gemini-cli",
] as const);

export function isHarnessId(value: unknown): value is HarnessId {
  return typeof value === "string" && (HARNESS_IDS as readonly string[]).includes(value);
}

export type RepoCaptureAction = "allow-capture" | "revoke-capture" | "check-capture";

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
