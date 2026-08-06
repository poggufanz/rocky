import type { ProcessRunner, ProcessSession } from "./process.js";

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

class AppServerProtocolError extends Error {
  constructor() {
    super("Codex app-server protocol error");
  }
}

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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
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
  timeoutMs: number,
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const remaining = Math.max(1, deadline - Date.now());
    const line = await withTimeout(processSession.readLine(), remaining, "Codex app-server request");
    if (line === undefined) throw new AppServerProtocolError();
    const message = parseLine(line);
    if (message.id === undefined && typeof message.method === "string") continue;
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
  timeoutMs: number,
): Promise<unknown> {
  await withTimeout(
    processSession.writeLine(JSON.stringify({ id, method, params })),
    timeoutMs,
    "Codex app-server request",
  );
  return readResponse(processSession, id, timeoutMs);
}

async function shutdownProcess(
  processSession: ProcessSession,
  timeoutMs: number,
): Promise<void> {
  processSession.end();
  try {
    await withTimeout(processSession.wait(), timeoutMs, "Codex app-server shutdown");
    return;
  } catch {
    processSession.kill("SIGTERM");
  }
  try {
    await withTimeout(processSession.wait(), timeoutMs, "Codex app-server shutdown");
    return;
  } catch {
    processSession.kill("SIGKILL");
  }
  await withTimeout(processSession.wait(), timeoutMs, "Codex app-server shutdown");
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
      const processSession = await withTimeout(
        runner.openSession(
          executable,
          ["app-server", "--listen", "stdio://"],
          { env: { CODEX_HOME: codexHome } },
        ),
        timeouts.startupTimeoutMs,
        "Codex app-server startup",
      );

      try {
        const initialized = await requestRaw(
          processSession,
          1,
          "initialize",
          {
            clientInfo: { name: "rocky", version: "0.2.1" },
            capabilities: { experimentalApi: true },
          },
          timeouts.startupTimeoutMs,
        );
        if (!isObject(initialized)
          || typeof initialized.codexHome !== "string"
          || typeof initialized.userAgent !== "string") {
          throw new AppServerProtocolError();
        }
        await withTimeout(
          processSession.writeLine(JSON.stringify({ method: "initialized" })),
          timeouts.startupTimeoutMs,
          "Codex app-server startup",
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
