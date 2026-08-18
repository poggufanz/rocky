import type { OllamaClient } from "./ollama.js";

const RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    lines: { type: "array", items: { type: "string" } },
    questions: { type: "array", items: { type: "string" } },
  },
  required: ["lines", "questions"],
};

const MAX_POLISHED_LINE_CHARS = 200;

interface BriefSections {
  areaStart: number;
  areaEnd: number;
  explainStart: number;
  explainEnd: number;
}

function findSections(lines: string[]): BriefSections | undefined {
  const areaStart = lines.indexOf("changes by area:");
  const memoryStart = lines.findIndex((line) => line === "failures and fixes in window:");
  const explainStart = lines.indexOf("explain-ready:");
  if (areaStart === -1 || memoryStart === -1 || explainStart === -1 || memoryStart <= areaStart) return undefined;
  return { areaStart: areaStart + 1, areaEnd: memoryStart, explainStart: explainStart + 1, explainEnd: lines.length };
}

function validStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length > MAX_POLISHED_LINE_CHARS)) return undefined;
  return value as string[];
}

/**
 * Polish wording of blocks 2 (changes by area) and 5 (explain-ready) only.
 * Every other line passes through verbatim. Any error or invalid model
 * output returns the deterministic input unchanged — LLM never adds facts.
 */
export async function polishBriefLines(lines: string[], client: OllamaClient, model: string): Promise<string[]> {
  const sections = findSections(lines);
  if (sections === undefined) return lines;
  const areaLines = lines.slice(sections.areaStart, sections.areaEnd);
  const explainLines = lines.slice(sections.explainStart, sections.explainEnd);
  const prompt = [
    "Rewrite these change-list lines and reviewer questions to read naturally.",
    "Keep every file path, commit subject fact, and count unchanged.",
    "Keep each question ending with ', question'. Do not add new items.",
    "Return JSON with keys lines and questions.",
    "LINES:",
    ...areaLines,
    "QUESTIONS:",
    ...explainLines,
  ].join("\n");
  try {
    const raw = await client.generateStructured(model, prompt, RESPONSE_SCHEMA);
    if (typeof raw !== "object" || raw === null) return lines;
    const output = raw as Record<string, unknown>;
    const polishedArea = validStrings(output.lines);
    const polishedExplain = validStrings(output.questions);
    if (polishedArea === undefined || polishedExplain === undefined) return lines;
    if (polishedArea.length === 0 && areaLines.length > 0) return lines;
    return [
      ...lines.slice(0, sections.areaStart),
      ...polishedArea,
      ...lines.slice(sections.areaEnd, sections.explainStart),
      ...polishedExplain,
    ];
  } catch {
    return lines;
  }
}
