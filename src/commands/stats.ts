import { dirname } from "node:path";
import { readJournal } from "../core/journal.js";
import { countReclaimTombstones, memoryPath, type MemoryRecord } from "../core/memory.js";
import { isOperationalMemoryRecord, loadMemoryChecked } from "../core/memory-read.js";
import { queryStats } from "../core/memory-query.js";
import { CYCLES_TOP, FAILURE_CYCLE_COUNT } from "../core/failure-cycle.js";
import { CliUsageError, reportCliUsage } from "./cli-args.js";
import { detail, face, say } from "../ui/rocky.js";

const STATS_USAGE = "rocky stats [--cycles]";

/** `stats` takes no arguments except the advisory `--cycles` summary flag. */
export function parseStatsArgs(argv: readonly string[]): boolean {
  if (argv.length === 0) return false;
  if (argv.length === 1 && argv[0] === "--cycles") return true;
  throw new CliUsageError(`unexpected argument: ${argv[0]}`, STATS_USAGE);
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
    say("memory file does not open for me. I answer from nothing.");
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
  console.log(face());
  if (ranked.length === 0) {
    say("no failure heard yet. nothing cycles.");
  } else {
    say(`I hear ${ranked.length} trouble shape${ranked.length === 1 ? "" : "s"}. top ${shown.length} listed.`);
    for (const [fp, count] of shown) detail(`${fp} x${count}`);
    const clustered = ranked.filter(([, count]) => count >= FAILURE_CYCLE_COUNT).length;
    if (clustered > 0) {
      detail(`${clustered} shape${clustered === 1 ? "" : "s"} heard ${FAILURE_CYCLE_COUNT} or more times. count only, no cause named.`);
    }
  }
  detail(`memory coverage: version ${coverage.version}, scanned ${coverage.scanned}, skipped ${coverage.skipped}, truncated ${coverage.truncated}, complete ${coverage.complete}`);
  return 0;
}

export function memoryAgeDays(timestamps: readonly number[], now: number): number {
  if (timestamps.length === 0) return 0;
  const oldest = timestamps.reduce((min, ts) => Math.min(min, ts), Number.POSITIVE_INFINITY);
  return Math.max(0, Math.floor((now - oldest) / 86_400_000));
}

export function stats(argv: readonly string[] = []): number {
  let cycles = false;
  try {
    cycles = parseStatsArgs(argv);
  } catch (error) {
    const code = reportCliUsage(error, say, detail);
    if (code !== undefined) return code;
    throw error;
  }
  if (cycles) return statsCycles();
  let records: MemoryRecord[];
  let coverage;
  try {
    const loaded = loadMemoryChecked();
    records = loaded.records;
    coverage = loaded.coverage;
  } catch {
    say("memory file does not open for me. I answer from nothing.");
    detail(`    memory: ${memoryPath()}`);
    return 1;
  }
  const result = queryStats(records);
  const confirmedFixes = result.confirmedFixes ?? result.fixEvents;
  const possibleFixes = result.possibleFixes ?? 0;
  const triples = result.triples ?? 0;
  const notes = result.notes ?? 0;
  const total = result.total ?? records.length;
  console.log(face());
  say(`I remember ${result.failures} error${result.failures === 1 ? "" : "s"}. ${result.resolved} have fix. ${result.fixEvents} fix event${result.fixEvents === 1 ? "" : "s"} total.`);
  say(`memory holds ${total} remembered item${total === 1 ? "" : "s"}. ${confirmedFixes} confirmed fix${confirmedFixes === 1 ? "" : "es"}. ${possibleFixes} possible fix${possibleFixes === 1 ? "" : "es"}. ${triples} triple${triples === 1 ? "" : "s"}. ${notes} note${notes === 1 ? "" : "s"}.`);
  say(`memory file: ${memoryPath()}`);
  const byKind = result.byKind ?? {};
  const kindSummary = Object.entries(byKind)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, count]) => `${kind} ${count}`)
    .join(", ");
  say(`events by kind: ${kindSummary.length === 0 ? "none yet" : kindSummary}.`);
  const ageDays = memoryAgeDays(records.map((record) => record.ts), Date.now());
  const journalCount = readJournal().records.length;
  const briefRuns = byKind["brief_run"] ?? 0;
  say(`memory age ${ageDays} day${ageDays === 1 ? "" : "s"}. ${briefRuns} brief run${briefRuns === 1 ? "" : "s"}. ${journalCount} journal note${journalCount === 1 ? "" : "s"}.`);
  // Gate denials are never counted here: that state is ephemeral (never
  // written to memory), and counting it would imply a durability Rocky
  // does not have.
  const rationaleByFidelity = result.rationaleByFidelity ?? { raw: 0, summary: 0, none: 0 };
  const rationaleTotal = byKind["rationale"] ?? 0;
  const aliasTotal = byKind["alias"] ?? 0;
  say(`rationale heard ${rationaleTotal} time${rationaleTotal === 1 ? "" : "s"}. raw ${rationaleByFidelity.raw}, summary ${rationaleByFidelity.summary}, none ${rationaleByFidelity.none}. alias ${aliasTotal} remembered.`);
  detail(`memory coverage: version ${coverage.version}, scanned ${coverage.scanned}, skipped ${coverage.skipped}, truncated ${coverage.truncated}, complete ${coverage.complete}`);
  const tombstones = countReclaimTombstones(dirname(memoryPath()));
  if (tombstones > 0) detail(`tombstones waiting sweep: ${tombstones}`);
  if (result.unresolved > 0) say(`${result.unresolved} error${result.unresolved === 1 ? "" : "s"} still without fix. you fix, I remember. good trade.`);
  return 0;
}
