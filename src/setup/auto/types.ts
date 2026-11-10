import type { McpHarnessId } from "./state.js";

/** The setup surfaces a harness target can carry. */
export type AutoKind = "agent-hooks" | "desk-hooks" | "mcp" | "shell-hook";

/** What the engine found, did, or refused to do for one target. */
export type AutoState =
  | "ok"
  | "missing"
  | "stale"
  | "written"
  | "changed"
  | "foreign"
  | "refused"
  | "not_consented"
  | "error";

/** One target's outcome, addressed by harness, kind, and exact file path. */
export interface AutoTargetReport {
  harness: McpHarnessId | "shell";
  kind: AutoKind;
  path: string;
  state: AutoState;
  detail?: string;
}

/** Injected locations, resolved once by setup instead of re-derived per target. */
export interface Paths {
  nodePath: string;
  entryPath: string;
  /** Set only when the rocky-hook binary exists at `hookBinPath(rockyHome, platform)`. */
  deskHookBin?: string;
}
