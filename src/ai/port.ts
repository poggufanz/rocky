import type { Exposure } from "../core/config-read.js";
import type { RecallHit } from "../core/memory-query.js";
import { recallCandidateIdsForLength, validateRecallCandidateIds } from "../mcp/privacy.js";

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
  run(input: {
    query: string;
    hits: readonly RecallHit[];
    /** Source-local MCP IDs; absent for ordinary CLI recall. */
    candidateIds?: readonly string[];
    exposure: Exposure;
  }, signal: AbortSignal): Promise<RecallAiOutcome>;
}

export const disabledRecallWithAi: RecallWithAiPort = {
  async run(input) {
    const candidateIds = input.candidateIds === undefined
      ? recallCandidateIdsForLength(input.hits.length)
      : validateRecallCandidateIds(input.candidateIds, input.hits.length);
    if (candidateIds === undefined) return { aiStatus: "invalid_output", rankedCandidateIds: [] };
    return {
      aiStatus: input.hits.length === 0 ? "no_hits" : "disabled",
      rankedCandidateIds: candidateIds,
    };
  },
};
