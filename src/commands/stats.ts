import { readJournal } from "../core/journal.js";
import { memoryPath, type MemoryRecord } from "../core/memory.js";
import { loadMemoryChecked } from "../core/memory-read.js";
import { queryStats } from "../core/memory-query.js";
import { parseNoArgs, reportCliUsage } from "./cli-args.js";
import { detail, face, say } from "../ui/rocky.js";

export function memoryAgeDays(timestamps: readonly number[], now: number): number {
  if (timestamps.length === 0) return 0;
  const oldest = timestamps.reduce((min, ts) => Math.min(min, ts), Number.POSITIVE_INFINITY);
  return Math.max(0, Math.floor((now - oldest) / 86_400_000));
}

export function stats(argv: readonly string[] = []): number {
  try {
    parseNoArgs(argv, "rocky stats");
  } catch (error) {
    const code = reportCliUsage(error, say, detail);
    if (code !== undefined) return code;
    throw error;
  }
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
  detail(`memory coverage: version ${coverage.version}, scanned ${coverage.scanned}, skipped ${coverage.skipped}, truncated ${coverage.truncated}, complete ${coverage.complete}`);
  if (result.unresolved > 0) say(`${result.unresolved} error${result.unresolved === 1 ? "" : "s"} still without fix. you fix, I remember. good trade.`);
  return 0;
}
