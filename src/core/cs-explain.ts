export const CS_CONCEPT_IDS = ["control-flow", "program-state", "decomposition", "data-aggregation"] as const;
export type CsConceptId = (typeof CS_CONCEPT_IDS)[number];

export interface CsExplain {
  conceptId: CsConceptId;
  definition: string;
  trace: string[];
  check: string;
}

const DEFINITIONS: Record<CsConceptId, string> = {
  "control-flow": "control flow decides which lines run and how many times loop and branch guard that choice",
  "program-state": "program state is current variable values, mutation changes future behavior",
  "decomposition": "decomposition splits big behavior into small steps with one job each",
  "data-aggregation": "aggregation combines rows into sum and average then compares against threshold",
};

const CHECKS: Record<CsConceptId, string> = {
  "control-flow": "trace i values on paper then tell what total becomes, question",
  "program-state": "name which assign changes next iteration, question",
  "decomposition": "name first smallest step you would test alone, question",
  "data-aggregation": "name which filter threshold decides the total, question",
};

function isCsId(value: string): value is CsConceptId {
  return (CS_CONCEPT_IDS as readonly string[]).includes(value);
}

function buildTrace(snippet: string): string[] {
  const lines = snippet.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0).slice(0, 5);
  const capped = lines.map((l) => l.slice(0, 120));
  if (capped.length > 0) return capped;
  return ["start from first line", "track each assign once", "compare final values"];
}

export function explainFor(conceptId: string, snippet: string): CsExplain | undefined {
  if (!isCsId(conceptId)) return undefined;
  const definition = DEFINITIONS[conceptId].slice(0, 280);
  const trace = buildTrace(snippet).slice(0, 5);
  const check = CHECKS[conceptId].slice(0, 140);
  return { conceptId, definition, trace, check };
}
