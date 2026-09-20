/**
 * Append-only JSONL decision log: every judgment recorded with its engine,
 * status, latency, evidence refs, and (later) human outcome. The log is the
 * calibration source — tau tuning reads this file, never live memory — and a
 * witness that fallback paths actually downgraded instead of guessing.
 *
 * Path convention mirrors the journal: a single append-only file under
 * ROCKY_HOME (`decisions.jsonl`), owner-only, best-effort. This module never
 * touches the journal itself.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { resolveRockyPaths } from "../core/state-paths.js";
import type { DecisionEngine, DecisionStatus } from "./decision.js";

export interface DecisionLogEntry {
  ts: number;
  decision_id: string;
  engine: DecisionEngine;
  status: DecisionStatus;
  input_hash: string;
  answer: unknown;
  latency_ms: number;
  outcome: string;
  evidenceRefs: readonly string[];
  /** OpenRouter `usage.cost` on a used call; absent on the native path and on every downgrade. */
  cost?: number;
  human_action?: "accepted" | "ignored" | "corrected";
}

export function decisionLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveRockyPaths(env).home, "decisions.jsonl");
}

/** Stable short hash of the judged input: joins the log without the raw query. */
export function hashDecisionInput(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);
}

function normalizeEntry(entry: {
  engine: DecisionEngine;
  status: DecisionStatus;
  input_hash: string;
  answer: unknown;
  latency_ms: number;
  outcome: string;
  evidenceRefs: readonly string[];
  cost?: number;
  human_action?: DecisionLogEntry["human_action"];
  decision_id?: string;
  ts?: number;
}): DecisionLogEntry {
  const latency = Number(entry.latency_ms);
  const rawCost = entry.cost;
  const cost = typeof rawCost === "number" && Number.isFinite(rawCost) && rawCost >= 0 ? rawCost : undefined;
  return {
    ts: entry.ts ?? Date.now(),
    decision_id: entry.decision_id ?? randomUUID(),
    engine: entry.engine,
    status: entry.status,
    input_hash: entry.input_hash,
    answer: entry.answer ?? null,
    latency_ms: Number.isFinite(latency) && latency >= 0 ? Math.floor(latency) : 0,
    outcome: entry.outcome,
    evidenceRefs: entry.evidenceRefs,
    ...(cost === undefined ? {} : { cost }),
    ...(entry.human_action === undefined ? {} : { human_action: entry.human_action }),
  };
}

/**
 * One best-effort append. Never throws: logging must not break the answer
 * path it witnesses. Returns the entry it attempted, or undefined when the
 * entry itself is unserializable.
 */
export function appendDecisionLog(
  entry: {
    engine: DecisionEngine;
    status: DecisionStatus;
    input_hash: string;
    answer: unknown;
    latency_ms: number;
    outcome: string;
    evidenceRefs: readonly string[];
    cost?: number;
    human_action?: DecisionLogEntry["human_action"];
  },
  path = decisionLogPath(),
  now = Date.now(),
): DecisionLogEntry | undefined {
  let line: string;
  let normalized: DecisionLogEntry;
  try {
    normalized = normalizeEntry({ ...entry, ts: now, decision_id: randomUUID() });
    line = `${JSON.stringify(normalized)}\n`;
  } catch {
    return undefined;
  }
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, line, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Best-effort witness: a full disk must not fail the chat answer.
  }
  return normalized;
}
