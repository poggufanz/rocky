/**
 * DecisionPort — the typed analysis layer between Rocky's evidence and rendering.
 *
 * Rocky supplies bounded, redacted evidence; a DecisionPort implementation
 * judges it and returns typed answers. Code owns the workflow; the answers
 * only reorder or gate what evidence already says. No implementation here
 * invents claims: a failure always downgrades trust (status) and keeps the
 * baseline order, never substitutes a guess.
 *
 * Shape mirrors the Jev primitives 1:1 so engines stay swappable:
 * - `noul` answers carry `{ type, noul }` with NO separate `confidence` field.
 * - `choice` / `score` answers carry their full `probabilities` distribution
 *   plus a `confidence` derived from that distribution (concentration proxy).
 */

export type DecisionEngine = "heuristic" | "local" | "jev";

export type DecisionStatus =
  | "used"
  | "disabled"
  | "unavailable"
  | "timeout"
  | "invalid_output"
  | "low_confidence";

export interface DecisionCandidate {
  ref: string;
  kind: string;
  snippet: string;
}

export interface DecisionState {
  query: string;
  candidates: readonly DecisionCandidate[];
}

export interface NoulQuestion {
  readonly kind: "noul";
  readonly id: string;
  readonly instructions: string;
  readonly criteria?: { readonly true?: string; readonly false?: string };
}

export interface ChoiceQuestion {
  readonly kind: "choice";
  readonly id: string;
  readonly instructions: string;
  readonly criteria: Record<string, string | null>;
}

export interface ScoreQuestion {
  readonly kind: "score";
  readonly id: string;
  readonly instructions: string;
  readonly criteria: readonly string[];
}

export type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

/** Noul carries a calibrated probability only — never a separate confidence. */
export interface NoulAnswer {
  readonly kind: "noul";
  readonly id: string;
  readonly noul: number;
}

export interface ChoiceAnswer {
  readonly kind: "choice";
  readonly id: string;
  readonly choice: string;
  readonly probabilities: Record<string, number>;
  readonly confidence: number;
}

export interface ScoreAnswer {
  readonly kind: "score";
  readonly id: string;
  readonly score: number;
  readonly legend: Record<string, string>;
  readonly probabilities: Record<string, number>;
  readonly confidence: number;
}

export type DecisionAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface DecisionResult {
  readonly answers: readonly DecisionAnswer[];
  /** The engine that produced these answers; a downgrade keeps the requested engine name. */
  readonly engine: DecisionEngine;
  readonly status: DecisionStatus;
  readonly latencyMs: number;
  /** Candidate refs in display order: ranked when used, baseline otherwise. */
  readonly evidenceRefs: readonly string[];
  /** OpenRouter `usage.cost` on a used call; absent on the native path and on every downgrade. */
  readonly cost?: number;
  /** Human-disclosable failure note (for example OpenRouter 402 credits); never secrets, never keys. */
  readonly detail?: string;
}

export interface DecisionPort {
  evaluate(
    state: DecisionState,
    questions: readonly DecisionQuestion[],
    signal?: AbortSignal,
  ): Promise<DecisionResult>;
}

/**
 * Concentration proxy for choice/score distributions: the winning mass.
 * Noul answers never use this — a Noul near 0.5 is an honest split verdict,
 * not medium confidence, and the type carries no confidence field at all.
 */
export function confidenceOf(probabilities: Record<string, number>): number {
  const values = Object.values(probabilities).filter(
    (value) => typeof value === "number" && Number.isFinite(value),
  );
  if (values.length === 0) return 0;
  return Math.min(1, Math.max(0, Math.max(...values)));
}

/**
 * One Noul relevance question per candidate, evaluated in parallel without
 * seeing each other. The indexed phrasing (`candidates[i].snippet`) keeps each
 * judgment pointed at its own displayed text, never the whole memory.
 */
export function buildRelevanceQuestions(candidates: readonly DecisionCandidate[]): NoulQuestion[] {
  return candidates.map((candidate, index) => ({
    kind: "noul",
    id: `q_${candidate.ref}`,
    instructions:
      `Query \`query\` is answered by the displayed text in \`candidates[${index}].snippet\`, ` +
      `not by mere topic similarity.`,
    criteria: {
      true: `\`candidates[${index}].snippet\` holds the answer or rationale that directly answers \`query\`.`,
      false: `\`candidates[${index}].snippet\` only shares topic or tokens with \`query\`, or does not answer it.`,
    },
  }));
}

/**
 * Order refs by Noul descending. Exact ties keep baseline order (stable,
 * explicit — never left to the sort implementation). Refs with no score sink
 * to the end in baseline relative order; they were never judged.
 */
export function rankByNoul(
  baselineRefs: readonly string[],
  noulByRef: ReadonlyMap<string, number>,
): string[] {
  return baselineRefs
    .map((ref, index) => ({ ref, index, noul: noulByRef.get(ref) ?? Number.NEGATIVE_INFINITY }))
    .sort((a, b) => b.noul - a.noul || a.index - b.index)
    .map((entry) => entry.ref);
}

function heuristicAnswer(question: DecisionQuestion): DecisionAnswer | undefined {
  if (question.kind === "noul") {
    // Uniform 0.5: no calibrated claim, so rankByNoul over these always
    // reproduces the baseline order. Reported as used/heuristic, never as evidence.
    return { kind: "noul", id: question.id, noul: 0.5 };
  }
  if (question.kind === "choice") {
    const options = Object.keys(question.criteria);
    if (options.length === 0) return undefined;
    const share = 1 / options.length;
    const probabilities: Record<string, number> = {};
    for (const option of options) probabilities[option] = share;
    return { kind: "choice", id: question.id, choice: options[0] as string, probabilities, confidence: share };
  }
  if (question.criteria.length === 0) return undefined;
  const share = 1 / question.criteria.length;
  const probabilities: Record<string, number> = {};
  const legend: Record<string, string> = {};
  question.criteria.forEach((level, index) => {
    probabilities[String(index)] = share;
    legend[String(index)] = level;
  });
  return {
    kind: "score",
    id: question.id,
    score: (question.criteria.length - 1) / 2,
    legend,
    probabilities,
    confidence: share,
  };
}

/**
 * The default engine: always present, fully offline. Answers are uniform
 * (uncalibrated by construction), so the display order is always the baseline
 * the deterministic retrieval produced. Zero behavior change by design.
 */
export function createHeuristicPort(): DecisionPort {
  return {
    async evaluate(state, questions) {
      const started = Date.now();
      const answers: DecisionAnswer[] = [];
      for (const question of questions) {
        const answer = heuristicAnswer(question);
        if (answer !== undefined) answers.push(answer);
      }
      return {
        answers,
        engine: "heuristic",
        status: "used",
        latencyMs: Math.max(0, Date.now() - started),
        evidenceRefs: state.candidates.map((candidate) => candidate.ref),
      };
    },
  };
}
