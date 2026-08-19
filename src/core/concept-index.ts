/**
 * Derived concept index over memory records.
 *
 * Pure functions: fold alias add/retract records into the active alias map,
 * and build a conceptId -> evidence index from matchable record text. No IO;
 * callers load memory and pass the record array in.
 */

import { matchConcepts } from "./concepts.js";
import type { MemoryRecord } from "./memory-read.js";

/**
 * Fold `alias` records into the active phrase -> conceptId map. Records are
 * applied oldest-first by `ts`; a `retract` removes the phrase, so the last
 * action on a phrase wins regardless of array order.
 */
export function activeAliases(records: readonly MemoryRecord[]): Map<string, string> {
  const aliases = new Map<string, string>();
  const sorted = records
    .filter((record) => record.kind === "alias")
    .slice()
    .sort((a, b) => a.ts - b.ts);
  for (const record of sorted) {
    if (record.kind !== "alias") continue;
    if (record.action === "add") aliases.set(record.alias, record.concept);
    else aliases.delete(record.alias);
  }
  return aliases;
}

export interface ConceptEvidence {
  conceptId: string;
  recordId: string;
  kind: string;
  ts: number;
  snippet: string;
}

export interface ConceptIndex {
  /** conceptId -> count of distinct records matching it. */
  counts: Map<string, number>;
  /** conceptId -> evidence entries, newest first. */
  evidence: Map<string, ConceptEvidence[]>;
}

const SNIPPET_CHARS = 120;

/** Text a concept match may run on; undefined means the record has none. */
function matchableText(record: MemoryRecord): string | undefined {
  switch (record.kind) {
    case "triple": {
      const parts = [record.intent?.text, record.rationale?.text].filter(
        (part): part is string => typeof part === "string" && part.length > 0,
      );
      return parts.length > 0 ? parts.join("\n") : undefined;
    }
    case "rationale":
      return record.excerpt.length > 0 ? record.excerpt : undefined;
    case "failure":
      return record.signature.length > 0 ? record.signature.join("\n") : undefined;
    default:
      return undefined;
  }
}

/**
 * Build the concept index over records with matchable text. When `sinceTs` is
 * given, records older than it are skipped. Alias records are always folded
 * over the full set so the matcher sees every active alias.
 */
export function buildConceptIndex(records: readonly MemoryRecord[], sinceTs?: number): ConceptIndex {
  const aliases = activeAliases(records);
  const counts = new Map<string, number>();
  const evidence = new Map<string, ConceptEvidence[]>();
  for (const record of records) {
    if (sinceTs !== undefined && record.ts < sinceTs) continue;
    const text = matchableText(record);
    if (text === undefined) continue;
    for (const match of matchConcepts(text, aliases)) {
      const conceptId = match.concept.id;
      counts.set(conceptId, (counts.get(conceptId) ?? 0) + 1);
      const entry: ConceptEvidence = {
        conceptId,
        recordId: record.id,
        kind: record.kind,
        ts: record.ts,
        snippet: text.slice(0, SNIPPET_CHARS),
      };
      const list = evidence.get(conceptId);
      if (list) list.push(entry);
      else evidence.set(conceptId, [entry]);
    }
  }
  for (const list of evidence.values()) {
    list.sort((a, b) => b.ts - a.ts);
  }
  return { counts, evidence };
}
