/**
 * Closed v1.0.0 harness identity + evidence contract (spec section 2).
 * Data only: no filesystem, process, or network access from this module.
 */

export type HarnessId =
  | "claude-code" | "codex" | "opencode" | "antigravity" | "cursor"
  | "devin" | "omp" | "dsh" | "vscode" | "copilot-cli" | "gemini-cli";

export type HarnessSurface = "cli" | "ide" | "local" | "profile";

export type DetectionStatus = "binary" | "app" | "config-only" | "not-found" | "unknown";
export type CapabilityStatus = "documented" | "verified" | "unverified" | "unavailable";

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

export const HARNESS_IDS: readonly HarnessId[] = [
  "claude-code", "codex", "opencode", "antigravity", "cursor",
  "devin", "omp", "dsh", "vscode", "copilot-cli", "gemini-cli",
];

export const HARNESS_REGISTRY: readonly HarnessDefinition[] = [
  { id: "claude-code", label: "Claude Code", surfaces: ["cli"], evidenceHints: ["claude CLI"], capabilityLabels: ["mcp", "listening"], markerNames: { mcp: "mcp-status", listening: "hook-event" } },
  { id: "codex", label: "Codex CLI", surfaces: ["cli"], evidenceHints: ["codex CLI"], capabilityLabels: ["mcp", "listening"], markerNames: { mcp: "mcp-list", listening: "hook-event" } },
  { id: "opencode", label: "OpenCode", surfaces: ["cli"], evidenceHints: ["opencode executable"], capabilityLabels: ["mcp", "listening"], markerNames: { mcp: "mcp-config", listening: "plugin-event" } },
  { id: "antigravity", label: "Antigravity", surfaces: ["cli", "ide"], evidenceHints: ["agy CLI", "IDE config"], capabilityLabels: ["mcp", "listening"], markerNames: { mcp: "mcp-config", listening: "hook-event" } },
  { id: "cursor", label: "Cursor", surfaces: ["cli", "ide"], evidenceHints: ["agent CLI provenance", "IDE config"], capabilityLabels: ["mcp", "listening"], markerNames: { mcp: "mcp-status", listening: "hook-event" } },
  { id: "devin", label: "Devin CLI", surfaces: ["cli"], evidenceHints: ["devin CLI"], capabilityLabels: ["mcp", "listening"], markerNames: { mcp: "mcp-status", listening: "hook-event" } },
  { id: "omp", label: "OMP", surfaces: ["cli", "profile"], evidenceHints: ["omp command", "active profile"], capabilityLabels: ["mcp", "listening"], markerNames: { mcp: "mcp-list", listening: "hook-event" } },
  { id: "dsh", label: "DSH", surfaces: ["profile"], evidenceHints: ["dsh --version", "active profile", "dsh --dump-config"], capabilityLabels: ["mcp", "listening"], markerNames: { mcp: "mcp-client", listening: "hook-event" } },
  { id: "vscode", label: "VS Code Local", surfaces: ["local"], evidenceHints: ["VS Code Local session"], capabilityLabels: ["mcp", "listening"], markerNames: { mcp: "mcp-config", listening: "hook-event" } },
  { id: "copilot-cli", label: "Copilot CLI", surfaces: ["cli"], evidenceHints: ["copilot CLI"], capabilityLabels: ["mcp", "listening"], markerNames: { mcp: "mcp-list", listening: "hook-event" } },
  { id: "gemini-cli", label: "Gemini CLI", surfaces: ["cli"], evidenceHints: ["gemini CLI"], capabilityLabels: ["mcp", "listening"], markerNames: { mcp: "mcp-list", listening: "hook-event" } },
];

export function isHarnessId(value: string): value is HarnessId {
  return (HARNESS_IDS as readonly string[]).includes(value);
}

export function surfacesFor(id: HarnessId): readonly HarnessSurface[] {
  const found = HARNESS_REGISTRY.find((entry) => entry.id === id);
  return found === undefined ? [] : found.surfaces;
}
