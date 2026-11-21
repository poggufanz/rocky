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
import { sanitizeTestimony } from "../core/redact.js";
import { detail, say } from "../ui/rocky.js";
import { safeTerminalLine } from "../ui/sanitize.js";
import { formatUtcDate, formatUtcDateTime } from "./stats.js";

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

function sanitizeAttemptChanges(changes: Attempt["changes"]): Attempt["changes"] {
  if (changes.state === "observed") {
    return {
      ...changes,
      files: changes.files.map((file) => sanitizeTestimony(file)),
    };
  }
  if (changes.state === "testimony") {
    return {
      ...changes,
      files: changes.files.map((file) => sanitizeTestimony(file)),
    };
  }
  return changes;
}

export function sanitizeProblemEntry(entry: ProblemEntry): ProblemEntry {
  return {
    ...entry,
    signature: entry.signature.map((line) => sanitizeTestimony(line)),
    attempts: entry.attempts.map((attempt) => ({
      ...attempt,
      cmd: sanitizeTestimony(attempt.cmd),
      changes: sanitizeAttemptChanges(attempt.changes),
    })),
  };
}

export function formatAttemptChanges(changes: Attempt["changes"]): string {
  if (changes.state === "observed") {
    const files = changes.files.map((file) => safeTerminalLine(sanitizeTestimony(file)));
    if (files.length === 0) {
      return changes.more > 0 ? `edited (+${changes.more} more)` : "changes unknown";
    }
    const base = `edited ${files.join(", ")}`;
    return changes.more > 0 ? `${base} (+${changes.more} more)` : base;
  }
  if (changes.state === "testimony") {
    const files = changes.files.map((file) => safeTerminalLine(sanitizeTestimony(file)));
    return files.length > 0 ? `said: edited ${files.join(", ")}` : "changes unknown";
  }
  return "changes unknown";
}

function truncateDisplayCommand(cmd: string): string {
  const safe = safeTerminalLine(sanitizeTestimony(cmd));
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
    const sig = safeTerminalLine(sanitizeTestimony(rawSig));
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

type ExitFn = (code: number) => void;

interface PersistentStdoutErrorState {
  reported: boolean;
  exit: ExitFn;
  activeHandlers: Set<(error: unknown) => void>;
  suppressedFollowupError: unknown;
  hasSuppressedFollowupError: boolean;
}

const persistentStdoutErrorStates = new WeakMap<object, PersistentStdoutErrorState>();

function defaultProcessExit(code: number): void {
  process.exit(code);
}

function isEpipeError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "EPIPE";
}

function ensurePersistentStdoutErrorListener(
  stdout: {
    on: (event: "error", listener: (error: unknown) => void) => unknown;
  },
  exit: ExitFn = defaultProcessExit,
): PersistentStdoutErrorState {
  let state = persistentStdoutErrorStates.get(stdout);
  if (state !== undefined) {
    state.exit = exit;
    return state;
  }
  state = {
    reported: false,
    exit,
    activeHandlers: new Set(),
    suppressedFollowupError: undefined,
    hasSuppressedFollowupError: false,
  };
  persistentStdoutErrorStates.set(stdout, state);
  stdout.on("error", (error: unknown) => {
    if (state.activeHandlers.size > 0) {
      state.hasSuppressedFollowupError = true;
      state.suppressedFollowupError = error;
      const pending = [...state.activeHandlers];
      state.activeHandlers.clear();
      for (const handler of pending) handler(error);
      return;
    }
    if (state.hasSuppressedFollowupError && state.suppressedFollowupError === error) {
      state.hasSuppressedFollowupError = false;
      state.suppressedFollowupError = undefined;
      return;
    }
    if (isEpipeError(error)) return;
    if (!state.reported) {
      state.reported = true;
      say("Cannot write attempts output.");
    }
    state.exit(1);
  });
  return state;
}

function registerActiveStdoutErrorHandler(
  state: PersistentStdoutErrorState,
  handler: (error: unknown) => void,
): () => void {
  state.hasSuppressedFollowupError = false;
  state.suppressedFollowupError = undefined;
  state.activeHandlers.add(handler);
  return () => {
    state.activeHandlers.delete(handler);
  };
}

export async function writeStdoutQuietEpipe(
  payload: string,
  exit: ExitFn = defaultProcessExit,
): Promise<void> {
  const stdout = process.stdout as NodeJS.WriteStream;
  const hasOn = typeof stdout === "object" && stdout !== null && typeof stdout.on === "function";

  if (stdout.write.length < 2) {
    let capturedError: unknown;
    let hasCaptured = false;
    let unregister: (() => void) | undefined;
    if (hasOn) {
      const state = ensurePersistentStdoutErrorListener(stdout, exit);
      unregister = registerActiveStdoutErrorHandler(state, (error) => {
        if (!hasCaptured) {
          hasCaptured = true;
          capturedError = error;
        }
      });
    }
    try {
      stdout.write(payload);
    } catch (error) {
      unregister?.();
      if (!isEpipeError(error)) throw error;
      return;
    }
    unregister?.();
    if (hasCaptured && !isEpipeError(capturedError)) throw capturedError;
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let unregister: (() => void) | undefined;

    const settleSuccess = (): void => {
      if (settled) return;
      settled = true;
      unregister?.();
      resolve();
    };

    const settleError = (error: unknown): void => {
      if (settled) return;
      settled = true;
      unregister?.();
      if (isEpipeError(error)) resolve();
      else reject(error);
    };

    if (hasOn) {
      const state = ensurePersistentStdoutErrorListener(stdout, exit);
      unregister = registerActiveStdoutErrorHandler(state, settleError);
    }

    try {
      stdout.write(payload, (error?: Error | null) => {
        if (error) settleError(error);
        else settleSuccess();
      });
    } catch (error) {
      settleError(error);
    }
  });
}

export async function attempts(
  argv: readonly string[],
  deps?: { memory?: MemoryQueries; now?: number; cwd?: string; exit?: (code: number) => void },
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
  if (snapshot === undefined || snapshot.coverage.reason === "read-race") {
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

  const sanitizedEntries = entries.map(sanitizeProblemEntry);

  if (parsed.json) {
    await writeStdoutQuietEpipe(
      `${JSON.stringify({
        v: 1,
        coverage: baseSet.coverage,
        ungroupedLegacy: baseSet.ungroupedLegacy,
        entries: sanitizedEntries,
      })}\n`,
      deps?.exit,
    );
    return 0;
  }

  const filteredSet: ProblemSet = {
    entries: sanitizedEntries,
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
