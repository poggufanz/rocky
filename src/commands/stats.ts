import { dirname } from "node:path";
import { readJournal } from "../core/journal.js";
import { describeMemoryCoverage } from "../core/coverage.js";
import { countReclaimTombstones, drainGuardPending, memoryPath, type MemoryRecord } from "../core/memory.js";
import { isOperationalMemoryRecord, loadMemoryChecked, type MemoryCoverage } from "../core/memory-read.js";
import { createMemoryQueries, loadDurableMemorySnapshot, queryStats, type MemoryQueries } from "../core/memory-query.js";
import { CYCLES_TOP, FAILURE_CYCLE_COUNT } from "../core/failure-cycle.js";
import { resolveRockyPaths } from "../core/state-paths.js";
import { formatUtcDate, formatUtcDateTime } from "../core/utc-format.js";
import { CliUsageError, reportCliUsage } from "./cli-args.js";
import { detail, isVerbose, say } from "../ui/rocky.js";

const STATS_USAGE = "rocky stats [--cycles | --attempts [--json]]";

type StatsMode = { mode: "summary" } | { mode: "cycles" } | { mode: "attempts"; json: boolean };

interface StatsDeps {
  now?: number;
  memory?: MemoryQueries;
  home?: string;
}

/**
 * Disclosure for the counts printed above it. Whenever the read was not whole,
 * one line says so in plain words and warns that these counts are not
 * all. ROCKY_VERBOSE=1 also prints the raw counters, whole read or not, ending
 * with the reason a cap or race stopped the read when there is one.
 */
function speakCoverage(coverage: MemoryCoverage, recordCount: number): void {
  const words = describeMemoryCoverage(coverage, recordCount, { counts: true });
  if (words !== undefined) say(words);
  if (isVerbose()) {
    const reason = coverage.reason === undefined ? "" : `, reason ${coverage.reason}`;
    detail(`memory coverage: version ${coverage.version}, scanned ${coverage.scanned}, skipped ${coverage.skipped}, truncated ${coverage.truncated}, complete ${coverage.complete}${reason}`);
  }
}

export function parseStatsArgs(argv: readonly string[]): StatsMode {
  const [first, second] = argv;
  if (argv.length === 0) return { mode: "summary" };
  if (argv.length === 1 && first === "--cycles") return { mode: "cycles" };
  if (argv.length === 1 && first === "--attempts") return { mode: "attempts", json: false };
  if (argv.length === 2 && (
    (first === "--attempts" && second === "--json") || (first === "--json" && second === "--attempts")
  )) return { mode: "attempts", json: true };
  throw new CliUsageError(`unexpected argument: ${first}`, STATS_USAGE);
}

/**
 * Advisory repeat summary: top failure fingerprints with counts from one
 * bounded memory read. Counts only — a repeated fingerprint is never
 * presented as proof of cause. Always exits 0 once memory opens.
 */
function statsCycles(): number {
  let records: MemoryRecord[];
  let coverage;
  try {
    const loaded = loadMemoryChecked();
    records = loaded.records;
    coverage = loaded.coverage;
  } catch {
    say("Memory file could not be opened. No records were read.");
    detail(`    memory: ${memoryPath()}`);
    return 1;
  }
  const now = Date.now();
  const counts = new Map<string, number>();
  for (const record of records) {
    if (record.kind !== "failure" || !isOperationalMemoryRecord(record, now)) continue;
    counts.set(record.fingerprint, (counts.get(record.fingerprint) ?? 0) + 1);
  }
  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const shown = ranked.slice(0, CYCLES_TOP);
  if (ranked.length === 0) {
    say("No failures recorded yet. Nothing repeats.");
  } else {
    say(`${ranked.length} distinct error${ranked.length === 1 ? "" : "s"} recorded. Top ${shown.length} listed.`);
    for (const [fp, count] of shown) detail(`${fp} x${count}`);
    const clustered = ranked.filter(([, count]) => count >= FAILURE_CYCLE_COUNT).length;
    if (clustered > 0) {
      detail(`${clustered} distinct error${clustered === 1 ? "" : "s"} seen ${FAILURE_CYCLE_COUNT} or more times. Counts only; no cause is named.`);
    }
  }
  speakCoverage(coverage, records.length);
  return 0;
}

export function memoryAgeDays(timestamps: readonly number[], now: number): number {
  if (timestamps.length === 0) return 0;
  const oldest = timestamps.reduce((min, ts) => Math.min(min, ts), Number.POSITIVE_INFINITY);
  return Math.max(0, Math.floor((now - oldest) / 86_400_000));
}

async function statsAttempts(json: boolean, deps?: StatsDeps): Promise<number> {
  const { anchorIds, buildAttemptStudy, readExposureLog, readStudyStart, renderAttemptStudyText } =
    await import("../core/attempt-study.js");
  const home = deps?.home ?? resolveRockyPaths(process.env).home;
  const log = readExposureLog(home);
  if (log.state === "unreadable") {
    say("Exposure log cannot be read.");
    return 1;
  }
  const { rows, malformed, logFull } = log.state === "ok" ? log : { rows: [], malformed: 0, logFull: false };

  const now = deps?.now ?? Date.now();
  const snapshot = loadDurableMemorySnapshot(deps?.memory ?? createMemoryQueries(), now);
  if (snapshot === undefined || snapshot.coverage.reason === "read-race") {
    say("Memory cannot be read.");
    return 1;
  }

  const [{ buildProblems }, { joinAttemptCards }, { makeCardsFor, toolTextAllowed }] = await Promise.all([
    import("../core/attempts.js"),
    import("../core/attempt-cards.js"),
    import("../desk/cards-read.js"),
  ]);
  const { records, coverage } = snapshot;
  const problems = buildProblems(records, coverage, { now });
  const anchors = anchorIds(rows);
  const kept = problems.entries.filter((entry) => entry.attempts.some((attempt) => anchors.has(attempt.failureId)));
  const cardsFor = makeCardsFor({ home, toolText: toolTextAllowed(home) });
  const { entries } = joinAttemptCards(kept, records, cardsFor, { platform: process.platform });
  const start = readStudyStart(home, now);
  const report = buildAttemptStudy({ rows, malformed, logFull, records, entries, coverage, start, now });
  if (json) {
    const { writeStdoutQuietEpipe } = await import("./attempts.js");
    await writeStdoutQuietEpipe(`${JSON.stringify(report)}\n`);
    return 0;
  }

  const { head, details } = renderAttemptStudyText(report, home);
  say(head);
  for (const line of details) detail(line);
  speakCoverage(coverage, records.length);
  return 0;
}

export async function stats(argv: readonly string[] = [], deps?: StatsDeps): Promise<number> {
  let parsed: StatsMode;
  try {
    parsed = parseStatsArgs(argv);
  } catch (error) {
    const code = reportCliUsage(error, say, detail);
    if (code !== undefined) return code;
    throw error;
  }
  if (parsed.mode === "cycles") return statsCycles();
  if (parsed.mode === "attempts") return statsAttempts(parsed.json, deps);
  let drainedGuard = 0;
  try {
    drainedGuard = drainGuardPending().drained;
  } catch {
    drainedGuard = 0;
  }
  let records: MemoryRecord[];
  let coverage;
  try {
    const loaded = loadMemoryChecked();
    records = loaded.records;
    coverage = loaded.coverage;
  } catch {
    say("Memory file could not be opened. No records were read.");
    detail(`    memory: ${memoryPath()}`);
    return 1;
  }
  const result = queryStats(records);
  const confirmedFixes = result.confirmedFixes ?? result.fixEvents;
  const possibleFixes = result.possibleFixes ?? 0;
  const triples = result.triples ?? 0;
  const notes = result.notes ?? 0;
  const total = result.total ?? records.length;
  // Memory stores an intent as a "triple". The plain word is the default; ROCKY_VERBOSE=1 keeps the stored one.
  const intentWord = isVerbose() ? "triple" : "intent";
  say(`${result.failures} error${result.failures === 1 ? "" : "s"} recorded. ${result.resolved} ${result.resolved === 1 ? "has" : "have"} a fix. ${result.fixEvents} fix event${result.fixEvents === 1 ? "" : "s"} total.`);
  say(`Memory holds ${total} recorded item${total === 1 ? "" : "s"}. ${confirmedFixes} confirmed fix${confirmedFixes === 1 ? "" : "es"}. ${possibleFixes} possible fix${possibleFixes === 1 ? "" : "es"}. ${triples} ${intentWord}${triples === 1 ? "" : "s"}. ${notes} note${notes === 1 ? "" : "s"}.`);
  say(`memory file: ${memoryPath()}`);
  let latestFixTs: number | undefined;
  for (const record of records) {
    if (record.kind === "fix" && Number.isFinite(record.ts)) {
      if (latestFixTs === undefined || record.ts > latestFixTs) latestFixTs = record.ts;
    }
  }
  say(latestFixTs !== undefined
    ? `fix links: last written ${formatUtcDateTime(latestFixTs)}`
    : "fix links: none in the records read");
  if (coverage.window === "tail") {
    const fromSuffix = coverage.oldestTs !== undefined ? ` (from ${formatUtcDate(coverage.oldestTs)})` : "";
    const countLabel = records.length === 1 ? "the newest record" : `the newest ${records.length} records`;
    say(`memory: reading ${countLabel}${fromSuffix}`);
  }
  const byKind = result.byKind ?? {};
  if (isVerbose()) {
    const kindSummary = Object.entries(byKind)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([kind, count]) => `${kind} ${count}`)
      .join(", ");
    say(`events by kind: ${kindSummary.length === 0 ? "none yet" : kindSummary}.`);
  }
  const ageDays = memoryAgeDays(records.map((record) => record.ts), Date.now());
  const journalCount = readJournal().records.length;
  const briefRuns = byKind["brief_run"] ?? 0;
  const ageSentence = coverage.window === "tail"
    ? `The records read span ${ageDays} day${ageDays === 1 ? "" : "s"}.`
    : `Memory is ${ageDays} day${ageDays === 1 ? "" : "s"} old.`;
  say(`${ageSentence} ${briefRuns} brief run${briefRuns === 1 ? "" : "s"}. ${journalCount} journal note${journalCount === 1 ? "" : "s"}.`);
  // Gate denials are never counted here: that state is ephemeral (never
  // written to memory), and counting it would imply a durability rocky
  // does not have.
  if (isVerbose()) {
    const rationaleByFidelity = result.rationaleByFidelity ?? { raw: 0, summary: 0, none: 0 };
    const rationaleTotal = byKind["rationale"] ?? 0;
    const aliasTotal = byKind["alias"] ?? 0;
    say(`Rationale recorded ${rationaleTotal} time${rationaleTotal === 1 ? "" : "s"}: raw ${rationaleByFidelity.raw}, summary ${rationaleByFidelity.summary}, none ${rationaleByFidelity.none}. Aliases recorded: ${aliasTotal}.`);
  }
  const guardTotal = result.guardTotal ?? 0;
  const guardCancelled = result.guardCancelled ?? 0;
  const guardProceeded = result.guardProceeded ?? 0;
  if (guardTotal === 0) {
    say("Guard has not stopped any command yet.");
  } else {
    say(`Guard stopped ${guardTotal} command${guardTotal === 1 ? "" : "s"}. ${guardCancelled} cancelled. ${guardProceeded} proceeded.`);
    const guardByRule = result.guardByRule ?? {};
    const topRule = Object.entries(guardByRule).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0];
    if (topRule !== undefined) detail(`top guard rule: ${topRule[0]} (${topRule[1]})`);
  }
  if (drainedGuard > 0) detail(`guard pending drained: ${drainedGuard}`);
  speakCoverage(coverage, records.length);
  if (isVerbose()) {
    const tombstones = countReclaimTombstones(dirname(memoryPath()));
    if (tombstones > 0) detail(`tombstones waiting sweep: ${tombstones}`);
  }
  if (result.unresolved > 0) say(`${result.unresolved} error${result.unresolved === 1 ? "" : "s"} still without a fix.`);
  return 0;
}
