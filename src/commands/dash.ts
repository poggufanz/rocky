import { say } from "../ui/rocky.js";
import { stats } from "./stats.js";
import { guiCommand, guiWanted } from "./gui.js";

export async function dashCommand(rest: string[]): Promise<number> {
  if (guiWanted(rest, process.stdout.isTTY === true, process.stdin.isTTY === true)) return guiCommand(rest, "dash");

  // A browser needs a human at the keyboard, except under --no-open: that
  // serves the page and prints the URL, so no terminal is needed. Piped
  // otherwise, the honest answer is the numbers, not a door nobody will walk
  // through.
  say("dash need real terminal to open browser, this one pipe. I give stats instead.");
  return stats([]);
}
