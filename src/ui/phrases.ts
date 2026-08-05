import type { AiAct } from "../ai/port.js";

export type PhraseKey =
  | "ai-known-fix"
  | "ai-unresolved"
  | "ai-ambiguous"
  | "ai-disabled"
  | "ai-unavailable"
  | "ai-timeout"
  | "ai-busy"
  | "ai-fallback";

const PHRASES: Readonly<Record<PhraseKey, string>> = Object.freeze({
  "ai-known-fix": "memory and small model agree. old fix is strong clue. good good.",
  "ai-unresolved": "memory has same pain, but no known fix. bad bad.",
  "ai-ambiguous": "memory points many directions. uncertain. check evidence, question",
  "ai-disabled": "small model sleeps. memory still works.",
  "ai-unavailable": "small model not answer. memory still works.",
  "ai-timeout": "small model takes too long. I keep old memory answer.",
  "ai-busy": "small model busy. deterministic memory speaks now.",
  "ai-fallback": "model words not grounded enough. I keep memory order.",
});

export const phraseKeys: readonly PhraseKey[] = Object.freeze([
  "ai-known-fix",
  "ai-unresolved",
  "ai-ambiguous",
  "ai-disabled",
  "ai-unavailable",
  "ai-timeout",
  "ai-busy",
  "ai-fallback",
]);

export function phrase(key: PhraseKey): string {
  return PHRASES[key];
}

export function phraseForAct(act: AiAct): string {
  switch (act) {
    case "known_fix":
      return phrase("ai-known-fix");
    case "unresolved":
      return phrase("ai-unresolved");
    case "ambiguous":
      return phrase("ai-ambiguous");
    default:
      return assertNever(act);
  }
}

const VISUAL_LANGUAGE = /\bi\s+(?:(?:can|cannot|can't|could|couldn't|will|would|do|did|am|was|were|have|had|never)\s+)*(?:see|saw|seen|seeing|look|looks|looked|looking|watch|watches|watched|watching|view|views|viewed|viewing|observe|observes|observed|observing|notice|notices|noticed|noticing|read|reads|reading|scan|scans|scanned|scanning)\b/i;
const ARTICLE = /(?:^|[^\p{L}\p{N}_])(?:a|an|the)(?=$|[^\p{L}\p{N}_])/iu;
const EMOJI = /[\u{00A9}\u{00AE}\u{203C}\u{2049}\u{2122}\u{2139}\u{2300}-\u{23FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{3030}\u{303D}\u{3297}\u{3299}\u{1F000}-\u{1FAFF}\u{200D}\u{FE0F}]/u;

export function validateRockyPhrase(value: string): readonly string[] {
  const violations: string[] = [];

  if (value.includes("?")) violations.push("question-mark");
  if (VISUAL_LANGUAGE.test(value)) violations.push("visual-language");
  if (ARTICLE.test(value)) violations.push("article");
  if (EMOJI.test(value)) violations.push("emoji");
  if (value.split(/\r?\n/).some((line) => /\bquestion\b/i.test(line) && !line.endsWith(", question"))) {
    violations.push("question-suffix");
  }

  return violations;
}

function assertNever(value: never): never {
  throw new Error(`Unexpected AI act: ${value}`);
}
