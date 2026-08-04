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

export interface ProcessRunner {
  run(command: string, args: readonly string[], options?: ProcessRunOptions): Promise<ProcessResult>;
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
          processError ??= error;
        });
        child.on("close", (status) => {
          if (timer !== undefined) clearTimeout(timer);
          const result: ProcessResult = {
            status,
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
  };
}

export const processRunner: ProcessRunner = createProcessRunner();
