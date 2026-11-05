/**
 * Deterministic chat fallback and model-claim validation.
 *
 * The GUI renders evidence cards before answer text. `renderChatText` provides
 * local status text; `chat-llm.ts` supplies model prose. Factual lines,
 * including bullet and numbered items, must cite an allowed record or Jev ref.
 *
 * Answer text says what Rocky heard. The record id, the decision, its detail
 * and the memory coverage line are trace: `renderChatTrace` returns them as
 * separate lines for the drawer that shows how Rocky answered.
 */

export type ChatRenderEngine = "heuristic" | "jev";

export type ChatRenderStatus =
  | "used"
  | "disabled"
  | "unavailable"
  | "timeout"
  | "invalid_output"
  | "low_confidence";

export interface ChatRenderFact {
  readonly query?: string;
  /** The record id: it goes to the trace, never to the answer text. */
  readonly topRef?: string;
  /** What Rocky heard for the top record, as the home list labels it. */
  readonly topLabel?: string;
  readonly topKind?: string;
  /** Top-1 Noul score when a Jev ranking was used, otherwise null/undefined. */
  readonly topScore?: number | null;
  readonly engine: ChatRenderEngine;
  readonly status: ChatRenderStatus;
  readonly evidenceCount: number;
  readonly latencyMs?: number;
  readonly detail?: string;
  /** One plain-words line, set when memory was read incomplete. The trace carries it as given. */
  readonly coverageLine?: string;
  readonly evidence?: readonly { readonly ref: string; readonly kind: string; readonly snippet: string }[];
}

/**
 * Evidence-first render contract for `/api/chat`: the frontend renders
 * these fields in this order. Existing field names are unchanged.
 */
export const CHAT_RENDER_ORDER = ["evidenceCards", "text", "decisionTrace"] as const;

/** Raw template: what a renderer failure degrades to, never a retry-guess. */
export const RAW_CHAT_TEXT = "rocky heard nothing. no witness, no ranking.";
export const RAW_CHAT_TRACE: readonly string[] = Object.freeze([
  "decision: heuristic unavailable, baseline kept, 0ms.",
]);

/** Deterministic trace lines are metadata; model claims must cite evidence. */
const TEMPLATE_PREFIXES = [
  "rocky heard ",
  "decision: ",
  "detail: ",
  "memory coverage incomplete: ",
  "renderer: ",
] as const;

function isTemplateLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return true;
  if (/^[-*+]\s/u.test(trimmed) || /^\d+[\.)]\s+/u.test(trimmed)) return false;
  if (/^#{1,6}\s/u.test(trimmed) || /^```/u.test(trimmed) || /^(?:---+|\*\*\*+)$/u.test(trimmed)) return true;
  return TEMPLATE_PREFIXES.some((prefix) => trimmed.toLowerCase().startsWith(prefix));
}

function hasTopRecord(fact: ChatRenderFact, count: number): fact is ChatRenderFact & { readonly topRef: string } {
  return count > 0 && fact.topRef !== undefined && fact.topRef.length > 0;
}

/**
 * The page reads answer lines as small Markdown, and that parser has no
 * escapes: a bare `test_a_b.py` or `*.log *.tmp` would turn into italics, and
 * Rocky would show a command other than the one he heard. A code span shows
 * the label as it is. A backtick inside it would end the span, so it becomes an
 * apostrophe, and a line break would split the span, so whitespace collapses.
 */
function labelSpan(label: string): string {
  return `\`${label.replace(/\s+/gu, " ").replace(/`/gu, "'")}\``;
}

/**
 * The top record as the answer says it: the label Rocky heard, then its kind.
 * The id is not here; it is the first trace line. A record that says nothing
 * else is labelled by its kind, and a label that only repeats the kind names
 * nothing, so it is not printed twice.
 */
function bestMatchLine(fact: ChatRenderFact): string | undefined {
  const label = fact.topLabel?.trim() ?? "";
  const kind = fact.topKind?.trim() ?? "";
  if (label.length > 0 && label !== kind) return `best match: ${labelSpan(label)}${kind.length > 0 ? ` (${kind})` : ""}. remembered, not proven.`;
  if (kind.length > 0) return `best match: ${kind} record. remembered, not proven.`;
  return undefined;
}

/**
 * Template-first answer text: how many records Rocky heard and which one
 * matches best, by label. Everything else Rocky knows about the answer is
 * trace: see `renderChatTrace`.
 */
export function renderChatText(fact: ChatRenderFact): string {
  const lines: string[] = [];
  const count = Math.max(0, Math.floor(fact.evidenceCount));
  if (count === 0) {
    lines.push(RAW_CHAT_TEXT);
  } else {
    lines.push(`rocky heard ${count} thing${count === 1 ? "" : "s"}.`);
    const best = hasTopRecord(fact, count) ? bestMatchLine(fact) : undefined;
    if (best !== undefined) lines.push(best);
  }
  return lines.join("\n");
}

/**
 * The lines behind the answer text, in the order the drawer shows them: the
 * top record's id, the decision, its detail, then the memory coverage line.
 * The renderer line is added by whoever ran the renderer, because only that
 * stage knows which model, if any, wrote the text.
 */
export function renderChatTrace(fact: ChatRenderFact): string[] {
  const lines: string[] = [];
  const count = Math.max(0, Math.floor(fact.evidenceCount));
  if (hasTopRecord(fact, count)) {
    const kind = fact.topKind !== undefined && fact.topKind.length > 0 ? ` (${fact.topKind})` : "";
    lines.push(`top: ${fact.topRef}${kind}. remembered, not proven.`);
  }
  if (fact.engine === "jev" && fact.status === "used" && typeof fact.topScore === "number") {
    lines.push(`decision: jev used, top score ${fact.topScore.toFixed(2)}, ${fact.latencyMs ?? 0}ms.`);
  } else {
    lines.push(`decision: ${fact.engine} ${fact.status}, baseline kept, ${fact.latencyMs ?? 0}ms.`);
  }
  if (fact.detail !== undefined) lines.push(`detail: ${fact.detail}`);
  if (fact.coverageLine !== undefined) lines.push(fact.coverageLine);
  return lines;
}

/** Never throws: a renderer failure degrades to the raw template. */
export function safeRenderChatText(fact: ChatRenderFact): string {
  try {
    return renderChatText(fact);
  } catch {
    return RAW_CHAT_TEXT;
  }
}

/** Never throws: a renderer failure degrades to the raw trace. */
export function safeRenderChatTrace(fact: ChatRenderFact): string[] {
  try {
    return renderChatTrace(fact);
  } catch {
    return [...RAW_CHAT_TRACE];
  }
}

export interface RenderedClaimsCheck {
  stripped: string;
  dropped: number;
}

/**
 * No-new-claims gate (citation-check pattern): every non-template line must
 * cite an evidence ref, indexed citation ([1], [2]), or Jev answer id (`q_<ref>`).
 * Anything else is an extra ungrounded claim — stripped and counted, never passed through.
 */
export function validateRenderedClaims(
  text: string,
  allowedRefs: ReadonlySet<string> | readonly string[],
): RenderedClaimsCheck {
  const allowList: readonly string[] = Array.isArray(allowedRefs)
    ? (allowedRefs as readonly string[])
    : Array.from(allowedRefs as ReadonlySet<string>);
  const allowSet = new Set<string>(allowList);

  const citationMap = new Map<string, string>();
  allowList.forEach((ref, index) => {
    citationMap.set(`[${index + 1}]`, ref);
    citationMap.set(`[#${index + 1}]`, ref);
  });

  const kept: string[] = [];
  let dropped = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || isTemplateLine(line)) {
      kept.push(line);
      continue;
    }
    let cited = false;
    for (const ref of allowSet) {
      if (ref.length > 0 && line.includes(ref)) {
        cited = true;
        break;
      }
    }
    if (!cited) {
      for (const [citation] of citationMap) {
        if (line.includes(citation)) {
          cited = true;
          break;
        }
      }
    }
    if (cited) {
      kept.push(line);
    } else {
      dropped += 1;
    }
  }
  return { stripped: kept.join("\n"), dropped };
}
