/**
 * Listening v1 canonical types (spec 2026-09-26-rocky-v100-listening-design.md, §§5,7,11).
 *
 * V1 emits ONLY: direct | filesystem_observed | content_mapped |
 * candidate_link | temporal_candidate | unknown.
 * NEVER: runtime_observed, observer_hypothesis, phantom process nodes.
 * candidate_link is weak non-causal context and is never promoted.
 */
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

export type ListeningSource = "watcher" | "adapter" | "git" | "hook";

export type V1LinkBasis =
  | "direct" | "filesystem_observed" | "content_mapped"
  | "candidate_link" | "temporal_candidate" | "unknown";

/** Bases that must never appear in v1 output. Writers refuse them; the projection drops them. */
export type ForbiddenV1Basis = "runtime_observed" | "observer_hypothesis";

export const V1_LINK_BASES: readonly V1LinkBasis[] = Object.freeze([
  "direct", "filesystem_observed", "content_mapped",
  "candidate_link", "temporal_candidate", "unknown",
] as const);

export function isV1LinkBasis(value: unknown): value is V1LinkBasis {
  return typeof value === "string" && (V1_LINK_BASES as readonly string[]).includes(value);
}

/** Runtime guard for parsed durable data; throws on V1-forbidden bases. */
export function assertV1Basis(value: string): asserts value is V1LinkBasis {
  if (!isV1LinkBasis(value)) throw new Error(`forbidden v1 link basis: ${value}`);
}

export type ListeningNodeKind =
  | "repo" | "work_episode" | "agent_session" | "tool_action"
  | "file_version" | "diff_hunk" | "test_run" | "commit";

export function isV1NodeKind(value: unknown): value is ListeningNodeKind {
  return value === "repo" || value === "work_episode" || value === "agent_session"
    || value === "tool_action" || value === "file_version" || value === "diff_hunk"
    || value === "test_run" || value === "commit";
}

export type ListeningEdgeKind =
  | "belongs_to_episode" | "read_from" | "wrote_version" | "generated_hunk"
  | "validated_by" | "committed_as" | "spawned_by";

export interface ListeningConsentState {
  host: boolean;
  repo: boolean;
  rawTrace: boolean;
}

export interface ListeningEdge {
  kind: ListeningEdgeKind;
  from: string;
  to: string;
  basis: V1LinkBasis;
}

/** Verified test-run claim (§5): all three fields required before test_run/validated_by. */
export interface TestRunClaim {
  commandIdentity: string;
  outcome: "pass" | "fail";
  testedVersion: string;
}

export interface EventEnvelope {
  v: 1;
  eventId: string;
  source: ListeningSource;
  harnessId?: HarnessId;
  surface?: "cli" | "ide" | "local" | "profile";
  repoRoot?: string;
  ts: number;
  adapterVersion: string;
  nativeId?: string;
  node?: ListeningNodeKind;
  nodeId?: string;
  edge?: ListeningEdge;
  /** Verified test claim; required for test_run nodes (graph-store drops others). */
  testClaim?: TestRunClaim;
  /** Hook policy/decision reason. Never presented as agent-stated why. */
  hookPolicyReason?: string;
  consent: ListeningConsentState;
  redaction: { applied: boolean; truncated: boolean };
  coverage: "complete" | "partial" | "unknown";
  refs: {
    episode?: string;
    session?: string;
    version?: string;
    commit?: string;
    fileRel?: string;
    summaryRef?: string;
    /** True when this event is the consent-start baseline, not a new edit. */
    baseline?: boolean;
    /** True when this version records a deletion. */
    deleted?: boolean;
    /** 1-based start line of the hunk this event describes. */
    startLine?: number;
    /** Number of lines the hunk spans. */
    lineCount?: number;
  };
  /** Set only on oldest-first eviction tombstones. */
  gapEvicted?: number;
}

export interface FileVersionObject {
  versionId: string;
  repoRoot: string;
  rel: string;
  sha256: string;
  bytes: number;
  snapshotRef: string;
  redacted: boolean;
}

/** candidate_link / temporal_candidate: weak non-causal context. NEVER promoted to direct, content_mapped, validated_by, episode membership, hunk attribution, or bundle grouping. Promotion is simply never performed anywhere in this codebase. */

// --- Bounds (spec §11): owner-approved as the v1 defaults. The PROPOSAL_
// prefix stays so callers and listening-types.test.ts keep one stable name.
// Event + object caps form the per-repo disk budget told to users at consent;
// the file-version and path caps are internal safety bounds, not budget. ---

/** Safety bound: max snapshot/file-version size; larger files keep no snapshot. */
export const PROPOSAL_MAX_FILE_VERSION_BYTES = 1 * 1024 * 1024;
/** Safety bound: max paths walked per reconciliation. */
export const PROPOSAL_MAX_PATHS_PER_RECONCILIATION = 10_000;
/** Disk budget: max content object store per repo, oldest-first eviction. */
export const PROPOSAL_MAX_OBJECT_STORE_BYTES_PER_REPO = 128 * 1024 * 1024;
/** Disk budget: max graph event store per repo, oldest-first + gap tombstone. */
export const PROPOSAL_MAX_EVENT_STORE_BYTES_PER_REPO = 32 * 1024 * 1024;
/** Per-repo disk budget users are told about: events plus objects. */
export const LISTENING_DISK_BUDGET_BYTES_PER_REPO =
  PROPOSAL_MAX_EVENT_STORE_BYTES_PER_REPO + PROPOSAL_MAX_OBJECT_STORE_BYTES_PER_REPO;
