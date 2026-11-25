import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";

interface ExpectationNote {
  text: string;
  command?: string;
  failureId?: string;
  agent: "claude-code" | "codex" | "generic";
}

interface ExpectationReply {
  recorded: boolean;
  id?: string;
  reason?: string;
  linkedFailure: boolean;
}

export interface ExpectationBroker {
  note(payload: ExpectationNote, signal: AbortSignal): Promise<ExpectationReply>;
}

const STDOUT_CAP_BYTES = 4 * 1024;
const CHILD_DECLINE_REASONS = new Set(["duplicate", "cap", "disabled", "invalid_input", "memory_unavailable"]);
const BROKER_FAILED = Object.freeze({ recorded: false, reason: "broker_failed", linkedFailure: false });
const TIMEOUT = Object.freeze({ recorded: false, reason: "timeout", linkedFailure: false });

function parseReply(stdout: Buffer): ExpectationReply {
  try {
    const value: unknown = JSON.parse(stdout.toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return BROKER_FAILED;
    const { recorded, id, reason, linkedFailure } = value as Record<string, unknown>;
    if (typeof recorded !== "boolean" || typeof linkedFailure !== "boolean"
      || (id !== undefined && typeof id !== "string")
      || (reason !== undefined && (typeof reason !== "string" || !CHILD_DECLINE_REASONS.has(reason)))) {
      return BROKER_FAILED;
    }
    return {
      recorded,
      ...(id === undefined ? {} : { id }),
      ...(reason === undefined ? {} : { reason }),
      linkedFailure,
    };
  } catch {
    return BROKER_FAILED;
  }
}

export function createExpectationBroker(opts: {
  execPath: string;
  entry: string | undefined;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}): ExpectationBroker {
  return {
    async note(payload, signal) {
      if (opts.entry === undefined) return BROKER_FAILED;
      if (signal.aborted) return TIMEOUT;
      try {
        const input = JSON.stringify(payload);
        // Production supplies process.execPath and the Rocky entry point here.
        const child = spawn(opts.execPath, [opts.entry, "hook", "note-expectation"], {
          cwd: opts.cwd,
          env: opts.env,
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "pipe", "ignore"],
        });
        return await new Promise<ExpectationReply>((resolve) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          let stopped: ExpectationReply | undefined;
          const stop = (reply: ExpectationReply): void => {
            if (stopped !== undefined) return;
            stopped = reply;
            child.kill("SIGKILL");
            child.stdin.destroy();
            child.stdout.destroy();
          };
          const onAbort = (): void => stop(TIMEOUT);
          const onError = (): void => stop(BROKER_FAILED);
          const deadline = setTimeout(onAbort, opts.timeoutMs);
          signal.addEventListener("abort", onAbort, { once: true });
          child.on("error", onError);
          child.stdin.on("error", onError);
          child.stdout.on("error", onError);
          child.stdout.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > STDOUT_CAP_BYTES) {
              onError();
              return;
            }
            chunks.push(chunk);
          });
          child.once("close", (code) => {
            clearTimeout(deadline);
            signal.removeEventListener("abort", onAbort);
            resolve(stopped ?? (code === 0 ? parseReply(Buffer.concat(chunks, bytes)) : BROKER_FAILED));
          });
          child.stdin.end(input);
        });
      } catch {
        return BROKER_FAILED;
      }
    },
  };
}
