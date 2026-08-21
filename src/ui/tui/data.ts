import { loadMemoryChecked, type MemoryRecord } from "../../core/memory-read.js";
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

function labelFor(record: MemoryRecord): string {
  const value = record as unknown as Record<string, unknown>;
  const raw =
    [value.cmd, value.file, value.intent, value.note, value.kind].find(
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
