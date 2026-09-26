/**
 * Deterministic chat fallback and model-claim validation.
 *
 * The GUI renders evidence cards before answer text. `renderChatText` provides
 * local status text; `chat-llm.ts` supplies model prose. Factual lines,
 * including bullet and numbered items, must cite an allowed record or Jev ref.
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
  readonly topRef?: string;
  readonly topKind?: string;
  /** Top-1 Noul score when a Jev ranking was used, otherwise null/undefined. */
  readonly topScore?: number | null;
  readonly engine: ChatRenderEngine;
  readonly status: ChatRenderStatus;
  readonly evidenceCount: number;
  readonly latencyMs?: number;
  readonly detail?: string;
  readonly coverageReason?: string;
  readonly evidence?: readonly { readonly ref: string; readonly kind: string; readonly snippet: string }[];
}

/**
 * Evidence-first render contract for `/api/chat`: the frontend renders
 * these fields in this order. Existing field names are unchanged.
 */
export const CHAT_RENDER_ORDER = ["evidenceCards", "text", "decisionTrace"] as const;

/** Raw template: what a renderer failure degrades to, never a retry-guess. */
export const RAW_CHAT_TEMPLATE = [
  "rocky heard nothing. no witness, no ranking.",
  "decision: heuristic unavailable, baseline kept, 0ms.",
  "renderer: template (no model text).",
].join("\n");

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

/**
 * Template-first render. The LLM slot is disclosed, never filled:
 * `renderer: template (no model text).` carries no facts of its own.
 */
export function renderChatText(fact: ChatRenderFact): string {
  const lines: string[] = [];
  const count = Math.max(0, Math.floor(fact.evidenceCount));
  if (count === 0) {
    lines.push("rocky heard nothing. no witness, no ranking.");
  } else {
    lines.push(`rocky heard ${count} thing${count === 1 ? "" : "s"}.`);
    if (fact.topRef !== undefined && fact.topRef.length > 0) {
      const kind = fact.topKind !== undefined && fact.topKind.length > 0 ? ` (${fact.topKind})` : "";
      lines.push(`top: ${fact.topRef}${kind}. remembered, not proven.`);
    }
  }
  if (fact.engine === "jev" && fact.status === "used" && typeof fact.topScore === "number") {
    lines.push(`decision: jev used, top score ${fact.topScore.toFixed(2)}, ${fact.latencyMs ?? 0}ms.`);
  } else {
    lines.push(`decision: ${fact.engine} ${fact.status}, baseline kept, ${fact.latencyMs ?? 0}ms.`);
  }
  if (fact.detail !== undefined) lines.push(`detail: ${fact.detail}`);
  if (fact.coverageReason !== undefined) lines.push(`memory coverage incomplete: ${fact.coverageReason}.`);
  lines.push("renderer: template (no model text).");
  return lines.join("\n");
}

/** Never throws: a renderer failure degrades to the raw template. */
export function safeRenderChatText(fact: ChatRenderFact): string {
  try {
    return renderChatText(fact);
  } catch {
    return RAW_CHAT_TEMPLATE;
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
