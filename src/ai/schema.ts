import type { AiAct } from "./port.js";
import type { ProjectedRecallHit } from "../mcp/privacy.js";

export interface ModelRecallOutput {
  act: AiAct;
  ranked_candidates: readonly string[];
  evidence_refs: readonly string[];
  confidence: number;
  explanation: string;
}

export const RECALL_AI_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    act: { type: "string", enum: ["known_fix", "unresolved", "ambiguous"] },
    ranked_candidates: { type: "array", items: { type: "string" }, maxItems: 5, uniqueItems: true },
    evidence_refs: { type: "array", items: { type: "string" }, maxItems: 10, uniqueItems: true },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    explanation: { type: "string", maxLength: 300 },
  },
  required: ["act", "ranked_candidates", "evidence_refs", "confidence", "explanation"],
} as const;

const ACTS: readonly AiAct[] = ["known_fix", "unresolved", "ambiguous"];
const EVIDENCE_REF = /^c[1-5]\.(failure|fix)$/;
const ANSI_STRING_7BIT = /\u001b(?:\]|P|\^|_|X)[\s\S]*?(?:\u0007|\u009c|\u001b\\)/g;
const ANSI_STRING_8BIT = /[\u0090\u0098\u009d\u009e\u009f][\s\S]*?(?:\u0007|\u009c|\u001b\\)/g;
const ANSI_CSI_7BIT = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_CSI_8BIT = /\u009b[0-?]*[ -/]*[@-~]/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, maximum: number): value is string[] {
  return Array.isArray(value) && value.length <= maximum && value.every((item) => typeof item === "string") &&
    new Set(value).size === value.length;
}

function normalizeExplanation(value: string): string | undefined {
  const normalized = value
    .replace(ANSI_STRING_7BIT, "")
    .replace(ANSI_STRING_8BIT, "")
    .replace(ANSI_CSI_7BIT, "")
    .replace(ANSI_CSI_8BIT, "")
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.includes("```")) return undefined;
  return [...normalized].length <= 300 ? normalized : undefined;
}

export function parseModelRecallOutput(
  value: unknown,
  hits: readonly ProjectedRecallHit[],
): ModelRecallOutput | undefined {
  if (!isRecord(value)) return undefined;
  const required = ["act", "ranked_candidates", "evidence_refs", "confidence", "explanation"];
  if (Object.keys(value).length !== required.length || Object.keys(value).some((key) => !required.includes(key))) return undefined;
  if (typeof value.act !== "string" || !(ACTS as readonly string[]).includes(value.act)) return undefined;
  if (!stringArray(value.ranked_candidates, 5) || !stringArray(value.evidence_refs, 10)) return undefined;
  if (typeof value.confidence !== "number" || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) {
    return undefined;
  }
  if (typeof value.explanation !== "string" || [...value.explanation].length > 300) return undefined;

  const candidateIds = hits.slice(0, 5).map((hit) => hit.candidateId);
  const candidateSet = new Set(candidateIds);
  if (value.ranked_candidates.some((id) => !candidateSet.has(id))) return undefined;
  for (const ref of value.evidence_refs) {
    const match = EVIDENCE_REF.exec(ref);
    if (!match) return undefined;
    const candidateId = match[0].split(".")[0];
    if (!candidateSet.has(candidateId)) return undefined;
    if (match[1] === "fix" && !hits.find((hit) => hit.candidateId === candidateId)?.hasFix) return undefined;
  }

  const explanation = normalizeExplanation(value.explanation);
  if (explanation === undefined) return undefined;
  return {
    act: value.act as AiAct,
    ranked_candidates: value.ranked_candidates,
    evidence_refs: value.evidence_refs,
    confidence: value.confidence,
    explanation,
  };
}
