/**
 * Hidden `rocky translate` command: the desktop daemon's local translation
 * installer and JSON-lines translation worker.
 */
import { resolveRockyPaths } from "../core/state-paths.js";
import { loadEngine, type EngineLoadResult } from "../translate/engine.js";
import { installTranslation } from "../translate/install.js";
import type { Lang, Pair } from "../translate/language.js";
import { MANIFEST } from "../translate/manifest.js";
import {
  translateQuote,
  type QuoteFailure,
  type TranslatorLoad,
} from "../translate/quote.js";
import { CliUsageError } from "./cli-args.js";
import { createLineReader, MAX_LINE_BYTES } from "./listen.js";

export const TRANSLATE_USAGE =
  "Usage: rocky translate install --pair <id-en|en-id> | rocky translate run";
const TRANSLATE_CLI_USAGE = TRANSLATE_USAGE.replace(/^Usage:\s*/, "");
export const MAX_KEY_CHARS = 128;
export const MAX_TEXT_CHARS = 4000;

export type TranslateRequest = { key: string; to: Lang; text: string };
export type TranslateReply =
  | { v: 1; key: string; ok: true; from: Lang; text: string }
  | { v: 1; key: string; ok: false; reason: QuoteFailure | "bad-request" };

function isLang(value: unknown): value is Lang {
  return value === "en" || value === "id";
}

function isPair(value: unknown): value is Pair {
  return value === "id-en" || value === "en-id";
}

/**
 * Parses one v1 translation request line.
 * Lines without a valid `v: 1` envelope or usable `key` return `undefined`;
 * addressable lines with invalid `to` or `text` return `{ key, bad: true }`.
 */
export function parseTranslateRequest(
  line: string,
): TranslateRequest | { key: string; bad: true } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const { v, key, to, text } = value as Record<string, unknown>;
  if (
    v !== 1 ||
    typeof key !== "string" ||
    key.length === 0 ||
    key.length > MAX_KEY_CHARS
  ) {
    return undefined;
  }

  if (!isLang(to) || typeof text !== "string" || text.length > MAX_TEXT_CHARS) {
    return { key, bad: true };
  }

  return { key, to, text };
}

/**
 * Reads JSON-line requests from `input`, translates sequentially in arrival order,
 * and writes one JSON-line reply per addressable request via `write`.
 */
export async function runTranslate(
  input: NodeJS.ReadableStream,
  write: (line: string) => void,
  load: (pair: Pair) => Promise<TranslatorLoad>,
): Promise<void> {
  let chain: Promise<void> = Promise.resolve();
  let failed = false;

  const handleLine = async (line: string): Promise<void> => {
    if (failed) return;
    const parsed = parseTranslateRequest(line);
    if (!parsed) return;

    if ("bad" in parsed) {
      const badReply: TranslateReply = {
        v: 1,
        key: parsed.key,
        ok: false,
        reason: "bad-request",
      };
      write(JSON.stringify(badReply));
      return;
    }

    let reply: TranslateReply;
    try {
      const result = await translateQuote(parsed.text, parsed.to, load);
      reply = result.ok
        ? {
            v: 1,
            key: parsed.key,
            ok: true,
            from: result.from,
            text: result.text,
          }
        : {
            v: 1,
            key: parsed.key,
            ok: false,
            reason: result.reason,
          };
    } catch {
      reply = {
        v: 1,
        key: parsed.key,
        ok: false,
        reason: "engine-error",
      };
    }

    write(JSON.stringify(reply));
  };

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      input.off("data", onData);
      input.off("end", finish);
      input.off("error", finish);
      input.off("close", finish);
    };
    const finish = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reader.end();
      resolve();
    };
    const onQueueError = (err: unknown): void => {
      if (settled) return;
      settled = true;
      failed = true;
      cleanup();
      reject(err);
    };
    const reader = createLineReader((line) => {
      if (failed) return;
      const next = chain.then(() => handleLine(line));
      next.catch(onQueueError);
      chain = next;
    }, MAX_LINE_BYTES);
    const onData = (chunk: Buffer | string): void => {
      reader.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
    };
    input.on("data", onData);
    input.on("end", finish);
    input.on("error", finish);
    input.on("close", finish);
  });

  await chain;
}

function createLazyLoader(home: string): (pair: Pair) => Promise<TranslatorLoad> {
  let enginePromise: Promise<EngineLoadResult> | undefined;
  const pairCache = new Map<Pair, TranslatorLoad>();

  return async (pair: Pair): Promise<TranslatorLoad> => {
    const cached = pairCache.get(pair);
    if (cached) return cached;

    if (!enginePromise) {
      enginePromise = loadEngine(home);
    }
    const engineResult = await enginePromise;
    if (!engineResult.ok) {
      return engineResult;
    }

    const pairResult = engineResult.engine.translator(pair);
    pairCache.set(pair, pairResult);
    return pairResult;
  };
}

async function flushStdout(): Promise<void> {
  if (!process.stdout.writableNeedDrain) return;
  await new Promise<void>((resolve) => {
    const done = (): void => {
      process.stdout.off("drain", done);
      process.stdout.off("error", done);
      process.stdout.off("close", done);
      resolve();
    };
    process.stdout.once("drain", done);
    process.stdout.once("error", done);
    process.stdout.once("close", done);
  });
}

export async function translateCommand(args: string[]): Promise<number> {
  if (args.length === 0) {
    throw new CliUsageError("missing translate subcommand", TRANSLATE_CLI_USAGE);
  }

  if (args[0] === "run") {
    if (args.length !== 1) {
      throw new CliUsageError(`unexpected argument: ${args[1]}`, TRANSLATE_CLI_USAGE);
    }

    let stdoutClosed = false;
    const onStdoutError = (): void => {
      stdoutClosed = true;
      process.stdin.destroy();
    };
    process.stdout.on("error", onStdoutError);

    try {
      await runTranslate(
        process.stdin,
        (line) => {
          if (!stdoutClosed) {
            process.stdout.write(`${line}\n`);
          }
        },
        createLazyLoader(resolveRockyPaths().home),
      );
      if (!stdoutClosed) {
        await flushStdout();
      }
    } finally {
      process.stdout.off("error", onStdoutError);
    }
    return 0;
  }

  if (args[0] === "install") {
    if (args.length !== 3 || args[1] !== "--pair") {
      throw new CliUsageError(
        "install requires --pair <id-en|en-id>",
        TRANSLATE_CLI_USAGE,
      );
    }
    const pair = args[2];
    if (!isPair(pair)) {
      throw new CliUsageError(`invalid translation pair: ${pair}`, TRANSLATE_CLI_USAGE);
    }

    let stdoutClosed = false;
    const onStdoutError = (): void => {
      stdoutClosed = true;
    };
    process.stdout.on("error", onStdoutError);

    const writeJsonLine = (payload: object): void => {
      if (!stdoutClosed) {
        process.stdout.write(`${JSON.stringify(payload)}\n`);
      }
    };

    try {
      const result = await installTranslation(resolveRockyPaths().home, pair, {
        fetch: globalThis.fetch,
        manifest: MANIFEST,
        onProgress(progress) {
          writeJsonLine({
            v: 1,
            kind: "progress",
            done_bytes: progress.done_bytes,
            total_bytes: progress.total_bytes,
          });
        },
      });
      if (result.ok) {
        writeJsonLine({ v: 1, kind: "result", ok: true });
        if (!stdoutClosed) await flushStdout();
        return 0;
      }
      writeJsonLine({ v: 1, kind: "result", ok: false, reason: result.reason });
      if (!stdoutClosed) await flushStdout();
      return 1;
    } finally {
      process.stdout.off("error", onStdoutError);
    }
  }

  throw new CliUsageError(
    `unknown translate subcommand: ${args[0]}`,
    TRANSLATE_CLI_USAGE,
  );
}
