import type { AiAct } from "../ai/port.js";

export type PhraseKey =
  | "ai-known-fix"
  | "ai-unresolved"
  | "ai-ambiguous"
  | "ai-disabled"
  | "ai-unavailable"
  | "ai-timeout"
  | "ai-busy"
  | "ai-fallback"
  | "bashrc-write-protected"
  | "bashrc-created"
  | "hook-histcontrol"
  | "watch-ok"
  | "watch-fail"
  | "watch-log-unwritable"
  | "check-secret"
  | "check-package-missing"
  | "check-registry-consent"
  | "check-answer"
  | "check-comprehension"
  | "check-unknown-flag"
  | "gui-opener-failed"
  | "cmd-exe-parsed"
  | "fix-linked"
  | "fix-recurrence-same";

const PHRASES: Readonly<Record<PhraseKey, string>> = Object.freeze({
  "ai-known-fix": "Memory and the local model agree. The recorded fix is a strong lead.",
  "ai-unresolved": "Memory has the same failure, but no recorded fix.",
  "ai-ambiguous": "Memory points in several directions. Check the evidence before acting.",
  "ai-disabled": "Local model is off. Memory still works.",
  "ai-unavailable": "Local model did not answer. Memory still works.",
  "ai-timeout": "Local model took too long. Keeping the memory answer.",
  "ai-busy": "Local model is busy. Showing the deterministic memory answer.",
  "ai-fallback": "Model output was not grounded enough. Keeping memory order.",
  "bashrc-write-protected": ".bashrc is write-protected. Replacing it anyway; your lines are kept.",
  "bashrc-created": ".bashrc was missing, so a new one was created. Only Git Bash reads it here.",
  "hook-histcontrol": "The hook changes your history setting: commands typed with a leading space are now recorded.",
  "watch-ok": "Command finished.",
  "watch-fail": "Command failed.",
  "watch-log-unwritable": "Watch log folder cannot be opened. No log this time; memory still records.",
  "check-secret": "A secret is in the outgoing code.",
  "check-package-missing": "Package does not exist on the registry. Was it invented by an AI?",
  "check-registry-consent": "Only package names go to registry.npmjs.org. No telemetry. Offline failures stay open. Allow registry lookup? [y/N]",
  "check-answer": "Your answer:",
  "check-comprehension": "Risky new line. What does it do?",
  "check-unknown-flag": "Unknown flag.",
  "gui-opener-failed": "Browser opener did not start. Open the link above by hand.",
  // Disclosure only: names the shell that parsed the command. No cause, no remedy:
  // `bash -c` on a Windows PATH can resolve to WSL's bash.exe.
  "cmd-exe-parsed": "cmd.exe parsed this command; bash or PowerShell syntax does not apply there.",
  // Hedged on purpose (commit 91889e0): a confirmed link means the same command
  // worked after it failed, never that rocky knows what changed in between.
  "fix-linked": "Command passes now; linked to the earlier failure. The change itself was not recorded.",
  "fix-recurrence-same": "Last time, the same command passed again afterward. The change itself was not recorded.",
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
  "bashrc-write-protected",
  "bashrc-created",
  "hook-histcontrol",
  "watch-ok",
  "watch-fail",
  "watch-log-unwritable",
  "check-secret",
  "check-package-missing",
  "check-registry-consent",
  "check-answer",
  "check-comprehension",
  "check-unknown-flag",
  "gui-opener-failed",
  "cmd-exe-parsed",
  "fix-linked",
  "fix-recurrence-same",
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

/**
 * Mechanical checks for rocky-authored output lines (docs/output-principles.md).
 * They catch the retired mascot voice; they cannot judge tone, so review still
 * reads new strings. Apply them to text rocky writes, never to recorded user or
 * agent content, which may say anything.
 */
const OLD_PREFIX = /\[rocky\]/i;
const QUESTION_SUFFIX = /,\s*question\b/i;
// Emphasis by repetition: "good good", "bad bad". Any doubled word is suspect.
const REPEATED_WORD = /(?:^|[^\p{L}\p{N}_])(\p{L}+)(?:\s+\1)+(?=$|[^\p{L}\p{N}_])/iu;
const FIRST_PERSON = /(?:^|[^\p{L}\p{N}_'-])(?:I|I'm|I've|I'll|[Mm]e|[Mm]y|[Mm]ine|[Mm]yself)(?=$|[^\p{L}\p{N}_'-])/u;
const LORE = /\b(?:blind|eridian|alien|ears?|hears?|heard|hearing)\b/i;
// A bare trailing verdict: "command dies. bad." / "... good."
const VERDICT_TAG = /(?:^|[.!;]\s+)(?:good|bad)[.!]?\s*$/i;
const EMOJI = /[\u{00A9}\u{00AE}\u{203C}\u{2049}\u{2122}\u{2139}\u{2300}-\u{23FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{3030}\u{303D}\u{3297}\u{3299}\u{1F000}-\u{1FAFF}\u{200D}\u{FE0F}]/u;

export type OutputViolation =
  | "old-prefix"
  | "question-suffix"
  | "repetition"
  | "first-person"
  | "lore"
  | "verdict-tag"
  | "emoji";

export function validateOutputLine(value: string): readonly OutputViolation[] {
  const violations: OutputViolation[] = [];
  const lines = value.split(/\r?\n/);

  if (OLD_PREFIX.test(value)) violations.push("old-prefix");
  if (QUESTION_SUFFIX.test(value)) violations.push("question-suffix");
  if (lines.some((line) => REPEATED_WORD.test(line))) violations.push("repetition");
  if (FIRST_PERSON.test(value)) violations.push("first-person");
  if (LORE.test(value)) violations.push("lore");
  if (lines.some((line) => VERDICT_TAG.test(line))) violations.push("verdict-tag");
  if (EMOJI.test(value)) violations.push("emoji");

  return violations;
}

function assertNever(value: never): never {
  throw new Error(`Unexpected AI act: ${value}`);
}
