import type { AddedLine } from "./diff.js";

/** Weighted, additive heuristics. The goal is "one plausible question", not a security verdict. */
const RISK_PATTERNS: ReadonlyArray<readonly [weight: number, re: RegExp]> = [
  [5, /\beval\s*\(|new Function\s*\(/],
  [4, /\bexec(?:Sync|File|FileSync)?\s*\(|\bspawn(?:Sync)?\s*\(/],
  [4, /\brm\s+-rf\b|\bunlinkSync\s*\(|\brmSync\s*\(/],
  [3, /\bfetch\s*\(|\bhttps?:\/\//],
  [3, /\b(?:token|password|secret|api[_-]?key|authorization)\b/i],
  [2, /\bchild_process\b|\bprocess\.env\b/],
];

export function scoreLine(text: string): number {
  let score = 0;
  for (const [weight, re] of RISK_PATTERNS) if (re.test(text)) score += weight;
  return score;
}

/** Strict > keeps the first-seen line on ties: deterministic across runs. */
export function riskiestLine(lines: AddedLine[]): AddedLine | undefined {
  let best: AddedLine | undefined;
  let bestScore = 0;
  for (const l of lines) {
    const score = scoreLine(l.text);
    if (score > bestScore) { best = l; bestScore = score; }
  }
  return best;
}
