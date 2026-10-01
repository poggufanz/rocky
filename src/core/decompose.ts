/**
 * Decomposition coach — deterministic, zero-dependency, no model.
 *
 * A vibe-coding gap from the CHI'26 plan: changes arrive as one big bundle
 * and the intent behind them stays unsaid. This module renders the one
 * 3-step template every caller uses — (1) intended behavior in one line,
 * (2) state/fields that change, (3) how to verify (command plus observed
 * behavior) — filled from a staged diff/file list when one exists, blank
 * otherwise.
 *
 * Every export here is pure (no I/O, no clock) and never throws, so the
 * `check --decompose` and `brief --decompose` callers stay advisory and
 * fail open. File lists are bounded (DECOMPOSE_MAX_FILES named, the rest
 * counted) and secret-scrubbed with the same `redactSecretsAtBoundary`
 * the diff surfaces use. No causal claims: the template asks what the
 * change does, never why it failed or whether it works.
 */

import { redactSecretsAtBoundary } from "./redact.js";

/** One-line pre-push reminder. A question ends with `, question`, never `?`. */
export const DECOMPOSE_NUDGE = "say change in 3 lines: behavior, fields, verify, question" as const;
/** Blank-card prompt. Same voice rule: ends with `, question`, never `?`. */
export const DECOMPOSE_BLANK_PROMPT = "say 3 lines, question" as const;
/** Voice line for `check --decompose` when no diff names a file. */
export const DECOMPOSE_SAY_BLANK = "state 3 lines: behavior, fields, verify, question" as const;
/** Voice line for `check --decompose` when the diff names files. */
export const DECOMPOSE_SAY_FILLED = "change split in 3 lines. good good." as const;
/** How many file names one card names before counting the rest. */
export const DECOMPOSE_MAX_FILES = 5 as const;
/** Safety cap on extracted file names; a bounded diff cannot hold more real headers anyway. */
const DECOMPOSE_MAX_EXTRACTED = 100;
/** Longest single path kept; longer names truncate with an ellipsis. */
const DECOMPOSE_MAX_PATH_CHARS = 128;

/** One non-blocking nudge line in Rocky voice, or undefined on any failure. Never throws. */
export function decomposeNudgeLine(): string | undefined {
  try {
    return DECOMPOSE_NUDGE;
  } catch {
    return undefined;
  }
}

/** Scrub and bound one candidate path. Undefined means "not a nameable file". Never throws. */
function cleanPath(value: unknown): string | undefined {
  try {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed === "/dev/null") return undefined;
    const scrubbed = redactSecretsAtBoundary(trimmed);
    const bounded = scrubbed.length > DECOMPOSE_MAX_PATH_CHARS
      ? `${scrubbed.slice(0, DECOMPOSE_MAX_PATH_CHARS - 1)}…`
      : scrubbed;
    return bounded.length === 0 ? undefined : bounded;
  } catch {
    return undefined;
  }
}

/**
 * File names from a unified diff: the new side of `diff --git a/old b/new`
 * headers (quoted or plain) plus `+++ b/file` lines. Order-preserving,
 * deduplicated, capped. Garbage or non-string input yields []. Never throws.
 */
export function decomposeFilesFromDiff(diff: unknown): string[] {
  try {
    if (typeof diff !== "string" || diff.length === 0) return [];
    const files: string[] = [];
    const seen = new Set<string>();
    const push = (raw: string | undefined): void => {
      if (files.length >= DECOMPOSE_MAX_EXTRACTED || raw === undefined) return;
      let name = raw.trim();
      if (name.startsWith("b/")) name = name.slice(2);
      else if (name.startsWith("a/")) name = name.slice(2);
      if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) {
        name = name.slice(1, -1);
      }
      const cleaned = cleanPath(name);
      if (cleaned === undefined || seen.has(cleaned)) return;
      seen.add(cleaned);
      files.push(cleaned);
    };
    for (const line of diff.split(/\r?\n/)) {
      const quoted = /^diff --git\s+"a\/.*?"\s+"b\/(.+)"\s*$/.exec(line);
      if (quoted?.[1] !== undefined) {
        push(quoted[1]);
        continue;
      }
      const plain = /^diff --git\s+\S+\s+(\S+)\s*$/.exec(line);
      if (plain?.[1] !== undefined) {
        push(plain[1]);
        continue;
      }
      if (line.startsWith("+++ ")) {
        push(line.slice("+++ ".length).split("\t")[0]);
      }
    }
    return files;
  } catch {
    return [];
  }
}

/**
 * The 3-step card: header plus three numbered lines, filled from the file
 * list when one exists, blank otherwise. The blank card closes with a
 * question-style prompt (ends with `, question`, never `?`). At most
 * DECOMPOSE_MAX_FILES names print; the rest count as "and N more".
 * Never throws, never emits `?`.
 */
export function renderDecomposeCard(files: readonly string[]): string[] {
  const blank = (): string[] => [
    "decompose change in 3 lines.",
    "1. behavior: <one line what changes>",
    "2. state: <fields that change>",
    "3. verify: <command plus observed behavior>",
    DECOMPOSE_BLANK_PROMPT,
  ];
  try {
    const cleaned: string[] = [];
    if (Array.isArray(files)) {
      const seen = new Set<string>();
      for (const file of files) {
        const kept = cleanPath(file);
        if (kept === undefined || seen.has(kept)) continue;
        seen.add(kept);
        cleaned.push(kept);
      }
    }
    if (cleaned.length === 0) return blank();
    const shown = cleaned.slice(0, DECOMPOSE_MAX_FILES);
    const extra = cleaned.length - shown.length;
    const named = extra > 0 ? `${shown.join(", ")} and ${extra} more` : shown.join(", ");
    return [
      "decompose change in 3 lines.",
      `1. behavior: <one line what ${named} does>`,
      `2. state: <fields that change in ${named}>`,
      `3. verify: <command plus observed behavior for ${named}>`,
    ];
  } catch {
    return blank();
  }
}
