/**
 * `rocky recall "<query>"`
 *
 * Ask rocky's memory directly. Fuzzy-matches the query against every
 * recorded failure (command + error signature) and shows the best hits
 * with their fixes, newest context first.
 */

import { createOllamaClient } from "../ai/ollama.js";
import { type AiAct, type AiStatus, type RecallWithAiPort } from "../ai/port.js";
import { createRecallAiPort, formatModelExplanation, singleFlightRecallAi } from "../ai/recall-ai.js";
import { describeMemoryCoverage } from "../core/coverage.js";
import { createMemoryQueries, fixFromElsewhere, loadDurableMemorySnapshot, queryRecall, queryRecentFailures, type MemoryQueries, type RecallHit } from "../core/memory-query.js";
import { isCompleteMemoryCoverage, linkBasisRank, type MemoryCoverage } from "../core/memory-read.js";
import { resolveRockyPaths } from "../core/state-paths.js";
import { ago, detail, gapSpan, heading, isVerbose, phrase, phraseForAct, say } from "../ui/rocky.js";
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
    memory: createMemoryQueries(),
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

const MEMORY_EMPTY_LINE = "Memory is empty. No errors recorded yet.";
const NO_MATCH_LINE = "No match in memory. The error may be new, or the words may differ.";
const NO_MATCH_PARTIAL_LINE = "Memory coverage is incomplete. No match was found, but that does not prove there is none.";

/** Supporting line for a memory read that was not whole: plain words, or the raw counters under ROCKY_VERBOSE=1. */
function coverageDetail(coverage: MemoryCoverage, recordCount: number): string {
  const words = describeMemoryCoverage(coverage, recordCount, { counts: false });
  if (!isVerbose() && words !== undefined) return words;
  return `memory coverage incomplete: version ${coverage.version}, scanned ${coverage.scanned}, skipped ${coverage.skipped}, truncated ${coverage.truncated}, complete ${coverage.complete}${coverage.reason === undefined ? "" : `, reason ${coverage.reason}`}`;
}

export async function recall(argv: readonly string[], dependencies?: RecallDependencies): Promise<number> {
  let parsed: ParsedRecall;
  try {
    parsed = parseRecallArgs(argv);
  } catch (error) {
    say("Invalid option for recall.");
    detail(error instanceof Error ? error.message : "unknown option");
    return 2;
  }

  const { query } = parsed;
  if (!query || query.trim().length === 0) {
    say("No query given. Pass words from the error.");
    return 2;
  }

  const deps = dependencies ?? defaultDependencies();
  let hits: RecallHit[];
  let coverage;
  try {
    const now = Date.now();
    const snapshot = loadDurableMemorySnapshot(deps.memory, now);
    if (snapshot !== undefined) {
      // Single durable load: reuse the paired records+coverage for recall and
      // the empty-memory check instead of a second full load on the miss path.
      hits = parsed.useAi
        ? queryRecall(snapshot.records, { query, limit: 5, now }).slice(0, 5)
        : queryRecall(snapshot.records, { query, now });
      coverage = snapshot.coverage;
      if (coverage !== undefined && !isCompleteMemoryCoverage(coverage)) {
        detail(coverageDetail(coverage, snapshot.records.length));
      }
      if (hits.length === 0) {
        if (coverage !== undefined && !isCompleteMemoryCoverage(coverage)) {
          say(NO_MATCH_PARTIAL_LINE);
          return 1;
        }
        if (queryRecentFailures(snapshot.records, { limit: 1, now }).length === 0) {
          say(MEMORY_EMPTY_LINE);
          return 0;
        }
        say(NO_MATCH_LINE);
        return 1;
      }
    } else {
      hits = parsed.useAi
        ? deps.memory.recall({ query, limit: 5 }).slice(0, 5)
        : deps.memory.recall({ query });
      try { coverage = deps.memory.coverage?.(); } catch { coverage = undefined; }
      if (coverage !== undefined && !isCompleteMemoryCoverage(coverage)) {
        // A custom provider reports coverage without the records it read, so the
        // nearest count is the lines it scanned less the ones it could not use.
        detail(coverageDetail(coverage, Math.max(0, coverage.scanned - coverage.skipped)));
      }
      if (hits.length === 0) {
        if (coverage !== undefined && !isCompleteMemoryCoverage(coverage)) {
          say(NO_MATCH_PARTIAL_LINE);
          return 1;
        }
        if (deps.memory.recentFailures({ limit: 1 }).length === 0) {
          say(MEMORY_EMPTY_LINE);
          return 0;
        }
        say(NO_MATCH_LINE);
        return 1;
      }
    }
  } catch {
    say("Memory file could not be opened. No records were read.");
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

  say(`Found ${hits.length} match${hits.length === 1 ? "" : "es"} in memory.`);
  if (outcome !== undefined) sayAiOutcome(outcome);
  for (const [i, hit] of displayed.entries()) {
    heading(`${i + 1}. ${safeTerminalLine(hit.failure.cmd)}   (${ago(hit.failure.ts)}, exit ${hit.failure.exitCode})`);
    detail(indent(safeTerminalBlock(hit.failure.excerpt)));
    if (hit.fix) {
      say(`Resolved. The command passed again: ${safeTerminalLine(hit.fix.cmd)}`);
      const elsewhere = fixFromElsewhere(hit.fix, hit.failure.cwd);
      if (elsewhere !== undefined) {
        say("But that fix comes from a different directory.");
        detail(`place: ${safeTerminalLine(elsewhere)}`);
        say("Possible only. Check before acting.");
      } else {
        const link = hit.fix.links?.find((candidate) => candidate.id === hit.failure.id);
        if (link) {
          const span = gapSpan(hit.fix.ts - hit.failure.ts);
          if (link.basis === "identity" || link.basis === "signature") {
            say(`Same command, ${span} later. Strong link.`);
          } else if (link.basis === "program") {
            say(`Same program, ${span} later. May not be the fix. Check before acting.`);
          } else {
            // A recognized-but-weaker basis ("sequence") or a string this
            // reader does not recognize yet must never grade as
            // "same program" — that overstates evidence it doesn't have.
            say(`Different program, ${span} later. May not be the fix. Check before acting.`);
          }
        }
      }
    } else if (hit.possible) {
      // Weak candidate shown as a separate line below the hit; it never
      // reorders results and never appears beside a confirmed fix.
      say("No confirmed fix. After that error, you ran:");
      detail(`    ${safeTerminalLine(hit.possible.cmd)}`);
      if (hit.possible.fromElsewhere) {
        say("But that command comes from a different directory.");
        detail(`    place: ${safeTerminalLine(hit.possible.cwd)}`);
      }
      say(linkBasisRank(hit.possible.basis) > linkBasisRank("program")
        ? "Different program. It may or may not be a fix. Check before acting."
        : "It may or may not be a fix. Check before acting.");
    } else {
      say("No fix recorded for this failure.");
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
