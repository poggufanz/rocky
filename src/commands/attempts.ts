import {
  buildProblems,
  type Attempt,
  type AttemptOutcome,
  type ProblemEntry,
  type ProblemSet,
} from "../core/attempts.js";
import { describeMemoryCoverage } from "../core/coverage.js";
import {
  createMemoryQueries,
  loadDurableMemorySnapshot,
  queryRecall,
  type MemoryQueries,
} from "../core/memory-query.js";
import { isCompleteMemoryCoverage } from "../core/memory-read.js";
import { detail, say } from "../ui/rocky.js";
import { safeTerminalLine } from "../ui/sanitize.js";

const DEFAULT_LIMIT = 10;
const MIN_LIMIT = 1;
const MAX_LIMIT = 50;
const THIRTY_DAYS_MS = 30 * 86_400_000;
const MAX_CMD_DISPLAY_WIDTH = 24;
const OUTCOME_COLUMN_WIDTH = 18;
const FINGERPRINT_HEX_RE = /^[0-9a-f]{16}$/u;
const FOOTER_TEXT = "Rocky records order, not cause.";

export interface ParsedAttemptsArgs {
  query?: string;
  allDirs: boolean;
  limit: number;
  json: boolean;
}

export function parseAttemptsArgs(argv: readonly string[]): ParsedAttemptsArgs {
  let allDirs = false;
  let json = false;
  let limit: number | undefined;
  let parsingOptions = true;
  const queryTokens: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (parsingOptions && token === "--") {
      parsingOptions = false;
      continue;
    }
    if (parsingOptions && token === "--all-dirs") {
      if (allDirs) throw new Error("repeated option: --all-dirs");
      allDirs = true;
      continue;
    }
    if (parsingOptions && token === "--json") {
      if (json) throw new Error("repeated option: --json");
      json = true;
      continue;
    }
    if (parsingOptions && token === "--limit") {
      if (limit !== undefined) throw new Error("repeated option: --limit");
      const next = argv[i + 1];
      if (next === undefined) {
        throw new Error("--limit requires an integer between 1 and 50");
      }
      if (!/^\d+$/u.test(next)) {
        throw new Error("--limit must be an integer between 1 and 50");
      }
      const parsed = Number(next);
      if (!Number.isSafeInteger(parsed) || parsed < MIN_LIMIT || parsed > MAX_LIMIT) {
        throw new Error("--limit must be an integer between 1 and 50");
      }
      limit = parsed;
      i += 1;
      continue;
    }
    if (parsingOptions && token.startsWith("-")) {
      throw new Error(`unknown option: ${token}`);
    }
    queryTokens.push(token);
  }

  const joined = queryTokens.join(" ").trim();
  return {
    ...(joined.length > 0 ? { query: joined } : {}),
    allDirs,
    limit: limit ?? DEFAULT_LIMIT,
    json,
  };
}

function formatUtcDate(ts: number): string {
  const d = new Date(ts);
  const year = String(d.getUTCFullYear()).padStart(4, "0");
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatUtcDateTime(ts: number): string {
  const d = new Date(ts);
  const hours = String(d.getUTCHours()).padStart(2, "0");
  const minutes = String(d.getUTCMinutes()).padStart(2, "0");
  return `${formatUtcDate(ts)} ${hours}:${minutes}`;
}

export function formatAttemptOutcome(outcome: AttemptOutcome): string {
  switch (outcome) {
    case "passed":
      return "passed";
    case "possible_pass":
      return "possible pass";
    case "same_failure":
      return "failed same way";
    case "different_failure":
      return "other error";
    case "no_later_run":
      return "no later run";
    case "unknown":
      return "unknown";
  }
}

export function formatAttemptChanges(changes: Attempt["changes"]): string {
  if (changes.state === "observed") {
    const files = changes.files.map((file) => safeTerminalLine(file));
    if (files.length === 0) {
      return changes.more > 0 ? `edited (+${changes.more} more)` : "changes unknown";
    }
    const base = `edited ${files.join(", ")}`;
    return changes.more > 0 ? `${base} (+${changes.more} more)` : base;
  }
  if (changes.state === "testimony") {
    const files = changes.files.map((file) => safeTerminalLine(file));
    return files.length > 0 ? `said: edited ${files.join(", ")}` : "changes unknown";
  }
  return "changes unknown";
}

function truncateDisplayCommand(cmd: string): string {
  const safe = safeTerminalLine(cmd);
  const chars = [...safe];
  if (chars.length <= MAX_CMD_DISPLAY_WIDTH) return safe;
  return `${chars.slice(0, MAX_CMD_DISPLAY_WIDTH - 1).join("")}…`;
}

function padDisplay(value: string, width: number): string {
  const len = [...value].length;
  return len >= width ? value : `${value}${" ".repeat(width - len)}`;
}

export interface RenderedProblemsText {
  header: string;
  coverageLine?: string;
  detailLines: string[];
  footer: string;
}

export function renderProblemsText(
  problemSet: ProblemSet,
  opts: {
    now: number;
    cwd: string;
    allDirs: boolean;
    query?: string;
    totalRecords: number;
    cutoffTs?: number;
  },
): RenderedProblemsText {
  const { entries, coverage } = problemSet;
  const n = entries.length;
  const safeCwd = safeTerminalLine(opts.cwd);
  const isTail = coverage.window === "tail";
  const incomplete = !isCompleteMemoryCoverage(coverage);

  let header: string;
  if (n === 0) {
    if (opts.query !== undefined) {
      header = `No matching errors for "${safeTerminalLine(opts.query)}".`;
    } else if (opts.allDirs) {
      header = "No repeated errors in all directories.";
    } else {
      header = `No repeated errors in ${safeCwd}.`;
    }
  } else {
    const noun = opts.query !== undefined
      ? `matching error${n === 1 ? "" : "s"}`
      : `repeated error${n === 1 ? "" : "s"}`;
    const place = opts.allDirs ? "in all directories" : `in ${safeCwd}`;
    let tailSuffix = "";
    if (isTail) {
      const recordWord = opts.totalRecords === 1 ? "record" : "records";
      const fromPart = coverage.oldestTs !== undefined ? `, from ${formatUtcDate(coverage.oldestTs)}` : "";
      tailSuffix = ` (newest ${opts.totalRecords} ${recordWord}${fromPart})`;
    }
    header = `${n} ${noun} ${place}${tailSuffix}`;
  }

  let coverageLine: string | undefined;
  if (incomplete && (!isTail || n === 0)) {
    coverageLine = describeMemoryCoverage(coverage, opts.totalRecords, { counts: false });
  }

  const detailLines: string[] = [];
  for (const entry of entries) {
    const visibleAttempts = opts.cutoffTs !== undefined
      ? entry.attempts.filter((attempt) => attempt.ts >= opts.cutoffTs!)
      : entry.attempts;
    const rawSig = entry.signature[0] ?? visibleAttempts[0]?.cmd ?? entry.attempts[0]?.cmd ?? "";
    const sig = safeTerminalLine(rawSig);
    const elsewhereSuffix = entry.cwdScope === "elsewhere" ? `  (in ${safeTerminalLine(entry.cwd)})` : "";
    detailLines.push(`${entry.problemId}  ${sig}${elsewhereSuffix}`);

    const displayCmds = visibleAttempts.map((attempt) => truncateDisplayCommand(attempt.cmd));
    let cmdWidth = 0;
    for (const cmd of displayCmds) {
      const len = [...cmd].length;
      if (len > cmdWidth) cmdWidth = len;
    }

    for (let i = 0; i < visibleAttempts.length; i += 1) {
      const attempt = visibleAttempts[i]!;
      const tsText = formatUtcDateTime(attempt.ts);
      const cmdText = padDisplay(displayCmds[i]!, cmdWidth);
      const outcomeText = padDisplay(formatAttemptOutcome(attempt.outcome), OUTCOME_COLUMN_WIDTH);
      const changesText = formatAttemptChanges(attempt.changes);
      detailLines.push(`  ${tsText}  ${cmdText}  ${outcomeText}  ${changesText}`);
    }
  }

  return {
    header,
    ...(coverageLine === undefined ? {} : { coverageLine }),
    detailLines,
    footer: FOOTER_TEXT,
  };
}

export async function attempts(
  argv: readonly string[],
  deps?: { memory?: MemoryQueries; now?: number; cwd?: string },
): Promise<number> {
  let parsed: ParsedAttemptsArgs;
  try {
    parsed = parseAttemptsArgs(argv);
  } catch (error) {
    say("Invalid option for attempts.");
    detail(error instanceof Error ? error.message : "unknown option");
    return 2;
  }

  const now = deps?.now ?? Date.now();
  const cwd = deps?.cwd ?? process.cwd();
  const memory = deps?.memory ?? createMemoryQueries();
  const snapshot = loadDurableMemorySnapshot(memory, now);
  if (snapshot === undefined) {
    say("Memory cannot be read.");
    return 1;
  }

  let baseSet: ProblemSet;
  let entries: ProblemEntry[];
  let cutoffTs: number | undefined;

  if (parsed.query === undefined) {
    cutoffTs = now - THIRTY_DAYS_MS;
    baseSet = buildProblems(snapshot.records, snapshot.coverage, { now, cwd });
    const recentCount = (entry: ProblemEntry): number => {
      let count = 0;
      for (const attempt of entry.attempts) {
        if (attempt.ts >= cutoffTs!) count += 1;
      }
      return count;
    };
    const recentNonPassed = (entry: ProblemEntry): number => {
      let count = 0;
      for (const attempt of entry.attempts) {
        if (attempt.ts >= cutoffTs! && attempt.outcome !== "passed") count += 1;
      }
      return count;
    };
    entries = baseSet.entries
      .filter((entry) => (parsed.allDirs || entry.cwdScope === "here") && recentCount(entry) >= 2)
      .sort((a, b) =>
        recentNonPassed(b) - recentNonPassed(a) ||
        b.lastSeenTs - a.lastSeenTs ||
        (a.problemId < b.problemId ? -1 : a.problemId > b.problemId ? 1 : 0),
      )
      .slice(0, parsed.limit);
  } else if (FINGERPRINT_HEX_RE.test(parsed.query)) {
    baseSet = buildProblems(snapshot.records, snapshot.coverage, {
      now,
      fingerprint: parsed.query,
      cwd,
    });
    entries = baseSet.entries
      .filter((entry) => parsed.allDirs || entry.cwdScope === "here")
      .slice(0, parsed.limit);
  } else {
    baseSet = buildProblems(snapshot.records, snapshot.coverage, { now, cwd });
    const hits = queryRecall(snapshot.records, { query: parsed.query, limit: 50, now });
    const eligible = baseSet.entries.filter((entry) => parsed.allDirs || entry.cwdScope === "here");
    const seenProblemIds = new Set<string>();
    const matched: ProblemEntry[] = [];
    for (const hit of hits) {
      for (const entry of eligible) {
        if (seenProblemIds.has(entry.problemId)) continue;
        if (entry.family.includes(hit.failure.fingerprint)) {
          seenProblemIds.add(entry.problemId);
          matched.push(entry);
          if (matched.length >= parsed.limit) break;
        }
      }
      if (matched.length >= parsed.limit) break;
    }
    entries = matched;
  }

  if (parsed.json) {
    process.stdout.write(
      `${JSON.stringify({
        v: 1,
        coverage: baseSet.coverage,
        ungroupedLegacy: baseSet.ungroupedLegacy,
        entries,
      })}\n`,
    );
    return 0;
  }

  const filteredSet: ProblemSet = {
    entries,
    coverage: baseSet.coverage,
    ungroupedLegacy: baseSet.ungroupedLegacy,
  };
  const rendered = renderProblemsText(filteredSet, {
    now,
    cwd,
    allDirs: parsed.allDirs,
    totalRecords: snapshot.records.length,
    ...(parsed.query === undefined ? {} : { query: parsed.query }),
    ...(cutoffTs === undefined ? {} : { cutoffTs }),
  });

  say(rendered.header);
  if (rendered.coverageLine !== undefined) detail(rendered.coverageLine);
  for (const line of rendered.detailLines) detail(line);
  say(rendered.footer);
  return 0;
}
