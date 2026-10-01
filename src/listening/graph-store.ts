/**
 * Rebuildable graph projection (spec §5). Reads the durable log and emits
 * nodes/edges with their source and link basis. Never writes truth.
 * MCP-safe: imports only types, store-paths, event-codec-side reads,
 * and the consent read side. No writer imports.
 */
import type { EventEnvelope, V1LinkBasis } from "./types.js";
import { loadEventsForProjection } from "./event-log-read.js";

export interface GraphQuery {
  episode?: string;
  session?: string;
  file?: string;
  since?: number;
  until?: number;
  limit: number;
}

export interface ProjectedGraph {
  nodes: Record<string, unknown>[];
  edges: Record<string, unknown>[];
  coverage: { status: string; reasons: string[] };
  truncated: boolean;
}

const CANDIDATE_WINDOW_MS = 10 * 60 * 1000;
const CANDIDATE_MAX = 8;

function verifiedTestIds(events: readonly EventEnvelope[]): Set<string> {
  const ids = new Set<string>();
  for (const e of events) {
    if (e.node !== "test_run" || e.nodeId === undefined) continue;
    if (
      e.testClaim !== undefined
      && e.testClaim.commandIdentity.length > 0
      && (e.testClaim.outcome === "pass" || e.testClaim.outcome === "fail")
      && e.testClaim.testedVersion.length > 0
    ) {
      ids.add(e.nodeId);
    }
  }
  return ids;
}

function matchesQuery(e: EventEnvelope, q: GraphQuery): boolean {
  if (q.episode !== undefined && e.refs.episode !== q.episode) return false;
  if (q.session !== undefined && e.refs.session !== q.session) return false;
  if (q.file !== undefined && e.refs.fileRel !== q.file) return false;
  if (q.since !== undefined && e.ts < q.since) return false;
  if (q.until !== undefined && e.ts > q.until) return false;
  return true;
}

function isForbiddenBasis(value: string): boolean {
  return value === "runtime_observed" || value === "observer_hypothesis";
}

/** Bounded temporal context: order/time proximity only, never causal. */
export function findTemporalCandidates(
  ts: number,
  events: readonly EventEnvelope[],
  windowMs: number,
  maxN: number,
): { eventId: string; distance: number }[] {
  const window = Math.min(Math.max(0, Math.floor(windowMs)), CANDIDATE_WINDOW_MS * 6);
  const cap = Math.min(Math.max(1, Math.floor(maxN)), CANDIDATE_MAX * 4);
  const out: { eventId: string; distance: number }[] = [];
  for (const e of events) {
    const distance = Math.abs(e.ts - ts);
    if (distance <= window) out.push({ eventId: e.eventId, distance });
  }
  out.sort((left, right) => left.distance - right.distance);
  return out.slice(0, cap);
}

export function projectGraph(
  repoRoot: string,
  q: GraphQuery,
  home?: string,
): ProjectedGraph {
  const limit = Math.min(Math.max(1, Math.floor(q.limit)), 500);
  const { events, truncated, malformed } = loadEventsForProjection(repoRoot, home);
  const reasons: string[] = [];
  if (truncated) reasons.push("store-evicted: oldest events replaced by gap tombstone");
  if (malformed > 0) reasons.push(`malformed-lines-skipped:${malformed}`);
  const verified = verifiedTestIds(events);
  const nodes: Record<string, unknown>[] = [];
  const edges: Record<string, unknown>[] = [];
  for (const e of [...events].reverse()) {
    if (nodes.length + edges.length >= limit) break;
    if (!matchesQuery(e, q)) continue;
    if (e.edge !== undefined && isForbiddenBasis(e.edge.basis)) {
      reasons.push(`forbidden-basis-dropped:${e.eventId}`);
      continue;
    }
    if (e.node === "test_run" && e.nodeId !== undefined && !verified.has(e.nodeId)) {
      reasons.push(`unverified-test-run-dropped:${e.nodeId}`);
      continue;
    }
    if (e.edge?.kind === "validated_by") {
      const target = e.refs.version ?? e.edge.to;
      const targetVerified = [...verified].some((id) => id === target || e.edge?.to === id);
      if (!targetVerified) {
        reasons.push(`dangling-validated-by-dropped:${e.eventId}`);
        continue;
      }
    }
    if (e.node !== undefined && e.nodeId !== undefined) {
      nodes.push({
        id: e.nodeId,
        kind: e.node,
        source: e.source,
        harness: e.harnessId ?? "unknown",
        ts: e.ts,
        refs: e.refs,
        redacted: e.redaction.applied,
        coverage: e.coverage,
      });
    }
    if (e.edge !== undefined) {
      const basis: V1LinkBasis = e.edge.basis;
      const weak = basis === "candidate_link" || basis === "temporal_candidate";
      edges.push({
        kind: e.edge.kind,
        from: e.edge.from,
        to: e.edge.to,
        basis,
        weak,
        source: e.source,
        ts: e.ts,
      });
    }
  }
  const status = reasons.length > 0 ? "partial" : "complete";
  return { nodes, edges, coverage: { status, reasons }, truncated: nodes.length + edges.length >= limit };
}
