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

/**
 * Exit codes that mean "the user cancelled", not "the command failed":
 * 130 = SIGINT (Ctrl-C), 143 = SIGTERM. A cancelled run is not a memory
 * event — no record, no speaking. Deliberately NOT generalized further;
 * any other code needs its own evidence.
 */
export const CANCEL_CODES: ReadonlySet<number> = new Set([130, 143]);

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

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputLimitExceeded: boolean;
}

export interface GitOptions {
  /** Opt-in deadline. Omitted callers retain the prior unlimited behavior. */
  timeoutMs?: number;
  /** Opt-in combined stdout/stderr memory cap. The child is killed as soon as it is exceeded. */
  maxOutputBytes?: number;
}

/** Execute git with argv boundaries intact and capture its output. */
export function runGit(
  args: readonly string[],
  input?: string,
  options: GitOptions = {},
): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn("git", [...args], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
        outputLimitExceeded,
      });
    };

    const keepOutput = (target: Buffer[], chunk: Buffer): void => {
      const limit = options.maxOutputBytes;
      if (limit === undefined) {
        target.push(chunk);
        return;
      }
      const remaining = Math.max(0, limit - outputBytes);
      if (remaining > 0) {
        const kept = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
        target.push(kept);
        outputBytes += kept.length;
      }
      if (chunk.length > remaining) {
        outputLimitExceeded = true;
        child.kill("SIGKILL");
      }
    };

    child.stdout.on("data", (chunk: Buffer) => keepOutput(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => keepOutput(stderr, chunk));
    child.stdin.on("error", () => { /* spawn failure is reported by the child itself */ });
    child.on("error", (error) => {
      stderr.push(Buffer.from(error.message));
      finish(127);
    });
    child.on("close", (code, signal) => finish(code ?? signalExit(signal)));
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeoutMs);
    }
    child.stdin.end(input);
  });
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
