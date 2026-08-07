import type { ProcessRunner, ProcessSession } from "./process.js";
import { performance } from "node:perf_hooks";
import { isAbsolute } from "node:path";

interface JsonObject {
  [key: string]: unknown;
}

export interface AppServerSession {
  readonly codexHome: string;
  request(method: string, params: JsonObject): Promise<unknown>;
  close(): Promise<void>;
}

export interface AppServerSessionFactory {
  open(executable: string, codexHome: string): Promise<AppServerSession>;
}

export interface AppServerTimeouts {
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  shutdownTimeoutMs: number;
}

const DEFAULT_TIMEOUTS: AppServerTimeouts = {
  startupTimeoutMs: 5_000,
  requestTimeoutMs: 5_000,
  shutdownTimeoutMs: 2_000,
};
const MAX_IGNORED_NOTIFICATIONS = 64;
const MAX_IGNORED_NOTIFICATION_BYTES = 64 * 1024;

class AppServerProtocolError extends Error {
  constructor() {
    super("Codex app-server protocol error");
  }
}

class AppServerTimeoutError extends Error {}

export class AppServerRequestError extends Error {
  constructor(
    readonly code: number | undefined,
    readonly data: unknown,
  ) {
    super("Codex app-server request failed");
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveTimeout(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

interface Deadline {
  expiresAt: number;
  label: string;
}

function createDeadline(timeoutMs: number, label: string): Deadline {
  return { expiresAt: performance.now() + timeoutMs, label };
}

function remainingTime(deadline: Deadline): number {
  const remaining = deadline.expiresAt - performance.now();
  if (remaining <= 0) throw new AppServerTimeoutError(`${deadline.label} timed out`);
  return remaining;
}

function withDeadline<T>(promise: Promise<T>, deadline: Deadline): Promise<T> {
  const remaining = remainingTime(deadline);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new AppServerTimeoutError(`${deadline.label} timed out`)),
      remaining,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return withDeadline(promise, createDeadline(timeoutMs, label));
}

function parseLine(line: string): JsonObject {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!isObject(parsed)) throw new AppServerProtocolError();
    return parsed;
  } catch {
    throw new AppServerProtocolError();
  }
}

async function readResponse(
  processSession: ProcessSession,
  id: number,
  deadline: Deadline,
): Promise<unknown> {
  let notificationCount = 0;
  let notificationBytes = 0;
  while (true) {
    remainingTime(deadline);
    const line = await withDeadline(processSession.readLine(), deadline);
    if (line === undefined) throw new AppServerProtocolError();
    const message = parseLine(line);
    if (message.id === undefined && typeof message.method === "string") {
      if (Object.prototype.hasOwnProperty.call(message, "result")
        || Object.prototype.hasOwnProperty.call(message, "error")
        || (message.params !== undefined
          && !isObject(message.params)
          && !Array.isArray(message.params))) {
        throw new AppServerProtocolError();
      }
      notificationCount += 1;
      notificationBytes += Buffer.byteLength(line, "utf8");
      if (notificationCount > MAX_IGNORED_NOTIFICATIONS
        || notificationBytes > MAX_IGNORED_NOTIFICATION_BYTES) {
        throw new AppServerProtocolError();
      }
      continue;
    }
    if (message.id !== id) throw new AppServerProtocolError();
    if (isObject(message.error)) {
      const code = typeof message.error.code === "number" ? message.error.code : undefined;
      throw new AppServerRequestError(code, message.error.data);
    }
    if (!Object.prototype.hasOwnProperty.call(message, "result")) {
      throw new AppServerProtocolError();
    }
    return message.result;
  }
}

async function requestRaw(
  processSession: ProcessSession,
  id: number,
  method: string,
  params: JsonObject,
  timeoutMsOrDeadline: number | Deadline,
): Promise<unknown> {
  const deadline = typeof timeoutMsOrDeadline === "number"
    ? createDeadline(timeoutMsOrDeadline, "Codex app-server request")
    : timeoutMsOrDeadline;
  await withDeadline(
    processSession.writeLine(JSON.stringify({ id, method, params })),
    deadline,
  );
  return readResponse(processSession, id, deadline);
}

function isCleanExit(result: Awaited<ReturnType<ProcessSession["wait"]>>): boolean {
  return result.status === 0 && result.error === undefined;
}

type ShutdownWait = "clean" | "dirty" | "timeout" | "error";

async function waitForShutdown(
  processSession: ProcessSession,
  timeoutMs: number,
): Promise<ShutdownWait> {
  try {
    const result = await withTimeout(
      processSession.wait(),
      timeoutMs,
      "Codex app-server shutdown",
    );
    return isCleanExit(result) ? "clean" : "dirty";
  } catch (error) {
    return error instanceof AppServerTimeoutError ? "timeout" : "error";
  }
}

async function shutdownProcess(
  processSession: ProcessSession,
  timeoutMs: number,
): Promise<void> {
  let eofFailed = false;
  try {
    processSession.end();
  } catch {
    eofFailed = true;
  }

  if (!eofFailed) {
    const eofWait = await waitForShutdown(processSession, timeoutMs);
    if (eofWait === "clean") return;
    if (eofWait === "dirty") throw new Error("Codex app-server shutdown failed");
    if (eofWait === "error") eofFailed = true;
  }

  processSession.kill("SIGTERM");
  const termWait = await waitForShutdown(processSession, timeoutMs);
  if (termWait === "clean") {
    if (!eofFailed) return;
    throw new Error("Codex app-server shutdown failed");
  }
  if (termWait === "dirty") throw new Error("Codex app-server shutdown failed");

  processSession.kill("SIGKILL");
  const killWait = await waitForShutdown(processSession, timeoutMs);
  if (killWait !== "clean" || eofFailed) {
    throw new Error("Codex app-server shutdown failed");
  }
}

export function isConfigVersionConflict(error: unknown): boolean {
  if (!(error instanceof AppServerRequestError) || !isObject(error.data)) return false;
  return error.data.config_write_error_code === "configVersionConflict";
}

export function isUnsupportedAppServerMethod(error: unknown): boolean {
  return error instanceof AppServerRequestError
    && (error.code === -32601 || error.code === -32602);
}

export function createAppServerSessionFactory(
  runner: ProcessRunner,
  configuredTimeouts: Partial<AppServerTimeouts> = {},
): AppServerSessionFactory {
  const timeouts = {
    startupTimeoutMs: positiveTimeout(
      configuredTimeouts.startupTimeoutMs ?? DEFAULT_TIMEOUTS.startupTimeoutMs,
      "startup timeout",
    ),
    requestTimeoutMs: positiveTimeout(
      configuredTimeouts.requestTimeoutMs ?? DEFAULT_TIMEOUTS.requestTimeoutMs,
      "request timeout",
    ),
    shutdownTimeoutMs: positiveTimeout(
      configuredTimeouts.shutdownTimeoutMs ?? DEFAULT_TIMEOUTS.shutdownTimeoutMs,
      "shutdown timeout",
    ),
  };

  return {
    async open(executable, codexHome) {
      if (runner.openSession === undefined) {
        throw new Error("Codex app-server sessions are unavailable");
      }
      const startupDeadline = createDeadline(
        timeouts.startupTimeoutMs,
        "Codex app-server startup",
      );
      const acquisition = runner.openSession(
        executable,
        ["app-server", "--listen", "stdio://"],
        { env: { CODEX_HOME: codexHome } },
      );
      let processSession: ProcessSession;
      try {
        processSession = await withDeadline(acquisition, startupDeadline);
      } catch (error) {
        void acquisition.then(async (lateSession) => {
          try {
            await shutdownProcess(lateSession, timeouts.shutdownTimeoutMs);
          } catch {
            // Late acquisition remains failed; cleanup already escalated.
          }
        }, () => {});
        throw error;
      }

      try {
        const initialized = await requestRaw(
          processSession,
          1,
          "initialize",
          {
            clientInfo: { name: "rocky", version: "0.2.1" },
            capabilities: { experimentalApi: true },
          },
          startupDeadline,
        );
        if (!isObject(initialized)
          || typeof initialized.codexHome !== "string"
          || !isAbsolute(initialized.codexHome)
          || initialized.codexHome !== codexHome
          || typeof initialized.userAgent !== "string") {
          throw new AppServerProtocolError();
        }
        await withDeadline(
          processSession.writeLine(JSON.stringify({ method: "initialized" })),
          startupDeadline,
        );

        let nextId = 2;
        let closed = false;
        let active = false;
        return {
          codexHome: initialized.codexHome,
          async request(method, params) {
            if (closed || active) throw new AppServerProtocolError();
            active = true;
            try {
              const id = nextId;
              nextId += 1;
              return await requestRaw(
                processSession,
                id,
                method,
                params,
                timeouts.requestTimeoutMs,
              );
            } finally {
              active = false;
            }
          },
          async close() {
            if (closed) return;
            closed = true;
            await shutdownProcess(processSession, timeouts.shutdownTimeoutMs);
          },
        };
      } catch (error) {
        try {
          await shutdownProcess(processSession, timeouts.shutdownTimeoutMs);
        } catch {
          // Startup remains failed; shutdown already escalated through SIGKILL.
        }
        throw error;
      }
    },
  };
}
