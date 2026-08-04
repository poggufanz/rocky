import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

export const PROCESS_CAPTURE_LIMIT_BYTES = 64 * 1024;

export interface ProcessResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export interface ProcessRunOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
  input?: string;
}

export interface ProcessSessionOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface ProcessSession {
  writeLine(line: string): Promise<void>;
  readLine(): Promise<string | undefined>;
  end(): void;
  kill(signal?: NodeJS.Signals | number): void;
  wait(): Promise<ProcessResult>;
}

export interface ProcessRunner {
  run(command: string, args: readonly string[], options?: ProcessRunOptions): Promise<ProcessResult>;
  openSession?(
    command: string,
    args: readonly string[],
    options?: ProcessSessionOptions,
  ): Promise<ProcessSession>;
}

function captureChunk(chunks: Buffer[], capturedBytes: number, chunk: Buffer, limit: number): number {
  const remaining = limit - capturedBytes;
  if (remaining <= 0) return capturedBytes;
  const accepted = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
  chunks.push(accepted);
  return capturedBytes + accepted.length;
}

export function createProcessRunner(captureLimitBytes = PROCESS_CAPTURE_LIMIT_BYTES): ProcessRunner {
  if (!Number.isSafeInteger(captureLimitBytes) || captureLimitBytes < 0) {
    throw new Error("capture limit must be a non-negative integer");
  }

  return {
    run(command, args, options = {}) {
      return new Promise((resolveResult) => {
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let processError: Error | undefined;
        let spawnFailed = false;
        const controller = options.timeoutMs === undefined ? undefined : new AbortController();
        let child: ChildProcessWithoutNullStreams;

        try {
          child = spawn(command, [...args], {
            cwd: options.cwd,
            env: options.env,
            shell: false,
            signal: controller?.signal,
            stdio: ["pipe", "pipe", "pipe"] as const,
          }) as ChildProcessWithoutNullStreams;
        } catch (error) {
          resolveResult({
            status: null,
            stdout: "",
            stderr: "",
            error: error instanceof Error ? error : new Error("unable to start process"),
          });
          return;
        }

        const timer = options.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
            processError = new Error(`process timeout after ${options.timeoutMs}ms`);
            controller?.abort();
          }, Math.max(0, options.timeoutMs));

        child.stdout.on("data", (chunk: Buffer) => {
          stdoutBytes = captureChunk(stdout, stdoutBytes, chunk, captureLimitBytes);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderrBytes = captureChunk(stderr, stderrBytes, chunk, captureLimitBytes);
        });
        child.on("error", (error) => {
          spawnFailed = true;
          processError ??= error;
        });
        child.on("close", (status) => {
          if (timer !== undefined) clearTimeout(timer);
          const result: ProcessResult = {
            status: spawnFailed ? null : status,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
          };
          if (processError !== undefined) result.error = processError;
          resolveResult(result);
        });

        child.stdin.on("error", (error) => {
          processError ??= error;
        });
        child.stdin.end(options.input);
      });
    },

    async openSession(command, args, options = {}) {
      const stderr: Buffer[] = [];
      let stderrBytes = 0;
      let processError: Error | undefined;
      const queued: Array<string | Error> = [];
      const readers: Array<{
        resolve(value: string | undefined): void;
        reject(error: Error): void;
      }> = [];
      let buffered = Buffer.alloc(0);
      let queuedBytes = 0;
      let stdoutClosed = false;
      const child = spawn(command, [...args], {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"] as const,
      }) as ChildProcessWithoutNullStreams;

      const deliver = (value: string | Error): void => {
        const reader = readers.shift();
        if (reader !== undefined) {
          if (value instanceof Error) reader.reject(value);
          else reader.resolve(value);
          return;
        }
        queued.push(value);
        if (typeof value === "string") queuedBytes += Buffer.byteLength(value, "utf8");
      };

      const overflow = (): void => {
        buffered = Buffer.alloc(0);
        queued.length = 0;
        queuedBytes = 0;
        deliver(new Error("interactive process output exceeds capture limit"));
        child.stdout.pause();
      };

      child.stdout.on("data", (chunk: Buffer) => {
        if (buffered.length + chunk.length > captureLimitBytes * 2) {
          overflow();
          return;
        }
        buffered = Buffer.concat([buffered, chunk]);
        while (true) {
          const newline = buffered.indexOf(0x0a);
          if (newline === -1) break;
          const raw = buffered.subarray(0, newline);
          buffered = buffered.subarray(newline + 1);
          const line = (raw.at(-1) === 0x0d ? raw.subarray(0, -1) : raw).toString("utf8");
          if (raw.length > captureLimitBytes
            || queued.length >= 64
            || queuedBytes + raw.length > captureLimitBytes) {
            overflow();
            return;
          }
          deliver(line);
        }
        if (buffered.length > captureLimitBytes) overflow();
      });
      child.stdout.on("end", () => {
        if (buffered.length > 0) {
          if (queued.length >= 64 || queuedBytes + buffered.length > captureLimitBytes) {
            overflow();
          } else {
            deliver(buffered.toString("utf8"));
          }
        }
        buffered = Buffer.alloc(0);
        stdoutClosed = true;
        for (const reader of readers.splice(0)) reader.resolve(undefined);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes = captureChunk(stderr, stderrBytes, chunk, captureLimitBytes);
      });
      child.stdin.on("error", (error) => {
        processError ??= error;
      });

      const completed = new Promise<ProcessResult>((resolveResult) => {
        child.on("error", (error) => {
          processError ??= error;
        });
        child.on("close", (status) => {
          const result: ProcessResult = {
            status,
            stdout: "",
            stderr: Buffer.concat(stderr).toString("utf8"),
          };
          if (processError !== undefined) result.error = processError;
          resolveResult(result);
        });
      });

      return {
        writeLine(line) {
          return new Promise<void>((resolveWrite, rejectWrite) => {
            child.stdin.write(`${line}\n`, (error) => {
              if (error !== null && error !== undefined) rejectWrite(error);
              else resolveWrite();
            });
          });
        },
        readLine() {
          const value = queued.shift();
          if (value !== undefined) {
            if (typeof value === "string") queuedBytes -= Buffer.byteLength(value, "utf8");
            return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
          }
          if (stdoutClosed) return Promise.resolve(undefined);
          return new Promise<string | undefined>((resolve, reject) => {
            readers.push({ resolve, reject });
          });
        },
        end() {
          child.stdin.end();
        },
        kill(signal) {
          child.kill(signal);
        },
        wait() {
          return completed;
        },
      };
    },
  };
}

export const processRunner: ProcessRunner = createProcessRunner();
