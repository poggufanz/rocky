import { say } from "../ui/rocky.js";
import { stats } from "./stats.js";
import { guiCommand } from "./gui.js";

export async function dashCommand(rest: string[]): Promise<number> {
  const tty = process.stdout.isTTY === true && process.stdin.isTTY === true;
  if (tty) return guiCommand(rest, "dash");

  // A browser needs a human at the keyboard. Piped, the honest answer is the
  // numbers, not a door nobody will walk through.
  say("dash need real terminal to open browser, this one pipe. I give stats instead.");
  return stats([]);
}
