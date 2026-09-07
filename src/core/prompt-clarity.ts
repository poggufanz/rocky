/**
 * Prompt-clarity scorer — deterministic, zero-dependency, no model.
 *
 * Scores a rationale or prompt draft locally so `rocky check --prompt` and
 * the rationale gate can nudge toward clearer instructions without any
 * outside call. Every metric here is a pure function of the input text.
 *
 * Diversity metrics follow the lexical-diversity literature:
 * - type-token ratio (TTR),
 * - HD-D per McCarthy & Jarvis (2010): the sum over types of the
 *   hypergeometric inclusion probability `1 - C(N-ni, S)/C(N, S)` with
 *   S = CLARITY_SAMPLE_SIZE capped by N. The brief draft said "mean
 *   per-type", but a mean is maximized (= 1) by pure repetition — a
 *   single-type text scores exactly 1 — so it cannot satisfy the required
 *   varied-vs-repeated monotonicity. The published statistic sums; the
 *   diversity blend normalizes that sum by CLARITY_SAMPLE_SIZE, which is
 *   the natural ceiling (an all-unique text of length N >= S sums to
 *   exactly S), clamped to [0, 1].
 * - MTLD approximation: sequential TTR < CLARITY_MTLD_THRESHOLD factor
 *   counting with the standard partial-factor remainder, forward+backward
 *   mean, capped at CLARITY_MTLD_CAP.
 *
 * No causal claims: a clear score does not promise the change works, and a
 * vague score only names what is missing from the words on the page.
 */

/** Hypergeometric sample size for HD-D. */
export const CLARITY_SAMPLE_SIZE = 42 as const;
/** Sequential-TTR trip point for MTLD factor counting. */
export const CLARITY_MTLD_THRESHOLD = 0.72 as const;
/** Ceiling for the MTLD approximation. */
export const CLARITY_MTLD_CAP = 200 as const;
/** MTLD normalization point for the diversity blend. */
const MTLD_NORM = 100;

/** Verbs that start an actionable instruction. Checked against the first word. */
export const IMPERATIVE_VERBS: ReadonlySet<string> = new Set([
  "add", "fix", "update", "create", "remove", "refactor", "implement",
  "explain", "move", "rename", "delete", "write", "change", "make",
  "ensure", "prevent", "allow", "check", "verify", "test",
]);

/** Words that point at nothing by themselves. */
export const VAGUE_PRONOUNS: ReadonlySet<string> = new Set([
  "it", "this", "that", "these", "those", "stuff", "thing", "things",
]);

/** Tokenizer shared by every metric: lowercase `[a-z0-9']+`, min length 1. */
const PROMPT_TOKEN = /[a-z0-9']+/g;
/** One leading step marker (`1.`, `2)`, `-`, `*`) so it never reads as the verb. */
const LEAD_STEP_MARKER = /^\s*(?:\d+[.)]|[-*\u2022])\s+/;
/** A numbered step line: `1. do x` or `2) do x`. */
const NUMBERED_STEP_LINE = /^\s*\d+[.)]\s+\S/;
/** A concrete anchor: fenced code, a slash path with a dot, or a dotted filename. */
const CODE_REF =
  /(?:```|[A-Za-z0-9_.~+-]+\/[A-Za-z0-9_./~+-]*\.[A-Za-z0-9~+-]+|\b[\w~+-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|rb|php|c|cc|cpp|h|hpp|cs|css|html|md|json|yaml|yml|toml|ini|env|sh|sql|swift|vue|wasm|xml|lock|log|txt)\b)/;

/** Lowercase tokens; empty text yields an empty array, never throws. */
export function tokenizePrompt(text: string): string[] {
  if (typeof text !== "string") return [];
  return text.toLowerCase().match(PROMPT_TOKEN) ?? [];
}

/** Distinct tokens over total tokens. Empty input yields 0. */
export function typeTokenRatio(tokens: readonly string[]): number {
  if (tokens.length === 0) return 0;
  return new Set(tokens).size / tokens.length;
}

/**
 * `C(rest, s) / C(n, s)` as a product of s fractions — no factorial
 * overflow for long prompts. Returns 0 when the type fills the sample.
 */
function inclusionComplement(n: number, ni: number, s: number): number {
  const rest = n - ni;
  if (rest < s) return 0;
  let ratio = 1;
  for (let j = 0; j < s; j += 1) ratio *= (rest - j) / (n - j);
  return ratio;
}

/**
 * HD-D lexical diversity (McCarthy & Jarvis 2010): sum over types of the
 * probability that a random sample of S tokens contains the type. Higher
 * means more diverse. Empty input yields 0.
 */
export function hdd(tokens: readonly string[], sampleSize: number = CLARITY_SAMPLE_SIZE): number {
  const n = tokens.length;
  if (n === 0) return 0;
  const s = Math.min(sampleSize, n);
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  let sum = 0;
  for (const ni of counts.values()) sum += 1 - inclusionComplement(n, ni, s);
  return sum;
}

/** One MTLD pass: count full TTR trips plus the standard partial remainder. */
function mtldFactors(tokens: readonly string[], threshold: number): number {
  let factors = 0;
  let types = new Set<string>();
  let length = 0;
  for (const token of tokens) {
    types.add(token);
    length += 1;
    if (types.size / length < threshold) {
      factors += 1;
      types = new Set<string>();
      length = 0;
    }
  }
  if (length > 0) factors += (1 - types.size / length) / (1 - threshold);
  return factors;
}

/**
 * MTLD approximation: tokens per factor, forward+backward mean, capped.
 * Higher means more diverse. Empty input yields 0.
 */
export function mtld(
  tokens: readonly string[],
  threshold: number = CLARITY_MTLD_THRESHOLD,
  cap: number = CLARITY_MTLD_CAP,
): number {
  const n = tokens.length;
  if (n === 0) return 0;
  const mean = (mtldFactors(tokens, threshold) + mtldFactors([...tokens].reverse(), threshold)) / 2;
  if (!(mean > 0)) return Math.min(cap, n);
  return Math.min(cap, n / mean);
}

/** True when the first real word is an imperative verb. */
export function hasImperativeStart(text: string): boolean {
  if (typeof text !== "string") return false;
  const first = text.replace(LEAD_STEP_MARKER, "").toLowerCase().match(/[a-z]+/);
  return first !== null && IMPERATIVE_VERBS.has(first[0]);
}

/** How many times a vague pronoun appears as a token. */
export function countVaguePronouns(tokens: readonly string[]): number {
  let count = 0;
  for (const token of tokens) if (VAGUE_PRONOUNS.has(token)) count += 1;
  return count;
}

/** Lines shaped like numbered steps. */
export function countNumberedSteps(text: string): number {
  if (typeof text !== "string") return 0;
  let count = 0;
  for (const line of text.split(/\r?\n/)) if (NUMBERED_STEP_LINE.test(line)) count += 1;
  return count;
}

/** True when the text anchors to code: a fence or a file path. */
export function hasCodeRef(text: string): boolean {
  return typeof text === "string" && CODE_REF.test(text);
}

/** Whitespace-separated words; the length-band metric, not the tokenizer. */
export function countWords(text: string): number {
  if (typeof text !== "string") return 0;
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

export interface ClarityMetrics {
  words: number;
  tokens: number;
  types: number;
  ttr: number;
  hdd: number;
  mtld: number;
  vagueCount: number;
  steps: number;
  hasVerb: boolean;
  hasCodeRef: boolean;
}

export type ClarityBand = "clear" | "needs-detail" | "vague";

export interface ClarityResult {
  /** Integer 0-100. */
  score: number;
  band: ClarityBand;
  /** At most 3 missing-info suggestions, plain serious-info wording. */
  suggestions: string[];
  metrics: ClarityMetrics;
}

export interface ScorePromptOptions {
  /** True when this prompt follows an already-seen failure. */
  repeatedFailure?: boolean;
}

const NEUTRAL_SCORE = 50;

function emptyMetrics(): ClarityMetrics {
  return {
    words: 0, tokens: 0, types: 0, ttr: 0, hdd: 0, mtld: 0,
    vagueCount: 0, steps: 0, hasVerb: false, hasCodeRef: false,
  };
}

/**
 * Score prompt clarity 0-100:
 * `clarity = 0.35*structure + 0.35*precision + 0.30*diversity`.
 * Bands: clear (>= 70), needs-detail (40-69), vague (< 40).
 * Empty or non-string input fails open with a neutral 50, never throws.
 */
export function scorePrompt(text: string, options: ScorePromptOptions = {}): ClarityResult {
  const tokens = tokenizePrompt(text);
  if (tokens.length === 0) {
    return {
      score: NEUTRAL_SCORE,
      band: "needs-detail",
      suggestions: ["start with an imperative verb such as fix, add, update, or test"],
      metrics: emptyMetrics(),
    };
  }
  const words = countWords(text);
  const ttr = typeTokenRatio(tokens);
  const hddValue = hdd(tokens);
  const mtldValue = mtld(tokens);
  const vagueCount = countVaguePronouns(tokens);
  const steps = countNumberedSteps(text);
  const hasVerb = hasImperativeStart(text);
  const codeRef = hasCodeRef(text);

  let structure = 0;
  if (hasVerb) structure += 35;
  if (steps >= 2) structure += 30;
  else if (steps === 1) structure += 15;
  if (codeRef) structure += 20;
  if (words >= 8 && words <= 200) structure += 15;
  else if ((words >= 4 && words <= 7) || (words >= 201 && words <= 400)) structure += 8;
  else structure += 3;

  const precision = 100 - Math.min(80, vagueCount * 15);

  const diversity = 100 * (
    0.30 * ttr
    + 0.40 * Math.min(1, hddValue / CLARITY_SAMPLE_SIZE)
    + 0.30 * Math.min(1, mtldValue / MTLD_NORM)
  );

  const raw = 0.35 * structure + 0.35 * precision + 0.30 * diversity;
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  const band: ClarityBand = score >= 70 ? "clear" : score >= 40 ? "needs-detail" : "vague";

  const suggestions: string[] = [];
  if (!hasVerb) suggestions.push("start with an imperative verb such as fix, add, update, or test");
  if (vagueCount > 2) suggestions.push("name the file and behavior instead of it, this, that");
  if (steps === 0 && words > 25) suggestions.push("split into numbered steps, one action each");
  if (options.repeatedFailure === true && diversity < 40) {
    suggestions.push("add new info from the failure, not a paraphrase");
  }

  return {
    score,
    band,
    suggestions: suggestions.slice(0, 3),
    metrics: {
      words, tokens: tokens.length, types: new Set(tokens).size,
      ttr, hdd: hddValue, mtld: mtldValue,
      vagueCount, steps, hasVerb, hasCodeRef: codeRef,
    },
  };
}

/** Detail lines for CLI output; the advisory rendering pattern Task 2 reuses. */
export function renderClarityCard(result: ClarityResult): string[] {
  const lines = [`clarity ${result.score}/100 ${result.band}`];
  for (const suggestion of result.suggestions) lines.push(`suggest: ${suggestion}`);
  return lines;
}

/**
 * One-line gate/CLI nudge, or undefined when there is nothing to say
 * (clear prompts and empty input stay silent). Never throws, never
 * returns a question mark — questions end with `, question`.
 */
export function clarityNudgeLine(text: unknown, options: ScorePromptOptions = {}): string | undefined {
  try {
    if (typeof text !== "string" || text.trim().length === 0) return undefined;
    const result = scorePrompt(text, options);
    if (result.band === "clear") return undefined;
    const first = result.suggestions[0] ?? "say the file and the change";
    return `prompt ${result.band} ${result.score}/100. ${first}, question`;
  } catch {
    return undefined;
  }
}
