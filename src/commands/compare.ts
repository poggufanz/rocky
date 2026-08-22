/**
 * `rocky compare` — interactive side-by-side memory inspection by file.
 * On a real terminal it opens the compare surface; through a pipe it
 * speaks one line and exits 0, never breaking a scripted caller.
 */

import { say } from "../ui/rocky.js";
import { runSurface } from "../ui/tui/surface/shell.js";
import { surfaceEntry } from "../ui/tui/surface/entry.js";

export async function compareCommand(_rest: string[]): Promise<number> {
  const route = surfaceEntry("compare", process.stdout.isTTY === true && process.stdin.isTTY === true);
  if ("surface" in route && route.surface === "compare") {
    return runSurface({
      stdout: process.stdout,
      stdin: process.stdin,
      env: process.env,
      view: "compare",
    });
  }
  say("compare needs real terminal, this one pipe. try rocky recall, question");
  return 0;
}
