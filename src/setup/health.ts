import type { McpRegistration } from "./clients.js";
import { performance } from "node:perf_hooks";
import { JSON_RPC_ERROR, MODERN_PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSION } from "../mcp/protocol.js";
import type { ProcessResult, ProcessRunner, ProcessSession } from "./process.js";

export interface HealthCheckResult {
  healthy: boolean;
  era?: "modern" | "legacy";
  detail: string;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_UNMATCHED_LINES = 32;
const MAX_UNMATCHED_BYTES = 64 * 1024;
const REQUIRED_TOOLS = ["recall", "recent_failures", "stats", "recall_with_ai"] as const;

interface JsonObject {
  [key: string]: unknown;
}

type ResponseWait =
  | { kind: "response"; value: JsonObject }
  | { kind: "timeout" | "eof" | "malformed" | "overflow" };

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modernParams(): JsonObject {
  return {
    _meta: {
      "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
      "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": { name: "rocky-health", version: "0.2.1" },
    },
  };
}

async function untilDeadline<T>(work: Promise<T>, deadlineAt: number): Promise<T | undefined> {
  const remaining = deadlineAt - performance.now();
  if (remaining <= 0) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), remaining);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitForResponse(
  session: ProcessSession,
  id: string,
  deadlineAt: number,
): Promise<ResponseWait> {
  let unmatchedLines = 0;
  let unmatchedBytes = 0;
  while (true) {
    let line: string | undefined;
    try {
      line = await untilDeadline(session.readLine(), deadlineAt);
    } catch {
      return { kind: "overflow" };
    }
    if (line === undefined) {
      return performance.now() >= deadlineAt ? { kind: "timeout" } : { kind: "eof" };
    }
    unmatchedLines += 1;
    unmatchedBytes += Buffer.byteLength(line, "utf8");
    if (unmatchedLines > MAX_UNMATCHED_LINES || unmatchedBytes > MAX_UNMATCHED_BYTES) {
      return { kind: "overflow" };
    }
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      return { kind: "malformed" };
    }
    if (!isObject(value) || value.jsonrpc !== "2.0") return { kind: "malformed" };
    if (value.id !== id) continue;
    const hasResult = Object.hasOwn(value, "result");
    const hasError = Object.hasOwn(value, "error");
    if (hasResult === hasError || (hasError && !isObject(value.error))) {
      return { kind: "malformed" };
    }
    return { kind: "response", value };
  }
}

async function request(
  session: ProcessSession,
  id: string,
  method: string,
  params: JsonObject,
  deadlineAt: number,
): Promise<ResponseWait> {
  try {
    await untilDeadline(
      session.writeLine(JSON.stringify({ jsonrpc: "2.0", id, method, params })),
      deadlineAt,
    );
  } catch {
    return { kind: "eof" };
  }
  if (performance.now() >= deadlineAt) return { kind: "timeout" };
  return waitForResponse(session, id, deadlineAt);
}

async function notify(
  session: ProcessSession,
  method: string,
  params: JsonObject,
  deadlineAt: number,
): Promise<boolean> {
  if (performance.now() >= deadlineAt) return false;
  try {
    await untilDeadline(
      session.writeLine(JSON.stringify({ jsonrpc: "2.0", method, params })),
      deadlineAt,
    );
    return performance.now() < deadlineAt;
  } catch {
    return false;
  }
}

function hasToolsCapability(result: unknown): boolean {
  return isObject(result) && isObject(result.capabilities) && isObject(result.capabilities.tools);
}

function hasSupportedVersion(result: unknown, version: string): boolean {
  return isObject(result)
    && Array.isArray(result.supportedVersions)
    && result.supportedVersions.includes(version);
}

function hasRequiredTools(result: unknown): boolean {
  if (!isObject(result) || !Array.isArray(result.tools)) return false;
  const names = new Set(result.tools.flatMap((tool) => isObject(tool) && typeof tool.name === "string" ? [tool.name] : []));
  return REQUIRED_TOOLS.every((name) => names.has(name));
}

async function cleanup(
  session: ProcessSession,
  gracefulDeadlineAt: number,
  finalDeadlineAt = gracefulDeadlineAt,
): Promise<ProcessResult | undefined> {
  const completion = session.wait();
  try {
    session.end();
  } catch {
    session.kill("SIGKILL");
    return untilDeadline(completion, finalDeadlineAt);
  }
  const completed = await untilDeadline(completion, gracefulDeadlineAt);
  if (completed === undefined) {
    session.kill("SIGKILL");
    return untilDeadline(completion, finalDeadlineAt);
  }
  return completed;
}

function exitedCleanly(result: ProcessResult | undefined): boolean {
  return result !== undefined && result.status === 0 && result.error === undefined;
}

export async function checkMcpRegistration(
  registration: McpRegistration,
  runner: ProcessRunner,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<HealthCheckResult> {
  if (runner.openSession === undefined) {
    return {
      healthy: false,
      detail: "Interactive protocol transport is unavailable",
    };
  }
  const duration = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const startedAt = performance.now();
  const deadlineAt = startedAt + duration;
  const modernDeadlineAt = startedAt + Math.max(1, Math.floor(duration * 0.4));
  let session: ProcessSession;
  try {
    session = await runner.openSession(registration.command, registration.args, {
      env: { ...process.env, ...registration.env },
    });
  } catch {
    return { healthy: false, detail: "Unable to start Rocky MCP health probe" };
  }

  const discover = await request(
    session,
    "rocky-health-modern-discover",
    "server/discover",
    modernParams(),
    modernDeadlineAt,
  );
  if (discover.kind === "response") {
    const response = discover.value;
    const discoveryResult = response.result;
    if (isObject(response.error)
      && response.error.code === JSON_RPC_ERROR.UNSUPPORTED_PROTOCOL_VERSION) {
      await cleanup(session, deadlineAt);
      return { healthy: false, era: "modern", detail: "Rocky MCP modern protocol version is unsupported" };
    }
    if (Object.hasOwn(response, "result")) {
      if (!isObject(discoveryResult)
        || !Array.isArray(discoveryResult.supportedVersions)
        || !hasToolsCapability(discoveryResult)) {
        await cleanup(session, deadlineAt);
        return { healthy: false, era: "modern", detail: "Rocky MCP modern discovery is incomplete" };
      }
      if (!hasSupportedVersion(discoveryResult, MODERN_PROTOCOL_VERSION)) {
        await cleanup(session, deadlineAt);
        return {
          healthy: false,
          era: "modern",
          detail: "Rocky MCP modern protocol version is unsupported",
        };
      }
      const listed = await request(
        session,
        "rocky-health-modern-list",
        "tools/list",
        modernParams(),
        deadlineAt,
      );
      const healthy = listed.kind === "response" && hasRequiredTools(listed.value.result);
      const stopped = await cleanup(session, deadlineAt);
      if (!healthy) {
        return { healthy: false, era: "modern", detail: "Rocky MCP tool catalog is incomplete" };
      }
      return exitedCleanly(stopped)
        ? { healthy: true, era: "modern", detail: "Rocky MCP tools are healthy" }
        : { healthy: false, era: "modern", detail: "Rocky MCP probe did not exit cleanly" };
    }
  }

  const modernStopped = await cleanup(session, modernDeadlineAt, deadlineAt);
  if (modernStopped === undefined) {
    return { healthy: false, era: "modern", detail: "Rocky MCP probe cleanup timed out" };
  }

  try {
    session = await runner.openSession(registration.command, registration.args, {
      env: { ...process.env, ...registration.env },
    });
  } catch {
    return { healthy: false, detail: "Unable to start Rocky MCP legacy health probe" };
  }

  const initialized = await request(
    session,
    "rocky-health-legacy-initialize",
    "initialize",
    {
      protocolVersion: LEGACY_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "rocky-health", version: "0.2.1" },
    },
    deadlineAt,
  );
  const initializedResult = initialized.kind === "response" ? initialized.value.result : undefined;
  if (!isObject(initializedResult)
    || initializedResult.protocolVersion !== LEGACY_PROTOCOL_VERSION
    || !hasToolsCapability(initializedResult)
    || !await notify(session, "notifications/initialized", {}, deadlineAt)) {
    await cleanup(session, deadlineAt);
    return { healthy: false, era: "legacy", detail: "Rocky MCP legacy initialization failed" };
  }

  const pinged = await request(session, "rocky-health-legacy-ping", "ping", {}, deadlineAt);
  if (pinged.kind !== "response" || !isObject(pinged.value.result)) {
    await cleanup(session, deadlineAt);
    return { healthy: false, era: "legacy", detail: "Rocky MCP legacy ping failed" };
  }

  const listed = await request(session, "rocky-health-legacy-list", "tools/list", {}, deadlineAt);
  const healthy = listed.kind === "response" && hasRequiredTools(listed.value.result);
  const stopped = await cleanup(session, deadlineAt);
  if (!healthy) {
    return { healthy: false, era: "legacy", detail: "Rocky MCP legacy tool catalog is incomplete" };
  }
  return exitedCleanly(stopped)
    ? { healthy: true, era: "legacy", detail: "Rocky MCP tools are healthy" }
    : { healthy: false, era: "legacy", detail: "Rocky MCP probe did not exit cleanly" };
}
