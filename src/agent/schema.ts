import { createHash } from "node:crypto";

export type AgentName = "claude-code" | "codex";

/** Evidence source for a remembered file change. */
export type FileProvenance = "tool-observed" | "git-diff-inferred" | "unknown";

export interface TurnBaselineFile {
  path: string;
  plusMinus: [number, number];
}

/**
 * A baseline is captured at UserPromptSubmit and consumed at Stop.  A missing
 * baseline is explicit: annotation must not present current repository state
 * as a proven turn delta.
 */
export interface TurnBaseline {
  status: "captured" | "unknown";
  head?: string;
  files?: TurnBaselineFile[];
}

export interface IntentEvent {
  v: 1;
  agent: AgentName;
  kind: "intent";
  ts: number;
  cwd?: string;
  text: string;
  baseline?: TurnBaseline;
}

export interface MechanismEvent {
  v: 1;
  agent: AgentName;
  kind: "mechanism";
  ts: number;
  tool: string;
  path: string;
  excerpt?: string;
  provenance?: FileProvenance;
  /** Number of unique paths omitted by an adapter event cap. */
  truncatedFiles?: number;
  /**
   * Bounded batch coverage witness.  Adapters attach this to the first
   * mechanism event when their path list overflows, so annotation can union
   * tool and Git identities instead of adding independent overflow counters.
   */
  coveragePaths?: string[];
  coveragePathsComplete?: boolean;
}

export const MAX_BASELINE_FILES = 256;
/** Keep durable coverage identity metadata bounded while retaining common multi-file turns. */
export const MAX_COVERAGE_PATHS = 256;

export interface RationaleEvent {
  v: 1;
  agent: AgentName;
  kind: "rationale";
  ts: number;
  source: "transcript" | "notify";
  text: string;
}

export type AgentEvent = IntentEvent | MechanismEvent | RationaleEvent;

export const MAX_INTENT_CHARS = 2000;
export const MAX_RATIONALE_CHARS = 2000;
export const MAX_EXCERPT_CHARS = 400;

const MAX_BATCH_KEY_CHARS = 120;
const AGENTS: ReadonlySet<string> = new Set(["claude-code", "codex"]);
const FILENAME_SAFE = /^[A-Za-z0-9_-]+$/;

function str(value: unknown, cap: number): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, cap) : undefined;
}

function parseBaseline(value: unknown): TurnBaseline | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.status !== "captured" && record.status !== "unknown") return undefined;
  const filesValue = record.files;
  if (filesValue !== undefined && !Array.isArray(filesValue)) return undefined;
  if (filesValue !== undefined && filesValue.length > MAX_BASELINE_FILES) return { status: "unknown" };
  const files: TurnBaselineFile[] = [];
  for (const item of filesValue ?? []) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;
    const file = item as Record<string, unknown>;
    if (typeof file.path !== "string" || file.path.length === 0 || file.path.length > 1024 ||
        !Array.isArray(file.plusMinus) || file.plusMinus.length !== 2 ||
        typeof file.plusMinus[0] !== "number" || !Number.isSafeInteger(file.plusMinus[0]) || file.plusMinus[0] < 0 ||
        typeof file.plusMinus[1] !== "number" || !Number.isSafeInteger(file.plusMinus[1]) || file.plusMinus[1] < 0) return undefined;
    files.push({ path: file.path, plusMinus: [file.plusMinus[0], file.plusMinus[1]] });
    if (files.length >= MAX_BASELINE_FILES) break;
  }
  const head = record.head === undefined ? undefined : str(record.head, 256);
  if (record.head !== undefined && head === undefined) return undefined;
  return {
    status: record.status,
    ...(head === undefined ? {} : { head }),
    ...(files.length === 0 ? {} : { files }),
  };
}

export function parseAgentEvent(value: unknown): AgentEvent | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.v !== 1) return undefined;
  if (typeof record.agent !== "string" || !AGENTS.has(record.agent)) return undefined;
  if (typeof record.ts !== "number" || !Number.isFinite(record.ts)) return undefined;
  const agent = record.agent as AgentName;
  const ts = record.ts;

  switch (record.kind) {
    case "intent": {
      const text = str(record.text, MAX_INTENT_CHARS);
      if (!text) return undefined;
      const cwd = typeof record.cwd === "string" ? record.cwd : undefined;
      const baseline = record.baseline === undefined ? undefined : parseBaseline(record.baseline);
      if (record.baseline !== undefined && baseline === undefined) return undefined;
      return { v: 1, agent, kind: "intent", ts, ...(cwd ? { cwd } : {}), text, ...(baseline ? { baseline } : {}) };
    }
    case "mechanism": {
      const path = str(record.path, 1024);
      const tool = str(record.tool, 64);
      if (!path || !tool) return undefined;
      const excerpt = str(record.excerpt, MAX_EXCERPT_CHARS);
      const provenance = record.provenance === undefined ? undefined : record.provenance;
      if (provenance !== undefined && provenance !== "tool-observed" && provenance !== "git-diff-inferred" && provenance !== "unknown") {
        return undefined;
      }
      const rawTruncatedFiles = record.truncatedFiles;
      if (rawTruncatedFiles !== undefined && (typeof rawTruncatedFiles !== "number" || !Number.isSafeInteger(rawTruncatedFiles) || rawTruncatedFiles < 0)) return undefined;
      const truncatedFiles = typeof rawTruncatedFiles === "number" ? rawTruncatedFiles : undefined;
      const rawCoveragePaths = record.coveragePaths;
      let coveragePaths: string[] | undefined;
      let coveragePathsComplete: boolean | undefined;
      if (rawCoveragePaths !== undefined) {
        if (!Array.isArray(rawCoveragePaths)) return undefined;
        coveragePaths = [];
        const seen = new Set<string>();
        for (const value of rawCoveragePaths.slice(0, MAX_COVERAGE_PATHS)) {
          if (typeof value !== "string" || value.length === 0 || value.length > 1024) return undefined;
          if (!seen.has(value)) {
            seen.add(value);
            coveragePaths.push(value);
          }
        }
        coveragePathsComplete = rawCoveragePaths.length <= MAX_COVERAGE_PATHS;
      }
      if (record.coveragePathsComplete !== undefined) {
        if (typeof record.coveragePathsComplete !== "boolean") return undefined;
        coveragePathsComplete = record.coveragePathsComplete && coveragePathsComplete !== false;
      }
      return {
        v: 1, agent, kind: "mechanism", ts, tool, path,
        ...(excerpt ? { excerpt } : {}),
        ...(provenance === undefined ? {} : { provenance }),
        ...(truncatedFiles === undefined ? {} : { truncatedFiles }),
        ...(coveragePaths === undefined ? {} : { coveragePaths }),
        ...(coveragePathsComplete === undefined ? {} : { coveragePathsComplete }),
      };
    }
    case "rationale": {
      const text = str(record.text, MAX_RATIONALE_CHARS);
      if (!text) return undefined;
      const source = record.source === "notify"
        ? "notify"
        : record.source === "transcript"
          ? "transcript"
          : undefined;
      if (!source) return undefined;
      return { v: 1, agent, kind: "rationale", ts, source, text };
    }
    default:
      return undefined;
  }
}

function sanitizeKeyPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

function keyDigest(agent: AgentName, session: string, turn: string): string {
  // Hash a structured value, not the display form.  Joining with hyphens would
  // make (session: "a-b", turn: "c") collide with (session: "a", turn: "b-c").
  return createHash("sha256")
    .update(JSON.stringify([agent, session, turn]), "utf8")
    .digest("hex")
    .slice(0, 16);
}

export function batchKey(agent: AgentName, session: string, turn: string): string {
  const raw = `${agent}-${session}-${turn}`;
  const componentsAreUnambiguous = session.length > 0 && turn.length > 0
    && !session.includes("-") && !turn.includes("-");
  if (componentsAreUnambiguous && raw.length <= MAX_BATCH_KEY_CHARS && FILENAME_SAFE.test(raw)) return raw;

  const prefix = `${sanitizeKeyPart(agent)}-`;
  const suffix = `-${keyDigest(agent, session, turn)}`;
  const body = sanitizeKeyPart(`${session}-${turn}`);
  const available = Math.max(0, MAX_BATCH_KEY_CHARS - prefix.length - suffix.length);
  return `${prefix}${body.slice(0, available)}${suffix}`;
}
