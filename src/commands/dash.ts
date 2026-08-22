import { say } from "../ui/rocky.js";
import { stats } from "./stats.js";
import { runSurface } from "../ui/tui/surface/shell.js";
import { surfaceEntry } from "../ui/tui/surface/entry.js";

export async function dashCommand(rest: string[]): Promise<number> {
  const initialQuery = rest.find((arg) => !arg.startsWith("--")) ?? "";
  const route = surfaceEntry("dash", process.stdout.isTTY === true && process.stdin.isTTY === true);
  if ("surface" in route && route.surface === "compare") {
    return runSurface({
      stdout: process.stdout,
      stdin: process.stdin,
      env: process.env,
      view: "compare",
    });
  }
  say(
    "dash need real terminal, this one pipe. I give stats instead. on git bash, try winpty rocky dash.",
  );
  return stats([]);
}
