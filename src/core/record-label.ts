/**
 * One human-readable label for a memory record.
 *
 * Outlived the terminal grid it was written for: the label rule (skip an
 * agent envelope, fall through to the next usable field) is about the record,
 * not about how it was drawn.
 */
import type { MemoryRecord } from "./memory-read.js";
import { isAgentEnvelopeText } from "./envelope.js";
import { tokens, similarity } from "./fingerprint.js";
import { redactSecretsAtBoundary } from "./redact.js";


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
