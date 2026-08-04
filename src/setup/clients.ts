import type { Exposure } from "../core/config-read.js";

export interface McpRegistration {
  name: "rocky";
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
}

export type SetupMode = "configure" | "check" | "remove";

export interface SetupOptions {
  mode: SetupMode;
  exposure: Exposure;
  replace: boolean;
  yes: boolean;
}

export type SetupClientId = "codex" | "claude-code" | "claude-desktop";

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
