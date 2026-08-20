/**
 * `rocky concepts` — list concepts heard in memory with counts and active
 * aliases; `rocky concept <id>` — reverse lookup, newest-first evidence;
 * `rocky concept alias [--retract] "<phrase>" <id>` — teach or retract one
 * phrase -> concept alias (append-only `alias` record).
 */

import { CONCEPTS } from "../core/concepts.js";
import { activeAliases, buildConceptIndex } from "../core/concept-index.js";
import { recordAlias } from "../core/memory.js";
import { isCompleteMemoryCoverage, loadMemoryChecked, type MemoryCoverage } from "../core/memory-read.js";
import { ago, detail, heading, say } from "../ui/rocky.js";

function knownConcept(id: string): boolean {
  return CONCEPTS.some((concept) => concept.id === id);
}

function refuseUnknown(): number {
  say("concept not known. rocky knows: " + CONCEPTS.map((concept) => concept.id).join(", "));
  return 1;
}

function coverageIncomplete(value: MemoryCoverage | undefined): boolean {
  return value !== undefined && !isCompleteMemoryCoverage(value);
}

function coverageLine(value: MemoryCoverage): string {
  return `memory coverage incomplete: version ${value.version}; scanned ${value.scanned}; skipped ${value.skipped}; truncated ${value.truncated}; bytes ${value.bytesScanned}/${value.bytesTotal}${value.reason === undefined ? "" : `; reason ${value.reason}`}`;
}

function aliasCommand(argv: readonly string[]): number {
  const retract = argv.includes("--retract");
  const positional = argv.filter((arg) => arg !== "--retract");
  if (positional.length !== 2) {
    say('alias needs exactly phrase and concept id. rocky concept alias "<phrase>" <id>. try again, question');
    return 2;
  }
  const [phrase, conceptId] = positional;
  if (!knownConcept(conceptId)) return refuseUnknown();
  if (phrase.trim().length < 2) {
    say("alias phrase too short. two letters minimum, else I hear noise. try again, question");
    return 2;
  }
  try {
    recordAlias({ alias: phrase, concept: conceptId, action: retract ? "retract" : "add" });
  } catch (error) {
    say("memory file does not open for me. alias not written.");
    detail(`    reason: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  say(retract ? "alias retracted. I forget phrase, concept stays." : "alias remembered. good good.");
  return 0;
}

function listConcepts(): number {
  const loaded = loadMemoryChecked();
  const records = loaded.records;
  const index = buildConceptIndex(records);
  const aliases = activeAliases(records);
  if (index.counts.size === 0 && aliases.size === 0) {
    if (coverageIncomplete(loaded.coverage)) {
      say("memory coverage incomplete. I cannot say nothing heard. check, question");
      detail(coverageLine(loaded.coverage));
      return 0;
    }
    say("no concepts heard yet. memory grows, concepts come.");
    return 0;
  }
  heading("concepts");
  const entries = [...index.counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [id, count] of entries) {
    if (count > 0) detail(`${id}  heard ${count} times`);
  }
  if (aliases.size > 0) {
    heading("aliases");
    for (const [phrase, conceptId] of [...aliases.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      detail(`${phrase}  ->  ${conceptId}`);
    }
  }
  if (coverageIncomplete(loaded.coverage)) detail(coverageLine(loaded.coverage));
  return 0;
}

function reverseLookup(conceptId: string): number {
  if (!knownConcept(conceptId)) return refuseUnknown();
  const loaded = loadMemoryChecked();
  const index = buildConceptIndex(loaded.records);
  const evidence = index.evidence.get(conceptId) ?? [];
  if (evidence.length === 0) {
    if (coverageIncomplete(loaded.coverage)) {
      say(`concept ${conceptId} known. memory coverage incomplete, I cannot say nothing heard. check, question`);
      detail(coverageLine(loaded.coverage));
      return 0;
    }
    say(`concept ${conceptId} known, nothing heard yet. memory grows, evidence comes.`);
    return 0;
  }
  heading(conceptId);
  for (const entry of evidence) {
    detail(`${ago(entry.ts)}  ${entry.kind}  ${entry.snippet}`);
  }
  if (coverageIncomplete(loaded.coverage)) detail(coverageLine(loaded.coverage));
  return 0;
}

export function conceptsCommand(argv: readonly string[]): number {
  if (argv[0] === "alias") return aliasCommand(argv.slice(1));
  if (argv.length === 0) return listConcepts();
  if (argv.length === 1) return reverseLookup(argv[0]);
  say("concepts takes nothing, one concept id, or alias. try again, question");
  return 2;
}
