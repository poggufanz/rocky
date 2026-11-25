import {
  buildProblems,
  selectProblemEntries,
  type Attempt,
  type AttemptOutcome,
  type ProblemEntry,
  type ProblemSet,
} from "../core/attempts.js";
import { describeMemoryCoverage } from "../core/coverage.js";
import {
  createMemoryQueries,
  loadDurableMemorySnapshot,
  type MemoryQueries,
} from "../core/memory-query.js";
import {
  isCompleteMemoryCoverage,
  tailReadable,
  type MemoryCoverage,
  type MemoryRecord,
} from "../core/memory-read.js";
import { sanitizeTestimony } from "../core/redact.js";
import { resolveRockyPaths } from "../core/state-paths.js";
import { formatUtcDate, formatUtcDateTime } from "../core/utc-format.js";
import { detail, say } from "../ui/rocky.js";
import { safeTerminalLine } from "../ui/sanitize.js";

const DEFAULT_LIMIT = 10;
const MIN_LIMIT = 1;
const MAX_LIMIT = 50;
const MAX_CMD_DISPLAY_WIDTH = 24;
const OUTCOME_COLUMN_WIDTH = 18;
const FOOTER_TEXT = "Rocky records order, not cause.";
const CARD_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/u;
const EXPECTATION_LABELS: Record<NonNullable<Attempt["expectations"]>[number]["observed"], string> = {
  same_command_passed: "passed",
  same_command_failed: "failed",
  no_matching_run: "none yet",
  not_comparable: "not comparable",
};

export interface ParsedAttemptsArgs {
  query?: string;
  card?: string;
  allDirs: boolean;
  limit: number;
  json: boolean;
}

function parseLimitValue(next: string | undefined): number {
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
  return parsed;
}

function parseCardValue(next: string | undefined): string {
  if (next === undefined || next.startsWith("-")) {
    throw new Error("--card requires a card id");
  }
  if (!CARD_ID_RE.test(next)) {
    throw new Error("--card id must match ^[A-Za-z0-9._:-]{1,128}$");
  }
  return next;
}

function finalizeAttemptsArgs(
  queryTokens: readonly string[],
  card: string | undefined,
  allDirs: boolean,
  limit: number | undefined,
  json: boolean,
): ParsedAttemptsArgs {
  const joined = queryTokens.join(" ").trim();
  if (card !== undefined) {
    if (joined.length > 0) throw new Error("--card cannot be combined with a query");
    if (allDirs) throw new Error("--card cannot be combined with --all-dirs");
    if (!json) throw new Error("--card requires --json");
  }
  return {
    ...(joined.length > 0 ? { query: joined } : {}),
    ...(card !== undefined ? { card } : {}),
    allDirs,
    limit: limit ?? DEFAULT_LIMIT,
    json,
  };
}

export function parseAttemptsArgs(argv: readonly string[]): ParsedAttemptsArgs {
  let allDirs = false;
  let json = false;
  let limit: number | undefined;
  let card: string | undefined;
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
      limit = parseLimitValue(argv[i + 1]);
      i += 1;
      continue;
    }
    if (parsingOptions && token === "--card") {
      if (card !== undefined) throw new Error("repeated option: --card");
      card = parseCardValue(argv[i + 1]);
      i += 1;
      continue;
    }
    if (parsingOptions && token.startsWith("-")) {
      throw new Error(`unknown option: ${token}`);
    }
    queryTokens.push(token);
  }

  return finalizeAttemptsArgs(queryTokens, card, allDirs, limit, json);
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
  if (!tailReadable(coverage) || coverage.skipped > 0 || (incomplete && n === 0)) {
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
      for (const expectation of attempt.expectations ?? []) {
        const text = safeTerminalLine(expectation.text);
        const label = EXPECTATION_LABELS[expectation.observed];
        detailLines.push(`    agent expected: ${text}  next matching run: ${label}`);
      }
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
type WriteSettlement = "pending" | "resolved" | "rejected";

interface PersistentStdoutErrorState {
  reported: boolean;
  exit: ExitFn;
  activeHandlers: Set<(error: unknown) => void>;
  lastSettlement: WriteSettlement;
}

const persistentStdoutErrorStates = new WeakMap<object, PersistentStdoutErrorState>();

function defaultProcessExit(code: number): void {
  process.exit(code);
}

function isEpipeError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "EPIPE";
}

function flushStderrAndExit(exit: ExitFn): void {
  const stderr = process.stderr as NodeJS.WriteStream;
  if (typeof stderr !== "object" || stderr === null || typeof stderr.write !== "function") {
    exit(1);
    return;
  }
  if (stderr.write.length === 1) {
    stderr.write("");
    exit(1);
    return;
  }
  let exited = false;
  const finish = (): void => {
    if (exited) return;
    exited = true;
    exit(1);
  };
  try {
    stderr.write("", finish);
  } catch {
    finish();
  }
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
    lastSettlement: "pending",
  };
  persistentStdoutErrorStates.set(stdout, state);
  stdout.on("error", (error: unknown) => {
    if (state.activeHandlers.size > 0) {
      const pending = [...state.activeHandlers];
      state.activeHandlers.clear();
      for (const handler of pending) handler(error);
      return;
    }
    if (state.lastSettlement !== "resolved") return;
    if (isEpipeError(error)) return;
    if (!state.reported) {
      state.reported = true;
      say("Cannot write attempts output.");
      flushStderrAndExit(state.exit);
    }
  });
  return state;
}

function registerActiveStdoutErrorHandler(
  state: PersistentStdoutErrorState,
  handler: (error: unknown) => void,
): () => void {
  state.lastSettlement = "pending";
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
    let state: PersistentStdoutErrorState | undefined;
    if (hasOn) {
      state = ensurePersistentStdoutErrorListener(stdout, exit);
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
      if (!isEpipeError(error)) {
        if (state !== undefined) state.lastSettlement = "rejected";
        throw error;
      }
      if (state !== undefined) state.lastSettlement = "resolved";
      return;
    }
    unregister?.();
    if (hasCaptured && !isEpipeError(capturedError)) {
      if (state !== undefined) state.lastSettlement = "rejected";
      throw capturedError;
    }
    if (state !== undefined) state.lastSettlement = "resolved";
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let unregister: (() => void) | undefined;
    const state = hasOn ? ensurePersistentStdoutErrorListener(stdout, exit) : undefined;

    const settleSuccess = (): void => {
      if (settled) return;
      settled = true;
      if (state !== undefined) state.lastSettlement = "resolved";
      unregister?.();
      resolve();
    };

    const settleError = (error: unknown): void => {
      if (settled) return;
      settled = true;
      if (state !== undefined) {
        state.lastSettlement = isEpipeError(error) ? "resolved" : "rejected";
      }
      unregister?.();
      if (isEpipeError(error)) resolve();
      else reject(error);
    };

    if (state !== undefined) {
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

async function selectCardAttempts(
  records: readonly MemoryRecord[],
  coverage: MemoryCoverage,
  opts: { cardId: string; limit: number; now: number; cwd: string; home: string; toolText: boolean },
): Promise<{ set: ProblemSet; entries: ProblemEntry[] }> {
  const [{ joinAttemptCards }, { findCardById, makeCardsFor }, { isPathInside }] = await Promise.all([
    import("../core/attempt-cards.js"),
    import("../desk/cards-read.js"),
    import("../desk/cards-record.js"),
  ]);

  const baseSet = buildProblems(records, coverage, { now: opts.now, cwd: opts.cwd });
  let card: ReturnType<typeof findCardById>;
  try {
    card = findCardById(opts.cardId, { home: opts.home, toolText: opts.toolText });
  } catch {
    card = undefined;
  }
  if (card === undefined) {
    return { set: baseSet, entries: [] };
  }
  const inRoot = baseSet.entries.filter((entry) => isPathInside(entry.cwd, card.root));
  const cardsFor = makeCardsFor({ home: opts.home, toolText: opts.toolText });
  const joined = joinAttemptCards(inRoot, records, cardsFor, { platform: process.platform });
  const matched = joined.entries
    .filter((entry) =>
      entry.attempts.some((attempt) => joined.matchedCardByFailureId.get(attempt.failureId) === card.card_id),
    )
    .sort(
      (a, b) =>
        b.lastSeenTs - a.lastSeenTs || (a.problemId < b.problemId ? -1 : a.problemId > b.problemId ? 1 : 0),
    )
    .slice(0, opts.limit);
  return { set: baseSet, entries: matched };
}

async function selectAndJoinAttempts(
  records: readonly MemoryRecord[],
  coverage: MemoryCoverage,
  parsed: ParsedAttemptsArgs,
  now: number,
  cwd: string,
): Promise<{ set: ProblemSet; entries: ProblemEntry[]; cutoffTs?: number }> {
  const [{ joinAttemptCards }, { makeCardsFor, toolTextAllowed }] = await Promise.all([
    import("../core/attempt-cards.js"),
    import("../desk/cards-read.js"),
  ]);

  const home = resolveRockyPaths().home;
  const toolText = toolTextAllowed(home);

  if (parsed.card !== undefined) {
    return selectCardAttempts(records, coverage, {
      cardId: parsed.card,
      limit: parsed.limit,
      now,
      cwd,
      home,
      toolText,
    });
  }

  const { set, entries, cutoffTs } = selectProblemEntries(records, coverage, {
    now,
    cwd,
    query: parsed.query,
    allDirs: parsed.allDirs,
    limit: parsed.limit,
  });
  const cardsFor = makeCardsFor({ home, toolText });
  const joined = joinAttemptCards(entries, records, cardsFor, { platform: process.platform });
  return {
    set,
    entries: joined.entries,
    ...(cutoffTs === undefined ? {} : { cutoffTs }),
  };
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

  const { set: baseSet, entries, cutoffTs } = await selectAndJoinAttempts(
    snapshot.records,
    snapshot.coverage,
    parsed,
    now,
    cwd,
  );

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
