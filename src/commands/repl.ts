/**
 * `rocky repl` -- a deterministic loop over Rocky's existing memory
 * commands: recall, what, why, how, concepts, sessions. Not a chatbot.
 * node:readline reads one line, the first word picks a command from a
 * fixed table, the rest of the line becomes that command's argv, and the
 * matching in-process function runs. No subprocess, no model, no parsing
 * cleverness. Unknown input gets the command list back, in Rocky's voice.
 *
 * The loop must never crash: a bad line loses the person's place, which is
 * worse than no repl at all. Every dispatch is wrapped so a thrown command
 * becomes a spoken line instead of a stack trace, and the loop re-prompts.
 */

import { createInterface } from "node:readline";
import { recall } from "./recall.js";
import { how, what, why } from "./dictionary.js";
import { conceptsCommand } from "./concepts.js";
import { sessionsCommand } from "./sessions.js";
import { detail, prompt as rockyPrompt, say } from "../ui/rocky.js";

const UNKNOWN_COMMAND =
  "not command. rocky hears: recall, what, why, how, concepts, sessions, help, quit. try again, question";

/** Commands whose argv accepts `--ai` when the repl session itself was started with it. */
const AI_AWARE_COMMANDS = new Set(["recall", "why"]);

export type ReplCommandHandler = (argv: string[]) => number | Promise<number>;

/** Rocky's real command functions, unwrapped -- the production dispatch table. */
function defaultDispatch(): Record<string, ReplCommandHandler> {
  return {
    recall,
    what,
    why,
    how,
    concepts: conceptsCommand,
    concept: conceptsCommand,
    sessions: sessionsCommand,
  };
}

function printHelp(): void {
  detail("recall <query>   ask memory, find matching failure and fix.");
  detail("what <query>     look up what remembered intent became.");
  detail("why <file>       hear why remembered change touched file.");
  detail("how <query>      remember how intent became code.");
  detail("concepts         list concepts heard in memory.");
  detail("concept <id>     hear evidence for one concept.");
  detail("sessions         list recent work sessions.");
  detail("help             show this list.");
  detail("quit, exit       leave repl.");
}

/**
 * Query parsers only recognize `--ai` before the query text starts, so it
 * must go first, and never twice -- both `recall` and `why` reject a
 * repeated `--ai` as a usage error rather than a crash, but there is no
 * reason to trigger that when the person already typed it themselves.
 */
function withAiFlag(command: string, rest: string[], useAi: boolean): string[] {
  if (!useAi || !AI_AWARE_COMMANDS.has(command) || rest.includes("--ai")) return rest;
  return ["--ai", ...rest];
}

/**
 * Run one already-tokenized line against a dispatch table. Exported (not
 * just used by replCommand) because none of Rocky's real commands throw --
 * they catch their own errors and return a code -- so the only way to prove
 * this try/catch actually survives a thrown command is to inject a handler
 * that does one.
 */
export async function runReplCommand(
  command: string,
  rest: string[],
  useAi: boolean,
  dispatch: Record<string, ReplCommandHandler> = defaultDispatch(),
): Promise<number> {
  if (command === "help") {
    printHelp();
    return 0;
  }
  const handler = dispatch[command];
  if (handler === undefined) {
    say(UNKNOWN_COMMAND);
    return 0;
  }
  try {
    const result = handler(withAiFlag(command, rest, useAi));
    return typeof result === "number" ? result : await result;
  } catch {
    say("command stumbled. rocky still here.");
    return 1;
  }
}

interface ParsedLine {
  command: string;
  rest: string[];
}

/** Whitespace-split only -- no quoting, no shell grammar. */
function parseLine(raw: string): ParsedLine | undefined {
  const tokens = raw.trim().split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) return undefined;
  const [command, ...rest] = tokens;
  return { command, rest };
}

export async function replCommand(argv: readonly string[], input?: NodeJS.ReadableStream): Promise<number> {
  const useAi = argv.includes("--ai");
  const rl = createInterface({
    input: input ?? process.stdin,
    output: process.stderr,
    prompt: rockyPrompt("rocky>"),
  });

  return new Promise<number>((resolve) => {
    let finished = false;
    const finish = (code: number): void => {
      if (finished) return;
      finished = true;
      rl.close();
      resolve(code);
    };

    // Ctrl-C: readline intercepts SIGINT itself once a listener exists, so
    // registering one is what makes it exit instead of silently pausing.
    rl.on("SIGINT", () => finish(0));
    // Ctrl-D / end of piped input.
    rl.on("close", () => finish(0));

    rl.on("line", (raw: string) => {
      if (finished) return;
      const parsed = parseLine(raw);
      if (parsed === undefined) {
        rl.prompt();
        return;
      }
      const { command, rest } = parsed;
      if (command === "quit" || command === "exit") {
        finish(0);
        return;
      }
      rl.pause();
      runReplCommand(command, rest, useAi)
        .catch(() => {
          // runReplCommand never rejects; this is a last-resort net so a
          // future change to it can never take the loop down with it.
          say("command stumbled. rocky still here.");
        })
        .then(() => {
          if (finished) return;
          rl.resume();
          rl.prompt();
        });
    });

    rl.prompt();
  });
}
