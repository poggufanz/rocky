/**
 * Chat structuring: the deterministic half of `user -> structure -> Jev`.
 *
 * `buildChatStructure` is the fallback the chat pipeline uses when the LLM
 * structurer's output fails validation: it builds the Jev state straight
 * from the user message plus the already-retrieved Rocky evidence, bounded
 * and redacted like every other Jev state in this package. `validateChatStructure`
 * is the gate in front of it: an LLM structurer may only select from refs
 * Rocky actually retrieved — any invented ref fails the allowlist and the
 * caller falls back to `buildChatStructure` with the status disclosed.
 *
 * Bounds mirror `ai/jev.ts` (query 1000, snippet 500, 10 candidates) so the
 * fallback state always fits the Jev context guard downstream.
 */

import { redactSecretsAtBoundary } from "../core/redact.js";

export interface ChatStructureCandidate {
  ref: string;
  kind: string;
  snippet: string;
}

export interface ChatStructure {
  query: string;
  candidates: ChatStructureCandidate[];
}

export interface ChatEvidenceRef {
  ref: string;
  kind: string;
  snippet: string;
}

const MAX_CANDIDATES = 10;
const MAX_QUERY_CHARS = 1_000;
const MAX_SNIPPET_CHARS = 500;
const MAX_REF_CHARS = 128;
const MAX_KIND_CHARS = 32;
/** Headroom for the `… cut, … long` marker `buildChatStructure` appends. */
const CUT_MARKER_HEADROOM = 32;

/**
 * Deterministic fallback state: no LLM involved, so nothing here can invent
 * evidence. Bounds and redacts exactly like `buildJevState`.
 */
export function buildChatStructure(
  userMessage: string,
  evidence: readonly ChatEvidenceRef[],
): ChatStructure {
  const boundedQuery =
    userMessage.length > MAX_QUERY_CHARS
      ? `${userMessage.slice(0, MAX_QUERY_CHARS)}… cut, query long`
      : userMessage;
  return {
    query: redactSecretsAtBoundary(boundedQuery),
    candidates: evidence.slice(0, MAX_CANDIDATES).map((hit) => {
      const snippet = redactSecretsAtBoundary(String(hit.snippet));
      return {
        ref: String(hit.ref).slice(0, MAX_REF_CHARS),
        kind: String(hit.kind).slice(0, MAX_KIND_CHARS),
        snippet:
          snippet.length > MAX_SNIPPET_CHARS
            ? `${snippet.slice(0, MAX_SNIPPET_CHARS)}… cut, snippet long`
            : snippet,
      };
    }),
  };
}

/**
 * Shape + allowlist gate for LLM structurer output. `allowed` is the exact
 * ref set Rocky retrieved for this message; a candidate naming anything else
 * is an invented ref and the whole structure is rejected. Refs must also be
 * unique — the same evidence twice is a structurer bug, not coverage.
 * Extra top-level keys are ignored; missing or malformed fields reject.
 */
export function validateChatStructure(
  value: unknown,
  allowed: readonly string[] | ReadonlySet<string>,
): value is ChatStructure {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    typeof record.query !== "string" ||
    record.query.length === 0 ||
    record.query.length > MAX_QUERY_CHARS + CUT_MARKER_HEADROOM
  ) {
    return false;
  }
  if (!Array.isArray(record.candidates) || record.candidates.length > MAX_CANDIDATES) return false;
  const allow: ReadonlySet<string> = Array.isArray(allowed)
    ? new Set<string>(allowed as readonly string[])
    : (allowed as ReadonlySet<string>);
  const seen = new Set<string>();
  for (const entry of record.candidates) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
    const candidate = entry as Record<string, unknown>;
    if (
      typeof candidate.ref !== "string" ||
      candidate.ref.length === 0 ||
      candidate.ref.length > MAX_REF_CHARS
    ) {
      return false;
    }
    if (
      typeof candidate.kind !== "string" ||
      candidate.kind.length === 0 ||
      candidate.kind.length > MAX_KIND_CHARS
    ) {
      return false;
    }
    if (
      typeof candidate.snippet !== "string" ||
      candidate.snippet.length === 0 ||
      candidate.snippet.length > MAX_SNIPPET_CHARS + CUT_MARKER_HEADROOM
    ) {
      return false;
    }
    if (!allow.has(candidate.ref)) return false;
    if (seen.has(candidate.ref)) return false;
    seen.add(candidate.ref);
  }
  return true;
}

/**
 * Robust candidate extractor: extracts valid allowed refs from any shape
 * returned by the LLM (objects, arrays, or text) without inventing refs.
 */
export function extractCandidateRefs(
  raw: unknown,
  allowed: readonly string[] | ReadonlySet<string>,
): string[] {
  const allow: ReadonlySet<string> = Array.isArray(allowed)
    ? new Set<string>(allowed as readonly string[])
    : (allowed as ReadonlySet<string>);
  const found: string[] = [];
  const seen = new Set<string>();

  const check = (candidate: unknown) => {
    let ref = "";
    if (typeof candidate === "string") {
      ref = candidate.trim();
    } else if (typeof candidate === "object" && candidate !== null) {
      const obj = candidate as Record<string, unknown>;
      if (typeof obj.ref === "string") ref = obj.ref.trim();
      else if (typeof obj.id === "string") ref = obj.id.trim();
    }
    if (ref.length > 0 && allow.has(ref) && !seen.has(ref) && found.length < MAX_CANDIDATES) {
      seen.add(ref);
      found.push(ref);
    }
  };

  if (Array.isArray(raw)) {
    raw.forEach(check);
  } else if (typeof raw === "object" && raw !== null) {
    const record = raw as Record<string, unknown>;
    if (Array.isArray(record.candidates)) {
      record.candidates.forEach(check);
    } else if (Array.isArray(record.refs)) {
      record.refs.forEach(check);
    } else if (Array.isArray(record.evidence)) {
      record.evidence.forEach(check);
    }
  }

  if (found.length === 0) {
    const str = typeof raw === "string" ? raw : JSON.stringify(raw);
    for (const ref of allow) {
      if (str.includes(ref) && !seen.has(ref) && found.length < MAX_CANDIDATES) {
        seen.add(ref);
        found.push(ref);
      }
    }
  }

  return found;
}
