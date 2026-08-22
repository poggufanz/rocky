import { loadMemoryChecked, type MemoryRecord } from "../../core/memory-read.js";
import { isAgentEnvelopeText } from "../../core/envelope.js";
import { tokens, similarity } from "../../core/fingerprint.js";
import { redactSecretsAtBoundary } from "../../core/redact.js";
import type { BadgeId, DashRow } from "./state.js";

const BADGE_BY_KIND: Record<string, BadgeId> = {
  failure: "fail",
  fix: "fix",
  association: "fix",
  triple: "why",
  rationale: "why",
  note: "why",
  alias: "why",
  brief_run: "why",
  invariant_touch: "guard",
};

/** A field that may be a plain string or a nested `{ text }` object (triples nest intent/rationale that way). */
function fieldText(value: unknown): string | undefined {
  if (typeof value === "string" && value !== "") return value;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const text = (value as Record<string, unknown>).text;
    if (typeof text === "string" && text !== "") return text;
  }
  return undefined;
}

export function labelFor(record: MemoryRecord): string {
  const value = record as unknown as Record<string, unknown>;
  // Step 0 of the retrieval-quality spec: an agent-envelope intent is
  // machinery, not a usable label — skip it so the label falls back to the
  // next field. The record's full JSON detail view stays unfiltered.
  const intentText = fieldText(value.intent);
  const intentLabel = intentText !== undefined && isAgentEnvelopeText(intentText) ? undefined : intentText;
  const raw =
    [value.cmd, value.file, intentLabel, fieldText(value.rationale), value.excerpt, value.note, value.kind].find(
      (v): v is string => typeof v === "string" && v !== "",
    ) ?? record.kind;
  return redactSecretsAtBoundary(raw);
}

export function loadDashRows(
  memoryPath: string,
  now: number,
): { rows: DashRow[]; coverageLine: string } {
  const loaded = loadMemoryChecked(memoryPath, now);
  const rows = loaded.records
    .map((record, index): DashRow => ({
      id: `${record.kind}:${(record as { id?: string }).id ?? index}`,
      badge: BADGE_BY_KIND[record.kind] ?? "why",
      label: labelFor(record),
      ts: record.ts,
      kind: record.kind,
      json: redactSecretsAtBoundary(JSON.stringify(record, null, 2)),
    }))
    .sort((a, b) => b.ts - a.ts);
  const reason = loaded.coverage.reason;
  const coverageLine =
    reason === undefined ? "coverage full" : `coverage partial (${reason})`;
  return { rows, coverageLine };
}

export function searchRows(rows: DashRow[], query: string): DashRow[] {
  if (query === "") return rows;
  const queryTokens = tokens(query);
  return rows
    .map((row, index) => ({
      row,
      index,
      score: similarity(queryTokens, tokens(row.label)),
    }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((hit) => hit.row);
}
