import { loadMemory, memoryPath } from "../core/memory.js";
import { queryStats } from "../core/memory-query.js";
import { face, say } from "../ui/rocky.js";

export function stats(): number {
  const result = queryStats(loadMemory());
  console.log(face());
  say(`I remember ${result.failures} error${result.failures === 1 ? "" : "s"}. ${result.resolved} have fix. ${result.fixEvents} fix event${result.fixEvents === 1 ? "" : "s"} total.`);
  say(`memory file: ${memoryPath()}`);
  if (result.unresolved > 0) say(`${result.unresolved} error${result.unresolved === 1 ? "" : "s"} still without fix. you fix, I remember. good trade.`);
  return 0;
}
