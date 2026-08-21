import { say } from "../ui/rocky.js";
import { stats } from "./stats.js";
import { runDashboard } from "../ui/tui/dash.js";

export async function dashCommand(rest: string[]): Promise<number> {
  const initialQuery = rest.find((arg) => !arg.startsWith("--")) ?? "";
  if (process.stdout.isTTY !== true || process.stdin.isTTY !== true) {
    say(
      "dash need real terminal, this one pipe. I give stats instead. on git bash, try winpty rocky dash.",
    );
    return stats([]);
  }
  return runDashboard({
    initialQuery,
    stdout: process.stdout,
    stdin: process.stdin,
    env: process.env,
  });
}
