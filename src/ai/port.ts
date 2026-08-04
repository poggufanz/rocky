import type { Exposure } from "../core/config.js";
import type { RecallHit } from "../core/memory-query.js";

export type AiAct = "known_fix" | "unresolved" | "ambiguous";
export type AiStatus = "used" | "disabled" | "unavailable" | "model_missing" |
  "timeout" | "cancelled" | "invalid_output" | "low_confidence" | "busy" | "no_hits";

export interface RecallAiOutcome {
  aiStatus: AiStatus;
  rankedCandidateIds: readonly string[];
  act?: AiAct;
  evidenceRefs?: readonly string[];
  confidence?: number;
  explanation?: string;
}

export interface RecallWithAiPort {
  run(input: { query: string; hits: readonly RecallHit[]; exposure: Exposure }, signal: AbortSignal): Promise<RecallAiOutcome>;
}

export const disabledRecallWithAi: RecallWithAiPort = {
  async run(input) {
    return {
      aiStatus: input.hits.length === 0 ? "no_hits" : "disabled",
      rankedCandidateIds: input.hits.map((_, index) => `c${index + 1}`),
    };
  },
};
