/**
 * Process spawning for `rocky run` (and, later, `rocky watch`).
 *
 * Streams a child's stdout/stderr through untouched, same as before, but
 * keeps only a bounded tail of stderr in memory instead of concatenating
 * the whole stream: 200 MB of stderr used to mean 297 MB of peak RSS,
 * growing linearly with the child's output. `runProcess` never lets stored
 * stderr grow past `tailLines` lines of at most `maxLineBytes` bytes each.
 */

import { spawn } from "node:child_process";
import { constants } from "node:os";
import { StringDecoder } from "node:string_decoder";

export const TAIL_LINES = 200;
export const MAX_LINE_BYTES = 4096;

export interface ExecOptions {
  tailLines?: number; // default TAIL_LINES
  maxLineBytes?: number; // default MAX_LINE_BYTES
  /** Silence threshold. undefined = no timer at all (the `run` behavior). */
  idleMs?: number;
  /** Called every time the threshold is crossed again; ms since last stderr. */
  onIdle?: (elapsedMs: number) => void;
}

export interface ExecResult {
  code: number;
  /** The bounded tail joined with "\n" — what fingerprinting consumes. */
  stderr: string;
  /** The bounded tail, newest last. */
  tail: string[];
  durationMs: number;
}

/** Exported for tests: the ring buffer, independent of any child process. */
export interface TailBuffer {
  push(chunk: string): void;
  end(): string[];
}

/**
 * Truncate to at most `maxBytes` UTF-8 bytes, keeping the leading bytes.
 * `Buffer.write` stops before a multi-byte character it can't fit whole, so
 * this never emits a split/corrupted character at the cut point.
 */
function truncateBytes(line: string, maxBytes: number): string {
  if (Buffer.byteLength(line, "utf8") <= maxBytes) return line;
  const buf = Buffer.alloc(maxBytes);
  const written = buf.write(line, 0, maxBytes, "utf8");
  return buf.toString("utf8", 0, written);
}

export function createTailBuffer(
  tailLines: number = TAIL_LINES,
  maxLineBytes: number = MAX_LINE_BYTES,
): TailBuffer {
  const lines: string[] = [];
  let partial = "";

  function pushLine(line: string): void {
    lines.push(truncateBytes(line, maxLineBytes));
    if (lines.length > tailLines) lines.shift();
  }

  return {
    push(chunk: string): void {
      partial += chunk;
      const parts = partial.split("\n");
      partial = parts.pop() ?? "";
      for (const line of parts) pushLine(line);
      // Cap the still-accumulating, not-yet-terminated line on every call —
      // not just at end() — so a single huge line with no newline is never
      // held in full in memory.
      if (Buffer.byteLength(partial, "utf8") > maxLineBytes) {
        partial = truncateBytes(partial, maxLineBytes);
      }
    },
    end(): string[] {
      if (partial.length > 0) pushLine(partial);
      partial = "";
      return lines;
    },
  };
}

/** Shell convention: a command killed by signal N exits with 128 + N. */
export function signalExit(signal: NodeJS.Signals | null): number {
  if (!signal) return 1;
  const number = constants.signals[signal];
  return typeof number === "number" ? 128 + number : 1;
}

export function runProcess(cmd: string, options: ExecOptions = {}): Promise<ExecResult> {
  const start = Date.now();
  const buffer = createTailBuffer(options.tailLines, options.maxLineBytes);
  const decoder = new StringDecoder("utf8");
  let lastActivity = start;

  return new Promise((resolve) => {
    const child = spawn(cmd, {
      shell: true,
      stdio: ["inherit", "inherit", "pipe"],
    });

    // Repeating, not one-shot: with the child silent, every idleMs tick's
    // elapsed-since-activity keeps clearing the threshold again (idleMs,
    // 2*idleMs, 3*idleMs, ...), so onIdle fires on each crossing. unref()
    // so this never holds the process open; cleared on both close and error
    // so it can never fire after runProcess has already resolved.
    let idleTimer: NodeJS.Timeout | undefined;
    if (options.idleMs !== undefined) {
      const idleMs = options.idleMs;
      idleTimer = setInterval(() => {
        const elapsed = Date.now() - lastActivity;
        if (elapsed >= idleMs) options.onIdle?.(elapsed);
      }, idleMs);
      idleTimer.unref();
    }

    child.stderr?.on("data", (chunk: Buffer) => {
      lastActivity = Date.now();
      buffer.push(decoder.write(chunk));
      process.stderr.write(chunk); // stream through untouched, unbounded, unmodified
    });

    child.on("close", (code, signal) => {
      if (idleTimer) clearInterval(idleTimer);
      buffer.push(decoder.end());
      const tail = buffer.end();
      resolve({ code: code ?? signalExit(signal), stderr: tail.join("\n"), tail, durationMs: Date.now() - start });
    });

    child.on("error", (err) => {
      if (idleTimer) clearInterval(idleTimer);
      const message = `${err.message}\n`;
      process.stderr.write(message);
      buffer.push(decoder.end());
      buffer.push(message);
      const tail = buffer.end();
      resolve({ code: 127, stderr: tail.join("\n"), tail, durationMs: Date.now() - start });
    });
  });
}
