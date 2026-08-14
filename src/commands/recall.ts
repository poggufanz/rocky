/**
 * `rocky recall "<query>"`
 *
 * Ask Rocky's memory directly. Fuzzy-matches the query against every
 * remembered failure (command + error signature) and shows the best hits
 * with their fixes, newest context first.
 */

import { createOllamaClient } from "../ai/ollama.js";
import { type AiAct, type AiStatus, type RecallWithAiPort } from "../ai/port.js";
import { createRecallAiPort, formatModelExplanation, singleFlightRecallAi } from "../ai/recall-ai.js";
import { createMemoryQueries, fixFromElsewhere, type MemoryQueries, type RecallHit } from "../core/memory-query.js";
import { loadMemory } from "../core/memory-read.js";
import { resolveRockyPaths } from "../core/state-paths.js";
import { ago, detail, elapsed, heading, phrase, phraseForAct, say } from "../ui/rocky.js";
import { safeTerminalBlock, safeTerminalLine } from "../ui/sanitize.js";

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

type ValidUsedOutcome = {
  aiStatus: "used";
  rankedCandidateIds: readonly string[];
  act: AiAct;
  evidenceRefs: readonly string[];
  confidence: number;
  explanation: string;
};

type ValidFallbackOutcome = {
  aiStatus: Exclude<AiStatus, "used">;
  rankedCandidateIds: readonly string[];
  act?: AiAct;
  evidenceRefs?: readonly string[];
  confidence?: number;
  explanation?: string;
};

type ValidRecallAiOutcome = ValidUsedOutcome | ValidFallbackOutcome;

const AI_STATUSES: readonly AiStatus[] = [
  "used", "disabled", "unavailable", "model_missing", "timeout", "cancelled",
  "invalid_output", "low_confidence", "busy", "no_hits",
];

function boundedStringArray(value: unknown, maximum: number): value is readonly string[] {
  return Array.isArray(value) && value.length <= maximum && value.every((item) => typeof item === "string");
}

function boundedExplanation(value: unknown): value is string {
  return typeof value === "string" && [...value].length <= 300;
}

function validOptionalFields(candidate: {
  act?: unknown;
  evidenceRefs?: unknown;
  confidence?: unknown;
  explanation?: unknown;
}): boolean {
  return (candidate.act === undefined || isAiAct(candidate.act)) &&
    (candidate.evidenceRefs === undefined || boundedStringArray(candidate.evidenceRefs, 10)) &&
    (candidate.confidence === undefined ||
      (typeof candidate.confidence === "number" && Number.isFinite(candidate.confidence) &&
        candidate.confidence >= 0 && candidate.confidence <= 1)) &&
    (candidate.explanation === undefined || boundedExplanation(candidate.explanation));
}

function isRecallAiOutcome(value: unknown): value is ValidRecallAiOutcome {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as {
    aiStatus?: unknown;
    rankedCandidateIds?: unknown;
    act?: unknown;
    evidenceRefs?: unknown;
    confidence?: unknown;
    explanation?: unknown;
  };
  if (typeof candidate.aiStatus !== "string" || !AI_STATUSES.includes(candidate.aiStatus as AiStatus)) return false;
  if (!boundedStringArray(candidate.rankedCandidateIds, 5) || !validOptionalFields(candidate)) return false;
  if (candidate.aiStatus !== "used") return true;
  return isAiAct(candidate.act) && boundedStringArray(candidate.evidenceRefs, 10) &&
    typeof candidate.confidence === "number" && Number.isFinite(candidate.confidence) &&
    candidate.confidence >= 0.6 && candidate.confidence <= 1 && boundedExplanation(candidate.explanation);
}

function sayAiOutcome(outcome: ValidRecallAiOutcome): void {
  if (outcome.aiStatus === "used") {
    say(phraseForAct(outcome.act));
    detail(safeTerminalBlock(formatModelExplanation(outcome.explanation)));
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
  let hits: RecallHit[];
  try {
    hits = parsed.useAi
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
  } catch {
    say("memory file does not open for me. I answer from nothing.");
    detail(`    memory: ${resolveRockyPaths().memory}`);
    return 1;
  }

  let displayed = hits;
  let outcome: ValidRecallAiOutcome | undefined;
  if (parsed.useAi) {
    try {
      const result: unknown = await deps.recallWithAi.run({ query, hits, exposure: "raw" }, new AbortController().signal);
      outcome = isRecallAiOutcome(result)
        ? result
        : { aiStatus: "invalid_output", rankedCandidateIds: [] };
    } catch {
      outcome = { aiStatus: "unavailable", rankedCandidateIds: [] };
    }
    if (outcome.aiStatus === "used") displayed = deterministicOrder(hits, outcome.rankedCandidateIds);
  }

  say(`I remember ${hits.length} thing${hits.length === 1 ? "" : "s"}.`);
  if (outcome !== undefined) sayAiOutcome(outcome);
  for (const [i, hit] of displayed.entries()) {
    heading(`${i + 1}. ${safeTerminalLine(hit.failure.cmd)}   (${ago(hit.failure.ts)}, exit ${hit.failure.exitCode})`);
    detail(indent(safeTerminalBlock(hit.failure.excerpt)));
    if (hit.fix) {
      say(`fixed with: ${safeTerminalLine(hit.fix.cmd)}`);
      const elsewhere = fixFromElsewhere(hit.fix, hit.failure.cwd);
      if (elsewhere !== undefined) {
        say("but fix comes from other place.");
        detail(`place: ${safeTerminalLine(elsewhere)}`);
        say("possible only. check, question");
      } else {
        const link = hit.fix.links?.find((candidate) => candidate.id === hit.failure.id);
        if (link) {
          const span = elapsed(hit.fix.ts - hit.failure.ts);
          say(link.basis === "identity" || link.basis === "signature"
            ? `same command, ${span} later. strong.`
            : `same program, ${span} later. maybe not fix. check, question`);
        }
      }
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
