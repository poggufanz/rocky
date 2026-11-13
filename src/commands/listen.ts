/**
 * Hidden `rocky listen collect --stdio`: the desktop daemon's capture process.
 * It runs the collector loop with no GUI and talks in JSON lines. stdin
 * carries `{"v":1,"root":"<absolute path>"}` requests; stdout carries `roots`
 * and `result` lines and nothing else. All human text goes to stderr.
 */
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { isAbsolute } from "node:path";
import { resolveRockyPaths } from "../core/state-paths.js";
import { say } from "../ui/rocky.js";
import {
  CAPTURE_FULL_EVERY_MS,
  startCollectorLoop,
  type ReconcileReport,
  type RootOwnership,
} from "../listening/collector-loop.js";

/** Longest request line read. A longer line is dropped whole, never buffered. */
export const MAX_LINE_BYTES = 64 * 1024;

const USAGE = "Usage: rocky listen collect --stdio";

/** The one place anything is written to stdout, so the wire stays JSON lines. */
function writeLine(value: object): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function writeRoots(roots: RootOwnership[]): void {
  writeLine({ v: 1, kind: "roots", roots });
}

function writeResult(report: ReconcileReport): void {
  writeLine({
    v: 1,
    kind: "result",
    root: report.root,
    coverage: report.coverage,
    gaps: report.gaps,
    reason: report.reason ?? null,
    started_ms: report.startedMs,
    at_ms: report.atMs,
  });
}

/** The root a request line names, or undefined for anything that is not a v1 request. */
export function parseRequestLine(line: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { v, root } = value as { v?: unknown; root?: unknown };
  if (v !== 1 || typeof root !== "string" || root.length === 0 || !isAbsolute(root)) return undefined;
  return root;
}

/**
 * Splits a byte stream into UTF-8 lines. A line over `maxBytes` is dropped
 * without holding more than one chunk of it in memory.
 */
export function createLineReader(
  onLine: (line: string) => void,
  maxBytes = MAX_LINE_BYTES,
): { push(chunk: Buffer): void; end(): void } {
  const decoder = new StringDecoder("utf8");
  let partial = "";
  let skipping = false;

  const emit = (line: string): void => {
    if (Buffer.byteLength(line, "utf8") <= maxBytes) onLine(line);
  };

  const feed = (text: string): void => {
    let rest = text;
    for (let newline = rest.indexOf("\n"); newline >= 0; newline = rest.indexOf("\n")) {
      const line = partial + rest.slice(0, newline);
      partial = "";
      rest = rest.slice(newline + 1);
      if (skipping) skipping = false;
      else emit(line);
    }
    if (skipping) return;
    partial += rest;
    // Every UTF-16 unit takes at least one byte, so this line is already too long.
    if (partial.length > maxBytes) {
      partial = "";
      skipping = true;
    }
  };

  return {
    push: (chunk) => feed(decoder.write(chunk)),
    end: () => {
      feed(decoder.end());
      if (!skipping && partial.length > 0) emit(partial);
      partial = "";
    },
  };
}

/** Internal test seam. The command line passes neither. */
export interface ListenDeps {
  startLoop?: typeof startCollectorLoop;
  input?: Readable;
}

export async function listenCommand(args: string[], deps: ListenDeps = {}): Promise<number> {
  if (args.length !== 2 || args[0] !== "collect" || args[1] !== "--stdio") {
    say(USAGE);
    return 2;
  }
  const input = deps.input ?? process.stdin;
  const loop = (deps.startLoop ?? startCollectorLoop)({
    proc: "daemon",
    home: resolveRockyPaths().home,
    fullEveryMs: CAPTURE_FULL_EVERY_MS,
    onRoots: writeRoots,
    onResult: writeResult,
  });
  const reader = createLineReader((line) => {
    try {
      const root = parseRequestLine(line);
      if (root !== undefined) loop.request(root);
    } catch {
      // fail-open: a bad request line never stops capture
    }
  });
  const inputEnded = new Promise<void>((resolve) => {
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      reader.end();
      resolve();
    };
    input.on("data", (chunk: Buffer) => reader.push(chunk));
    input.on("end", finish);
    input.on("error", finish);
    // The reader is gone: nobody is left to hear results, so stop capturing.
    process.stdout.on("error", finish);
  });
  try {
    await Promise.race([loop.done, inputEnded]);
    await loop.stop();
  } finally {
    // The daemon may still hold its end of the pipe (worker failure, output gone).
    // A live stdin listener would keep this process running after the exit code is set.
    input.destroy();
  }
  return (await loop.done) === "failed" ? 1 : 0;
}
