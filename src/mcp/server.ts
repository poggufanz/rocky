import { Buffer } from "node:buffer";
import type { Readable, Writable } from "node:stream";
import {
  INITIAL_PROTOCOL_STATE,
  JSON_RPC_ERROR,
  LEGACY_PROTOCOL_VERSION,
  MODERN_PROTOCOL_VERSION,
  SERVER_INSTRUCTIONS,
  protocolError,
  resultResponse,
  routeProtocolMessage,
  type JsonRpcId,
  type JsonRpcResponse,
  type ProtocolState,
  type RoutedMessage,
  type ServerInfo,
} from "./protocol.js";
import {
  JsonLineDecoder,
  MAX_INPUT_LINE_BYTES,
  SerializedJsonWriter,
  type DecodedLine,
} from "./stdio.js";
import { McpInvalidParamsError, type McpToolRegistry } from "./tools.js";

export interface McpMessageServer {
  accept(value: unknown): void;
  whenIdle(): Promise<void>;
  close(deadlineAt?: number): Promise<"drained" | "timed_out">;
}

export const DEFAULT_DRAIN_TIMEOUT_MS = 1_000;

interface InFlightSlot {
  controller: AbortController;
  cancelled: boolean;
  work: Promise<void>;
  phase: "running" | "responding";
}

interface MessageServerDependencies {
  tools: McpToolRegistry;
  serverInfo: ServerInfo;
  send(response: JsonRpcResponse): Promise<void>;
  diagnostic(message: string): void;
  drainTimeoutMs?: number;
}

function unexpectedDetail(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  return String(error);
}

function requestResult(
  routed: Extract<RoutedMessage, { kind: "request" }>,
  tools: McpToolRegistry,
  serverInfo: ServerInfo,
  signal: AbortSignal,
): Promise<Record<string, unknown>> | Record<string, unknown> {
  switch (routed.method) {
    case "server/discover":
      return {
        supportedVersions: [MODERN_PROTOCOL_VERSION],
        capabilities: { tools: { listChanged: false } },
        instructions: SERVER_INSTRUCTIONS,
      };
    case "initialize":
      return {
        protocolVersion: LEGACY_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo,
        instructions: SERVER_INSTRUCTIONS,
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: tools.list() };
    case "tools/call": {
      if (typeof routed.params.name !== "string") throw new McpInvalidParamsError("invalid params");
      const args = routed.params.arguments === undefined ? {} : routed.params.arguments;
      return tools.call(routed.params.name, args, signal).then((result) => ({ ...result }));
    }
  }
}

export function createMcpMessageServer(deps: MessageServerDependencies): McpMessageServer {
  const inFlight = new Map<JsonRpcId, InFlightSlot>();
  const pending = new Set<Promise<void>>();
  const drainTimeoutMs = deps.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  let protocolState: ProtocolState = INITIAL_PROTOCOL_STATE;
  let accepting = true;
  let closeOutcome: "drained" | "timed_out" | undefined;
  let closing: Promise<"drained" | "timed_out"> | undefined;

  const diagnostic = (message: string): void => {
    try {
      deps.diagnostic(message);
    } catch {
      // Diagnostics must never interfere with protocol work.
    }
  };

  const track = (work: Promise<void>): void => {
    pending.add(work);
    void work.then(
      () => { pending.delete(work); },
      () => { pending.delete(work); },
    );
  };

  const send = async (response: JsonRpcResponse): Promise<void> => {
    try {
      await deps.send(response);
    } catch (error) {
      diagnostic(`MCP response write failed: ${unexpectedDetail(error)}`);
    }
  };

  const execute = async (
    routed: Extract<RoutedMessage, { kind: "request" }>,
    slot: InFlightSlot,
  ): Promise<void> => {
    let response: JsonRpcResponse | undefined;
    try {
      const result = await requestResult(routed, deps.tools, deps.serverInfo, slot.controller.signal);
      response = resultResponse(routed.id, routed.era, result, deps.serverInfo);
    } catch (error) {
      if (!slot.cancelled) {
        if (error instanceof McpInvalidParamsError) {
          response = protocolError(routed.id, JSON_RPC_ERROR.INVALID_PARAMS, "Invalid params");
        } else {
          diagnostic(`MCP request ${String(routed.id)} failed: ${unexpectedDetail(error)}`);
          response = protocolError(routed.id, JSON_RPC_ERROR.INTERNAL_ERROR, "Internal error");
        }
      }
    }

    try {
      if (slot.cancelled || response === undefined) return;
      slot.phase = "responding";
      await send(response);
    } finally {
      if (inFlight.get(routed.id) === slot) inFlight.delete(routed.id);
    }
  };

  const accept = (value: unknown): void => {
    if (!accepting) return;

    const routed = routeProtocolMessage(value, protocolState);

    switch (routed.kind) {
      case "notification":
        protocolState = routed.nextState;
        return;
      case "cancel": {
        protocolState = routed.nextState;
        const slot = inFlight.get(routed.requestId);
        if (slot === undefined || slot.phase !== "running") return;
        slot.cancelled = true;
        slot.controller.abort(routed.reason);
        return;
      }
      case "error":
        protocolState = routed.nextState;
        track(send(routed.response));
        return;
      case "request": {
        if (inFlight.has(routed.id)) {
          track(send(protocolError(routed.id, JSON_RPC_ERROR.INVALID_REQUEST, "Invalid Request")));
          return;
        }

        protocolState = routed.nextState;
        const slot: InFlightSlot = {
          controller: new AbortController(),
          cancelled: false,
          work: Promise.resolve(),
          phase: "running",
        };
        inFlight.set(routed.id, slot);
        slot.work = Promise.resolve().then(() => execute(routed, slot));
        track(slot.work);
      }
    }
  };

  const whenIdle = async (): Promise<void> => {
    while (pending.size > 0) await Promise.all([...pending]);
  };

  const waitForPending = async (deadlineAt: number): Promise<"drained" | "timed_out"> => {
    if (pending.size === 0) return "drained";
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) return "timed_out";

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.all([...pending]).then(() => "drained" as const),
        new Promise<"timed_out">((resolve) => {
          timeout = setTimeout(() => resolve("timed_out"), remaining);
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  };

  const close = (deadlineAt = Date.now() + drainTimeoutMs): Promise<"drained" | "timed_out"> => {
    if (closeOutcome !== undefined) return Promise.resolve(closeOutcome);
    if (closing !== undefined) return closing;

    accepting = false;
    for (const slot of inFlight.values()) {
      if (slot.phase !== "running") continue;
      slot.cancelled = true;
      slot.controller.abort();
    }
    closing = waitForPending(deadlineAt);
    void closing.then((outcome) => { closeOutcome = outcome; });
    return closing;
  };

  return { accept, whenIdle, close };
}

function inputChunk(value: unknown): Buffer | string {
  if (typeof value === "string" || Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return String(value);
}

export async function runMcpStdio(
  streams: { input: Readable; output: Writable; diagnostics: Writable },
  deps: { tools: McpToolRegistry; serverInfo: ServerInfo },
  options: { maxLineBytes?: number; drainTimeoutMs?: number } = {},
): Promise<void> {
  const maxLineBytes = options.maxLineBytes ?? MAX_INPUT_LINE_BYTES;
  const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const decoder = new JsonLineDecoder(maxLineBytes);
  const writer = new SerializedJsonWriter(streams.output);
  const diagnostic = (message: string): void => {
    try {
      streams.diagnostics.write(`${message}\n`);
    } catch {
      // Diagnostics are best effort and never go to protocol stdout.
    }
  };
  const server = createMcpMessageServer({
    tools: deps.tools,
    serverInfo: deps.serverInfo,
    send: (response) => writer.write(response),
    diagnostic,
    drainTimeoutMs,
  });

  const acceptDecoded = (decoded: DecodedLine): void => {
    switch (decoded.kind) {
      case "message":
        server.accept(decoded.value);
        return;
      case "parse_error":
        void writer.write(protocolError(undefined, JSON_RPC_ERROR.PARSE_ERROR, "Parse error")).catch((error: unknown) => {
          diagnostic(`MCP response write failed: ${unexpectedDetail(error)}`);
        });
        return;
      case "too_large":
        void writer.write(protocolError(
          undefined,
          JSON_RPC_ERROR.INVALID_REQUEST,
          `Input line exceeds ${maxLineBytes} bytes`,
        )).catch((error: unknown) => {
          diagnostic(`MCP response write failed: ${unexpectedDetail(error)}`);
        });
    }
  };

  let inputFailed = false;
  let inputFailure: unknown;
  try {
    for await (const chunk of streams.input) {
      for (const decoded of decoder.push(inputChunk(chunk))) acceptDecoded(decoded);
    }
    for (const decoded of decoder.end()) acceptDecoded(decoded);
  } catch (error) {
    inputFailed = true;
    inputFailure = error;
  } finally {
    const deadlineAt = Date.now() + drainTimeoutMs;
    await server.close(deadlineAt);
    try {
      await writer.close(deadlineAt);
    } catch (error) {
      diagnostic(`MCP response write failed: ${unexpectedDetail(error)}`);
    }
  }

  if (inputFailed) throw inputFailure;
}
