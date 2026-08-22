export interface Command {
  name: string;
  usage: string;
  help: string;
  takesArgs: boolean;
}

export const COMMANDS: readonly Command[] = [
  { name: "run",      usage: "<cmd>",   help: "run command, rocky listens",              takesArgs: true },
  { name: "recall",   usage: "<query>", help: "ask memory by words",                    takesArgs: true },
  { name: "why",      usage: "<query>", help: "hear remembered reasons",                takesArgs: true },
  { name: "sessions", usage: "",        help: "work sessions derived from memory",      takesArgs: false },
  { name: "brief",    usage: "",        help: "hear what changed since last brief",     takesArgs: false },
  { name: "stats",    usage: "",        help: "what rocky holds in memory",             takesArgs: false },
  { name: "compare",  usage: "",        help: "compare file moments, side by side",     takesArgs: false },
  { name: "browse",   usage: "",        help: "browse all memory",                      takesArgs: false },
  { name: "help",     usage: "",        help: "command list",                           takesArgs: false },
  { name: "home",     usage: "",        help: "back to dashboard",                      takesArgs: false },
  { name: "quit",     usage: "",        help: "leave",                                  takesArgs: false },
];

export function matchCommands(prefix: string): Command[] {
  return COMMANDS.filter((c) => c.name.startsWith(prefix));
}

export function parseInput(raw: string): { cmd: string; arg: string } {
  const line = raw.trim().replace(/^\//, "");
  const sp = line.indexOf(" ");
  if (sp === -1) return { cmd: line, arg: "" };
  return { cmd: line.slice(0, sp), arg: line.slice(sp + 1).trim() };
}
