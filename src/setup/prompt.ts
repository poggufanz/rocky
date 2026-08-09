import { createReadStream, createWriteStream, openSync } from "node:fs";
import { createInterface } from "node:readline/promises";

export interface PromptPort {
  ask(message: string, timeoutMs?: number): Promise<string | undefined>;
  confirm(message: string, timeoutMs?: number): Promise<boolean>;
}

export interface PromptInput {
  isTTY?: boolean;
  read?: (size?: number) => unknown;
}

async function ask(
  input: PromptInput,
  output: NodeJS.WritableStream,
  message: string,
  timeoutMs?: number,
): Promise<string | undefined> {
  if (input.isTTY !== true) return undefined;
  const terminal = createInterface({
    input: input as NodeJS.ReadableStream,
    output,
    terminal: true,
  });
  const controller = timeoutMs === undefined ? undefined : new AbortController();
  const timer = timeoutMs === undefined
    ? undefined
    : setTimeout(() => controller!.abort(), timeoutMs);
  try {
    return controller === undefined
      ? await terminal.question(message)
      : await terminal.question(message, { signal: controller.signal });
  } catch (error) {
    if (controller?.signal.aborted === true) return undefined;
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    terminal.close();
  }
}

export function createPromptPort(
  input: PromptInput = process.stdin,
  output: NodeJS.WritableStream = process.stderr,
): PromptPort {
  return {
    ask(message, timeoutMs) {
      return ask(input, output, message, timeoutMs);
    },
    async confirm(message, timeoutMs) {
      const answer = await ask(input, output, `${message} [y/N] `, timeoutMs);
      if (answer === undefined) return false;
      const normalized = answer.trim().toLowerCase();
      return normalized === "y" || normalized === "yes";
    },
  };
}

interface TtyAttempt {
  available: boolean;
  answer?: string;
}

type ControllingTerminalAsk = (message: string, timeoutMs?: number) => Promise<TtyAttempt>;

async function askTty(message: string, timeoutMs?: number): Promise<TtyAttempt> {
  let input: ReturnType<typeof createReadStream> | undefined;
  let output: ReturnType<typeof createWriteStream> | undefined;
  try {
    input = createReadStream("/dev/tty", { fd: openSync("/dev/tty", "r"), autoClose: true });
    output = createWriteStream("/dev/tty", { fd: openSync("/dev/tty", "w"), autoClose: true });
  } catch {
    input?.destroy();
    output?.end();
    return { available: false };
  }
  try {
    return { available: true, answer: await ask(Object.assign(input, { isTTY: true }), output, message, timeoutMs) };
  } finally {
    input?.destroy();
    output?.end();
  }
}

/** A prompt backed by the controlling terminal, independent of piped stdin. */
export function createTtyPromptPort(
  fallbackInput: PromptInput = process.stdin,
  fallbackOutput: NodeJS.WritableStream = process.stderr,
  controllingAsk: ControllingTerminalAsk = askTty,
): PromptPort | undefined {
  if (process.stderr.isTTY !== true && fallbackInput.isTTY !== true) return undefined;
  const askWithFallback = async (message: string, timeoutMs?: number): Promise<string | undefined> => {
    const result = await controllingAsk(message, timeoutMs);
    if (result.available) return result.answer;
    return ask(fallbackInput, fallbackOutput, message, timeoutMs);
  };
  return {
    ask: askWithFallback,
    async confirm(message, timeoutMs) {
      const answer = await askWithFallback(`${message} [y/N] `, timeoutMs);
      if (answer === undefined) return false;
      const normalized = answer.trim().toLowerCase();
      return normalized === "y" || normalized === "yes";
    },
  };
}
