/**
 * Pure builder for the prior-attempts note emitted when a recurring error
 * repeats in the current directory.
 *
 * Uses only observed run order and optional observed file-change records — never
 * stated testimony, expectations, or raw error text. Output is a single printable
 * ASCII line capped at `ATTEMPT_NOTE_MAX_BYTES` bytes with the non-causal
 * footer preserved.
 */

import { joinAttemptCards, type CardJoin } from "./attempt-cards.js";
import { buildProblems, type Attempt, type ProblemEntry } from "./attempts.js";
import { isCompleteMemoryCoverage, type MemoryCoverage, type MemoryRecord } from "./memory-read.js";
import { sanitizeTestimony } from "./redact.js";
import { formatUtcDate, formatUtcDateTime } from "./utc-format.js";

export const ATTEMPT_NOTE_MAX_BYTES = 600;
export const ATTEMPT_NOTE_MAX_ATTEMPTS = 5;

export type CardsFor = (cwd: string) => CardJoin;

export interface AttemptNote {
  key: string;
  fingerprint: string;
  text: string;
  bytes: number;
}

const THIRTY_DAYS_MS = 30 * 86_400_000;
const MAX_FILES_PER_CLAUSE = 3;
const FOOTER_NOTICE = "Rocky records order, not cause.";

function toPrintableAscii(text: string): string {
  return text.replace(/[^\x20-\x7e]/gu, "?");
}

function findMatchingHereEntry(
  records: readonly MemoryRecord[],
  coverage: MemoryCoverage,
  failure: { fingerprints: readonly string[]; cwd: string },
  opts: { now: number; platform: NodeJS.Platform },
): { entry: ProblemEntry; fingerprint: string } | undefined {
  for (const fp of failure.fingerprints) {
    if (fp.length === 0) continue;
    const set = buildProblems(records, coverage, {
      now: opts.now,
      fingerprint: fp,
      cwd: failure.cwd,
      platform: opts.platform,
    });
    const entry = set.entries.find((item) => item.cwdScope === "here");
    if (entry !== undefined) {
      return { entry, fingerprint: fp };
    }
  }
  return undefined;
}

interface OutcomeSummary {
  sameCount: number;
  diffCount: number;
  possiblePassCount: number;
  passedCount: number;
  latestPassedTs: number | undefined;
}

function summarizeOutcomes(attempts: readonly Attempt[]): OutcomeSummary {
  let sameCount = 0;
  let diffCount = 0;
  let possiblePassCount = 0;
  let passedCount = 0;
  let latestPassedTs: number | undefined;

  for (const attempt of attempts) {
    if (attempt.outcome === "same_failure") {
      sameCount += 1;
    } else if (attempt.outcome === "different_failure") {
      diffCount += 1;
    } else if (attempt.outcome === "possible_pass") {
      possiblePassCount += 1;
    } else if (attempt.outcome === "passed") {
      passedCount += 1;
      const passTs = attempt.outcomeTs ?? attempt.ts;
      if (latestPassedTs === undefined || passTs > latestPassedTs) {
        latestPassedTs = passTs;
      }
    }
  }

  return { sameCount, diffCount, possiblePassCount, passedCount, latestPassedTs };
}

function rerunWord(count: number): string {
  return count === 1 ? "rerun" : "reruns";
}

function buildOutcomeClause(totalRecent: number, summary: OutcomeSummary): string | undefined {
  const parts: string[] = [];
  if (summary.sameCount > 0) {
    parts.push(`${summary.sameCount} ${rerunWord(summary.sameCount)} failed the same way`);
  }
  if (summary.diffCount > 0) {
    parts.push(
      parts.length === 0
        ? `${summary.diffCount} ${rerunWord(summary.diffCount)} failed with another error`
        : `${summary.diffCount} failed with another error`,
    );
  }
  if (summary.possiblePassCount > 0) {
    const label = summary.possiblePassCount === 1 ? "possible pass" : "possible passes";
    parts.push(`${summary.possiblePassCount} ${label}`);
  }
  if (summary.passedCount > 0 && summary.latestPassedTs !== undefined) {
    const when = formatUtcDateTime(summary.latestPassedTs);
    parts.push(
      parts.length === 0
        ? `${summary.passedCount} ${rerunWord(summary.passedCount)} passed (${when})`
        : `${summary.passedCount} passed (${when})`,
    );
  }
  if (parts.length === 0) return undefined;

  const lead = totalRecent > ATTEMPT_NOTE_MAX_ATTEMPTS
    ? `After the last ${ATTEMPT_NOTE_MAX_ATTEMPTS} runs`
    : totalRecent === 1
      ? "After that run"
      : "After those runs";
  return `${lead}: ${parts.join(", ")}.`;
}

function collectClauseFiles(
  attempts: readonly Attempt[],
  outcome: "passed" | "same_failure",
  platform: NodeJS.Platform,
): string[] {
  const stats = new Map<string, { display: string; count: number; lastOrder: number; firstOrder: number }>();
  let globalOrder = 0;

  for (let attemptIndex = 0; attemptIndex < attempts.length; attemptIndex += 1) {
    const attempt = attempts[attemptIndex]!;
    if (attempt.outcome !== outcome) continue;
    if (attempt.changes.state !== "observed") continue;

    const seenInAttempt = new Set<string>();
    for (const rawPath of attempt.changes.files) {
      const identityRaw = sanitizeTestimony(rawPath).trim();
      if (identityRaw.length === 0) continue;
      const cleaned = toPrintableAscii(identityRaw).trim();
      if (cleaned.length === 0) continue;
      const key = platform === "win32" ? identityRaw.toLowerCase() : identityRaw;
      if (seenInAttempt.has(key)) continue;
      seenInAttempt.add(key);

      const existing = stats.get(key);
      if (existing === undefined) {
        stats.set(key, { display: cleaned, count: 1, lastOrder: attemptIndex, firstOrder: globalOrder });
      } else {
        existing.count += 1;
        existing.lastOrder = attemptIndex;
      }
      globalOrder += 1;
    }
  }

  return [...stats.values()]
    .sort((a, b) => (b.count - a.count) || (b.lastOrder - a.lastOrder) || (a.firstOrder - b.firstOrder))
    .slice(0, MAX_FILES_PER_CLAUSE)
    .map((item) => (item.count > 1 ? `${item.display} (${item.count})` : item.display));
}

function assembleNote(parts: {
  header: string;
  outcomesClause: string | undefined;
  passPrefix: string;
  passFiles: readonly string[];
  samePrefix: string;
  sameFiles: readonly string[];
  footer: string;
}): string {
  const segments: string[] = [parts.header];
  if (parts.outcomesClause !== undefined) {
    segments.push(parts.outcomesClause);
  }
  if (parts.passFiles.length > 0) {
    segments.push(`${parts.passPrefix}${parts.passFiles.join(", ")}.`);
  }
  if (parts.sameFiles.length > 0) {
    segments.push(`${parts.samePrefix}${parts.sameFiles.join(", ")}.`);
  }
  segments.push(parts.footer);
  return segments.join(" ");
}

function fitWithinBudget(parts: {
  header: string;
  outcomesClause: string | undefined;
  passPrefix: string;
  passFiles: readonly string[];
  samePrefix: string;
  sameFiles: readonly string[];
  footer: string;
}): { text: string; bytes: number } {
  const passFiles = [...parts.passFiles];
  const sameFiles = [...parts.sameFiles];
  let outcomesClause = parts.outcomesClause;
  let header = parts.header;

  let text = assembleNote({ ...parts, header, outcomesClause, passFiles, sameFiles });
  let bytes = Buffer.byteLength(text, "utf8");

  while (bytes > ATTEMPT_NOTE_MAX_BYTES) {
    if (sameFiles.length > 1) {
      sameFiles.pop();
    } else if (passFiles.length > 1) {
      passFiles.pop();
    } else if (sameFiles.length > 0) {
      sameFiles.length = 0;
    } else if (passFiles.length > 0) {
      passFiles.length = 0;
    } else if (outcomesClause !== undefined) {
      outcomesClause = undefined;
    } else {
      const footerBytes = Buffer.byteLength(parts.footer, "utf8");
      const maxHeaderBytes = Math.max(0, ATTEMPT_NOTE_MAX_BYTES - footerBytes - 1);
      header = header.slice(0, maxHeaderBytes).trimEnd();
      text = header.length > 0 ? `${header} ${parts.footer}` : parts.footer.slice(0, ATTEMPT_NOTE_MAX_BYTES);
      bytes = Buffer.byteLength(text, "utf8");
      break;
    }
    text = assembleNote({ ...parts, header, outcomesClause, passFiles, sameFiles });
    bytes = Buffer.byteLength(text, "utf8");
  }

  return { text, bytes };
}

/**
 * Build a single-line ASCII prior-attempts note from a pre-append memory
 * snapshot, or `undefined` when the failure moment is not eligible.
 */
export function priorAttemptsNote(
  records: readonly MemoryRecord[],
  coverage: MemoryCoverage,
  failure: { fingerprints: readonly string[]; cwd: string },
  opts: { now: number; cardsFor: CardsFor | undefined; platform: NodeJS.Platform },
): AttemptNote | undefined {
  const matched = findMatchingHereEntry(records, coverage, failure, {
    now: opts.now,
    platform: opts.platform,
  });
  if (matched === undefined) return undefined;

  const cutoffTs = opts.now - THIRTY_DAYS_MS;
  const recentAttempts = matched.entry.attempts.filter((attempt) => attempt.ts >= cutoffTs);
  if (recentAttempts.length === 0) return undefined;
  if (!recentAttempts.some((attempt) => attempt.outcome !== "passed")) return undefined;

  const windowAttempts = recentAttempts.slice(-ATTEMPT_NOTE_MAX_ATTEMPTS);
  const summary = summarizeOutcomes(windowAttempts);

  let passFiles: string[] = [];
  let sameFiles: string[] = [];
  if (opts.cardsFor !== undefined) {
    try {
      const trimmedEntry: ProblemEntry = { ...matched.entry, attempts: windowAttempts };
      const joined = joinAttemptCards([trimmedEntry], records, opts.cardsFor, {
        platform: opts.platform,
      });
      const joinedAttempts = joined.entries[0]?.attempts ?? windowAttempts;
      passFiles = collectClauseFiles(joinedAttempts, "passed", opts.platform);
      sameFiles = collectClauseFiles(joinedAttempts, "same_failure", opts.platform);
    } catch {
      passFiles = [];
      sameFiles = [];
    }
  }

  const totalRecent = recentAttempts.length;
  const timeWord = totalRecent === 1 ? "time" : "times";
  const firstDate = formatUtcDate(recentAttempts[0]!.ts);
  const partialCoverage =
    matched.entry.historyMayStartEarlier ||
    coverage.skipped > 0 ||
    !isCompleteMemoryCoverage(coverage);
  const header = partialCoverage
    ? `rocky: Same error recorded ${totalRecent} ${timeWord} before in this directory in the records read (earliest read ${firstDate}).`
    : `rocky: Same error recorded ${totalRecent} ${timeWord} before in this directory (first ${firstDate}).`;
  const outcomesClause = buildOutcomeClause(totalRecent, summary);
  const passPrefix = `Files edited before the passing ${rerunWord(summary.passedCount)}: `;
  const samePrefix = `Files edited before the same-way ${summary.sameCount === 1 ? "failure" : "failures"}: `;
  const safeFp = toPrintableAscii(sanitizeTestimony(matched.fingerprint)).trim();
  const footer = `${FOOTER_NOTICE} More: rocky attempts ${safeFp}`;

  const { text, bytes } = fitWithinBudget({
    header,
    outcomesClause,
    passPrefix,
    passFiles,
    samePrefix,
    sameFiles,
    footer,
  });

  return {
    key: matched.entry.key,
    fingerprint: matched.fingerprint,
    text,
    bytes,
  };
}
