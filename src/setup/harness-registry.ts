/**
 * Closed v1 harness identity + evidence contract.
 * Data only: no filesystem, process, or network access from this module.
 */

export type HarnessId =
  | "claude-code" | "codex" | "opencode" | "antigravity" | "cursor"
  | "devin" | "omp" | "dsh" | "vscode" | "copilot-cli" | "gemini-cli";

export type HarnessSurface = "cli" | "ide" | "local" | "profile";

export type DetectionStatus = "binary" | "app" | "config-only" | "not-found" | "unknown";
export type CapabilityStatus = "documented" | "verified" | "unverified" | "unavailable";

export type RockyHarnessStatus = "verified" | "probe-required" | "documented" | "unverified";

export interface HarnessCapabilityMatrixEntry {
  configFormat: "json" | "plugin" | "toml-manual" | "none";
  vendorDocumented: string;
  versionSurface: string;
  syncResponse: "supported" | "probe-required" | "unsupported";
  rockyStatus: RockyHarnessStatus;
  verifiedVersion?: string;
}

export interface HarnessEvidence {
  id: HarnessId;
  surface?: HarnessSurface;
  detectionStatus: DetectionStatus;
  evidencePath?: string;
  observedVersion?: string;
  capabilities: { mcp: CapabilityStatus; listening: CapabilityStatus };
  verificationMarkers: { mcp?: string; listening?: string };
}

export interface HarnessDefinition {
  readonly id: HarnessId;
  readonly label: string;
  readonly surfaces: readonly HarnessSurface[];
  readonly evidenceHints: readonly string[];
  readonly capabilityLabels: readonly string[];
  readonly markerNames: { readonly mcp: string; readonly listening: string };
  readonly matrix: HarnessCapabilityMatrixEntry;
}

/**
 * Mutation outcome for a configured target. Separate from HarnessEvidence:
 * applying a mutation result MUST never overwrite discovery evidence.
 */
export interface HarnessOperationResult {
  readonly id: HarnessId;
  readonly surface?: HarnessSurface;
  readonly outcome:
    | "configured" | "already-configured" | "checked" | "removed"
    | "requires-consent" | "unsupported" | "blocked" | "conflict" | "failed";
  readonly detail?: string;
}

export const HARNESS_REGISTRY: readonly HarnessDefinition[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    surfaces: ["cli"],
    evidenceHints: ["claude CLI"],
    capabilityLabels: ["mcp", "listening"],
    markerNames: { mcp: "mcp-status", listening: "hook-event" },
    matrix: {
      configFormat: "json",
      vendorDocumented: "JSON ~/.claude/settings.json (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, Stop)",
      versionSurface: "CLI",
      syncResponse: "supported",
      rockyStatus: "verified",
    },
  },
  {
    id: "codex",
    label: "Codex CLI",
    surfaces: ["cli"],
    evidenceHints: ["codex CLI"],
    capabilityLabels: ["mcp", "listening"],
    markerNames: { mcp: "mcp-list", listening: "hook-event" },
    matrix: {
      configFormat: "json",
      vendorDocumented: "$CODEX_HOME/hooks.json & .codex/hooks.json (JSON; trust via /hooks, sandbox --dangerously-bypass-hook-trust); inline [hooks] & notify in config.toml",
      versionSurface: "CLI (0.171.0)",
      syncResponse: "probe-required",
      rockyStatus: "probe-required",
    },
  },
  {
    id: "opencode",
    label: "OpenCode",
    surfaces: ["cli"],
    evidenceHints: ["opencode executable"],
    capabilityLabels: ["mcp", "listening"],
    markerNames: { mcp: "mcp-config", listening: "plugin-event" },
    matrix: {
      configFormat: "plugin",
      vendorDocumented: "Plugin auto-discovery .js/.ts (NOT .mjs): V1 tool.execute.before/after, V2 ctx.tool.hook(\"execute.before\"/\"execute.after\", ...)",
      versionSurface: "CLI (V1 / V2)",
      syncResponse: "probe-required",
      rockyStatus: "unverified",
    },
  },
  {
    id: "antigravity",
    label: "Antigravity",
    surfaces: ["cli", "ide"],
    evidenceHints: ["agy CLI", "IDE config"],
    capabilityLabels: ["mcp", "listening"],
    markerNames: { mcp: "mcp-config", listening: "hook-event" },
    matrix: {
      configFormat: "json",
      vendorDocumented: "JSON ~/.gemini/config/hooks.json & .agents/hooks.json (PreToolUse requires empty stdout; Stop requires {\"decision\":\"\"}; PostToolUse {})",
      versionSurface: "CLI / IDE",
      syncResponse: "unsupported",
      rockyStatus: "documented",
    },
  },
  {
    id: "cursor",
    label: "Cursor",
    surfaces: ["cli", "ide"],
    evidenceHints: ["agent CLI provenance", "IDE config"],
    capabilityLabels: ["mcp", "listening"],
    markerNames: { mcp: "mcp-status", listening: "hook-event" },
    matrix: {
      configFormat: "json",
      vendorDocumented: "JSON ~/.cursor/hooks.json (\"version\": 1, flat { command }; beforeSubmitPrompt requires {\"continue\":true}; afterShellExecution observational)",
      versionSurface: "CLI / IDE",
      syncResponse: "supported",
      rockyStatus: "documented",
    },
  },
  {
    id: "devin",
    label: "Devin CLI",
    surfaces: ["cli"],
    evidenceHints: ["devin CLI"],
    capabilityLabels: ["mcp", "listening"],
    markerNames: { mcp: "mcp-status", listening: "hook-event" },
    matrix: {
      configFormat: "json",
      vendorDocumented: "~/.config/devin/config.json / %APPDATA%\\devin\\config.json / .devin/hooks.v1.json (regex matcher; also reads Claude config → duplicate-hook risk)",
      versionSurface: "CLI",
      syncResponse: "probe-required",
      rockyStatus: "unverified",
    },
  },
  {
    id: "omp",
    label: "OMP",
    surfaces: ["cli", "profile"],
    evidenceHints: ["omp command", "active profile"],
    capabilityLabels: ["mcp", "listening"],
    markerNames: { mcp: "mcp-list", listening: "hook-event" },
    matrix: {
      configFormat: "plugin",
      vendorDocumented: "Extensions in ~/.omp/agent/extensions (ExtensionAPI tool_call/tool_result)",
      versionSurface: "CLI / Profile",
      syncResponse: "probe-required",
      rockyStatus: "unverified",
    },
  },
  {
    id: "dsh",
    label: "DSH",
    surfaces: ["profile"],
    evidenceHints: ["dsh --version", "active profile", "dsh --dump-config"],
    capabilityLabels: ["mcp", "listening"],
    markerNames: { mcp: "mcp-client", listening: "hook-event" },
    matrix: {
      configFormat: "none",
      vendorDocumented: "Log-only (no hook installer in Wave 1 scope)",
      versionSurface: "Profile",
      syncResponse: "unsupported",
      rockyStatus: "verified",
    },
  },
  {
    id: "vscode",
    label: "VS Code Local",
    surfaces: ["local"],
    evidenceHints: ["VS Code Local session"],
    capabilityLabels: ["mcp", "listening"],
    markerNames: { mcp: "mcp-config", listening: "hook-event" },
    matrix: {
      configFormat: "json",
      vendorDocumented: "Multi-runtime surface sharing .github/hooks/*.json with Copilot CLI (must avoid double-registering)",
      versionSurface: "Local / IDE",
      syncResponse: "probe-required",
      rockyStatus: "unverified",
    },
  },
  {
    id: "copilot-cli",
    label: "Copilot CLI",
    surfaces: ["cli"],
    evidenceHints: ["copilot CLI"],
    capabilityLabels: ["mcp", "listening"],
    markerNames: { mcp: "mcp-list", listening: "hook-event" },
    matrix: {
      configFormat: "json",
      vendorDocumented: "JSON $COPILOT_HOME/hooks/*.json (default ~/.copilot/hooks/rocky.json, version: 1, bash/powershell; repo .github/hooks/*.json); preToolUse is fail-closed",
      versionSurface: "CLI",
      syncResponse: "probe-required",
      rockyStatus: "probe-required",
    },
  },
  {
    id: "gemini-cli",
    label: "Gemini CLI",
    surfaces: ["cli"],
    evidenceHints: ["gemini CLI"],
    capabilityLabels: ["mcp", "listening"],
    markerNames: { mcp: "mcp-list", listening: "hook-event" },
    matrix: {
      configFormat: "json",
      vendorDocumented: "JSON ~/.gemini/settings.json (BeforeTool, AfterTool, BeforeAgent, AfterAgent, SessionStart; timeout in ms)",
      versionSurface: "CLI",
      syncResponse: "supported",
      rockyStatus: "documented",
    },
  },
];

export const HARNESS_IDS: readonly HarnessId[] = Object.freeze(HARNESS_REGISTRY.map(({ id }) => id));

export function isHarnessId(value: unknown): value is HarnessId {
  return typeof value === "string" && (HARNESS_IDS as readonly string[]).includes(value);
}

export function getHarnessDefinition(id: HarnessId): HarnessDefinition {
  const found = HARNESS_REGISTRY.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`unknown harness id: ${id}`);
  return found;
}

export function surfacesFor(id: HarnessId): readonly HarnessSurface[] {
  const found = HARNESS_REGISTRY.find((entry) => entry.id === id);
  return found === undefined ? [] : found.surfaces;
}
