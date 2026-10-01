/**
 * Chat LLM gate for code questions and local-memory rendering.
 *
 * Memory-only chat searches complete local records and never calls BYOK or
 * remote Jev. It may call loopback Ollama only after relevance filtering.
 * Code questions retain BYOK-capable structurer and renderer stages.
 *
 * Active predicate (`isLlmActive`, documented here, single definition):
 * a selected model id — `body.model` when the page names one, else the
 * Settings-stored default — resolves to a servable provider AND its
 * credential is present. API-KEY-FIRST: the keyed BYOK check runs BEFORE
 * the Ollama installed list, so an offline daemon can never mask a keyed
 * model as unavailable:
 * - BYOK (OpenAI / Anthropic / OpenRouter catalogue endpoint, including
 *   unified OpenRouter mode where the shared main key drives both): the
 *   id equals the stored `model`, `endpoint` is set, and the server-side
 *   key for that path is present (unified: env OPENROUTER_API_KEY wins,
 *   stored main `key` falls back; otherwise stored `key`). Missing key =
 *   `missing-key` (stages report `disabled`), never mocked. The Jev slots
 *   (`jevKey`, `openRouterKey`) are never read here — unified mode needs
 *   only the one main key the Settings page writes.
 * - Ollama: the id is in the daemon's installed list (loopback
 *   `/api/tags`). No key exists on this path; reachability + listing IS
 *   the credential. Pure-Ollama ids with an offline daemon = `unavailable`.
 * Anything else — empty selection, unknown id, stale stored model — is
 * inactive with a disclosed reason (`disabled` / `invalid_model` /
 * `unavailable`). With endpoint+model configured, a non-matching id is
 * `invalid_model` even while Ollama is offline. Unknown ids never
 * generate text.
 *
 * TypeSafe mapping: Select-instead-of-generate (the LLM selects refs from
 * the retrieved set, never invents); Verify-and-escalate (every structurer
 * payload passes `validateChatStructure` against the retrieved ref
 * allowlist, every rendered line passes `validateRenderedClaims`; extras
 * are stripped and counted, failures fall back to the deterministic
 * template with the status disclosed). State is the named JSON
 * `{query, candidates[]}`; Noul answers carry no confidence field, so the
 * trace keeps Jev confidence nullable and separate from the LLM trace.
 */

import { createOllamaClient } from "./ollama.js";
import { buildChatStructure, extractCandidateRefs, validateChatStructure, type ChatEvidenceRef, type ChatStructure } from "./chat-structure.js";
import { safeRenderChatText, validateRenderedClaims, type ChatRenderFact } from "./chat-render.js";

export type ChatLlmKind = "ollama" | "byok";

export type ChatLlmInactiveReason = "no-model" | "missing-key" | "invalid_model" | "unavailable";

export interface ChatLlmStored {
  readonly provider: string;
  readonly endpoint: string;
  readonly model: string;
  readonly key: string;
}

export interface ChatLlmSelection {
  /** The single active predicate: true only when id + servable + credential all hold. */
  readonly active: boolean;
  /** Selected id (`body.model` wins, else stored default), or "" when none. */
  readonly modelId: string;
  readonly kind: ChatLlmKind | "none";
  /** BYOK endpoint serving this selection ("" on the Ollama path). */
  readonly endpoint: string;
  /** Disclosed reason while inactive; "ok" while active. */
  readonly reason: "ok" | ChatLlmInactiveReason;
}

export type ChatStructurerStatus =
  | "used"
  | "disabled"
  | "invalid_model"
  | "structurer-fallback"
  | "timeout"
  | "unavailable";

export type ChatRendererStatus =
  | "used"
  | "disabled"
  | "invalid_model"
  | "template"
  | "timeout"
  | "unavailable";

export interface ChatLlmTrace {
  readonly active: boolean;
  readonly model: string;
  readonly structurerStatus: ChatStructurerStatus | string;
  readonly rendererStatus: ChatRendererStatus | string;
  readonly stripped: number;
}

export const CHAT_LLM_TIMEOUT_MS = 30_000;
const CHAT_STRUCTURER_MAX_TOKENS = 2048;
const CHAT_RENDERER_MAX_TOKENS = 2048;

function cleanId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function unifiedKeyPresent(env: NodeJS.ProcessEnv, storedMainKey: string): boolean {
  const fromEnv = typeof env.OPENROUTER_API_KEY === "string" ? env.OPENROUTER_API_KEY : "";
  if (fromEnv.length > 0) return true;
  return storedMainKey.length > 0;
}

function isUnifiedProvider(provider: string, endpoint: string): boolean {
  if (provider === "openrouter") return true;
  return endpoint.toLowerCase().includes("openrouter.ai");
}

/**
 * Shared key-presence predicate for the chat LLM path: unified OpenRouter
 * mode reads env OPENROUTER_API_KEY first, stored main `key` second;
 * every other provider reads the stored main `key` only. The Jev slots
 * (`jevKey`, `openRouterKey`) are never read here. `/api/chat-models` uses
 * this same function so the picker and the chat resolver cannot drift.
 */
export function chatByokKeyPresent(provider: string, endpoint: string, key: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (isUnifiedProvider(provider, endpoint)) return unifiedKeyPresent(env, key);
  return key.length > 0;
}

/**
 * Pure resolver behind `isLlmActive`. `installed` is the Ollama installed
 * name list, or `undefined` when the loopback daemon is offline/unknown.
 * No network here, so the predicate matrix is unit-testable.
 */
export function resolveChatLlmSelection(args: {
  readonly requestedModel?: unknown;
  readonly stored: ChatLlmStored;
  readonly installed: readonly string[] | undefined;
  readonly env?: NodeJS.ProcessEnv;
}): ChatLlmSelection {
  const env = args.env ?? process.env;
  const requested = cleanId(args.requestedModel);
  const storedModel = cleanId(args.stored.model);
  const storedEndpoint = cleanId(args.stored.endpoint);
  const modelId = requested.length > 0 ? requested : storedModel;
  if (modelId.length === 0) {
    return { active: false, modelId: "", kind: "none", endpoint: "", reason: "no-model" };
  }
  // API-KEY-FIRST (creator order): a keyed BYOK selection never depends on
  // the Ollama daemon. Exact stored.model match + endpoint + the server-side
  // key for this path (unified OpenRouter mode: env OPENROUTER_API_KEY wins,
  // stored main `key` falls back; otherwise stored main `key`) resolves
  // active BEFORE the installed list is consulted, so an offline daemon can
  // never mask a keyed model as unavailable. The Jev slots (`jevKey`,
  // `openRouterKey`) are never read here — unified mode needs only the one
  // main key the Settings page writes.
  if (storedEndpoint.length > 0 && storedModel.length > 0 && modelId === storedModel) {
    const keyPresent = chatByokKeyPresent(args.stored.provider, storedEndpoint, cleanId(args.stored.key), env);
    if (!keyPresent) {
      return { active: false, modelId, kind: "none", endpoint: storedEndpoint, reason: "missing-key" };
    }
    return { active: true, modelId, kind: "byok", endpoint: storedEndpoint, reason: "ok" };
  }
  const installed = args.installed;
  if (installed !== undefined && installed.includes(modelId)) {
    return { active: true, modelId, kind: "ollama", endpoint: "", reason: "ok" };
  }
  // An offline daemon reports `unavailable` only when no keyed BYOK provider
  // exists to judge the id: with endpoint+model configured, a non-matching
  // id is `invalid_model` even while Ollama is offline — the daemon must not
  // mask a wrong id as an outage. Unknown ids never generate text.
  if (installed === undefined && !(storedEndpoint.length > 0 && storedModel.length > 0)) {
    return { active: false, modelId, kind: "none", endpoint: storedEndpoint, reason: "unavailable" };
  }
  return { active: false, modelId, kind: "none", endpoint: storedEndpoint, reason: "invalid_model" };
}

/**
 * The documented LLM-active predicate: the selected id resolves to a
 * servable provider AND its credential is present. `selection.active` is
 * the single source of truth; this wrapper only exists so the predicate
 * has a named, unit-tested entry point.
 */
export function isLlmActive(selection: ChatLlmSelection): boolean {
  return selection.active;
}

export function inactiveToStageStatus(reason: ChatLlmInactiveReason): { structurer: ChatStructurerStatus; renderer: ChatRendererStatus } {
  if (reason === "invalid_model") return { structurer: "invalid_model", renderer: "invalid_model" };
  if (reason === "unavailable") return { structurer: "unavailable", renderer: "unavailable" };
  return { structurer: "disabled", renderer: "disabled" };
}

/** Test-only transport doubles. Production never sets these; tests stub counts here. */
export interface ChatLlmTestDoubles {
  listInstalledModels?: () => Promise<readonly string[]>;
  ollamaStructured?: (model: string, prompt: string, schema: Record<string, unknown>) => Promise<unknown>;
  byokStructured?: (args: { endpoint: string; model: string; key: string; prompt: string; provider: string }) => Promise<unknown>;
  byokText?: (args: { endpoint: string; model: string; key: string; prompt: string; provider: string }) => Promise<string>;
}

let testDoubles: ChatLlmTestDoubles | undefined;

export function __setChatLlmTestDoubles(doubles: ChatLlmTestDoubles | undefined): void {
  testDoubles = doubles;
}

export function __clearChatLlmTestDoubles(): void {
  testDoubles = undefined;
}

export async function listChatInstalledModelNames(): Promise<string[] | undefined> {
  try {
    if (testDoubles?.listInstalledModels !== undefined) {
      return [...(await testDoubles.listInstalledModels())];
    }
    const installed = await createOllamaClient().listInstalledModels();
    return installed.map((model) => model.name);
  } catch {
    return undefined;
  }
}

const CHAT_STRUCTURER_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["query", "candidates"],
  properties: {
    query: { type: "string" },
    candidates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ref", "kind", "snippet"],
        properties: {
          ref: { type: "string" },
          kind: { type: "string" },
          snippet: { type: "string" },
        },
      },
    },
  },
};

const CHAT_RENDER_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["text"],
  properties: { text: { type: "string" } },
};

function structurerSystemPrompt(): string {
  const lines: string[] = [];
  lines.push("You are a strict TypeSafe AI query structurer for Rocky CLI.");
  lines.push("Your task: structure the user's question and select relevant candidate memory records into typed JSON.");
  lines.push("Output format: ONLY valid JSON matching { \"query\": string, \"candidates\": [ { \"ref\": string, \"kind\": string, \"snippet\": string } ] }.");
  lines.push("Rules:");
  lines.push("1. Select ONLY candidate refs that exist in the Allowed Refs list below. Never invent new refs.");
  lines.push("2. Copy kind and snippet verbatim from the provided evidence items.");
  lines.push("3. Do not include markdown fences or any conversational filler outside the JSON.");
  return lines.join("\n");
}

function structurerUserPrompt(query: string, evidence: readonly ChatEvidenceRef[], allowed: readonly string[]): string {
  const lines: string[] = [];
  lines.push(`User Question: ${query}`);
  lines.push(`Allowed Refs: ${allowed.join(", ") || "(none)"}`);
  lines.push("");
  lines.push("Retrieved Evidence Items:");
  evidence.forEach((hit, index) => {
    lines.push(`[${index + 1}] ref: ${hit.ref} | kind: ${hit.kind} | snippet: ${hit.snippet}`);
  });
  lines.push("");
  lines.push("Return JSON structure with the relevant candidates.");
  return lines.join("\n");
}

function rendererSystemPrompt(): string {
  const lines: string[] = [];
  lines.push("You are Rocky's expert reasoning and comprehension assistant in Rocky CLI Dash.");
  lines.push("You help developers understand their project's execution history, errors, successful fixes, and reasoning recorded by Rocky.");
  lines.push("");
  lines.push("Rules for your response:");
  lines.push("1. Direct Answer: Answer only what the user's question asks. Do not turn weakly related history into a summary.");
  lines.push("2. Language Matching: Reply in Bahasa Indonesia if the user asks in Indonesian, or in English if the user asks in English.");
  lines.push("3. Grounded in Evidence: Use ONLY the provided Rocky Memory records and Jev decision facts; do not add outside facts.");
  lines.push("4. Evidence Citations: Cite every factual sentence and each list item with an allowed evidence reference such as [1] or [2].");
  lines.push("5. Relevance: If no supplied record directly answers the question, say Rocky has no matching memory and stop. Do not summarize merely related records.");
  lines.push("6. Clean Human Tone: Avoid raw hash IDs; use numbered citations. The UI displays raw record IDs and snippets in the Thought Process drawer.");
  lines.push("7. Format: Use concise markdown with natural paragraphs, bold terms, and bullets only when useful.");
  lines.push("8. IMPORTANT: Do NOT output raw template tags or debug lines like 'top: ...' or 'detail: ...' or 'renderer: ...'. Speak naturally.");
  return lines.join("\n");
}

function rendererUserPrompt(fact: ChatRenderFact, allowed: readonly string[]): string {
  const lines: string[] = [];
  if (fact.query) {
    lines.push(`User Question: ${fact.query}`);
    lines.push("");
  }

  if (fact.evidence && fact.evidence.length > 0) {
    lines.push(`Rocky Memory Evidence Records (${fact.evidence.length} items):`);
    fact.evidence.forEach((item, i) => {
      lines.push(`[${i + 1}] Type: ${item.kind}\nContext & Details: ${item.snippet}`);
    });
  } else {
    lines.push("Rocky Memory Evidence: (No matching records found in memory)");
  }
  lines.push("");
  lines.push(`Jev Decision Assessment: Engine: ${fact.engine}, Status: ${fact.status}${typeof fact.topScore === "number" ? `, Top Score: ${fact.topScore.toFixed(2)}` : ""}${fact.detail ? `, Detail: ${fact.detail}` : ""}`);
  lines.push("");
  lines.push("Please provide a comprehensive, clear, and friendly narrative explanation to answer the user's question based ONLY on these facts.");
  return lines.join("\n");
}

function timedOut(signal: AbortSignal, error: unknown): boolean {
  if (signal.aborted) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /timed out|timeout|aborted|abort/i.test(message);
}

/**
 * Server-side renderer disclosure: the served text always names the renderer
 * outcome and model (`renderer: <status> (<model>).`), so the dash can show
 * LLM usage without a browser change. The line uses the `renderer: ` template
 * prefix, so it carries no facts and always survives `validateRenderedClaims`.
 */
function withRendererDisclosure(text: string, status: string, modelId: string): string {
  const label = modelId.trim().length > 0 ? modelId.trim() : "no model text";
  const line = `renderer: ${status} (${label}).`;
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim().startsWith("renderer:")) {
      lines[i] = line;
      return lines.join("\n");
    }
  }
  lines.push(line);
  return lines.join("\n");
}

async function byokFetchText(args: {
  endpoint: string;
  model: string;
  key: string;
  systemPrompt?: string;
  prompt: string;
  provider: string;
  maxTokens: number;
  signal: AbortSignal;
}): Promise<string> {
  if (testDoubles?.byokText !== undefined && args.maxTokens === CHAT_RENDERER_MAX_TOKENS) {
    return testDoubles.byokText({ endpoint: args.endpoint, model: args.model, key: args.key, prompt: args.prompt, provider: args.provider });
  }
  const anthropic = args.endpoint.includes("/v1/messages");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (anthropic) {
    headers["x-api-key"] = args.key;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers.Authorization = `Bearer ${args.key}`;
  }
  const payload = anthropic
    ? {
        model: args.model,
        max_tokens: args.maxTokens,
        ...(args.systemPrompt ? { system: args.systemPrompt } : {}),
        messages: [{ role: "user", content: args.prompt }],
      }
    : {
        model: args.model,
        max_tokens: args.maxTokens,
        messages: [
          ...(args.systemPrompt ? [{ role: "system", content: args.systemPrompt }] : []),
          { role: "user", content: args.prompt },
        ],
      };
  const response = await fetch(args.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: args.signal,
  });
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || data === null) throw new Error("provider refused");
  const text = anthropic
    ? (data.content as Array<{ text?: unknown }> | undefined)?.[0]?.text
    : ((data.choices as Array<{ message?: { content?: unknown } }> | undefined)?.[0]?.message?.content);
  if (typeof text !== "string" || text.length === 0) throw new Error("provider returned no text");
  return text;
}

async function byokFetchJson(args: {
  endpoint: string;
  model: string;
  key: string;
  systemPrompt?: string;
  prompt: string;
  provider: string;
  signal: AbortSignal;
}): Promise<unknown> {
  if (testDoubles?.byokStructured !== undefined) {
    return testDoubles.byokStructured({ endpoint: args.endpoint, model: args.model, key: args.key, prompt: args.prompt, provider: args.provider });
  }
  const text = await byokFetchText({ ...args, maxTokens: CHAT_STRUCTURER_MAX_TOKENS });
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  return JSON.parse(cleaned) as unknown;
}

async function ollamaStructured(model: string, prompt: string, schema: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  if (testDoubles?.ollamaStructured !== undefined) {
    return testDoubles.ollamaStructured(model, prompt, schema);
  }
  return createOllamaClient().generateStructured(model, prompt, schema, signal);
}

function resolveByokKey(kind: ChatLlmSelection, stored: ChatLlmStored, env: NodeJS.ProcessEnv): { key: string; provider: string } {
  const provider = stored.provider;
  const endpoint = stored.endpoint;
  if (isUnifiedProvider(provider, endpoint)) {
    const fromEnv = typeof env.OPENROUTER_API_KEY === "string" ? env.OPENROUTER_API_KEY : "";
    return { key: fromEnv.length > 0 ? fromEnv : stored.key, provider };
  }
  return { key: stored.key, provider };
}

export interface ChatStructurerOutcome {
  readonly status: ChatStructurerStatus;
  readonly structure?: ChatStructure;
}

/**
 * Code-question first pass: ask the active model for Jev state JSON, then
 * gate it through the retrieved-ref allowlist. Memory-only requests never
 * call this stage. Failures fall back deterministically with status disclosed.
 */
export async function runChatStructurer(
  selection: ChatLlmSelection,
  userMessage: string,
  evidence: readonly ChatEvidenceRef[],
  stored: ChatLlmStored,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ChatStructurerOutcome> {
  if (!isLlmActive(selection)) {
    return { status: inactiveToStageStatus(selection.reason === "ok" ? "no-model" : selection.reason).structurer };
  }
  const allowed = evidence.map((hit) => hit.ref);
  const sysPrompt = structurerSystemPrompt();
  const userPrompt = structurerUserPrompt(userMessage, evidence, allowed);
  const signal = AbortSignal.timeout(CHAT_LLM_TIMEOUT_MS);
  try {
    let raw: unknown;
    if (selection.kind === "ollama") {
      raw = await ollamaStructured(selection.modelId, `${sysPrompt}\n\n${userPrompt}`, CHAT_STRUCTURER_SCHEMA, signal);
    } else {
      const { key, provider } = resolveByokKey(selection, stored, env);
      if (key.length === 0) return { status: "disabled" };
      raw = await byokFetchJson({ endpoint: selection.endpoint, model: selection.modelId, key, systemPrompt: sysPrompt, prompt: userPrompt, provider, signal });
    }
    const byRef = new Map(evidence.map((hit) => [hit.ref, hit] as const));
    const deterministicQuery = buildChatStructure(userMessage, evidence).query;

    if (validateChatStructure(raw, allowed)) {
      const candidates = raw.candidates.map((candidate) => {
        const source = byRef.get(candidate.ref) as ChatEvidenceRef;
        return { ref: source.ref, kind: source.kind, snippet: source.snippet };
      });
      return { status: "used", structure: { query: deterministicQuery, candidates } };
    }

    const extractedRefs = extractCandidateRefs(raw, allowed);
    if (extractedRefs.length > 0) {
      const candidates = extractedRefs.map((ref) => {
        const source = byRef.get(ref) as ChatEvidenceRef;
        return { ref: source.ref, kind: source.kind, snippet: source.snippet };
      });
      return { status: "used", structure: { query: deterministicQuery, candidates } };
    }

    return { status: "structurer-fallback", structure: buildChatStructure(userMessage, evidence) };
  } catch (error) {
    if (timedOut(signal, error)) {
      return { status: "timeout", structure: buildChatStructure(userMessage, evidence) };
    }
    return { status: "unavailable", structure: buildChatStructure(userMessage, evidence) };
  }
}

export interface ChatRendererOutcome {
  readonly status: ChatRendererStatus;
  readonly text: string;
  readonly stripped: number;
}

/**
 * Rendering pass for code answers and local-memory synthesis. The caller
 * supplies whole code-owned facts; every factual line must cite an allowed
 * ref. Failure degrades to the deterministic template with status disclosed.
 */
export async function runChatRenderer(
  selection: ChatLlmSelection,
  fact: ChatRenderFact,
  allowedRefs: readonly string[] | ReadonlySet<string>,
  stored: ChatLlmStored,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ChatRendererOutcome> {
  const template = withRendererDisclosure(safeRenderChatText(fact), "template", "");
  if (!isLlmActive(selection)) {
    const status = inactiveToStageStatus(selection.reason === "ok" ? "no-model" : selection.reason).renderer;
    return { status, text: withRendererDisclosure(safeRenderChatText(fact), status, selection.modelId), stripped: 0 };
  }
  const allowArray: readonly string[] = Array.isArray(allowedRefs) ? allowedRefs : [...allowedRefs];
  const allowWithIds = [...allowArray, ...allowArray.map((ref) => `q_${ref}`)];
  const sysPrompt = rendererSystemPrompt();
  const userPrompt = rendererUserPrompt(fact, allowArray);
  const signal = AbortSignal.timeout(CHAT_LLM_TIMEOUT_MS);
  try {
    let rawText: string;
    if (selection.kind === "ollama") {
      const raw = await ollamaStructured(selection.modelId, `${sysPrompt}\n\n${userPrompt}`, CHAT_RENDER_SCHEMA, signal);
      const record = raw as Record<string, unknown>;
      rawText = typeof record.text === "string" ? record.text : "";
      if (rawText.length === 0) return { status: "template", text: template, stripped: 0 };
    } else {
      const { key, provider } = resolveByokKey(selection, stored, env);
      if (key.length === 0) return { status: "disabled", text: withRendererDisclosure(safeRenderChatText(fact), "disabled", selection.modelId), stripped: 0 };
      rawText = await byokFetchText({
        endpoint: selection.endpoint,
        model: selection.modelId,
        key,
        systemPrompt: sysPrompt,
        prompt: userPrompt,
        provider,
        maxTokens: CHAT_RENDERER_MAX_TOKENS,
        signal,
      });
    }
    const check = validateRenderedClaims(rawText, allowWithIds);
    if (check.stripped.trim().length === 0) {
      return { status: "template", text: template, stripped: check.dropped };
    }
    return { status: "used", text: withRendererDisclosure(check.stripped, "used", selection.modelId), stripped: check.dropped };
  } catch (error) {
    if (timedOut(signal, error)) {
      return { status: "timeout", text: withRendererDisclosure(safeRenderChatText(fact), "timeout", selection.modelId), stripped: 0 };
    }
    return { status: "unavailable", text: withRendererDisclosure(safeRenderChatText(fact), "unavailable", selection.modelId), stripped: 0 };
  }
}
