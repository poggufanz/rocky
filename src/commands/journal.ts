import { appendJournal } from "../core/journal.js";
import { resolveRockyPaths } from "../core/state-paths.js";
import { CliUsageError, reportCliUsage } from "./cli-args.js";
import { detail, say } from "../ui/rocky.js";

const USAGE = 'rocky journal "<note>"';

export function journalCommand(argv: readonly string[]): number {
  try {
    const args = argv[0] === "--" ? argv.slice(1) : [...argv];
    if (args.length === 0) throw new CliUsageError("journal needs note", USAGE);
    try {
      appendJournal(args.join(" "));
    } catch {
      say("Note was not saved: it is empty or the journal file could not be opened.");
      detail(`    journal: ${resolveRockyPaths().journal}`);
      return 1;
    }
    say("Journal note recorded.");
    return 0;
  } catch (error) {
    const code = reportCliUsage(error, say, detail);
    if (code !== undefined) return code;
    throw error;
  }
}
