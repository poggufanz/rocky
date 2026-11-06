/**
 * `rocky concepts` — list concepts matched in memory with counts and active
 * aliases; `rocky concept <id>` — reverse lookup, newest-first evidence;
 * `rocky concept alias [--retract] "<phrase>" <id>` — add or retract one
 * phrase -> concept alias (append-only `alias` record).
 */

import { CONCEPTS } from "../core/concepts.js";
import { activeAliases, buildConceptIndex } from "../core/concept-index.js";
import { describeMemoryCoverage } from "../core/coverage.js";
import { recordAlias } from "../core/memory.js";
import { isCompleteMemoryCoverage, loadMemoryChecked, type MemoryCoverage } from "../core/memory-read.js";
import { CS_CONCEPT_IDS } from "../core/cs-explain.js";
import { ago, detail, heading, isVerbose, say } from "../ui/rocky.js";

/**
 * Plain words for the kinds of record a concept is matched in: the three kinds
 * the concept index holds today. A kind with no entry prints as stored, and
 * ROCKY_VERBOSE=1 prints the stored kind for all of them.
 */
const KIND_WORDS: ReadonlyMap<string, string> = new Map([
  ["triple", "intent"],
  ["rationale", "reason"],
  ["failure", "error"],
]);

function kindWord(kind: string): string {
  return isVerbose() ? kind : KIND_WORDS.get(kind) ?? kind;
}

function knownConcept(id: string): boolean {
  return CONCEPTS.some((concept) => concept.id === id);
}

function refuseUnknown(): number {
  say(`Unknown concept. Known concepts: ${CONCEPTS.map((concept) => concept.id).join(", ")}.`);
  return 1;
}

function coverageIncomplete(value: MemoryCoverage | undefined): boolean {
  return value !== undefined && !isCompleteMemoryCoverage(value);
}

function coverageLine(value: MemoryCoverage, recordCount: number): string {
  const words = describeMemoryCoverage(value, recordCount, { counts: false });
  if (!isVerbose() && words !== undefined) return words;
  return `memory coverage incomplete: version ${value.version}; scanned ${value.scanned}; skipped ${value.skipped}; truncated ${value.truncated}; bytes ${value.bytesScanned}/${value.bytesTotal}${value.reason === undefined ? "" : `; reason ${value.reason}`}`;
}

function recordsWord(count: number): string {
  return `${count} record${count === 1 ? "" : "s"}`;
}

function aliasCommand(argv: readonly string[]): number {
  const retract = argv.includes("--retract");
  const positional = argv.filter((arg) => arg !== "--retract");
  if (positional.length !== 2) {
    say('Alias needs exactly one phrase and one concept id: rocky concept alias "<phrase>" <id>.');
    return 2;
  }
  const [phrase, conceptId] = positional;
  if (!knownConcept(conceptId)) return refuseUnknown();
  if (phrase.trim().length < 2) {
    say("Alias phrase is too short. Use at least two letters; shorter phrases match too much.");
    return 2;
  }
  try {
    recordAlias({ alias: phrase, concept: conceptId, action: retract ? "retract" : "add" });
  } catch (error) {
    say("Memory file could not be opened. Alias not written.");
    detail(`    reason: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  say(retract ? "Alias retracted. The concept itself stays." : "Alias recorded.");
  return 0;
}

function listConcepts(): number {
  const loaded = loadMemoryChecked();
  const records = loaded.records;
  const index = buildConceptIndex(records);
  const aliases = activeAliases(records);
  if (index.counts.size === 0 && aliases.size === 0) {
    if (coverageIncomplete(loaded.coverage)) {
      say("Memory coverage is incomplete, so it is not known whether any concept matched. See the coverage line below.");
      detail(coverageLine(loaded.coverage, records.length));
      return 0;
    }
    say("No concepts matched in memory yet.");
    return 0;
  }
  heading("concepts");
  const entries = [...index.counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [id, count] of entries) {
    if (count > 0) detail(`${id}  matched ${recordsWord(count)}`);
  }
  if (aliases.size > 0) {
    heading("aliases");
    for (const [phrase, conceptId] of [...aliases.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      detail(`${phrase}  ->  ${conceptId}`);
    }
  }
  if (coverageIncomplete(loaded.coverage)) detail(coverageLine(loaded.coverage, records.length));
  return 0;
}

function reverseLookup(conceptId: string): number {
  if (!knownConcept(conceptId)) return refuseUnknown();
  const loaded = loadMemoryChecked();
  const index = buildConceptIndex(loaded.records);
  const evidence = index.evidence.get(conceptId) ?? [];
  if (evidence.length === 0) {
    if (coverageIncomplete(loaded.coverage)) {
      say(`Concept ${conceptId} is known. Memory coverage is incomplete, so it is not known whether any record matches it. See the coverage line below.`);
      detail(coverageLine(loaded.coverage, loaded.records.length));
      return 0;
    }
    say(`Concept ${conceptId} is known. No record matches it yet.`);
    return 0;
  }
  heading(conceptId);
  if ((CS_CONCEPT_IDS as readonly string[]).includes(conceptId)) {
    detail(`cs concept ${conceptId}. Full explanation in rocky dash.`);
  }
  for (const entry of evidence) {
    detail(`${ago(entry.ts)}  ${kindWord(entry.kind)}  ${entry.snippet}`);
  }
  if (coverageIncomplete(loaded.coverage)) detail(coverageLine(loaded.coverage, loaded.records.length));
  return 0;
}

export function conceptsCommand(argv: readonly string[]): number {
  if (argv[0] === "alias") return aliasCommand(argv.slice(1));
  if (argv.length === 0) return listConcepts();
  if (argv.length === 1) return reverseLookup(argv[0]);
  say("The concepts command takes no argument, one concept id, or alias.");
  return 2;
}
