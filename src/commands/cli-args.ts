/** Small, dependency-free parsers shared by public CLI commands. */

export class CliUsageError extends Error {
  constructor(
    message: string,
    public readonly usage: string,
  ) {
    super(message);
    this.name = "CliUsageError";
  }
}

export interface ParsedQueryArgs {
  query: string;
  useAi: boolean;
}

/** Reject every argument before a command reads or mutates state. */
export function parseNoArgs(argv: readonly string[], usage: string): void {
  if (argv.length === 0) return;
  throw new CliUsageError(`unexpected argument: ${argv[0]}`, usage);
}

/** `run` deliberately accepts one opaque command string, including its bytes. */
export function parseExactCommand(argv: readonly string[], usage: string): string {
  if (argv.length !== 1 || argv[0] === undefined || argv[0].trim().length === 0) {
    throw new CliUsageError("run needs exactly one non-empty command string", usage);
  }
  return argv[0];
}

/**
 * Parse a human query. Options are valid only before the first query token;
 * `--` makes every remaining token literal. This keeps `what --ai`
 * unambiguous while allowing `what -- --ai` to search for that exact word.
 */
export function parseQueryArgs(
  argv: readonly string[],
  options: { usage: string; allowAi?: boolean },
): ParsedQueryArgs {
  let terminated = false;
  let useAi = false;
  const query: string[] = [];

  for (const token of argv) {
    if (!terminated && token === "--") {
      terminated = true;
      continue;
    }
    if (!terminated && token === "--ai") {
      if (options.allowAi !== true || useAi || query.length > 0) {
        throw new CliUsageError(`unexpected option: ${token}`, options.usage);
      }
      useAi = true;
      continue;
    }
    if (!terminated && token.startsWith("-")) {
      throw new CliUsageError(`unexpected option: ${token}`, options.usage);
    }
    query.push(token);
  }

  return { query: query.join(" ").trim(), useAi };
}

/** Render a parser error through the command's normal persona/support sinks. */
export function reportCliUsage(
  error: unknown,
  speak: (line: string) => void,
  support: (line: string) => void,
): number | undefined {
  if (!(error instanceof CliUsageError)) return undefined;
  speak(`${error.message}. run rocky --help, question`);
  support(`usage: ${error.usage}`);
  return 2;
}
