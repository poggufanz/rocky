/**
 * Shared Answering Engine for Main Chat and Code Explain.
 *
 * Unifies model resolution, context building, multi-hop reference tracing,
 * evidence assessment, TypeSafe Jev/heuristic evaluation, structurer,
 * renderer, and error/fallback reporting across `/api/chat` and `/api/ask`.
 */

import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { loadMemoryChecked, type MemoryRecord } from "../core/memory-read.js";
import { redactSecretsAtBoundary } from "../core/redact.js";
import { readSettings, type GuiSettings } from "../gui/settings.js";
import { loadConfig } from "../core/config-read.js";
import { fileIndex } from "../core/compare-data.js";
import { searchKnowledge } from "../core/memory-query.js";
import {
  CODE_EXCERPTS_ONLY,
  CODE_MODEL_LOCAL,
  CODE_NO_MATCH,
  CODE_NO_MODEL,
  CODE_PREFIX_EMPTY,
  CODE_UNGROUNDED,
  buildCodePrompt,
  codeFallbackText,
  collectCodeEvidence,
  isCodeQuery,
  memoryPriorTokens,
  splitCodePrefix,
  validateCodeCitations,
  type CodeAnswer,
  type CodeEvidenceResult,
  type CodeExcerpt,
  type CodeTrace,
} from "../gui/code-search.js";
import {
  buildRelevanceQuestions,
  createHeuristicPort,
  type DecisionCandidate,
  type DecisionResult,
} from "./decision.js";
import { appendDecisionLog, hashDecisionInput } from "./decision-log.js";
import {
  createJevPort,
  isUnifiedOpenRouterMode,
  resolveActiveJevKey,
  resolveUnifiedOpenRouterKey,
} from "./jev.js";
import { buildChatStructure } from "./chat-structure.js";
import { CHAT_RENDER_ORDER, safeRenderChatText, type ChatRenderStatus } from "./chat-render.js";
import {
  listChatInstalledModelNames,
  resolveChatLlmSelection,
  runChatRenderer,
  runChatStructurer,
  type ChatLlmSelection,
  type ChatLlmTrace,
} from "./chat-llm.js";
import { analyzeExplainDecision } from "./explain-decision.js";
import { traceReferences, type ReferenceTraceResult } from "../core/reference-trace.js";

export const CHAT_MAX_MESSAGE_CHARS = 4_000;
export const CHAT_DEFAULT_LIMIT = 5;
export const CHAT_MAX_LIMIT = 10;
export const CHAT_MAX_SNIPPET_CHARS = 500;
export const MAX_PROMPT_CHARS = 24_000;
// A few common-token overlaps are not enough to answer a memory question.
const CHAT_MEMORY_RELEVANCE_FLOOR = 0.4;
const CHAT_MEMORY_PROMPT_RESERVE_CHARS = 2_048;
export const ASK_TIMEOUT_MS = 60_000;

export interface ChatEvidenceCard {
  ref: string;
  kind: string;
  snippet: string;
}

export interface ChatTrace {
  engine: "heuristic" | "jev";
  status: "used" | "disabled" | "unavailable" | "timeout" | "invalid_output" | "low_confidence";
  confidence: number | null;
  evidenceRefs: readonly string[];
  latencyMs: number;
  llm: ChatLlmTrace;
}

export interface CodeSupport {
  evidence: CodeExcerpt[];
  answer: CodeAnswer;
  trace: CodeTrace;
}

export interface ExplainCodeContext {
  path: string;
  start: number;
  end: number;
  commit?: string;
  symbol?: string;
}

export interface AnswerOptions {
  mode: "chat" | "explain";
  message?: string;
  prompt?: string;
  model?: string;
  jev?: boolean;
  limit?: number;
  codeContext?: ExplainCodeContext;
  root: string;
  env?: NodeJS.ProcessEnv;
}

export interface ChatResponsePayload {
  text: string;
  evidenceCards: ChatEvidenceCard[];
  decisionTrace: ChatTrace;
  llm: ChatLlmTrace;
  renderOrder: readonly string[];
  coverage?: { reason: string };
  codeEvidence?: CodeExcerpt[];
  codeAnswer?: CodeAnswer;
  codeTrace?: CodeTrace;
  referenceTrace?: ReferenceTraceResult;
  referenceChain?: readonly string[];
  decision?: unknown;
  error?: string;
}

export interface AnswerOutcome {
  status: number;
  payload: ChatResponsePayload | { error: string };
}

let chatInFlight = 0;
const CHAT_MAX_IN_FLIGHT = 2;
let askInFlight = 0;
const MAX_ASK_IN_FLIGHT = 2;

const ASSET_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "gui");
const TEACH_SPEC_CAP_BYTES = 64 * 1024;
const teachSpec: Partial<Record<"id" | "en", string | null>> = {};

const TEACH_RULES = [
  "You explain why a code snippet exists. You are a witness, not a judge, and you do not invent.",
  "",
  "Output language: Indonesian.",
  "",
  "HARD STOP: you have no shell, no git, no database and no filesystem. You see only what is",
  "quoted below. NEVER claim you ran a command, read another file, or queried a database.",
  "NEVER imply you inspected live data. If a reason would need evidence you were not given,",
  "say so and stop there.",
  "",
  "Keep two tracks separate, and do not merge them into one essay:",
  "  KODE    why this construct is written this way in THIS file",
  "  BISNIS  why this behaviour exists for the product",
  "",
  "Every claim must point at something in the text you were given: a line, a quoted comment,",
  "or a record Rocky recorded. No support means the claim does not exist: do not write it.",
  "NEVER say `best practice`, `lebih rapi`, or `idiomatic` without naming the alternative it",
  "was chosen over. NEVER paraphrase a comment that is already quoted: quote it.",
  "NEVER present your reconstruction as something an agent stated when the code was written.",
  "",
  "Answer in this shape, omitting any line you have no support for:",
  "  KODE",
  "    why 1  …",
  "    stop   …",
  "  BISNIS",
  "    why 1  …",
  "    stop   …",
  "",
  "Two sentences per why, at most. Thin evidence is an answer: an honest two-line card beats",
  "a five-line story. Say plainly when you cannot tell.",
].join("\n");

export const TEACH_ENV = [
  "Environment note for this run: you have no shell, no git, no database and no filesystem.",
  "Rocky walks the hops for you and quotes what it found after the rules, selection first:",
  "the enclosing function, the definitions of the symbols the selection uses, the comment",
  "above it, the tests that name those symbols, and the git commit that first touched the",
  "lines. Cite only what is quoted; never claim you ran anything.",
].join("\n");

export function loadTeachSpec(lang: "id" | "en"): string {
  if (teachSpec[lang] === undefined) {
    try {
      const path = resolve(ASSET_ROOT, "..", lang === "en" ? "teach-agent.en.md" : "teach-agent.md");
      const raw = readFileSync(path, "utf8");
      teachSpec[lang] = Buffer.byteLength(raw) <= TEACH_SPEC_CAP_BYTES ? raw : null;
    } catch {
      teachSpec[lang] = null;
    }
  }
  return teachSpec[lang] ?? TEACH_RULES;
}

export function boundedPrompt(text: string): string {
  const bounded = text.length > MAX_PROMPT_CHARS ? `${text.slice(0, MAX_PROMPT_CHARS)}\n… cut, prompt long` : text;
  return redactSecretsAtBoundary(bounded);
}

export function readDecisionSelection(): { engine: "heuristic" | "local" | "jev"; jevProvider: "typesafe" | "openrouter" } {
  try {
    const loaded = loadConfig();
    if (loaded.status === "valid" && loaded.config.decision !== undefined) {
      return { engine: loaded.config.decision.engine, jevProvider: loaded.config.decision.jevProvider ?? "typesafe" };
    }
  } catch {
    // default
  }
  return { engine: "heuristic", jevProvider: "typesafe" };
}

export function records(): { list: ReturnType<typeof loadMemoryChecked>["records"]; reason: string | undefined } {
  const loaded = loadMemoryChecked();
  const reason = loaded.coverage?.complete === false ? loaded.coverage.reason : undefined;
  return { list: loaded.records, reason };
}

export function confine(root: string, candidate: string): string | undefined {
  const full = resolve(root, candidate);
  const fold = (value: string): string => (process.platform === "win32" ? value.toLowerCase() : value);
  const inside = fold(full) === fold(root) || fold(full).startsWith(fold(root) + sep);
  return inside ? full : undefined;
}

export function witnessed(candidate: string): string | undefined {
  const norm = candidate.replace(/\\/g, "/");
  const heard = fileIndex(records().list).some((file) => file.path === norm);
  return heard ? norm : undefined;
}

export function witnessedRepoPaths(list: MemoryRecord[], root: string): string[] {
  const out: string[] = [];
  for (const file of fileIndex(list)) {
    const full = confine(root, file.path);
    if (full === undefined) continue;
    const rel = relative(root, full).replace(/\\/g, "/");
    if (rel.length > 0 && !out.includes(rel)) out.push(rel);
  }
  return out;
}

export function toChatCards(
  hits: readonly { id: string; kind: string; snippet: string }[],
  limit: number,
): ChatEvidenceCard[] {
  return hits.slice(0, limit).map((hit) => {
    const snippet = redactSecretsAtBoundary(String(hit.snippet ?? ""));
    return {
      ref: String(hit.id),
      kind: String(hit.kind),
      snippet: snippet.length > CHAT_MAX_SNIPPET_CHARS
        ? `${snippet.slice(0, CHAT_MAX_SNIPPET_CHARS)}… cut, snippet long`
        : snippet,
    };
  });
}

function toWholeMemoryCards(
  memory: readonly MemoryRecord[],
  hits: readonly { id: string; kind: string; score: number }[],
  query: string,
): ChatEvidenceCard[] | undefined {
  if (!hits.some((hit) => hit.score >= CHAT_MEMORY_RELEVANCE_FLOOR)) return [];
  const recordsById = new Map<string, MemoryRecord>();
  for (const record of memory) recordsById.set(record.id, record);

  const cards: ChatEvidenceCard[] = [];
  let promptChars = query.length + CHAT_MEMORY_PROMPT_RESERVE_CHARS;
  for (const hit of hits) {
    if (hit.score < CHAT_MEMORY_RELEVANCE_FLOOR) continue;
    const record = recordsById.get(hit.id);
    if (record === undefined) continue;
    const serialized = JSON.stringify(record);
    if (serialized === undefined) continue;
    const snippet = redactSecretsAtBoundary(serialized);
    promptChars += snippet.length + hit.id.length + hit.kind.length + 48;
    if (promptChars > MAX_PROMPT_CHARS) return undefined;
    cards.push({ ref: hit.id, kind: hit.kind, snippet });
  }
  return cards;
}

export function topConfidence(result: DecisionResult): number | null {
  if (result.status !== "used" || result.engine !== "jev") return null;
  const top = result.evidenceRefs[0];
  if (top === undefined) return null;
  const answer = result.answers.find((candidate) => candidate.id === `q_${top}`);
  return answer?.kind === "noul" ? answer.noul : null;
}

export function chatMemoryBlock(cards: readonly ChatEvidenceCard[]): string {
  if (cards.length === 0) return "no memory evidence for this query";
  const lines = cards.map((card, index) => `[${index + 1}] ref: ${card.ref} | kind: ${card.kind} | snippet: ${card.snippet}`);
  return redactSecretsAtBoundary(lines.join("\n"));
}

export function chatJevBlock(trace: {
  engine: string;
  status: string;
  confidence: number | null;
  evidenceRefs: readonly string[];
  latencyMs: number;
}): string {
  const confidence = trace.confidence === null ? "none" : String(trace.confidence);
  const refs = trace.evidenceRefs.length > 0 ? trace.evidenceRefs.join(", ") : "none";
  const line = `engine: ${trace.engine}; status: ${trace.status}; confidence: ${confidence}; refs: ${refs}; latency: ${trace.latencyMs}ms`;
  return redactSecretsAtBoundary(line);
}

function objectField(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

function stringField(value: unknown, key: string): string | undefined {
  const field = objectField(value, key);
  return typeof field === "string" ? field : undefined;
}

function providerText(data: unknown, anthropic: boolean): string {
  if (anthropic) {
    const content = objectField(data, "content");
    const first = Array.isArray(content) ? content[0] : undefined;
    return stringField(first, "text") ?? "";
  }
  const choices = objectField(data, "choices");
  const first = Array.isArray(choices) ? choices[0] : undefined;
  return stringField(objectField(first, "message"), "content") ?? "";
}

export type ProviderOutcome =
  | { kind: "text"; text: string }
  | { kind: "refused"; status: number; error: string }
  | { kind: "failed"; error: unknown; timedOut: boolean };

function isUnifiedProvider(provider: string, endpoint: string): boolean {
  if (provider === "openrouter") return true;
  return endpoint.toLowerCase().includes("openrouter.ai");
}

export async function requestProvider(
  prompt: string,
  modelSelection?: ChatLlmSelection,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProviderOutcome> {
  const stored = readSettings();
  let selection = modelSelection;
  if (selection === undefined) {
    const installed = await listChatInstalledModelNames();
    selection = resolveChatLlmSelection({
      requestedModel: undefined,
      stored,
      installed,
      env,
    });
  }

  if (!selection.active) {
    if (selection.reason === "missing-key" || selection.reason === "no-model") {
      return { kind: "refused", status: 400, error: "rocky need endpoint, key, model in settings first" };
    }
    if (selection.reason === "invalid_model") {
      return { kind: "refused", status: 400, error: "invalid model" };
    }
    return { kind: "refused", status: 503, error: "model unavailable" };
  }

  if (askInFlight >= MAX_ASK_IN_FLIGHT) {
    return { kind: "refused", status: 429, error: "rocky already asking. wait, question" };
  }

  const endpoint = selection.endpoint;
  const model = selection.modelId;
  const isUnified = isUnifiedProvider(stored.provider, endpoint);
  const fromEnv = typeof env.OPENROUTER_API_KEY === "string" ? env.OPENROUTER_API_KEY : "";
  const key = (isUnified && fromEnv.length > 0) ? fromEnv : stored.key;

  if (!endpoint || !key || !model) {
    return { kind: "refused", status: 400, error: "rocky need endpoint, key, model in settings first" };
  }

  const anthropic = endpoint.includes("/v1/messages");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (anthropic) {
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers.Authorization = `Bearer ${key}`;
  }
  const payload = { model, max_tokens: 1024, messages: [{ role: "user", content: prompt }] };

  askInFlight += 1;
  try {
    const answer = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
    });
    const data: unknown = await answer.json();
    if (!answer.ok) {
      return { kind: "refused", status: answer.status, error: stringField(objectField(data, "error"), "message") ?? "provider refused" };
    }
    return { kind: "text", text: providerText(data, anthropic) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "failed", error, timedOut: /timed out|timeout|abort/i.test(message) };
  } finally {
    askInFlight -= 1;
  }
}

/**
 * The code phase of one chat: a live scan, then at most one provider call
 * through the ask machinery.
 */
export async function executeCodeSupport(args: {
  root: string;
  query: string;
  prefixEmpty: boolean;
  witnessed: readonly string[];
  priorTokens: ReadonlySet<string>;
  memoryBlock: string;
  jevBlock: string;
  selection: ChatLlmSelection;
  lang: GuiSettings["lang"];
}): Promise<CodeSupport> {
  if (args.prefixEmpty) {
    return {
      evidence: [],
      trace: { mode: "unranked", filesScanned: 0, filesTotal: 0, rounds: 0, roundsExhausted: false, truncated: false },
      answer: { text: CODE_EXCERPTS_ONLY, model: "", status: "skipped", stripped: 0, disclosure: CODE_PREFIX_EMPTY },
    };
  }

  const collected: CodeEvidenceResult = collectCodeEvidence({
    root: args.root,
    query: args.query,
    confine: (candidate) => confine(args.root, candidate),
    witnessed: args.witnessed,
    priorTokens: args.priorTokens,
  });
  const disclosures = [...collected.disclosures];
  if (collected.evidence.length === 0) disclosures.push(CODE_NO_MATCH);
  const fallback = codeFallbackText(collected.evidence);
  const answer = (text: string, status: CodeAnswer["status"], stripped: number): CodeAnswer => ({
    text,
    model: args.selection.modelId,
    status,
    stripped,
    ...(disclosures.length === 0 ? {} : { disclosure: disclosures.join(" ") }),
  });

  if (!args.selection.active || args.selection.kind !== "byok") {
    disclosures.push(args.selection.active ? CODE_MODEL_LOCAL : CODE_NO_MODEL);
    return { evidence: collected.evidence, trace: collected.trace, answer: answer(fallback, "no-model", 0) };
  }

  const prompt = boundedPrompt(buildCodePrompt({
    preamble: `${TEACH_ENV}\n\n${loadTeachSpec(args.lang)}`,
    question: args.query,
    memoryBlock: args.memoryBlock,
    jevBlock: args.jevBlock,
    evidence: collected.evidence,
  }));
  const outcome = await requestProvider(prompt);
  if (outcome.kind === "failed") {
    return {
      evidence: collected.evidence,
      trace: collected.trace,
      answer: answer(fallback, outcome.timedOut ? "timeout" : "unavailable", 0),
    };
  }
  if (outcome.kind === "refused") {
    return { evidence: collected.evidence, trace: collected.trace, answer: answer(fallback, "unavailable", 0) };
  }

  const check = validateCodeCitations(redactSecretsAtBoundary(outcome.text), collected.evidence);
  if (check.dropped > 0) disclosures.push(CODE_UNGROUNDED(check.dropped));
  const text = check.stripped.trim().length > 0 ? check.stripped : fallback;
  return { evidence: collected.evidence, trace: collected.trace, answer: answer(text, "used", check.dropped) };
}

function memoryOnlyAbstention(args: {
  asked: string;
  model: string;
  status: "low_confidence" | "unavailable";
  text: string;
  coverageReason?: string;
}): AnswerOutcome {
  const llm: ChatLlmTrace = {
    active: false,
    model: args.model,
    structurerStatus: "memory-only",
    rendererStatus: "memory-only",
    stripped: 0,
  };
  const trace: ChatTrace = {
    engine: "heuristic",
    status: args.status,
    confidence: null,
    evidenceRefs: [],
    latencyMs: 0,
    llm,
  };
  appendDecisionLog({
    engine: trace.engine,
    status: trace.status,
    input_hash: hashDecisionInput(`${args.asked}|`),
    answer: { order: [] },
    latency_ms: trace.latencyMs,
    outcome: "chat",
    evidenceRefs: [],
  });
  return {
    status: 200,
    payload: {
      text: args.text,
      evidenceCards: [],
      decisionTrace: trace,
      llm,
      renderOrder: [...CHAT_RENDER_ORDER],
      ...(args.coverageReason === undefined ? {} : { coverage: { reason: args.coverageReason } }),
    },
  };
}

async function executeMemoryOnlyAnswer(args: {
  asked: string;
  query: string;
  memory: readonly MemoryRecord[];
  coverageReason: string | undefined;
  requestedModel: string | undefined;
  stored: GuiSettings;
  env: NodeJS.ProcessEnv;
}): Promise<AnswerOutcome> {
  const lang = args.stored.lang;
  const model = args.requestedModel ?? args.stored.model;
  if (args.coverageReason !== undefined) {
    return memoryOnlyAbstention({
      asked: args.asked,
      model,
      status: "unavailable",
      text: lang === "id" ? "ingatan terbaca tidak lengkap. Rocky menahan jawaban." : "memory read incomplete. Rocky holds answer.",
      coverageReason: args.coverageReason,
    });
  }

  const hits = searchKnowledge(args.memory, { query: args.query, limit: args.memory.length });
  const cards = toWholeMemoryCards(args.memory, hits, args.query);
  if (cards === undefined) {
    return memoryOnlyAbstention({
      asked: args.asked,
      model,
      status: "unavailable",
      text: lang === "id"
        ? "bukti memori utuh melewati batas konteks. Rocky menahan jawaban. record tetap utuh."
        : "whole memory evidence exceeds context. Rocky holds answer. Records stay whole.",
    });
  }
  if (cards.length === 0) {
    return memoryOnlyAbstention({
      asked: args.asked,
      model,
      status: "low_confidence",
      text: lang === "id"
        ? "tidak ada ingatan yang cukup cocok. Rocky belum tahu jawaban ini."
        : "Rocky heard no memory that answers this question.",
    });
  }

  const selected = await resolveChatLlmSelection({
    requestedModel: args.requestedModel,
    stored: args.stored,
    installed: await listChatInstalledModelNames(),
    env: args.env,
  });
  const rendererSelection: ChatLlmSelection = selected.kind === "byok"
    ? { active: false, modelId: selected.modelId, kind: "none", endpoint: "", reason: "no-model" }
    : selected;
  const evidenceRefs = cards.map((card) => card.ref);
  const traceBase = {
    engine: "heuristic" as const,
    status: "used" as const,
    confidence: null,
    evidenceRefs,
    latencyMs: 0,
  };
  const renderer = await runChatRenderer(
    rendererSelection,
    {
      query: args.query,
      topRef: cards[0]?.ref,
      topKind: cards[0]?.kind,
      engine: traceBase.engine,
      status: traceBase.status,
      evidenceCount: cards.length,
      latencyMs: traceBase.latencyMs,
      evidence: cards.map((card) => ({ ref: card.ref, kind: card.kind, snippet: card.snippet })),
    },
    evidenceRefs,
    args.stored,
    args.env,
  );
  const llm: ChatLlmTrace = {
    active: rendererSelection.active,
    model: rendererSelection.modelId,
    structurerStatus: "memory-only",
    rendererStatus: renderer.status,
    stripped: renderer.stripped,
  };
  const trace: ChatTrace = { ...traceBase, evidenceRefs: [...evidenceRefs], llm };
  appendDecisionLog({
    engine: trace.engine,
    status: trace.status,
    input_hash: hashDecisionInput(`${args.asked}|${evidenceRefs.join(",")}`),
    answer: { order: [...evidenceRefs] },
    latency_ms: trace.latencyMs,
    outcome: "chat",
    evidenceRefs: [...evidenceRefs],
  });
  return {
    status: 200,
    payload: {
      text: renderer.text,
      evidenceCards: cards,
      decisionTrace: trace,
      llm,
      renderOrder: [...CHAT_RENDER_ORDER],
    },
  };
}


/**
 * Unified answering engine execution function.
 */
export async function executeAnswer(options: AnswerOptions): Promise<AnswerOutcome> {
  const root = options.root;
  const env = options.env ?? process.env;
  const stored = readSettings();

  if (options.mode === "chat") {
    if (chatInFlight >= CHAT_MAX_IN_FLIGHT) {
      return { status: 429, payload: { error: "rocky already chatting. wait, question" } };
    }
    const raw = typeof options.message === "string" ? options.message : "";
    const message = raw.trim();
    if (message.length === 0) {
      return { status: 400, payload: { error: "rocky needs a message, question" } };
    }
    const bounded = message.length > CHAT_MAX_MESSAGE_CHARS
      ? `${message.slice(0, CHAT_MAX_MESSAGE_CHARS)}\n… cut, message long`
      : message;
    const asked = redactSecretsAtBoundary(bounded);
    const split = splitCodePrefix(asked);
    const query = split.query;
    const requested = typeof options.limit === "number" && Number.isFinite(options.limit)
      ? Math.floor(options.limit)
      : CHAT_DEFAULT_LIMIT;
    const limit = Math.min(CHAT_MAX_LIMIT, Math.max(1, requested));

    chatInFlight += 1;
    try {
      const { list, reason } = records();
      const witnessedFiles = split.mode === "memory" ? [] : witnessedRepoPaths(list, root);
      const codeTriggered = split.mode !== "memory" && (split.mode === "code" || isCodeQuery(query, witnessedFiles));
      if (!codeTriggered) {
        return executeMemoryOnlyAnswer({
          asked,
          query,
          memory: list,
          coverageReason: reason,
          requestedModel: typeof options.model === "string" ? options.model : undefined,
          stored,
          env,
        });
      }
      const hits = searchKnowledge(list, { query, limit });
      const shortlist: DecisionCandidate[] = toChatCards(hits, limit).map((card) => ({ ...card }));

      const evidenceRefs = shortlist.map((card) => ({ ref: card.ref, kind: card.kind, snippet: card.snippet }));
      const llmSelection = resolveChatLlmSelection({
        requestedModel: typeof options.model === "string" ? options.model : undefined,
        stored,
        installed: await listChatInstalledModelNames(),
        env,
      });

      const structurer = await runChatStructurer(llmSelection, query, evidenceRefs, stored, env);
      const jevState = structurer.structure ?? buildChatStructure(query, evidenceRefs);

      const jevRequested = options.jev === true;
      const selection = readDecisionSelection();
      const engine = jevRequested ? "jev" : selection.engine;
      const useJev = engine === "jev";

      const unified = isUnifiedOpenRouterMode(stored.provider, stored.endpoint);
      const activeJevProvider = unified ? "openrouter" : selection.jevProvider;
      const activeApiKey = unified
        ? resolveUnifiedOpenRouterKey(env, stored.key)
        : resolveActiveJevKey(selection.jevProvider, env, stored.jevKey, stored.openRouterKey);
      const activeStoredKey = unified
        ? stored.key
        : selection.jevProvider === "openrouter" ? stored.openRouterKey : stored.jevKey;
      const port = useJev
        ? createJevPort({
          provider: activeJevProvider,
          apiKey: activeApiKey || undefined,
          storedKey: activeStoredKey,
        })
        : createHeuristicPort();
      const questions = buildRelevanceQuestions(jevState.candidates);
      let result: DecisionResult;
      try {
        result = await port.evaluate({ query: jevState.query, candidates: [...jevState.candidates] }, questions);
      } catch {
        result = {
          answers: [],
          engine: useJev ? "jev" : "heuristic",
          status: "unavailable",
          latencyMs: 0,
          evidenceRefs: shortlist.map((candidate) => candidate.ref),
        };
      }
      const byRef = new Map(shortlist.map((card) => [card.ref, card] as const));
      const ordered = result.evidenceRefs
        .map((ref) => byRef.get(ref))
        .filter((card): card is ChatEvidenceCard => card !== undefined);
      for (const card of shortlist) {
        if (!ordered.some((kept) => kept.ref === card.ref)) ordered.push(card);
      }
      const traceBase = {
        engine: result.engine === "jev" ? "jev" : "heuristic",
        status: result.status,
        confidence: topConfidence(result),
        evidenceRefs: ordered.map((card) => card.ref),
        latencyMs: result.latencyMs,
      } as const;

      const renderer = await runChatRenderer(
        llmSelection,
        {
          query,
          topRef: ordered[0]?.ref,
          topKind: ordered[0]?.kind,
          topScore: topConfidence(result),
          engine: traceBase.engine,
          status: traceBase.status as ChatRenderStatus,
          evidenceCount: ordered.length,
          latencyMs: traceBase.latencyMs,
          detail: result.detail,
          coverageReason: reason,
          evidence: ordered.map((card) => ({ ref: card.ref, kind: card.kind, snippet: card.snippet })),
        },
        ordered.map((card) => card.ref),
        stored,
        env,
      );
      const llm: ChatLlmTrace = {
        active: llmSelection.active,
        model: llmSelection.modelId,
        structurerStatus: structurer.status,
        rendererStatus: renderer.status,
        stripped: renderer.stripped,
      };
      const trace: ChatTrace = { ...traceBase, evidenceRefs: [...traceBase.evidenceRefs], llm };

      const code = codeTriggered
        ? await executeCodeSupport({
          root,
          query,
          prefixEmpty: split.prefixEmpty,
          witnessed: witnessedFiles,
          priorTokens: memoryPriorTokens(list, hits),
          memoryBlock: chatMemoryBlock(ordered),
          jevBlock: chatJevBlock(traceBase),
          selection: llmSelection,
          lang: stored.lang,
        })
        : undefined;

      appendDecisionLog({
        engine: trace.engine,
        status: trace.status,
        input_hash: hashDecisionInput(`${asked}|${shortlist.map((candidate) => candidate.ref).join(",")}`),
        answer: result.detail === undefined
          ? { order: [...trace.evidenceRefs] }
          : { order: [...trace.evidenceRefs], detail: result.detail },
        latency_ms: trace.latencyMs,
        outcome: "chat",
        evidenceRefs: [...trace.evidenceRefs],
        ...(result.cost === undefined ? {} : { cost: result.cost }),
      });

      return {
        status: 200,
        payload: {
          text: renderer.text,
          evidenceCards: ordered,
          decisionTrace: trace,
          llm,
          renderOrder: [...CHAT_RENDER_ORDER],
          ...(reason === undefined ? {} : { coverage: { reason } }),
          ...(code === undefined ? {} : { codeEvidence: code.evidence, codeAnswer: code.answer, codeTrace: code.trace }),
        },
      };
    } finally {
      chatInFlight -= 1;
    }
  }

  // Explain mode (/api/ask)
  const codeCtx = options.codeContext;
  const rel = codeCtx?.path ?? "";
  const rawPrompt = String(options.prompt ?? options.message ?? "");

  if (!rawPrompt && !rel) {
    return { status: 400, payload: { error: "rocky need endpoint, key, model in settings first" } };
  }

  const llmSelection = resolveChatLlmSelection({
    requestedModel: typeof options.model === "string" ? options.model : undefined,
    stored,
    installed: await listChatInstalledModelNames(),
    env,
  });

  let refTraceResult: ReferenceTraceResult | undefined;
  let packText = "";
  if (rel) {
    const full = confine(root, rel) ?? witnessed(rel);
    if (full !== undefined) {
      const start = Number(codeCtx?.start ?? 1);
      const end = Number(codeCtx?.end ?? start);
      refTraceResult = traceReferences({
        root,
        file: rel,
        startLine: start,
        endLine: end,
        commit: codeCtx?.commit,
      });
      if (refTraceResult.evidenceText) {
        packText = `\n\nEVIDENCE ROCKY GATHERED (quote only from this):\n${refTraceResult.evidenceText}`;
      }
    }
  }

  const prompt = `${TEACH_ENV}\n\n${loadTeachSpec(stored.lang)}\n\n---\n\n${boundedPrompt(rawPrompt)}${packText}`;
  const outcome = await requestProvider(prompt, llmSelection, env);

  if (outcome.kind === "refused") {
    return { status: outcome.status, payload: { error: outcome.error } };
  }
  if (outcome.kind === "failed") {
    throw outcome.error;
  }

  // Run advisory decision analysis if possible
  let decisionTrace: unknown;
  try {
    const queryForAnalysis = redactSecretsAtBoundary(rawPrompt.slice(0, 1000));
    const hits = searchKnowledge(records().list, { query: queryForAnalysis, limit: 5 });
    const unified = isUnifiedOpenRouterMode(stored.provider, stored.endpoint);
    const selection = readDecisionSelection();
    const provider = unified ? "openrouter" : selection.jevProvider;
    const apiKey = unified
      ? resolveUnifiedOpenRouterKey(env, stored.key)
      : resolveActiveJevKey(selection.jevProvider, env, stored.jevKey, stored.openRouterKey);
    decisionTrace = await analyzeExplainDecision({
      query: queryForAnalysis,
      candidates: hits.map((hit: { id: string; kind: string; snippet: string }) => ({
        ref: hit.id,
        kind: hit.kind,
        snippet: redactSecretsAtBoundary(hit.snippet).slice(0, 500),
      })),
    }, { outcome: "ask", provider, apiKey: apiKey || undefined });
  } catch {
    // advisory
  }

  const payload: ChatResponsePayload = {
    text: outcome.text,
    evidenceCards: [],
    decisionTrace: {
      engine: "heuristic",
      status: "used",
      confidence: null,
      evidenceRefs: [],
      latencyMs: 0,
      llm: {
        active: llmSelection.active,
        model: llmSelection.modelId || stored.model,
        structurerStatus: "used",
        rendererStatus: "used",
        stripped: 0,
      },
    },
    llm: {
      active: llmSelection.active,
      model: llmSelection.modelId || stored.model,
      structurerStatus: "used",
      rendererStatus: "used",
      stripped: 0,
    },
    renderOrder: [...CHAT_RENDER_ORDER],
    ...(decisionTrace !== undefined ? { decision: decisionTrace } : {}),
    ...(refTraceResult !== undefined ? {
      referenceTrace: refTraceResult,
      referenceChain: refTraceResult.referenceChain,
    } : {}),
  };

  return { status: 200, payload };
}
