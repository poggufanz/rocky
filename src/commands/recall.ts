/**
 * `rocky recall "<query>"`
 *
 * Ask Rocky's memory directly. Fuzzy-matches the query against every
 * remembered failure (command + error signature) and shows the best hits
 * with their fixes, newest context first.
 */

import { createOllamaClient } from "../ai/ollama.js";
import { type AiAct, type RecallAiOutcome, type RecallWithAiPort } from "../ai/port.js";
import { createRecallAiPort, formatModelExplanation, singleFlightRecallAi } from "../ai/recall-ai.js";
import { createMemoryQueries, type MemoryQueries, type RecallHit } from "../core/memory-query.js";
import { loadMemory } from "../core/memory-read.js";
import { ago, detail, heading, phrase, phraseForAct, say } from "../ui/rocky.js";

export type ParsedRecall = { useAi: boolean; query: string };

export interface RecallDependencies {
  memory: MemoryQueries;
  recallWithAi: RecallWithAiPort;
}

export function parseRecallArgs(argv: readonly string[]): ParsedRecall {
  let useAi = false;
  let parsingOptions = true;
  const query: string[] = [];

  for (const token of argv) {
    if (parsingOptions && token === "--") {
      parsingOptions = false;
      continue;
    }
    if (parsingOptions && token === "--ai") {
      if (useAi) throw new Error("unknown option: --ai");
      useAi = true;
      continue;
    }
    if (parsingOptions && token.startsWith("--")) throw new Error(`unknown option: ${token}`);
    parsingOptions = false;
    query.push(token);
  }

  return { useAi, query: query.join(" ") };
}

function defaultDependencies(): RecallDependencies {
  return {
    memory: createMemoryQueries(loadMemory),
    recallWithAi: singleFlightRecallAi(createRecallAiPort({ ollama: createOllamaClient() })),
  };
}

function deterministicOrder(hits: readonly RecallHit[], candidateIds: readonly string[]): RecallHit[] {
  const candidates = new Map(hits.map((hit, index) => [`c${index + 1}`, hit]));
  const ordered: RecallHit[] = [];
  const selected = new Set<string>();
  for (const id of candidateIds) {
    const hit = candidates.get(id);
    if (hit !== undefined && !selected.has(id)) {
      ordered.push(hit);
      selected.add(id);
    }
  }
  for (const [index, hit] of hits.entries()) {
    const id = `c${index + 1}`;
    if (!selected.has(id)) ordered.push(hit);
  }
  return ordered;
}

function isAiAct(value: unknown): value is AiAct {
  return value === "known_fix" || value === "unresolved" || value === "ambiguous";
}

function isRecallAiOutcome(value: unknown): value is RecallAiOutcome {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as { aiStatus?: unknown; rankedCandidateIds?: unknown };
  const statuses: readonly RecallAiOutcome["aiStatus"][] = [
    "used", "disabled", "unavailable", "model_missing", "timeout", "cancelled",
    "invalid_output", "low_confidence", "busy", "no_hits",
  ];
  return typeof candidate.aiStatus === "string" && statuses.includes(candidate.aiStatus as RecallAiOutcome["aiStatus"]) &&
    Array.isArray(candidate.rankedCandidateIds) && candidate.rankedCandidateIds.every((id) => typeof id === "string");
}

function sayAiOutcome(outcome: RecallAiOutcome): void {
  if (outcome.aiStatus === "used" && isAiAct(outcome.act)) {
    say(phraseForAct(outcome.act));
    if (typeof outcome.explanation === "string") detail(formatModelExplanation(outcome.explanation));
    return;
  }
  switch (outcome.aiStatus) {
    case "disabled":
      say(phrase("ai-disabled"));
      return;
    case "unavailable":
    case "model_missing":
      say(phrase("ai-unavailable"));
      return;
    case "timeout":
      say(phrase("ai-timeout"));
      return;
    case "busy":
      say(phrase("ai-busy"));
      return;
    default:
      say(phrase("ai-fallback"));
  }
}

export async function recall(argv: readonly string[], dependencies?: RecallDependencies): Promise<number> {
  let parsed: ParsedRecall;
  try {
    parsed = parseRecallArgs(argv);
  } catch (error) {
    say("recall option is wrong. bad bad.");
    detail(error instanceof Error ? error.message : "unknown option");
    return 2;
  }

  const { query } = parsed;
  if (!query || query.trim().length === 0) {
    say("recall what, question. give words from error.");
    return 2;
  }

  const deps = dependencies ?? defaultDependencies();
  const hits = parsed.useAi
    ? deps.memory.recall({ query, limit: 5 }).slice(0, 5)
    : deps.memory.recall({ query });
  if (hits.length === 0) {
    if (deps.memory.recentFailures({ limit: 1 }).length === 0) {
      say("memory is empty. no errors yet. this is good... or you not use me yet, question");
      return 0;
    }
    say("I listen to memory. nothing match. maybe error is new, maybe words are different.");
    return 1;
  }

  let displayed = hits;
  let outcome: RecallAiOutcome | undefined;
  if (parsed.useAi) {
    try {
      const result: unknown = await deps.recallWithAi.run({ query, hits, exposure: "raw" }, new AbortController().signal);
      outcome = isRecallAiOutcome(result)
        ? result
        : { aiStatus: "unavailable", rankedCandidateIds: [] };
    } catch {
      outcome = { aiStatus: "unavailable", rankedCandidateIds: [] };
    }
    if (outcome.aiStatus === "used") displayed = deterministicOrder(hits, outcome.rankedCandidateIds);
  }

  say(`I remember ${hits.length} thing${hits.length === 1 ? "" : "s"}.`);
  if (outcome !== undefined) sayAiOutcome(outcome);
  for (const [i, hit] of displayed.entries()) {
    heading(`${i + 1}. ${hit.failure.cmd}   (${ago(hit.failure.ts)}, exit ${hit.failure.exitCode})`);
    detail(indent(hit.failure.excerpt));
    if (hit.fix) {
      say(`fixed with: ${hit.fix.cmd}`);
    } else {
      say("no fix recorded for this one. bad bad.");
    }
  }
  return 0;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => "    " + l)
    .join("\n");
}
