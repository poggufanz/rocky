import { loadMemory, memoryPath, type MemoryRecord } from "../core/memory.js";
import { queryStats } from "../core/memory-query.js";
import { detail, face, say } from "../ui/rocky.js";

export function stats(): number {
  let records: MemoryRecord[];
  try {
    records = loadMemory();
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
  if (result.unresolved > 0) say(`${result.unresolved} error${result.unresolved === 1 ? "" : "s"} still without fix. you fix, I remember. good trade.`);
  return 0;
}
