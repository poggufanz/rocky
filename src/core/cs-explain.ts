export const CS_CONCEPT_IDS = ["control-flow", "program-state", "decomposition", "data-aggregation"] as const;
export type CsConceptId = (typeof CS_CONCEPT_IDS)[number];

export interface CsExplain {
  conceptId: CsConceptId;
  definition: string;
  trace: string[];
  check: string;
}

const DEFINITIONS: Record<CsConceptId, string> = {
  "control-flow": "Control flow decides which lines run and how many times. Loops and branches guard that choice.",
  "program-state": "Program state is the current variable values. Mutation changes future behavior.",
  "decomposition": "Decomposition splits big behavior into small steps with one job each.",
  "data-aggregation": "Aggregation combines rows into a sum and an average, then compares them against a threshold.",
};

const CHECKS: Record<CsConceptId, string> = {
  "control-flow": "Trace the values of i on paper. What does total become?",
  "program-state": "Which assignment changes the next iteration?",
  "decomposition": "What is the first, smallest step you would test alone?",
  "data-aggregation": "Which filter threshold decides the total?",
};

function isCsId(value: string): value is CsConceptId {
  return (CS_CONCEPT_IDS as readonly string[]).includes(value);
}

function buildTrace(snippet: string): string[] {
  const lines = snippet.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0).slice(0, 5);
  const capped = lines.map((l) => l.slice(0, 120));
  if (capped.length > 0) return capped;
  return ["Start from the first line.", "Track each assignment once.", "Compare the final values."];
}

export function explainFor(conceptId: string, snippet: string): CsExplain | undefined {
  if (!isCsId(conceptId)) return undefined;
  const definition = DEFINITIONS[conceptId].slice(0, 280);
  const trace = buildTrace(snippet).slice(0, 5);
  const check = CHECKS[conceptId].slice(0, 140);
  return { conceptId, definition, trace, check };
}
