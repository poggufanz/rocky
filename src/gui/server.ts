/**
 * Rocky's localhost GUI server.
 *
 * Binds loopback only. Every launch mints a fresh token that the page carries
 * in its URL fragment and sends back on each API call, so another tab on this
 * machine cannot read the memory by guessing the port. Reads only: no route
 * here writes evidence.
 *
 * The one exception to no-egress is `POST /api/ask`, the BYOK proxy. It exists
 * because browsers cannot call model providers cross-origin; the request is
 * forwarded from here instead, and only when the page supplies a key.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

import { loadMemoryChecked, type MemoryRecord } from "../core/memory-read.js";
import { redactSecretsAtBoundary } from "../core/redact.js";
import { publicSettings, readSettings, writeSettings, type GuiSettings } from "./settings.js";
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
} from "./code-search.js";
import { providerFor, providerList } from "./models-dev.js";
import { deriveHome } from "../core/home-data.js";
import { elapsed } from "../ui/rocky.js";
import { fileIndex, getCachedDiff, groupMomentsByChange, defaultDiffIo, lineOverlapPredicate, parsePatch, type DiffRow } from "../core/compare-data.js";
import { resolveContext } from "../core/context-resolve.js";
import { filteredFiles, TEACH_MAX_LINES } from "../core/file-filter.js";
import { repoForPath, type RepoCache } from "../core/repo-groups.js";
import { teachLookup } from "../core/teach.js";
import { buildLadder, calleeNames, collectImports, defaultTeachNeighbor, enclosingFunction, findDefinitionInText, isRelativeSpecifier, resolveRelativePath } from "../core/teach-ladder.js";
import { gitFirstTouch, resolveCommitDiff } from "../core/git-diff.js";
import { bundleGroups, splitRowsByFile, BUNDLE_MAX_FILES, type BundleInput } from "../core/bundle-groups.js";
import {
  gapRungFor,
  renderLadderCard,
  renderLadderExpanded,
  renderWitnessCard,
} from "../core/teach-render.js";
import { resolveRefer, escapeRegExp, type ReferWitness } from "../core/refer-resolve.js";
import { matchConcepts } from "../core/concepts.js";
import { CS_CONCEPT_IDS, explainFor } from "../core/cs-explain.js";
import { searchKnowledge } from "../core/memory-query.js";
import { loadConfig } from "../core/config-read.js";
import { saveConfigAtomic } from "../core/config.js";
import { appendDecisionLog, hashDecisionInput } from "../ai/decision-log.js";
import {
  buildRelevanceQuestions,
  createHeuristicPort,
  type DecisionCandidate,
  type DecisionResult,
} from "../ai/decision.js";
import { JEV_MODEL, JEV_OPENROUTER_MODEL, createJevPort, isUnifiedOpenRouterMode, resolveActiveJevKey, resolveJevKey, resolveOpenRouterKey, resolveUnifiedOpenRouterKey } from "../ai/jev.js";
import { createOllamaClient } from "../ai/ollama.js";
import { buildChatStructure } from "../ai/chat-structure.js";
import { CHAT_RENDER_ORDER, type ChatRenderStatus } from "../ai/chat-render.js";
import {
  chatByokKeyPresent,
  listChatInstalledModelNames,
  resolveChatLlmSelection,
  runChatRenderer,
  runChatStructurer,
  type ChatLlmSelection,
  type ChatLlmTrace,
} from "../ai/chat-llm.js";
import { analyzeExplainDecision } from "../ai/explain-decision.js";

export const DEFAULT_GUI_PORT = 7777;
const READ_CAP_BYTES = 2 * 1024 * 1024;
const MAX_BODY_BYTES = 256 * 1024;
const ASK_TIMEOUT_MS = 60_000;
const MAX_PROMPT_CHARS = 24_000;
const MAX_ASK_IN_FLIGHT = 2;
const CHAT_MAX_MESSAGE_CHARS = 4_000;
const CHAT_DEFAULT_LIMIT = 5;
const CHAT_MAX_LIMIT = 10;
const CHAT_MAX_SNIPPET_CHARS = 500;
let chatInFlight = 0;
const CHAT_MAX_IN_FLIGHT = 2;

/** Jev runs only behind an explicit `decision.engine: "jev"` opt-in; absent = heuristic. */
function readDecisionSelection(): { engine: "heuristic" | "local" | "jev"; jevProvider: "typesafe" | "openrouter" } {
  try {
    const loaded = loadConfig();
    if (loaded.status === "valid" && loaded.config.decision !== undefined) {
      return { engine: loaded.config.decision.engine, jevProvider: loaded.config.decision.jevProvider ?? "typesafe" };
    }
  } catch {
    // An unreadable config keeps the heuristic default; never fail the chat.
  }
  return { engine: "heuristic", jevProvider: "typesafe" };
}

interface ChatEvidenceCard {
  ref: string;
  kind: string;
  snippet: string;
}

interface ChatTrace {
  engine: "heuristic" | "jev";
  status: "used" | "disabled" | "unavailable" | "timeout" | "invalid_output" | "low_confidence";
  confidence: number | null;
  evidenceRefs: readonly string[];
  latencyMs: number;
  llm: ChatLlmTrace;
}

function toChatCards(
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

function topConfidence(result: DecisionResult): number | null {
  if (result.status !== "used" || result.engine !== "jev") return null;
  const top = result.evidenceRefs[0];
  if (top === undefined) return null;
  const answer = result.answers.find((candidate) => candidate.id === `q_${top}`);
  return answer?.kind === "noul" ? answer.noul : null;
}


async function chat(
  body: Record<string, unknown>,
  root: string,
): Promise<{ status: number; payload: unknown }> {
  if (chatInFlight >= CHAT_MAX_IN_FLIGHT) {
    return { status: 429, payload: { error: "rocky already chatting. wait, question" } };
  }
  const raw = typeof body.message === "string" ? body.message : "";
  const message = raw.trim();
  if (message.length === 0) {
    return { status: 400, payload: { error: "rocky needs a message, question" } };
  }
  const bounded = message.length > CHAT_MAX_MESSAGE_CHARS
    ? `${message.slice(0, CHAT_MAX_MESSAGE_CHARS)}\n… cut, message long`
    : message;
  const asked = redactSecretsAtBoundary(bounded);
  // Q6: `code:`/`memory:` decide first, then the heuristic runs on the
  // stripped query. When the trigger does not fire this function stays
  // byte-identical to the memory-only path: no scan, no provider code call,
  // no new field.
  const split = splitCodePrefix(asked);
  const query = split.query;
  const requested = typeof body.limit === "number" && Number.isFinite(body.limit) ? Math.floor(body.limit) : CHAT_DEFAULT_LIMIT;
  const limit = Math.min(CHAT_MAX_LIMIT, Math.max(1, requested));
  chatInFlight += 1;
  try {
    const { list, reason } = records();
    const witnessedFiles = witnessedRepoPaths(list, root);
    const codeTriggered = split.mode !== "memory" && (split.mode === "code" || isCodeQuery(query, witnessedFiles));
    const hits = searchKnowledge(list, { query, limit });
    const shortlist: DecisionCandidate[] = toChatCards(hits, limit).map((card) => ({ ...card }));
    const stored = readSettings();
    // GUARANTEE (creator order, main chat ONLY — teach/ask untouched): when
    // `isLlmActive(llmSelection)` is true, /api/chat MUST call the structurer
    // then the renderer (both route to `body.model` via the selection); when
    // false, both stages return disclosed fallbacks, never mocked text.
    // `resolveChatLlmSelection` is the single active predicate: body.model
    // wins, the stored default fills in; API-KEY-FIRST — a keyed BYOK id
    // (exact stored.model + endpoint + main-slot key) resolves active before
    // the Ollama list is consulted, so an offline daemon can never mask it.
    // Inactive/unknown/unkeyed selections skip both LLM stages with the
    // reason disclosed on the trace — never mocked, never silent.
    const evidenceRefs = shortlist.map((card) => ({ ref: card.ref, kind: card.kind, snippet: card.snippet }));
    const llmSelection = resolveChatLlmSelection({
      requestedModel: typeof body.model === "string" ? body.model : undefined,
      stored,
      installed: await listChatInstalledModelNames(),
    });
    // LLM aktif wajib lewat: active => structurer LLM call, then renderer LLM
    // call; inactive => disclosed fallback inside each stage. The two awaits
    // below are unconditional so no path can skip them.
    const structurer = await runChatStructurer(llmSelection, query, evidenceRefs, stored);
    // The structurer only shapes Jev state from retrieved refs (allowlisted);
    // the Jev port below stays the decider and never sees an invented ref.
    const jevState = structurer.structure ?? buildChatStructure(query, evidenceRefs);
    // Per-message lightning toggle: jev:true forces the Jev engine for this call.
    // The key resolves server-side only: in unified OpenRouter mode the shared
    // main credential (env OPENROUTER_API_KEY wins, stored main key falls back)
    // drives Jev; otherwise on the active provider path (typesafe: env
    // TYPESAFE_API_KEY wins, stored jevKey falls back; openrouter: env
    // OPENROUTER_API_KEY wins, stored openRouterKey falls back). With no key
    // the Jev port reports disabled plus baseline, which the trace and text
    // disclose — never mocked, never silent. Absent toggle keeps the
    // configured decision.engine default (heuristic when unset).
    const jevRequested = body.jev === true;
    const selection = readDecisionSelection();
    const engine = jevRequested ? "jev" : selection.engine;
    const useJev = engine === "jev";
    // Unified OpenRouter mode: the MAIN provider is itself OpenRouter, so the
    // Jev slots are never read here — the shared main credential (env
    // OPENROUTER_API_KEY wins, stored main `key` falls back) drives the Jev
    // path as typesafe/jev-1.13 behind the same key. Missing credential =
    // disabled plus baseline, disclosed, never mocked. Non-unified keeps the
    // existing jevProvider + Jev-key fallback exactly as before.
    const unified = isUnifiedOpenRouterMode(stored.provider, stored.endpoint);
    const activeJevProvider = unified ? "openrouter" : selection.jevProvider;
    const activeApiKey = unified
      ? resolveUnifiedOpenRouterKey(process.env, stored.key)
      : resolveActiveJevKey(selection.jevProvider, process.env, stored.jevKey, stored.openRouterKey);
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
      // Jev stays the decider: it judges the structured state (retrieved refs
      // only), never a free-form LLM claim.
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
    // The renderer reads ONLY this fact object: the LLM structures/selects,
    // never invents. Uncited lines are stripped and counted; failure keeps
    // the raw template with the status disclosed — never a retry-guess.
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
    );
    const llm: ChatLlmTrace = {
      active: llmSelection.active,
      model: llmSelection.modelId,
      structurerStatus: structurer.status,
      rendererStatus: renderer.status,
      stripped: renderer.stripped,
    };
    const trace: ChatTrace = { ...traceBase, evidenceRefs: [...traceBase.evidenceRefs], llm };
    // The code phase runs after the memory answer exists, so the prompt's
    // memory block and Jev block carry exactly the trace the user sees. One
    // live scan, at most one provider call, never a retry (Q10, Q12).
    const code = codeTriggered
      ? await codeSupport({
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
      answer: result.detail === undefined ? { order: [...trace.evidenceRefs] } : { order: [...trace.evidenceRefs], detail: result.detail },
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
        // Evidence-first render contract: the frontend renders evidenceCards
        // FIRST, the text bubble SECOND, decisionTrace last. Field names are
        // unchanged; this order list only documents the display sequence.
        renderOrder: [...CHAT_RENDER_ORDER],
        ...(reason === undefined ? {} : { coverage: { reason } }),
        // Appended only when the trigger fired: a memory-only question keeps
        // today's payload byte-for-byte, with no scan and no provider call.
        ...(code === undefined ? {} : { codeEvidence: code.evidence, codeAnswer: code.answer, codeTrace: code.trace }),
      },
    };
  } finally {
    chatInFlight -= 1;
  }
}

let askInFlight = 0;
let bundleCache: { key: string; payload: { bundles: unknown[]; unattributed: number } } | null = null;
let bundleInFlight: { key: string; promise: Promise<{ bundles: unknown[]; unattributed: number }> } | null = null;

/**
 * Memory-named files, reduced to launch-root-relative paths through the same
 * boundary every other read uses: a file outside the launch root is simply not
 * a candidate (Q1), never an error and never a second try.
 */
function witnessedRepoPaths(
  list: MemoryRecord[],
  root: string,
): string[] {
  const out: string[] = [];
  for (const file of fileIndex(list)) {
    const full = confine(root, file.path);
    if (full === undefined) continue;
    const rel = relative(root, full).replace(/\\/g, "/");
    if (rel.length > 0 && !out.includes(rel)) out.push(rel);
  }
  return out;
}

/** Q11: the memory block is the same cards the page shows, redacted again. */
function chatMemoryBlock(cards: readonly ChatEvidenceCard[]): string {
  if (cards.length === 0) return "no memory evidence for this query";
  const lines = cards.map((card, index) => `[${index + 1}] ref: ${card.ref} | kind: ${card.kind} | snippet: ${card.snippet}`);
  return redactSecretsAtBoundary(lines.join("\n"));
}

/** Q11: the Jev trace the page shows, as the prompt's context block. */
function chatJevBlock(trace: {
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

interface CodeSupport {
  evidence: CodeExcerpt[];
  answer: CodeAnswer;
  trace: CodeTrace;
}

/**
 * The code phase of one chat: a live scan, then at most one provider call
 * through the ask machinery. Degradation is total, never partial (Q9) — no
 * model, a provider refusal, a timeout, a spent budget, or a non-git root all
 * return the same shape with the excerpts and one disclosure line, and the
 * memory answer above them is never touched. There is no retry.
 */
async function codeSupport(args: {
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

  // Only a keyed BYOK selection can be reached from here: the code answer
  // rides the same endpoint, key and model `/api/ask` uses. Ollama is a local
  // daemon this route never calls, so it discloses instead of sending.
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

  // The citation gate: a path:line the excerpts do not hold is stripped and
  // counted, and the answer says so rather than reading as grounded.
  const check = validateCodeCitations(redactSecretsAtBoundary(outcome.text), collected.evidence);
  if (check.dropped > 0) disclosures.push(CODE_UNGROUNDED(check.dropped));
  const text = check.stripped.trim().length > 0 ? check.stripped : fallback;
  return { evidence: collected.evidence, trace: collected.trace, answer: answer(text, "used", check.dropped) };
}

/**
 * The fallback rules every BYOK answer is bound by when the spec file is not
 * on disk, prepended here rather than in the page so a browser cannot drop
 * them.
 *
 * Ported from the owner's teach agent spec (assets/teach-agent.md), minus
 * every instruction that
 * needs a tool. This model has no shell, no git, and no filesystem: it sees
 * the snippet and whatever Rocky already holds, and nothing else. Telling it
 * to walk five hops and cite `git log -L` would only teach it to invent
 * citations, which is the one failure this whole surface exists to prevent.
 */
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

const ASSET_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "gui");

/** The owner's spec, whole, next to the dash assets so the package ships it. */
const TEACH_SPEC_CAP_BYTES = 64 * 1024;
const teachSpec: Partial<Record<"id" | "en", string | null>> = {};

/**
 * teach-agent.md is the system prompt, read whole at request time (cached
 * after the first read) so editing the file edits the investigator. The
 * settings pick the language: id reads teach-agent.md, en its english twin.
 * The spec assumes tools this model does not have, so an environment note
 * rides ahead of it; where the spec says walk hops with a shell, the model
 * works only from the quoted evidence. TEACH_RULES stays as the fallback for
 * a spec that is not on disk.
 */
const TEACH_ENV = [
  "Environment note for this run: you have no shell, no git, no database and no filesystem.",
  "Rocky walks the hops for you and quotes what it found after the rules, selection first:",
  "the enclosing function, the definitions of the symbols the selection uses, the comment",
  "above it, the tests that name those symbols, and the git commit that first touched the",
  "lines. Cite only what is quoted; never claim you ran anything.",
].join("\n");

const PACK_BUDGET_CHARS = 20_000;
const PACK_DEF_CHARS = 1_200;
const PACK_DEF_MAX = 3;
const PACK_TEST_CHARS = 2_500;
const PACK_TEST_MAX = 2;
const PACK_WHOLE_FILE_LINES = 80;
const PACK_WINDOW_PAD_LINES = 25;

/** A js specifier points at .js on disk as often as .ts, so both are tried. */
function readNeighborFile(neighbor: (relPath: string) => string | undefined, rel: string): string | undefined {
  const tries = [rel];
  if (rel.endsWith(".js")) tries.push(`${rel.slice(0, -3)}.ts`);
  if (!/\.[a-z]+$/.test(rel)) tries.push(`${rel}.ts`, `${rel}.js`, `${rel}.php`);
  for (const candidate of tries) {
    const content = neighbor(candidate);
    if (content !== undefined) return content;
  }
  return undefined;
}

/** Test files live under a handful of names across ecosystems. */
const TEST_FILE_RE = /(?:\.test\.[tj]s|\.spec\.[tj]s|Test\.php)$/;

/** A PHP `use` line, as the pack reads it: the short name the code mentions
 *  and the class it points at. Grouped uses (`use App\{A, B}`) stay unparsed. */
interface PhpUse {
  name: string;
  fqcn: string;
}

function collectPhpUses(text: string): PhpUse[] {
  const out: PhpUse[] = [];
  const re = /^\s*use\s+([A-Za-z0-9_\\]+)(?:\s+as\s+([A-Za-z0-9_]+))?\s*;/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const fqcn = m[1] ?? "";
    if (fqcn.includes("{")) continue;
    out.push({ name: m[2] ?? fqcn.split("\\").pop() ?? fqcn, fqcn });
  }
  return out;
}

/**
 * PSR-4 resolution: the nearest composer.json above the file maps namespace
 * prefixes to directories; without one, the App/ and Tests/ conventions carry
 * Laravel-shaped projects. Bounded read, a miss is a miss, never an error.
 */
function resolvePhpClass(full: string, fqcn: string): { path: string; content: string } | undefined {
  let dir = dirname(full);
  let prefixes: Record<string, string> = {};
  for (let up = 0; up < 6; up += 1) {
    const composerPath = join(dir, "composer.json");
    if (existsSync(composerPath)) {
      try {
        const composer = JSON.parse(readFileSync(composerPath, "utf8")) as {
          autoload?: { ["psr-4"]?: Record<string, string | string[]> };
          ["autoload-dev"]?: { ["psr-4"]?: Record<string, string | string[]> };
        };
        for (const section of [composer.autoload?.["psr-4"], composer["autoload-dev"]?.["psr-4"]]) {
          for (const [prefix, target] of Object.entries(section ?? {})) {
            prefixes[prefix.replace(/\\+$/, "")] = Array.isArray(target) ? target[0] ?? "" : target;
          }
        }
      } catch {
        // a composer.json that will not parse falls through to conventions
      }
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (Object.keys(prefixes).length === 0) prefixes = { App: "app/", Tests: "tests/" };

  const match = Object.keys(prefixes)
    .sort((a, b) => b.length - a.length)
    .find((prefix) => fqcn === prefix || fqcn.startsWith(`${prefix}\\`));
  if (match === undefined) return undefined;
  const rel = `${prefixes[match]}${fqcn.slice(match.length + 1).replace(/\\/g, "/")}.php`;
  const candidate = resolve(dir, rel);
  try {
    const info = statSync(candidate);
    if (!info.isFile() || info.size > 64 * 1024) return undefined;
    return { path: rel.replace(/\\/g, "/"), content: readFileSync(candidate, "utf8") };
  } catch {
    return undefined;
  }
}

/** Where a PHP class or one of its methods is declared, for the pack to quote. */
function phpDefinition(
  name: string,
  text: string,
): { line: number; kind: "class" | "method" } | undefined {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lines = text.split(/\r?\n/);
  const classRe = new RegExp(`^\\s*(?:abstract\\s+|final\\s+)?(?:class|interface|trait|enum)\\s+${n}\\b`);
  for (let i = 0; i < lines.length; i += 1) {
    if (classRe.test(lines[i] ?? "")) return { line: i + 1, kind: "class" };
  }
  const methodRe = new RegExp(`^\\s*(?:public|protected|private|static|final|abstract|\\s)*function\\s+${n}\\s*\\(`);
  for (let i = 0; i < lines.length; i += 1) {
    if (methodRe.test(lines[i] ?? "")) return { line: i + 1, kind: "method" };
  }
  return undefined;
}

/**
 * The ask model has no eyes, so rocky digs for it, selection-first and in a
 * written order: the selection itself, the function enclosing it (or the whole
 * file when it is short), the definitions of the symbols the selection
 * actually uses, the comment above, the tests that name those symbols, and
 * the first commit that touched the lines. Everything is bounded, and
 * redaction happens on the joined pack before any of it may leave the machine.
 */
function evidencePack(full: string, rel: string, start: number, end: number): string {
  try {
    const info = statSync(full);
    if (!info.isFile() || info.size > READ_CAP_BYTES) return "";
    const fileText = readFileSync(full, "utf8");
    const lines = fileText.split(/\r?\n/);
    const selection = lines.slice(Math.max(0, start - 1), end).join("\n");

    // budget-aware assembly: a late block is dropped whole before the early
    // ones lose a character, because the order above is the priority
    const blocks: string[] = [];
    let spent = 0;
    const addBlock = (label: string, body: string, cap: number): void => {
      const remaining = PACK_BUDGET_CHARS - spent;
      if (remaining < 200) return;
      const cut = body.length > Math.min(cap, remaining) ? body.slice(0, Math.min(cap, remaining)) : body;
      const block = `${label}\n${cut}`;
      blocks.push(block);
      spent += block.length + 2;
    };

    addBlock(`=== selection ${rel}:${start}-${end} ===`, selection, 2_000);

    if (lines.length <= PACK_WHOLE_FILE_LINES) {
      addBlock(`=== file ${rel} (whole, ${lines.length} lines) ===`, fileText, PACK_BUDGET_CHARS / 2);
    } else {
      const enc = enclosingFunction(lines, start);
      if (enc !== undefined) {
        const from = Math.max(0, enc.start - 4);
        const to = Math.min(lines.length, enc.end + 3);
        addBlock(
          `=== enclosing function ${enc.name} (${rel}:${from + 1}-${to}) ===`,
          lines.slice(from, to).join("\n"),
          PACK_BUDGET_CHARS / 2,
        );
      } else {
        const from = Math.max(0, start - 1 - PACK_WINDOW_PAD_LINES);
        const to = Math.min(lines.length, end + PACK_WINDOW_PAD_LINES);
        addBlock(
          `=== file ${rel} (lines ${from + 1}-${to} of ${lines.length}; the selection sits inside) ===`,
          lines.slice(from, to).join("\n"),
          PACK_BUDGET_CHARS / 3,
        );
      }
    }

    // the symbols the selection actually uses: calls, plus imported names that
    // appear in it -- their definitions open, never a whole neighbour file.
    // php names its neighbours in use statements instead of imports.
    const imports = collectImports(fileText);
    const symbols = [...calleeNames(selection)];
    const wordIn = (name: string): boolean =>
      new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(selection);
    for (const imp of imports) {
      for (const name of imp.names) {
        if (!symbols.includes(name) && wordIn(name)) symbols.push(name);
      }
    }
    const php = rel.endsWith(".php");
    const phpUses = php ? collectPhpUses(fileText) : [];
    for (const use of phpUses) {
      if (!symbols.includes(use.name) && wordIn(use.name)) symbols.push(use.name);
    }

    const neighbor = defaultTeachNeighbor(full);
    const phpResolved: Array<{ path: string; content: string }> = [];
    let defs = 0;
    for (const name of symbols) {
      if (defs >= PACK_DEF_MAX) break;
      const inFile = findDefinitionInText(name, fileText);
      if (inFile !== undefined) {
        const from = Math.max(0, inFile.line - 2);
        const body = `${inFile.jsdoc !== undefined ? `${inFile.jsdoc}\n` : ""}${lines.slice(from, inFile.line + 6).join("\n")}`;
        addBlock(`=== definition ${name} (${rel}:${inFile.line}) ===`, body, PACK_DEF_CHARS);
        defs += 1;
        continue;
      }
      const imp = imports.find((i) => i.names.includes(name));
      if (imp !== undefined && isRelativeSpecifier(imp.specifier)) {
        const neighborRel = resolveRelativePath(full, imp.specifier);
        const content = readNeighborFile(neighbor, neighborRel);
        if (content === undefined) continue;
        const found = findDefinitionInText(name, content);
        if (found === undefined) continue;
        const neighborLines = content.split(/\r?\n/);
        const from = Math.max(0, found.line - 2);
        const body = `${found.jsdoc !== undefined ? `${found.jsdoc}\n` : ""}${neighborLines.slice(from, found.line + 6).join("\n")}`;
        addBlock(`=== definition ${name} (${neighborRel}:${found.line}) ===`, body, PACK_DEF_CHARS);
        defs += 1;
        continue;
      }
      if (php) {
        const use = phpUses.find((u) => u.name === name);
        if (use === undefined) continue;
        const resolved = resolvePhpClass(full, use.fqcn);
        if (resolved === undefined) continue;
        phpResolved.push(resolved);
        const def = phpDefinition(name, resolved.content);
        if (def === undefined) continue;
        const phpLines = resolved.content.split(/\r?\n/);
        const from = Math.max(0, def.line - 2);
        addBlock(
          `=== definition ${name} (${resolved.path}:${def.line}) ===`,
          phpLines.slice(from, def.line + 8).join("\n"),
          PACK_DEF_CHARS,
        );
        defs += 1;
      }
    }

    // php member calls name methods; their definitions sit in this file or in
    // a class a use statement already resolved above
    if (php) {
      const methodRe = /(?:->|::)\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
      const methods: string[] = [];
      let mm: RegExpExecArray | null;
      while ((mm = methodRe.exec(selection)) !== null) {
        const name = mm[1] ?? "";
        if (!methods.includes(name)) methods.push(name);
      }
      for (const method of methods) {
        if (defs >= PACK_DEF_MAX) break;
        const inFile = phpDefinition(method, fileText);
        if (inFile !== undefined) {
          const from = Math.max(0, inFile.line - 2);
          addBlock(`=== definition ${method} (${rel}:${inFile.line}) ===`, lines.slice(from, inFile.line + 8).join("\n"), PACK_DEF_CHARS);
          defs += 1;
          continue;
        }
        for (const f of phpResolved) {
          const def = phpDefinition(method, f.content);
          if (def === undefined) continue;
          const phpLines = f.content.split(/\r?\n/);
          const from = Math.max(0, def.line - 2);
          addBlock(`=== definition ${method} (${f.path}:${def.line}) ===`, phpLines.slice(from, def.line + 8).join("\n"), PACK_DEF_CHARS);
          defs += 1;
          break;
        }
      }
    }

    // the nearest comment above the selection often carries the why verbatim
    const comments: string[] = [];
    for (let i = start - 2; i >= Math.max(0, start - 11); i -= 1) {
      const trimmed = (lines[i] ?? "").trim();
      if (trimmed.length === 0) continue;
      if (!/^\s*(\/\/|\/\*|\*|#)/.test(lines[i] ?? "")) break;
      comments.unshift(trimmed);
    }
    if (comments.length > 0) addBlock(`=== comment above the selection ===`, comments.join("\n"), 600);

    // tests that name the symbol prove intent; the same-basename file is only
    // the fallback when no test mentions it. The file's own project is scanned
    // first; the launch cwd's test dirs count only when the file lives there.
    if (symbols.length > 0) {
      const dirs = [
        resolve(dirname(full), "..", "..", "src", "test"),
        resolve(dirname(full), "..", "..", "tests"),
        ...(confine(process.cwd(), full) !== undefined
          ? [resolve(process.cwd(), "src", "test"), resolve(process.cwd(), "tests")]
          : []),
      ];
      let found = 0;
      for (const dir of dirs) {
        if (found >= PACK_TEST_MAX) break;
        let entries: string[] = [];
        try {
          entries = readdirSync(dir).filter((name) => TEST_FILE_RE.test(name));
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (found >= PACK_TEST_MAX) break;
          let content: string;
          try {
            const path = join(dir, entry);
            if (statSync(path).size > 64 * 1024) continue;
            content = readFileSync(path, "utf8");
          } catch {
            continue;
          }
          const testLines = content.split(/\r?\n/);
          for (let i = 0; i < testLines.length; i += 1) {
            const hit = symbols.find((name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(testLines[i] ?? ""));
            if (hit === undefined) continue;
            const from = Math.max(0, i - 3);
            const to = Math.min(testLines.length, i + 4);
            addBlock(
              `=== test ${entry}:${i + 1} mentioning ${hit} ===`,
              testLines.slice(from, to).join("\n"),
              PACK_TEST_CHARS,
            );
            found += 1;
            break;
          }
        }
      }

      if (found === 0) {
        const base = rel.replace(/\\/g, "/").split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
        if (base) {
          for (const cand of [`src/test/${base}.test.ts`, `src/test/${base}.spec.ts`]) {
            const content = neighbor(cand);
            if (content !== undefined) {
              addBlock(`=== test ${cand} ===`, content, PACK_TEST_CHARS);
              break;
            }
          }
        }
      }
    }

    const first = gitFirstTouch(rel, Math.max(1, start), Math.max(1, end));
    if (first !== undefined) addBlock("=== git ===", `first touched in ${first.commit}: ${first.subject}`, 300);

    return blocks.join("\n\n");
  } catch {
    return "";
  }
}

function loadTeachSpec(lang: "id" | "en"): string {
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

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

/** Applied to every response: no store, no sniff, no referrer, no CORS at all. */
function baseHeaders(type: string): Record<string, string> {
  return {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, baseHeaders("application/json; charset=utf-8"));
  response.end(JSON.stringify(body));
}

/** 403 carries no detail: a prober learns nothing from which check failed. */
function forbid(response: ServerResponse): void {
  response.writeHead(403, baseHeaders("text/plain; charset=utf-8"));
  response.end("no");
}

/** Blocks DNS rebinding: a foreign name resolving here still fails the check. */
function hostAllowed(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/**
 * A path input may be read two ways: it sits inside the repo the server was
 * launched in, or memory already names it. The dash lists exactly what memory
 * names, so refusing such a read only breaks the page when rocky was launched
 * outside that file's tree.
 *
 * The comparison is case-insensitive on Windows because the filesystem is:
 * memory canonicalises paths to lower case, so a case-sensitive prefix test
 * refused the repo's own files and the page reported hearing nothing.
 */
function confine(root: string, candidate: string): string | undefined {
  const full = resolve(root, candidate);
  const fold = (value: string): string => (process.platform === "win32" ? value.toLowerCase() : value);
  const inside = fold(full) === fold(root) || fold(full).startsWith(fold(root) + sep);
  return inside ? full : undefined;
}

/** Memory already discloses these paths to the page, so reading one leaks nothing new. */
function witnessed(candidate: string): string | undefined {
  const norm = candidate.replace(/\\/g, "/");
  const heard = fileIndex(records().list).some((file) => file.path === norm);
  return heard ? norm : undefined;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function records(): { list: ReturnType<typeof loadMemoryChecked>["records"]; reason: string | undefined } {
  const loaded = loadMemoryChecked();
  // an incomplete read is disclosed, never passed off as full coverage
  const reason = loaded.coverage?.complete === false ? loaded.coverage.reason : undefined;
  return { list: loaded.records, reason };
}

const ago = (ts: number, now: number): string => {
  const delta = Math.max(0, now - ts);
  if (delta >= 86_400_000) return `${Math.floor(delta / 86_400_000)}d ago`;
  if (delta >= 3_600_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 60_000)}m ago`;
};

/** One moment as the GUI reads it: identity, labels, and its diff if any. */
function momentsFor(path: string, root: string, now: number) {
  const entry = fileIndex(records().list).find((file) => file.path === path);
  if (entry === undefined) return { changes: [], unattributed: [] };
  const flat = entry.recs.map((rec, index) => {
    const diff = getCachedDiff(path, rec, defaultDiffIo) ?? undefined;
    return {
      id: `${rec.ts}-${index}`,
      kind: rec.kind,
      source: rec.source,
      ts: rec.ts,
      ago: ago(rec.ts, now),
      machine: rec.machine,
      reason: rec.reason,
      summary: rec.summary,
      excerpt: rec.excerpt,
      intent: rec.intent,
      diff,
    };
  });
  return groupMomentsByChange(flat);
}

/** Flat moment list recovered from grouped output: compare, strict, and the
 *  picker need per-moment granularity with diffs intact. */
function flatMoments(grouped: ReturnType<typeof momentsFor>) {
  return [...grouped.changes.flatMap((c) => c.witnesses), ...grouped.unattributed];
}

/**
 * The one cap and the one redaction every prompt leaving this machine goes
 * through: a selected line can carry a key, and the provider must never see
 * it. Callers own the prompt's content; this owns what may cross.
 */
function boundedPrompt(text: string): string {
  const bounded = text.length > MAX_PROMPT_CHARS ? `${text.slice(0, MAX_PROMPT_CHARS)}\n… cut, prompt long` : text;
  return redactSecretsAtBoundary(bounded);
}

/** Provider JSON is untrusted input: read one field, keep it `unknown`. */
function objectField(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

function stringField(value: unknown, key: string): string | undefined {
  const field = objectField(value, key);
  return typeof field === "string" ? field : undefined;
}

/** Anthropic answers `content[0].text`; OpenAI-compatible answers `choices[0].message.content`. */
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

type ProviderOutcome =
  | { kind: "text"; text: string }
  | { kind: "refused"; status: number; error: string }
  | { kind: "failed"; error: unknown; timedOut: boolean };

/**
 * The single provider request: OpenAI-compatible hosts and Anthropic differ
 * only in header and body shape. endpoint, model and key all come off disk —
 * the page never holds the secret — and the in-flight count is the existing
 * ask budget, so the code phase and `/api/ask` share one ceiling.
 */
async function requestProvider(prompt: string): Promise<ProviderOutcome> {
  const stored = readSettings();
  const endpoint = stored.endpoint;
  const key = stored.key;
  const model = stored.model;
  if (!endpoint || !key || !model) {
    return { kind: "refused", status: 400, error: "rocky need endpoint, key, model in settings first" };
  }
  if (askInFlight >= MAX_ASK_IN_FLIGHT) {
    return { kind: "refused", status: 429, error: "rocky already asking. wait, question" };
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

/** Forwards one prompt to the provider the page names. When the page names
 *  the file its question is about, rocky digs first and quotes what it found:
 *  the model explains evidence, it does not have to imagine code. */
async function ask(body: Record<string, unknown>, root: string): Promise<{ status: number; payload: unknown }> {
  const raw = String(body.prompt ?? "");
  if (!raw) {
    return { status: 400, payload: { error: "rocky need endpoint, key, model in settings first" } };
  }

  // the dig: whole file, imported neighbours, sibling test, first git touch --
  // the same boundary as any other read, then redacted like the prompt itself
  let pack = "";
  const rel = typeof body.path === "string" ? body.path : "";
  if (rel) {
    const full = confine(root, rel) ?? witnessed(rel);
    if (full !== undefined) {
      const start = Number(body.start ?? 1);
      const end = Number(body.end ?? start);
      const dug = evidencePack(full, rel, start, end);
      if (dug) pack = `\n\nEVIDENCE ROCKY GATHERED (quote only from this):\n${redactSecretsAtBoundary(dug)}`;
    }
  }

  // the rules ride here, not in the page, so a browser cannot drop them
  const prompt = `${TEACH_ENV}\n\n${loadTeachSpec(readSettings().lang)}\n\n---\n\n${boundedPrompt(raw)}${pack}`;
  const outcome = await requestProvider(prompt);
  if (outcome.kind === "text") return { status: 200, payload: { text: outcome.text } };
  if (outcome.kind === "refused") return { status: outcome.status, payload: { error: outcome.error } };
  // a transport failure stays a failure: the route's 500 contract is unchanged
  throw outcome.error;
}

async function serveAsset(pathname: string, response: ServerResponse): Promise<void> {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/assets\//, "");
  const full = confine(ASSET_ROOT, rel);
  if (full === undefined) return forbid(response);
  try {
    const body = await readFile(full);
    response.writeHead(200, baseHeaders(TYPES[extname(full)] ?? "application/octet-stream"));
    response.end(body);
  } catch {
    response.writeHead(404, baseHeaders("text/plain; charset=utf-8")).end("no");
  }
}

async function computeBundles(q = "", repoFilter: string | null = null): Promise<{ bundles: unknown[]; unattributed: number }> {
  const { list } = records();
  const lastRec = list[list.length - 1];
  const cacheKey = `${list.length}:${lastRec ? lastRec.ts : 0}:${q}:${repoFilter ?? ""}`;
  if (bundleCache && bundleCache.key === cacheKey) {
    return bundleCache.payload;
  }
  if (bundleInFlight && bundleInFlight.key === cacheKey) {
    return bundleInFlight.promise;
  }
  const promise = (async () => {
    const files = fileIndex(list);
    const shown = filteredFiles({ files, fquery: q });
    const repos: RepoCache = new Map();
    const inputs: BundleInput[] = [];
    for (const file of shown) {
      const repo = (await repoForPath(file.path, repos)) ?? "";
      if (repoFilter && repo !== repoFilter) continue;
      for (const rec of file.recs) {
        if (!repo) {
          inputs.push({
            path: file.path,
            repo: "",
            rec,
            diff: { rows: [] },
          });
          continue;
        }
        const diff = getCachedDiff(file.path, rec, defaultDiffIo);
        inputs.push({
          path: file.path,
          repo,
          rec,
          diff,
        });
      }
    }
    const result = bundleGroups(inputs);
    const payload = {
      bundles: result.bundles,
      unattributed: result.unattributed.length,
    };
    bundleCache = { key: cacheKey, payload };
    return payload;
  })();

  bundleInFlight = { key: cacheKey, promise };
  try {
    return await promise;
  } finally {
    if (bundleInFlight?.key === cacheKey) {
      bundleInFlight = null;
    }
  }
}

async function handleApi(
  pathname: string,
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
  root: string,
): Promise<void> {
  const now = Date.now();

  if (pathname === "/api/home") {
    const { list, reason } = records();
    return sendJson(response, 200, deriveHome(list, reason, now));
  }

  if (pathname === "/api/files") {
    const files = fileIndex(records().list);
    const q = url.searchParams.get("q") ?? "";
    const shown = filteredFiles({ files, fquery: q });
    // one cache per answer: the dash's files share the same few repo walks
    const repos: RepoCache = new Map();
    return sendJson(response, 200, await Promise.all(shown.map(async (f) => {
      // the newest record names what this file was last heard doing, so the
      // repo filter can card each group with its latest intent and age
      let newest: (typeof f.recs)[number] | undefined;
      for (const rec of f.recs) {
        if (newest === undefined || (rec.ts ?? 0) > (newest.ts ?? 0)) newest = rec;
      }
      const rawLabel = (newest?.summary ?? newest?.reason ?? newest?.excerpt ?? newest?.intent ?? newest?.kind ?? "")
        .replace(/\s+/g, " ")
        .trim();
      const span = newest ? elapsed(Math.max(0, now - (newest.ts ?? 0))) : "";
      return {
        path: f.path,
        count: f.count,
        repo: await repoForPath(f.path, repos),
        last: newest ? {
          label: redactSecretsAtBoundary(rawLabel).slice(0, 140),
          agoText: span === "just now" ? span : `${span} ago`,
          ts: newest.ts ?? 0,
        } : null,
      };
    })));
  }

  if (pathname === "/api/file") {
    const rel = url.searchParams.get("path") ?? "";
    const full = confine(root, rel) ?? witnessed(rel);
    if (full === undefined) return forbid(response);
    try {
      const info = await stat(full);
      if (!info.isFile() || info.size > READ_CAP_BYTES) throw new Error("bounded read miss");
      const raw = (await readFile(full, "utf8")).split(/\r?\n/);
      const capped = raw.length > TEACH_MAX_LINES ? raw.slice(0, TEACH_MAX_LINES) : raw;
      return sendJson(response, 200, { lines: capped, truncated: raw.length > TEACH_MAX_LINES });
    } catch {
      return sendJson(response, 200, { lines: [], missing: true });
    }
  }

  if (pathname === "/api/moments") {
    const rel = url.searchParams.get("path") ?? "";
    const all = flatMoments(momentsFor(rel, root, now));
    if (url.searchParams.get("strict") !== "1") return sendJson(response, 200, all);
    // strict keeps only the moments touching the same lines as the other side
    const near = url.searchParams.get("near");
    const anchor = all.find((m) => m.id === near);
    const related = lineOverlapPredicate(rel);
    const kept = anchor === undefined
      ? all.filter((m) => m.diff !== undefined)
      : all.filter((m) => m.id === anchor.id || related(anchor as never, m as never));
    return sendJson(response, 200, kept);
  }

  if (pathname === "/api/compare") {
    const rel = url.searchParams.get("path") ?? "";
    const a = url.searchParams.get("a");
    const b = url.searchParams.get("b");
    const grouped = momentsFor(rel, root, now);
    if (a === null || b === null) return sendJson(response, 200, grouped);
    const all = flatMoments(grouped);
    const pick = (id: string) => {
      const found = all.find((m) => m.id === id);
      return found ? { record: found, diff: found.diff ?? null } : null;
    };
    return sendJson(response, 200, { A: pick(a), B: pick(b) });
  }

  if (pathname === "/api/bundles") {
    const q = url.searchParams.get("q") ?? "";
    const repoFilter = url.searchParams.get("repo");
    const payload = await computeBundles(q, repoFilter);
    return sendJson(response, 200, payload);
  }

  if (pathname === "/api/bundle") {
    const commit = url.searchParams.get("commit");
    if (!commit || !/^[0-9a-fA-F]{4,128}$/.test(commit)) {
      return sendJson(response, 400, { error: "rocky needs a commit sha, question" });
    }
    const resolved = resolveCommitDiff({ sha: commit, cwd: root });
    if (resolved === undefined) {
      return sendJson(response, 200, null);
    }
    const rows = parsePatch(resolved.diff);
    const byFile = splitRowsByFile(rows);
    const files = Array.from(byFile.entries()).map(([path, fileRows]) => ({ path, rows: fileRows }));
    const total = files.length;
    const capped = files.slice(0, BUNDLE_MAX_FILES);
    const truncated = resolved.truncated || total > BUNDLE_MAX_FILES;
    return sendJson(response, 200, {
      commit: resolved.commit,
      files: capped,
      truncated,
      total,
    });
  }

  if (pathname === "/api/refer") {
    const rel = url.searchParams.get("path");
    if (!rel) {
      return sendJson(response, 400, { error: "rocky needs a file path, question" });
    }
    const full = confine(root, rel) ?? witnessed(rel);
    if (full === undefined) return forbid(response);

    let fileText = "";
    try {
      const info = await stat(full);
      if (!info.isFile() || info.size > READ_CAP_BYTES) return sendJson(response, 200, null);
      const raw = (await readFile(full, "utf8")).split(/\r?\n/);
      const capped = raw.length > TEACH_MAX_LINES ? raw.slice(0, TEACH_MAX_LINES) : raw;
      fileText = capped.join("\n");
    } catch {
      return sendJson(response, 200, null);
    }

    const lineParam = url.searchParams.get("line");
    const line = lineParam !== null && !isNaN(Number(lineParam)) && Number(lineParam) > 0
      ? Math.floor(Number(lineParam))
      : 1;
    const symbolParam = url.searchParams.get("symbol");
    const symbol = symbolParam !== null && symbolParam.trim().length > 0 ? symbolParam.trim() : undefined;

    let targetSymbol = symbol ?? "";
    if (!targetSymbol) {
      const lines = fileText.split(/\r?\n/);
      const lineIndex = line - 1;
      const lineText = lineIndex >= 0 && lineIndex < lines.length ? (lines[lineIndex] ?? "") : "";
      const callees = calleeNames(lineText);
      targetSymbol = callees[0] ?? "";
    }

    const witnesses: ReferWitness[] = [];
    const texts = new Map<string, string>();

    if (targetSymbol.length > 0) {
      const symbolRe = new RegExp(`\\b${escapeRegExp(targetSymbol)}\\b`);
      const { list } = records();
      const files = fileIndex(list);
      let matchedFiles = 0;
      for (const file of files) {
        if (matchedFiles >= 20) break;
        let matchedText: string | undefined;
        for (const rec of file.recs) {
          for (const candidate of [rec.excerpt, rec.reason, rec.intent]) {
            if (typeof candidate === "string" && symbolRe.test(candidate)) {
              matchedText = candidate;
              break;
            }
          }
          if (matchedText !== undefined) break;
        }

        if (matchedText !== undefined) {
          matchedFiles += 1;
          const matchLine = matchedText.split(/\r?\n/).find((l) => symbolRe.test(l)) ?? matchedText;
          witnesses.push({
            path: file.path,
            line: 0,
            text: matchLine.trim(),
          });

          if (texts.size < 10) {
            const neighborFull = confine(root, file.path) ?? witnessed(file.path);
            if (neighborFull !== undefined) {
              try {
                const st = statSync(neighborFull);
                if (st.isFile() && st.size <= 64 * 1024) {
                  texts.set(file.path, readFileSync(neighborFull, "utf8"));
                }
              } catch {
                // fail open
              }
            }
          }
        }
      }
    }

    const result = resolveRefer({
      path: rel,
      fileText,
      line,
      symbol,
      readNeighbor: defaultTeachNeighbor(full),
      texts,
      witnesses,
    });

    if (result.definition !== null) {
      result.definition.text = redactSecretsAtBoundary(result.definition.text);
      if (result.definition.jsdoc !== undefined) {
        result.definition.jsdoc = redactSecretsAtBoundary(result.definition.jsdoc);
      }
    }
    for (const ref of result.references) {
      ref.text = redactSecretsAtBoundary(ref.text);
    }

    return sendJson(response, 200, result);
  }

  if (pathname === "/api/teach" && request.method === "POST") {
    const body = (await readBody(request)) as Record<string, unknown>;
    const rel = String(body.path ?? "");
    let start = Number(body.start ?? 0);
    let end = Number(body.end ?? 0);
    const full = confine(root, rel) ?? witnessed(rel);
    if (full === undefined) return forbid(response);

    const lines = existsSync(full) ? readFileSync(full, "utf8").split(/\r?\n/) : [];
    const snippet = lines.slice(Math.max(0, start - 1), end).join("\n");
    const { list } = records();

    let expanded: { start: number; end: number; why: string } | undefined;
    if (body.expand === 1 && start === end) {
      let rows: DiffRow[] | undefined;
      const commit = typeof body.commit === "string" ? body.commit : "";
      if (/^[0-9a-fA-F]{4,128}$/.test(commit)) {
        const resolved = resolveCommitDiff({ sha: commit, cwd: root });
        if (resolved !== undefined) {
          const parsedRows = parsePatch(resolved.diff);
          const byFile = splitRowsByFile(parsedRows);
          for (const [diffPath, fileRows] of byFile.entries()) {
            if (diffPath === rel || diffPath.endsWith("/" + rel) || rel.endsWith("/" + diffPath)) {
              rows = fileRows;
              break;
            }
          }
        }
      }
      const ctx = resolveContext({
        fileText: lines.join("\n"),
        line: start,
        ...(rows !== undefined ? { rows } : {}),
      });
      start = ctx.start;
      end = ctx.end;
      expanded = { start: ctx.start, end: ctx.end, why: ctx.why };
    }

    const hit = teachLookup(list, { path: rel, snippet, cwd: root });
    const ladder = buildLadder({
      file: rel,
      startLine: start,
      endLine: end,
      fileText: lines.join("\n"),
      readNeighbor: defaultTeachNeighbor(rel),
    });
    if (hit !== undefined) {
      const card = renderWitnessCard(hit, gapRungFor(hit, ladder));
      const base = expanded !== undefined ? { ...card, expanded } : card;
      try {
        // Unified OpenRouter mode shares the main credential with the Jev path;
        // otherwise the active provider path resolves its own slot.
        const teachStored = readSettings();
        const teachUnified = isUnifiedOpenRouterMode(teachStored.provider, teachStored.endpoint);
        const teachSelection = readDecisionSelection();
        const teachProvider = teachUnified ? "openrouter" : teachSelection.jevProvider;
        const teachApiKey = teachUnified
          ? resolveUnifiedOpenRouterKey(process.env, teachStored.key)
          : resolveActiveJevKey(teachSelection.jevProvider, process.env, teachStored.jevKey, teachStored.openRouterKey);
        const trace = await analyzeExplainDecision({
          query: snippet.slice(0, 1000),
          candidates: [{
            ref: hit.record.id,
            kind: "explain",
            snippet: redactSecretsAtBoundary(hit.record.snippet ?? hit.record.code).slice(0, 500),
          }],
        }, { outcome: "teach", provider: teachProvider, apiKey: teachApiKey || undefined });
        if (trace !== undefined) return sendJson(response, 200, { ...base, decision: trace });
      } catch {
        // Analysis is advisory: the witness card stands on its own.
      }
      return sendJson(response, 200, base);
    }
    if (ladder.rungs.length > 0) {
      const card = renderLadderCard(rel, `${start}-${end}`, ladder);
      const payload = { ...card, rungs: renderLadderExpanded(ladder) };
      return sendJson(response, 200, expanded !== undefined ? { ...payload, expanded } : payload);
    }
    return sendJson(response, 200, null);
  }

  if (pathname === "/api/providers") {
    return sendJson(response, 200, await providerList());
  }

  if (pathname === "/api/provider") {
    // an endpoint the catalogue does not know returns nothing, so the page
    // offers no models rather than a wrong list
    const found = await providerFor(url.searchParams.get("endpoint") ?? "");
    return sendJson(response, 200, found ?? null);
  }
  if (pathname === "/api/chat-models") {
    // Model picker backing: the 1 keyed BYOK model named in settings
    // (with its human-friendly catalogue label if available), plus the
    // pinned Jev model of the ACTIVE provider when its key is present.
    // In unified OpenRouter mode the active provider is always
    // openrouter and the shared main credential (env OPENROUTER_API_KEY wins,
    // stored main key falls back) is the only presence signal — the Jev slots
    // are never read. Offline/absent BYOK falls back to Ollama or empty list.
    const stored = readSettings();
    const unified = isUnifiedOpenRouterMode(stored.provider, stored.endpoint);
    const provider = unified ? "openrouter" : readDecisionSelection().jevProvider;
    const byId: Record<string, string> = {};
    if (stored.endpoint.length > 0 && stored.model.length > 0 &&
      chatByokKeyPresent(stored.provider, stored.endpoint, stored.key)) {
      let label = stored.model;
      try {
        const info = await providerFor(stored.endpoint);
        const match = info?.models.find((m) => m.id === stored.model);
        if (match?.name) label = match.name;
      } catch {
        // fallback to model id
      }
      byId[stored.model] = label;
    }
    if (provider === "openrouter") {
      const shared = unified ? resolveUnifiedOpenRouterKey(process.env, stored.key) : resolveOpenRouterKey(process.env, stored.openRouterKey);
      if (shared.length > 0 && byId[JEV_OPENROUTER_MODEL] === undefined) {
        byId[JEV_OPENROUTER_MODEL] = JEV_OPENROUTER_MODEL;
      }
    } else if (resolveJevKey(process.env, stored.jevKey).length > 0 && byId[JEV_MODEL] === undefined) {
      byId[JEV_MODEL] = JEV_MODEL;
    }
    if (Object.keys(byId).length === 0) {
      try {
        const installed = await createOllamaClient().listInstalledModels();
        for (const model of installed) {
          if (model.name.length > 0 && byId[model.name] === undefined) byId[model.name] = model.name;
        }
      } catch {
        // Ollama offline: the picker still offers BYOK/Jev, never an error.
      }
    }
    return sendJson(response, 200, {
      models: Object.entries(byId).map(([id, label]) => ({ id, label })),
    });
  }
  if (pathname === "/api/settings") {
    if (request.method === "POST") {
      const patch = (await readBody(request)) as Record<string, unknown>;
      // The GUI provider selector writes the non-secret choice into config.json
      // (strict allowlist); keys stay in gui.json via writeSettings. A failed
      // provider write keeps the previous public settings so the page can retry.
      const requested = patch.jevProvider;
      if (requested !== undefined) {
        if (requested !== "typesafe" && requested !== "openrouter") {
          return sendJson(response, 400, { error: "unknown jev provider" });
        }
        try {
          const loaded = loadConfig();
          if (loaded.status === "invalid") throw new Error("invalid config");
          const decision = { ...(loaded.config.decision ?? { engine: "heuristic" as const }), jevProvider: requested as "typesafe" | "openrouter" };
          saveConfigAtomic({ ...loaded.config, decision }, loaded.path);
        } catch {
          return sendJson(response, 200, { ...publicSettings(readSettings()), jevProvider: readDecisionSelection().jevProvider });
        }
      }
      const saved = writeSettings(patch);
      return sendJson(response, 200, { ...publicSettings(saved), jevProvider: readDecisionSelection().jevProvider });
    }
    return sendJson(response, 200, { ...publicSettings(readSettings()), jevProvider: readDecisionSelection().jevProvider });
  }

  if (pathname === "/api/ask" && request.method === "POST") {
    const body = (await readBody(request)) as Record<string, unknown>;
    const { status, payload } = await ask(body, root);
    if (status !== 200 || typeof payload !== "object" || payload === null) {
      return sendJson(response, status, payload);
    }
    const record = payload as Record<string, unknown> & { text?: unknown };
    if (typeof record.text !== "string") return sendJson(response, status, payload);
    try {
      const prompt = redactSecretsAtBoundary(String(body.prompt ?? "").slice(0, 1000));
      const hits = searchKnowledge(records().list, { query: prompt, limit: 5 });
      // Unified OpenRouter mode shares the main credential with the Jev path;
      // otherwise the active provider path resolves its own slot.
      const askStored = readSettings();
      const askUnified = isUnifiedOpenRouterMode(askStored.provider, askStored.endpoint);
      const askSelection = readDecisionSelection();
      const askProvider = askUnified ? "openrouter" : askSelection.jevProvider;
      const askApiKey = askUnified
        ? resolveUnifiedOpenRouterKey(process.env, askStored.key)
        : resolveActiveJevKey(askSelection.jevProvider, process.env, askStored.jevKey, askStored.openRouterKey);
      const trace = await analyzeExplainDecision({
        query: prompt,
        candidates: hits.map((hit: { id: string; kind: string; snippet: string }) => ({
          ref: hit.id,
          kind: hit.kind,
          snippet: redactSecretsAtBoundary(hit.snippet).slice(0, 500),
        })),
      }, { outcome: "ask", provider: askProvider, apiKey: askApiKey || undefined });
      if (trace !== undefined) return sendJson(response, status, { ...record, decision: trace });
    } catch {
      // Analysis is advisory: the template answer stands on its own.
    }
    return sendJson(response, status, payload);
  }

  if (pathname === "/api/chat" && request.method === "POST") {
    const body = (await readBody(request)) as Record<string, unknown>;
    const { status, payload } = await chat(body, root);
    return sendJson(response, status, payload);
  }

  if (pathname === "/api/cs-explain") {
    const rel = url.searchParams.get("path") ?? "";
    const start = Number(url.searchParams.get("start") ?? "1");
    const end = Number(url.searchParams.get("end") ?? String(start));
    const full = confine(root, rel) ?? witnessed(rel);
    if (full === undefined) return forbid(response);
    try {
      const info = await stat(full);
      if (!info.isFile() || info.size > READ_CAP_BYTES) return sendJson(response, 200, null);
      const raw = (await readFile(full, "utf8")).split(/\r?\n/);
      const s = Math.max(1, Math.floor(start) || 1);
      const e = Math.max(s, Math.floor(end) || s);
      const snippet = raw.slice(Math.max(0, s - 1), e).join("\n").slice(0, 2000);
      const hit = matchConcepts(`${rel} ${snippet}`).find((h) => (CS_CONCEPT_IDS as readonly string[]).includes(h.concept.id));
      if (hit === undefined) return sendJson(response, 200, null);
      const built = explainFor(hit.concept.id, snippet);
      if (built === undefined) return sendJson(response, 200, null);
      return sendJson(response, 200, {
        conceptId: redactSecretsAtBoundary(built.conceptId),
        definition: redactSecretsAtBoundary(built.definition),
        trace: built.trace.map((l) => redactSecretsAtBoundary(l)),
        check: redactSecretsAtBoundary(built.check),
      });
    } catch {
      return sendJson(response, 200, null);
    }
  }

  response.writeHead(404, baseHeaders("text/plain; charset=utf-8")).end("no");
}

export interface GuiHandle {
  port: number;
  token: string;
  url: string;
  close: () => Promise<void>;
}

/** Starts the surface. Resolves once bound, so the caller can print the URL. */
export function startGui(options: { port?: number; root?: string } = {}): Promise<GuiHandle> {
  const token = randomBytes(16).toString("hex");
  const root = resolve(options.root ?? process.cwd());
  const wanted = options.port ?? DEFAULT_GUI_PORT;
  let boundPort = wanted;
  void computeBundles().catch(() => {});

  const server = createServer((request, response) => {
    void (async () => {
      try {
        const addr = server.address();
        const port = typeof addr === "object" && addr !== null ? addr.port : boundPort;
        if (!hostAllowed(request.headers.host, port)) return forbid(response);
        const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
        const pathname = url.pathname;

        if (pathname.startsWith("/api/")) {
          // the shell and its assets load before any script can send a header,
          // so only the api is token-gated
          if (request.headers["x-rocky-token"] !== token) return forbid(response);
          return await handleApi(pathname, url, request, response, root);
        }
        if (pathname === "/" || pathname.startsWith("/assets/")) {
          return await serveAsset(pathname, response);
        }
        response.writeHead(404, baseHeaders("text/plain; charset=utf-8")).end("no");
      } catch {
        // one bad request never takes the server down with it
        if (!response.headersSent) sendJson(response, 500, { error: "rocky not hear that, question" });
        else response.end();
      }
    })();
  });

  return new Promise((done, fail) => {
    const bind = (port: number, retry: boolean): void => {
      server.once("error", (error: NodeJS.ErrnoException) => {
        // the wanted port being busy is not a failure: take any free one
        if (retry && error.code === "EADDRINUSE") return bind(0, false);
        fail(error);
      });
      server.listen(port, "127.0.0.1", () => {
        const addr = server.address();
        boundPort = typeof addr === "object" && addr !== null ? addr.port : port;
        done({
          port: boundPort,
          token,
          url: `http://127.0.0.1:${boundPort}/#${token}`,
          close: () =>
            new Promise<void>((shut) => {
              if (typeof (server as any).closeAllConnections === "function") {
                (server as any).closeAllConnections();
              }
              server.close(() => shut());
            }),
        });
      });
    };
    bind(wanted, wanted !== 0);
  });
}
