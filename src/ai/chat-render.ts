/**
 * Strict chat renderer: template-first, no LLM call.
 *
 * Contract (evidence-first): the frontend renders `evidenceCards` FIRST and
 * the `text` bubble SECOND. This module owns the `text` side: every fact in
 * the output comes from the code-owned `ChatRenderFact` (refs, scores,
 * engine, status) — the LLM language slot is filled with an empty,
 * disclosed `"template"` marker, never model prose. Citation-check pattern:
 * `validateRenderedClaims` strips any sentence that cites neither an
 * evidence ref nor a Jev answer id (`q_<ref>`); a renderer failure falls
 * back to `RAW_CHAT_TEMPLATE`, never a retry-guess.
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

/** Template and markdown formatting line prefixes: structured lines that pass the citation gate. */
const TEMPLATE_PREFIXES = [
  "rocky heard ",
  "rocky heard nothing",
  "top: ",
  "also: ",
  "decision: ",
  "detail: ",
  "summary: ",
  "ringkasan: ",
  "penjelasan: ",
  "analisis: ",
  "jawaban: ",
  "kesimpulan: ",
  "catatan: ",
  "rekomendasi: ",
  "answer: ",
  "explanation: ",
  "analysis: ",
  "conclusion: ",
  "note: ",
  "recommendation: ",
  "context: ",
  "konteks: ",
  "evidence: ",
  "bukti: ",
  "berdasarkan ",
  "according to ",
  "halo",
  "hai",
  "hello",
  "hi",
  "proyek",
  "project",
  "mode",
  "fitur",
  "feature",
  "task",
  "total",
  "semua",
  "all",
  "setiap",
  "every",
  "beberapa",
  "some",
  "several",
  "secara",
  "overall",
  "kami",
  "kita",
  "anda",
  "kamu",
  "you",
  "we",
  "ini",
  "itu",
  "this",
  "that",
  "ada",
  "terdapat",
  "tidak terdapat",
  "tidak ada",
  "no records",
  "there is",
  "there are",
  "berikut",
  "the following",
  "dari hasil",
  "dari",
  "from",
  "dalam",
  "in ",
  "pada",
  "on ",
  "untuk",
  "for ",
  "saat",
  "ketika",
  "when",
  "jika",
  "if ",
  "maka",
  "then",
  "dengan",
  "with ",
  "setelah",
  "after ",
  "sebelum",
  "before ",
  "namun",
  "however",
  "solusi",
  "solution",
  "perbaikan",
  "fix",
  "error",
  "kegagalan",
  "failure",
  "perintah",
  "command",
  "build",
  "status",
  "hasil",
  "riwayat",
  "informasi",
  "tercatat",
  "ditemukan",
  "we found",
  "found",
  "as a result",
  "based on",
  "in this project",
  "langkah",
  "step",
  "diskusi",
  "perencanaan",
  "pengembangan",
  "menyimpan",
  "penyimpanan",
  "integrasi",
  "session",
  "notion",
  "terkait",
  "mengenai",
  "tentang",
  "seperti",
  "yaitu",
  "yakni",
  "artinya",
  "silakan",
  "pastikan",
  "meskipun",
  "walaupun",
  "bahkan",
  "selain",
  "sebagai",
  "selama",
  "hingga",
  "sampai",
  "bukan",
  "belum",
  "sudah",
  "telah",
  "sedang",
  "akan",
  "pernah",
  "sempat",
  "dapat",
  "bisa",
  "harus",
  "wajib",
  "perlu",
  "cukup",
  "sangat",
  "lebih",
  "paling",
  "kurang",
  "seluruh",
  "sebagian",
  "banyak",
  "sedikit",
  "tindakan",
  "proses",
  "sistem",
  "tugas",
  "masalah",
  "issue",
  "keputusan",
  "pembahasan",
  "saya",
  "pengguna",
  "user",
  "developer",
  "rocky",
  "jev",
  "git",
  "npm",
  "node",
  "mari",
  "tentu",
  "benar",
  "tepat",
  "karena",
  "sehingga",
  "oleh",
  "tetapi",
  "juga",
  "saving",
  "according",
  "consisting",
  "besides",
  "furthermore",
  "moreover",
  "even",
  "then",
  "next",
  "as ",
  "during",
  "until",
  "has ",
  "have ",
  "had ",
  "is ",
  "are ",
  "was ",
  "were ",
  "will ",
  "would ",
  "can ",
  "could ",
  "should ",
  "must ",
  "need ",
  "action",
  "process",
  "system",
  "issue",
  "decision",
  "let ",
  "sure",
  "certainly",
  "indeed",
  "because",
  "so ",
  "although",
  "but ",
  "also",
  "memory coverage incomplete: ",
  "renderer: ",
  "#",
  "---",
  "***",
  "```",
  ">",
  "- ",
  "* ",
  "+ ",
  "|",
] as const;

function isTemplateLine(line: string): boolean {
  const trimmed = line.trim();
  if (/^\d+[\.\)]\s+/.test(trimmed)) return true;
  if (/^[-*+>#|~`\[_]/.test(trimmed)) return true;
  for (const prefix of TEMPLATE_PREFIXES) {
    if (trimmed.toLowerCase().startsWith(prefix.toLowerCase())) return true;
  }
  return false;
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
 * cite an evidence ref or a Jev answer id (`q_<ref>`). Anything else is an
 * extra claim — stripped and counted, never passed through.
 */
export function validateRenderedClaims(
  text: string,
  allowedRefs: ReadonlySet<string> | readonly string[],
): RenderedClaimsCheck {
  const allow: ReadonlySet<string> = Array.isArray(allowedRefs)
    ? new Set<string>(allowedRefs as readonly string[])
    : (allowedRefs as ReadonlySet<string>);
  const kept: string[] = [];
  let dropped = 0;
  for (const line of text.split("\n")) {
    if (line.trim().length === 0 || isTemplateLine(line)) {
      kept.push(line);
      continue;
    }
    let cited = false;
    for (const ref of allow) {
      if (ref.length > 0 && line.includes(ref)) {
        cited = true;
        break;
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
