#!/usr/bin/env node
/**
 * rocky — a blind Eridian engineer who lives in your terminal.
 *
 * MVP surface:
 *   rocky run "<command>"     run a command; Rocky remembers failures & fixes
 *   rocky recall "<query>"    search Rocky's memory of past errors
 *   rocky stats               how much Rocky remembers
 *   rocky --help
 */

import { run } from "./commands/run.js";
import { recall } from "./commands/recall.js";
import { hookFail, hookSuccess } from "./commands/hook.js";
import { loadMemory, memoryPath } from "./core/memory.js";
import { face, say } from "./ui/rocky.js";

const HELP = `
rocky — he remembers, so you don't have to.

usage:
  rocky run "<command>"     run command through Rocky. failures are remembered;
                            when the same error returns, Rocky tells you what
                            fixed it last time.
  rocky recall "<query>"    ask Rocky's memory. matches words from the error
                            or the command.
  rocky stats               what Rocky holds in memory.

memory lives in ~/.rocky/memory.jsonl — local only, never uploaded.
`;

async function main(): Promise<number> {
  const [, , command, ...rest] = process.argv;
  const arg = rest.join(" ");

  switch (command) {
    case "run":
      return run(arg);
    case "recall":
      return recall(arg);
    case "stats":
      return stats();
    case "_hookfail":
      return hookFail(rest[0] ?? "", Number(rest[1] ?? 1), rest[2] ?? process.cwd());
    case "_hooksuccess":
      return hookSuccess(rest[0] ?? "", rest[1] ?? process.cwd());
    case "--help":
    case "-h":
    case "help":
    case undefined:
      console.log(face());
      console.log(HELP);
      return 0;
    default:
      say(`"${command}" is not command I know. run --help, question`);
      return 2;
  }
}

function stats(): number {
  const memory = loadMemory();
  const failures = memory.filter((r) => r.kind === "failure");
  const fixes = memory.filter((r) => r.kind === "fix");
  const resolved = failures.filter((f) => f.kind === "failure" && f.resolvedBy).length;
  console.log(face());
  say(`I remember ${failures.length} error${failures.length === 1 ? "" : "s"}. ${resolved} have fix. ${fixes.length} fix event${fixes.length === 1 ? "" : "s"} total.`);
  say(`memory file: ${memoryPath()}`);
  if (failures.length > resolved) {
    say(`${failures.length - resolved} error${failures.length - resolved === 1 ? "" : "s"} still without fix. you fix, I remember. good trade.`);
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    say(`something break inside me. bad bad bad. ${String(err)}`);
    process.exit(1);
  }
);
