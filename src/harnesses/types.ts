import type { ParsedHookPayload } from "../agent/adapters/claude-code.js";
import type { CanonicalRationaleEvent } from "../agent/logs/types.js";
import type { ToolResultEvent } from "../core/tool-result.js";
import type { HarnessId } from "../setup/harness-registry.js";

export interface EditedPathEntry {
  path: string;
  excerpt?: string;
}

export interface NormalizedToolOutcome {
  command?: string;
  cwd?: string;
  exitCode?: number;
  exitCodeSource: "structured" | "header" | "unknown";
  /** Header from the hook error field. Null marks a supplied, unusable error field. */
  errorExitHeader?: { exitCode: number; body: string } | null;
  output?: string;
  isError?: boolean;
  toolUseId?: string;
  agentId?: string;
  interrupted?: boolean;
  background?: boolean;
  skipReason?: Extract<ToolResultEvent, { kind: "skip" }>["reason"];
  edits: EditedPathEntry[];
  coveragePaths?: string[];
  coveragePathsComplete?: boolean;
  coverageDigest?: string;
  truncatedFiles?: number;
}

export interface ListeningHookFields {
  nativeId?: string;
  sessionId?: string;
  toolName?: string;
  episode?: string;
  fileRel?: string;
  summaryRef?: string;
  repoRoot?: string;
  ts?: number;
}

export interface DecodedHookInput {
  harnessId: HarnessId;
  eventName?: string;
  sessionId?: string;
  shellTool?: boolean;
  listening: ListeningHookFields;
  /** These fields are evaluated only when an authorized consumer requests them. */
  readonly outcome?: NormalizedToolOutcome;
  readonly agent?: ParsedHookPayload;
}

export type TranscriptEvent =
  | ({ kind: "rationale" } & CanonicalRationaleEvent)
  | {
    kind: "tool-outcome";
    agent: "claude-code" | "codex";
    sessionId?: string;
    turnRef?: string;
    ts: number;
    cwd?: string;
    logPath?: string;
    toolName: string;
    outcome: NormalizedToolOutcome;
  };

export interface TranscriptReducer {
  consume(line: string): TranscriptEvent[];
  finish(): TranscriptEvent[];
}

export interface TranscriptContext {
  logPath?: string;
  sessionId?: string;
}

export type SyncHookResponse = (noteText: string) => string;

export interface HarnessDecoder {
  readonly id: HarnessId;
  decodeHook(raw: unknown, now?: number): DecodedHookInput | undefined;
  createTranscriptReducer(context?: TranscriptContext): TranscriptReducer;
  renderSyncResponse?: SyncHookResponse;
}
