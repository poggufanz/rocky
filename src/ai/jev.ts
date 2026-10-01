/**
 * Jev decision engine: one HTTP call per event, Noul per candidate, over
 * bounded redacted snippets only. Two provider paths behind one DecisionPort
 * (`engine` stays `"jev"`): native TypeSafe (`JEV_ENDPOINT`, pinned
 * `JEV_MODEL`) and OpenRouter alpha (`JEV_OPENROUTER_ENDPOINT`, pinned
 * `JEV_OPENROUTER_MODEL`) — direct stdlib fetch, no SDK, no new runtime deps.
 *
 * Failure contract: timeouts, HTTP errors, shape violations, and model
 * mismatches are failure categories, never imputed scores. The baseline
 * order is kept and the status downgrades so the caller can disclose it.
 * A missing key on the active provider path is `disabled`, not a mock:
 * deterministic fallback upstream.
 */

import { redactSecretsAtBoundary } from "../core/redact.js";
import {
  buildRelevanceQuestions,
  confidenceOf,
  rankByNoul,
  type DecisionAnswer,
  type DecisionCandidate,
  type DecisionPort,
  type DecisionResult,
  type DecisionState,
  type NoulQuestion,
} from "./decision.js";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-1.13.0";
/** OpenRouter Jev path is alpha: the named constant tracks graduation without touching call sites. */
export const JEV_OPENROUTER_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
export const JEV_OPENROUTER_MODEL = "typesafe/jev-1.13";
export const JEV_TIMEOUT_MS = 30_000;
export type JevProvider = "typesafe" | "openrouter";
export const JEV_CREDIT_SHORTFALL_DETAIL = "insufficient OpenRouter credits: top up credits and retry";

const MAX_CANDIDATES = 10;
const MAX_SNIPPET_CHARS = 500;
const MAX_QUERY_CHARS = 1_000;
/** Conservative chars-per-token guard (no real tokenizer here): ~1 token / 3 chars. */
const APPROX_CHARS_PER_TOKEN = 3;
const MAX_BODY_TOKENS = 64_000;
const MAX_STATE_PLUS_LONGEST_QUESTION_TOKENS = 32_000;

export interface JevQuestionWire {
  type: "noul";
  instructions: string;
  criteria?: { true?: string; false?: string };
}

export interface JevRequestBody {
  state: { query: string; candidates: { ref: string; kind: string; snippet: string }[] };
  model: string;
  questions: Record<string, JevQuestionWire>;
}

export interface JevEngineOptions {
  apiKey?: string;
  storedKey?: string;
  provider?: JevProvider;
  model?: string;
  endpoint?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export function buildJevState(query: string, candidates: readonly DecisionCandidate[]): JevRequestBody["state"] {
  const boundedQuery = query.length > MAX_QUERY_CHARS ? `${query.slice(0, MAX_QUERY_CHARS)}… cut, query long` : query;
  return {
    query: redactSecretsAtBoundary(boundedQuery),
    candidates: candidates.slice(0, MAX_CANDIDATES).map((candidate) => {
      const snippet = redactSecretsAtBoundary(String(candidate.snippet));
      return {
        ref: String(candidate.ref).slice(0, 128),
        kind: String(candidate.kind).slice(0, 32),
        snippet: snippet.length > MAX_SNIPPET_CHARS ? `${snippet.slice(0, MAX_SNIPPET_CHARS)}… cut, snippet long` : snippet,
      };
    }),
  };
}

export function buildJevBody(
  state: JevRequestBody["state"],
  questions: readonly NoulQuestion[],
  model = JEV_MODEL,
): JevRequestBody {
  const wire: Record<string, JevQuestionWire> = {};
  for (const question of questions) {
    wire[question.id] = {
      type: "noul",
      instructions: question.instructions,
      ...(question.criteria === undefined ? {} : { criteria: { ...question.criteria } }),
    };
  }
  return { state, model, questions: wire };
}

/**
 * OpenRouter body variant: the Noul binding rejects one-sided criteria, so
 * every question carries BOTH true+false keys. Missing or blank sides fall
 * back to the same relevance phrasing `buildRelevanceQuestions` uses, kept
 * non-empty so the call is well-formed without inventing new claims.
 */
export function buildJevOpenRouterBody(
  state: JevRequestBody["state"],
  questions: readonly NoulQuestion[],
  model = JEV_OPENROUTER_MODEL,
): JevRequestBody {
  const wire: Record<string, JevQuestionWire> = {};
  for (const question of questions) {
    const match = /^q_(.*)$/.exec(question.id);
    const ref = match?.[1] ?? question.id;
    const index = Math.max(0, state.candidates.findIndex((candidate) => candidate.ref === ref));
    const fallbackTrue = `\`candidates[${index}].snippet\` holds the answer or rationale that directly answers \`query\`.`;
    const fallbackFalse = `\`candidates[${index}].snippet\` only shares topic or tokens with \`query\`, or does not answer it.`;
    const truthy = question.criteria?.true;
    const falsy = question.criteria?.false;
    wire[question.id] = {
      type: "noul",
      instructions: question.instructions,
      criteria: {
        true: typeof truthy === "string" && truthy.length > 0 ? truthy : fallbackTrue,
        false: typeof falsy === "string" && falsy.length > 0 ? falsy : fallbackFalse,
      },
    };
  }
  return { state, model, questions: wire };
}

/** Context guard before any byte leaves the machine; breach = no call at all. */
export function jevBodyFits(body: JevRequestBody): boolean {
  const bodyChars = JSON.stringify(body).length;
  const stateChars = JSON.stringify(body.state).length;
  let longestQuestionChars = 0;
  for (const question of Object.values(body.questions)) {
    longestQuestionChars = Math.max(longestQuestionChars, JSON.stringify(question).length);
  }
  return (
    Math.ceil(bodyChars / APPROX_CHARS_PER_TOKEN) <= MAX_BODY_TOKENS &&
    Math.ceil((stateChars + longestQuestionChars) / APPROX_CHARS_PER_TOKEN) <=
      MAX_STATE_PLUS_LONGEST_QUESTION_TOKENS
  );
}

/**
 * Server-side only: the browser never sees, stores, or forwards this key.
 * Precedence is fixed: TYPESAFE_API_KEY env wins when set; the Settings-stored
 * key (gui.json `jevKey`, pasted in the GUI) is the fallback. Presence only —
 * callers must never log or return the resolved value.
 */
export function resolveJevKey(env: NodeJS.ProcessEnv = process.env, stored = ""): string {
  const fromEnv = typeof env.TYPESAFE_API_KEY === "string" ? env.TYPESAFE_API_KEY : "";
  if (fromEnv.length > 0) return fromEnv;
  return stored;
}
/**
 * OpenRouter slot: env OPENROUTER_API_KEY wins when set, the Settings-stored
 * openRouterKey (gui.json) is the fallback. The Jev slots are never read on
 * this path and vice versa — presence only, never logged or returned.
 */
export function resolveOpenRouterKey(env: NodeJS.ProcessEnv = process.env, stored = ""): string {
  const fromEnv = typeof env.OPENROUTER_API_KEY === "string" ? env.OPENROUTER_API_KEY : "";
  if (fromEnv.length > 0) return fromEnv;
  return stored;
}

/** Env-only presence check for the OpenRouter slot. */
export function openRouterKeyPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof env.OPENROUTER_API_KEY === "string" && (env.OPENROUTER_API_KEY as string).length > 0;
}

/** Active-provider key resolution: each path reads only its own slot. */
export function resolveActiveJevKey(
  provider: JevProvider,
  env: NodeJS.ProcessEnv = process.env,
  storedJevKey = "",
  storedOpenRouterKey = "",
): string {
  return provider === "openrouter" ? resolveOpenRouterKey(env, storedOpenRouterKey) : resolveJevKey(env, storedJevKey);
}

/**
 * Unified OpenRouter mode: the MAIN LLM provider is itself OpenRouter, so one
 * OpenRouter credential drives BOTH the LLM path and the Jev path. Detection
 * is shared here so server + tests use one definition: `provider` is the
 * Settings main-provider value (`"openrouter"`), or the configured endpoint
 * points at OpenRouter (`openrouter.ai` substring, case-insensitive — which
 * also covers catalogue id `openrouter`, whose chat endpoint is OpenRouter).
 * In this mode there are no Jev fields at all: no Jev key, no second
 * OpenRouter key, no jevProvider selection — the Jev slots are never read.
 */
export function isUnifiedOpenRouterMode(provider: string, endpoint: string): boolean {
  if (provider === "openrouter") return true;
  return endpoint.toLowerCase().includes("openrouter.ai");
}

/**
 * Shared-credential precedence in unified mode: env OPENROUTER_API_KEY wins
 * when set (non-empty), else the Settings-stored MAIN key (gui.json `key` —
 * which IS the OpenRouter key when the main provider is OpenRouter). The
 * Jev-specific slots (`jevKey`, `openRouterKey`) are never read on this path
 * by design; unified mode needs only the one main key. Presence only — the
 * resolved value must never be logged or returned to the page.
 */
export function resolveUnifiedOpenRouterKey(env: NodeJS.ProcessEnv = process.env, storedMainKey = ""): string {
  return typeof env.OPENROUTER_API_KEY === "string" && env.OPENROUTER_API_KEY.length > 0
    ? env.OPENROUTER_API_KEY
    : storedMainKey;
}

export function isValidNoulAnswer(value: unknown): value is { type: "noul"; noul: number } {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === "noul" &&
    typeof record.noul === "number" &&
    Number.isFinite(record.noul) &&
    (record.noul as number) >= 0 &&
    (record.noul as number) <= 1
  );
}

function baselineResult(
  state: DecisionState,
  status: DecisionResult["status"],
  latencyMs: number,
  answers?: readonly DecisionAnswer[],
  detail?: string,
): DecisionResult {
  return {
    answers: answers ?? [],
    engine: "jev",
    status,
    latencyMs: Math.max(0, latencyMs),
    evidenceRefs: state.candidates.map((candidate) => candidate.ref),
    ...(detail === undefined ? {} : { detail }),
  };
}

/** OpenRouter `usage.cost` is a non-negative finite number; anything else is absent. */
function openRouterCostOf(record: Record<string, unknown>): number | undefined {
  const usage = record.usage;
  if (typeof usage !== "object" || usage === null) return undefined;
  const cost = (usage as Record<string, unknown>).cost;
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
}

/** Uniform stand-ins for non-Noul questions so the result shape stays whole. */
function uniformExtras(
  questions: readonly { kind: string; id: string }[],
  criteriaOf: (id: string) => { options?: readonly string[]; levels?: readonly string[] },
): DecisionAnswer[] {
  const answers: DecisionAnswer[] = [];
  for (const question of questions) {
    if (question.kind === "noul") continue;
    const { options, levels } = criteriaOf(question.id);
    if (options !== undefined && options.length > 0) {
      const share = 1 / options.length;
      const probabilities: Record<string, number> = {};
      for (const option of options) probabilities[option] = share;
      answers.push({
        kind: "choice",
        id: question.id,
        choice: options[0] as string,
        probabilities,
        confidence: confidenceOf(probabilities),
      });
    } else if (levels !== undefined && levels.length > 0) {
      const share = 1 / levels.length;
      const probabilities: Record<string, number> = {};
      const legend: Record<string, string> = {};
      levels.forEach((level, index) => {
        probabilities[String(index)] = share;
        legend[String(index)] = level;
      });
      answers.push({
        kind: "score",
        id: question.id,
        score: (levels.length - 1) / 2,
        legend,
        probabilities,
        confidence: confidenceOf(probabilities),
      });
    }
  }
  return answers;
}

export function createJevPort(options: JevEngineOptions = {}): DecisionPort {
  const provider: JevProvider = options.provider ?? "typesafe";
  const model = options.model ?? (provider === "openrouter" ? JEV_OPENROUTER_MODEL : JEV_MODEL);
  const endpoint = options.endpoint ?? (provider === "openrouter" ? JEV_OPENROUTER_ENDPOINT : JEV_ENDPOINT);
  const timeoutMs = options.timeoutMs ?? JEV_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const storedKey = options.storedKey ?? "";
  return {
    async evaluate(state: DecisionState, questions, signal?: AbortSignal): Promise<DecisionResult> {
      const started = Date.now();
      const elapsed = (): number => Math.max(0, Date.now() - started);
      const byId = new Map(questions.map((question) => [question.id, question] as const));
      const extras = (): readonly DecisionAnswer[] =>
        uniformExtras(questions, (id) => {
          const found = byId.get(id);
          if (found?.kind === "choice") return { options: Object.keys(found.criteria) };
          if (found?.kind === "score") return { levels: found.criteria };
          return {};
        });
      const resolved =
        options.apiKey ??
        (provider === "openrouter"
          ? resolveOpenRouterKey(process.env, storedKey)
          : resolveJevKey(process.env, storedKey));
      const key = typeof resolved === "string" ? resolved : "";
      if (key.length === 0) {
        return baselineResult(state, "disabled", elapsed(), extras());
      }
      if (state.candidates.length === 0) {
        return baselineResult(state, "used", elapsed());
      }
      const sent = buildJevState(state.query, state.candidates);
      const rebuilt = buildRelevanceQuestions(sent.candidates);
      const body =
        provider === "openrouter"
          ? buildJevOpenRouterBody(sent, rebuilt, model)
          : buildJevBody(sent, rebuilt, model);
      if (!jevBodyFits(body)) {
        return baselineResult(state, "invalid_output", elapsed(), extras());
      }
      if (signal?.aborted) {
        return baselineResult(state, "timeout", elapsed(), extras());
      }
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const timedOut = signal?.aborted === true || /timed out|timeout|aborted|abort/i.test(message);
        return baselineResult(state, timedOut ? "timeout" : "unavailable", elapsed(), extras());
      }
      const latencyMs = elapsed();
      let parsed: unknown = null;
      try {
        parsed = await response.json();
      } catch {
        parsed = null;
      }
      if (!response.ok || typeof parsed !== "object" || parsed === null) {
        if (provider === "openrouter" && response.status === 402) {
          return baselineResult(state, "unavailable", latencyMs, extras(), JEV_CREDIT_SHORTFALL_DETAIL);
        }
        return baselineResult(state, "unavailable", latencyMs, extras());
      }
      const record = parsed as Record<string, unknown>;
      const received = record.answers;
      const answersValid =
        typeof received === "object" &&
        received !== null &&
        rebuilt.every((question) => isValidNoulAnswer((received as Record<string, unknown>)[question.id]));
      // Native keeps the exact model-echo contract; OpenRouter relaxes it (its
      // id spelling differs from the native pinned model) and accepts on valid answers.
      const echoValid = provider === "openrouter" ? true : record.model === model;
      if (!answersValid || !echoValid) {
        return baselineResult(state, "invalid_output", latencyMs, extras());
      }
      const answerMap = received as Record<string, { type: "noul"; noul: number }>;
      const noulByRef = new Map<string, number>();
      const noulAnswers: DecisionAnswer[] = [];
      for (const question of rebuilt) {
        const value = answerMap[question.id].noul;
        noulByRef.set(question.id.replace(/^q_/, ""), value);
        noulAnswers.push({ kind: "noul", id: question.id, noul: value });
      }
      const cost = provider === "openrouter" ? openRouterCostOf(record) : undefined;
      return {
        answers: [...noulAnswers, ...extras()],
        engine: "jev",
        status: "used",
        latencyMs,
        evidenceRefs: rankByNoul(
          state.candidates.map((candidate) => candidate.ref),
          noulByRef,
        ),
        ...(cost === undefined ? {} : { cost }),
      };
    },
  };
}
