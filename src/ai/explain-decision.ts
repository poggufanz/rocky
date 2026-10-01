/**
 * Opt-in Jev analysis for the explain surfaces (`rocky teach`, `/api/teach`,
 * `/api/ask`) and the engine-selection core shared with `/api/chat`.
 *
 * Rule: heuristic default, Jev only when explicitly enabled. The `decision`
 * section is absent by default, and an absent section means no analysis at
 * all on the explain surfaces — zero behavior change. `/api/chat` is always
 * on (it has no legacy shape to preserve) and uses the same selection:
 * Jev iff `decision.engine === "jev"`, heuristic otherwise.
 *
 * Output is template-first: refs, scores, engine, and status only. No new
 * claims are ever minted here — a Jev score reorders or annotates evidence
 * the deterministic retrieval already produced, and every failure keeps the
 * baseline order with the status disclosed.
 */

import { loadConfig, type ConfigLoadResult, type JevProviderName } from "../core/config-read.js";
import {
  buildRelevanceQuestions,
  createHeuristicPort,
  type DecisionCandidate,
  type DecisionEngine,
  type DecisionResult,
  type DecisionStatus,
} from "./decision.js";
import { appendDecisionLog, hashDecisionInput } from "./decision-log.js";
import { createJevPort } from "./jev.js";

export interface ExplainDecisionTrace {
  engine: DecisionEngine;
  status: DecisionStatus;
  /**
   * Top-1 selection strength when a Jev ranking was used, otherwise null.
   * A Noul near 0.5 is an honest split verdict on that candidate — reported
   * as the selected score, never as a separate calibration. The heuristic's
   * uniform 0.5 is uncalibrated by construction and is never reported.
   */
  confidence: number | null;
  evidenceRefs: readonly string[];
  latencyMs: number;
}

export interface DecisionSelection {
  /** True only when the config carries an explicit `decision` section. */
  configured: boolean;
  /** True only when the configured engine is Jev (key presence checked later). */
  useJev: boolean;
  /** Active Jev provider; absent in config means native typesafe. */
  jevProvider: JevProviderName;
}

export function readDecisionSelection(load: () => ConfigLoadResult = loadConfig): DecisionSelection {
  const fallback: DecisionSelection = { configured: false, useJev: false, jevProvider: "typesafe" };
  try {
    const loaded = load();
    if (loaded.status !== "valid") return fallback;
    const decision = loaded.config.decision;
    if (decision === undefined) return fallback;
    return {
      configured: true,
      useJev: decision.engine === "jev",
      jevProvider: decision.jevProvider ?? "typesafe",
    };
  } catch {
    return fallback;
  }
}

export function confidenceFor(result: DecisionResult): number | null {
  if (result.status !== "used" || result.engine !== "jev") return null;
  const top = result.evidenceRefs[0];
  if (top === undefined) return null;
  const answer = result.answers.find((candidate) => candidate.id === `q_${top}`);
  if (answer?.kind === "noul") return answer.noul;
  return null;
}

function toTrace(result: DecisionResult): ExplainDecisionTrace {
  return {
    engine: result.engine,
    status: result.status,
    confidence: confidenceFor(result),
    evidenceRefs: result.evidenceRefs,
    latencyMs: result.latencyMs,
  };
}

/** Template line for terminal detail output: refs, scores, status — no new claims. */
export function formatDecisionLine(trace: ExplainDecisionTrace): string {
  if (trace.status === "used" && trace.engine === "jev" && trace.confidence !== null) {
    const top = trace.evidenceRefs[0] ?? "";
    return `decision: jev used, top ${top} ${trace.confidence.toFixed(2)}, ${trace.latencyMs}ms`;
  }
  return `decision: ${trace.engine} ${trace.status}, baseline kept, ${trace.latencyMs}ms`;
}

export interface AnalyzeExplainOptions {
  load?: () => ConfigLoadResult;
  apiKey?: string;
  storedKey?: string;
  provider?: JevProviderName;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  outcome?: string;
}

/**
 * One analysis pass over already-retrieved evidence. Returns undefined when
 * the `decision` section is absent (explain surfaces stay exactly as they
 * were) or when there is no evidence to judge. Never throws: logging and
 * analysis must not break the answer path they witness.
 */
export async function analyzeExplainDecision(
  input: { query: string; candidates: readonly DecisionCandidate[] },
  options: AnalyzeExplainOptions = {},
): Promise<ExplainDecisionTrace | undefined> {
  const selection = readDecisionSelection(options.load ?? loadConfig);
  if (!selection.configured || input.candidates.length === 0) return undefined;
  const questions = buildRelevanceQuestions(input.candidates);
  const provider = options.provider ?? selection.jevProvider;
  // The caller resolves the key server-side (unified mode passes the shared
  // main credential; otherwise options apiKey/storedKey per the active path).
  // Absent here, the port still falls back inside createJevPort; a missing key
  // on the active path reports disabled plus baseline, never mocked.
  const port = selection.useJev
    ? createJevPort({ apiKey: options.apiKey, storedKey: options.storedKey, provider, timeoutMs: options.timeoutMs, fetchImpl: options.fetchImpl })
    : createHeuristicPort();
  let result: DecisionResult;
  try {
    result = await port.evaluate(
      { query: input.query, candidates: input.candidates },
      questions,
      options.signal,
    );
  } catch {
    return {
      engine: selection.useJev ? "jev" : "heuristic",
      status: "unavailable",
      confidence: null,
      evidenceRefs: input.candidates.map((candidate) => candidate.ref),
      latencyMs: 0,
    };
  }
  appendDecisionLog({
    engine: result.engine,
    status: result.status,
    input_hash: hashDecisionInput(`${input.query}|${input.candidates.map((candidate) => candidate.ref).join(",")}`),
    answer: { order: [...result.evidenceRefs] },
    latency_ms: result.latencyMs,
    outcome: options.outcome ?? "explain",
    evidenceRefs: [...result.evidenceRefs],
    ...(result.cost === undefined ? {} : { cost: result.cost }),
  });
  return toTrace(result);
}
