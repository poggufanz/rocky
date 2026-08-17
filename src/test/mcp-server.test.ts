import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { PassThrough, Readable, Writable } from "node:stream";
import test from "node:test";
import { disabledRecallWithAi } from "../ai/port.js";
import { createMemoryQueries } from "../core/memory-query.js";
import {
  JSON_RPC_ERROR,
  MODERN_PROTOCOL_VERSION,
  SERVER_INSTRUCTIONS,
  type JsonRpcId,
  type JsonRpcResponse,
  type ProtocolEra,
} from "../mcp/protocol.js";
import {
  createMcpMessageServer,
  runMcpStdio,
} from "../mcp/server.js";
import { SerializedJsonWriter } from "../mcp/stdio.js";
import {
  createToolRegistry,
  McpInvalidParamsError,
  ToolExecutionError,
  type McpToolRegistry,
  type ToolCallResult,
} from "../mcp/tools.js";

const serverInfo = { name: "@poggufanz/rocky-cli", version: "0.3.0" };
const statsPayload = { failures: 0, fixEvents: 0, resolved: 0, unresolved: 0 };

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function toolResult(payload: Record<string, unknown>, isError = false): ToolCallResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

type ToolHandler = (args: unknown, signal: AbortSignal) => Promise<ToolCallResult> | ToolCallResult;

function fakeRegistry(handlers: Partial<Record<string, ToolHandler>>): McpToolRegistry {
  return {
    list: () => [],
    async call(name, args, signal) {
      const handler = handlers[name];
      if (handler === undefined) throw new McpInvalidParamsError("unknown tool");
      return await handler(args, signal);
    },
  };
}

function modernMeta(): Record<string, unknown> {
  return {
    "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
    "io.modelcontextprotocol/clientCapabilities": {},
  };
}

function modernRequest(id: JsonRpcId, method: string, params: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params: { _meta: modernMeta(), ...params },
  };
}

function modernToolCall(id: JsonRpcId, name: string, args: unknown = {}): Record<string, unknown> {
  return modernRequest(id, "tools/call", { name, arguments: args });
}

function cancelNotification(requestId: JsonRpcId): Record<string, unknown> {
  return { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId } };
}

function legacyInitialize(id: JsonRpcId = "init"): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "rocky-test-client", version: "1.0.0" },
    },
  };
}

function legacyReady(server: { accept(value: unknown): void }): void {
  server.accept(legacyInitialize());
  server.accept({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
}

function eraToolCall(era: ProtocolEra, id: JsonRpcId, name: string, args: unknown): Record<string, unknown> {
  if (era === "modern") return modernToolCall(id, name, args);
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition not reached before timeout");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

class RecordingWritable extends Writable {
  readonly chunks: string[] = [];

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.from(chunk).toString("utf8"));
    callback();
  }

  text(): string {
    return this.chunks.join("");
  }

  messages(): JsonRpcResponse[] {
    return this.text().split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as JsonRpcResponse);
  }
}

class PermanentBackpressureWritable extends Writable {
  readonly chunks: string[] = [];

  override write(chunk: string | Uint8Array): boolean {
    this.chunks.push(Buffer.from(chunk).toString("utf8"));
    return false;
  }
}

class ControllableBackpressureWritable extends Writable {
  readonly chunks: string[] = [];
  private blocked = true;

  override write(chunk: string | Uint8Array): boolean {
    this.chunks.push(Buffer.from(chunk).toString("utf8"));
    return !this.blocked;
  }

  releaseDrain(): void {
    this.blocked = false;
    this.emit("drain");
  }
}

function parseLine(line: string | undefined): JsonRpcResponse {
  return JSON.parse(line ?? "") as JsonRpcResponse;
}

function expectedRecallSuccess(id: JsonRpcId): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      ...toolResult({ completed: true }),
      resultType: "complete",
      _meta: { "io.modelcontextprotocol/serverInfo": serverInfo },
    },
  };
}

function serverWith(
  tools: McpToolRegistry,
  send: (response: JsonRpcResponse) => Promise<void> = async () => undefined,
  diagnostic: (message: string) => void = () => undefined,
  drainTimeoutMs?: number,
) {
  return createMcpMessageServer({
    tools,
    serverInfo,
    send,
    diagnostic,
    ...(drainTimeoutMs === undefined ? {} : { drainTimeoutMs }),
  });
}

test("deterministic request completes while an AI request waits", async () => {
  const ai = deferred<ToolCallResult>();
  const sent: JsonRpcResponse[] = [];
  const server = serverWith(fakeRegistry({
    recall_with_ai: () => ai.promise,
    stats: () => toolResult(statsPayload),
  }), async (message) => { sent.push(message); });

  server.accept(modernToolCall("ai", "recall_with_ai", { query: "missing" }));
  server.accept(modernToolCall("stats", "stats"));

  await waitFor(() => sent.some((message) => message.id === "stats"));
  assert.equal(sent.some((message) => message.id === "ai"), false);
  ai.resolve(toolResult({ aiStatus: "disabled", rankedCandidateIds: [] }));
  await server.whenIdle();
});

test("reverse completion writes complete JSON lines in completion order", async () => {
  const first = deferred<ToolCallResult>();
  const second = deferred<ToolCallResult>();
  const output = new RecordingWritable();
  const writer = new SerializedJsonWriter(output);
  const server = serverWith(fakeRegistry({
    recall: () => first.promise,
    recent_failures: () => second.promise,
  }), (message) => writer.write(message));

  server.accept(modernToolCall("first", "recall", { query: "one" }));
  server.accept(modernToolCall("second", "recent_failures"));
  second.resolve(toolResult({ order: 2 }));
  await waitFor(() => output.text().includes('"id":"second"'));
  first.resolve(toolResult({ order: 1 }));
  await server.whenIdle();
  await writer.close(Date.now() + 1_000);

  assert.equal(output.text().endsWith("\n"), true);
  const lines = output.text().split("\n");
  assert.equal(lines.at(-1), "");
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.slice(0, -1).map((line) => (JSON.parse(line) as JsonRpcResponse).id), ["second", "first"]);
});

test("cancel aborts the exact numeric ID without touching the matching string ID", async () => {
  const numeric = deferred<ToolCallResult>();
  const textual = deferred<ToolCallResult>();
  const signals: AbortSignal[] = [];
  const sent: JsonRpcResponse[] = [];
  const server = serverWith(fakeRegistry({
    recall: (_args, signal) => { signals.push(signal); return numeric.promise; },
    recent_failures: (_args, signal) => { signals.push(signal); return textual.promise; },
  }), async (message) => { sent.push(message); });

  server.accept(modernToolCall(1, "recall", { query: "one" }));
  server.accept(modernToolCall("1", "recent_failures"));
  await waitFor(() => signals.length === 2);
  server.accept(cancelNotification(1));

  assert.equal(signals[0]?.aborted, true);
  assert.equal(signals[1]?.aborted, false);
  numeric.resolve(toolResult({ id: "numeric" }));
  textual.resolve(toolResult({ id: "textual" }));
  await server.whenIdle();
  assert.deepEqual(sent.map((message) => message.id), ["1"]);

  // the cancelled request released its reservation, so ID 1 is reusable
  server.accept(modernToolCall(1, "recall", { query: "again" }));
  await server.whenIdle();
  assert.equal(signals.length, 3);
  assert.deepEqual(sent.map((message) => message.id), ["1", 1]);
});

test("duplicate live ID is rejected without replacing the original controller", async () => {
  const original = deferred<ToolCallResult>();
  let calls = 0;
  let originalSignal: AbortSignal | undefined;
  const sent: JsonRpcResponse[] = [];
  const server = serverWith(fakeRegistry({
    recall: (_args, signal) => {
      calls += 1;
      originalSignal = signal;
      return original.promise;
    },
  }), async (message) => { sent.push(message); });

  server.accept(modernToolCall("same", "recall", { query: "one" }));
  server.accept(modernToolCall("same", "recall", { query: "two" }));
  await waitFor(() => calls === 1 && sent.length === 1);
  server.accept(cancelNotification("same"));

  assert.equal(calls, 1);
  assert.equal(originalSignal?.aborted, true);
  assert.deepEqual(sent[0], {
    jsonrpc: "2.0",
    id: "same",
    error: { code: JSON_RPC_ERROR.INVALID_REQUEST, message: "Invalid Request" },
  });
  original.resolve(toolResult({ completed: true }));
  await server.whenIdle();
  assert.equal(sent.length, 1);
});

test("duplicate live ID cannot commit a legacy state transition", async () => {
  const original = deferred<ToolCallResult>();
  let originalStarted = false;
  const sent: JsonRpcResponse[] = [];
  const server = serverWith(fakeRegistry({
    recall: () => {
      originalStarted = true;
      return original.promise;
    },
  }), async (message) => { sent.push(message); });

  server.accept(modernToolCall("same", "recall", { query: "one" }));
  await waitFor(() => originalStarted);
  server.accept(legacyInitialize("same"));
  server.accept(modernRequest("after-duplicate", "tools/list"));
  original.resolve(toolResult({ completed: true }));
  await server.whenIdle();

  assert.deepEqual(sent.find((message) => message.id === "after-duplicate"), {
    jsonrpc: "2.0",
    id: "after-duplicate",
    result: {
      tools: [],
      resultType: "complete",
      _meta: { "io.modelcontextprotocol/serverInfo": serverInfo },
    },
  });
});

test("a blocked send keeps the ID reserved through duplicate rejection, cancellation, and close, then frees it after settlement", async () => {
  const output = new ControllableBackpressureWritable();
  const writer = new SerializedJsonWriter(output);
  let calls = 0;
  let originalSignal: AbortSignal | undefined;
  const server = serverWith(fakeRegistry({
    recall: (_args, signal) => {
      calls += 1;
      originalSignal = signal;
      return toolResult({ completed: true });
    },
  }), (message) => writer.write(message));

  // 1. Fast tools/call "same" is called once; its success response reaches
  // the blocked send but has not settled.
  server.accept(modernToolCall("same", "recall", { query: "one" }));
  await waitFor(() => output.chunks.length === 1);
  assert.equal(calls, 1);

  // 2/3. A duplicate "same" accepted while blocked must not call the tool
  // again; it queues the exact -32600 Invalid Request response behind the
  // still-unsettled original send, while the original reservation remains
  // live. The writer serializes strictly in submission order, so the queued
  // write cannot reach output until backpressure releases (step 6) — settle
  // one bounded tick and prove no second tool call happened instead of
  // waiting on output bytes that cannot arrive yet.
  server.accept(modernToolCall("same", "recall", { query: "two" }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(output.chunks.length, 1);

  // 4. notifications/cancelled for "same" during the responding phase must
  // not abort the original signal or retract the original success.
  server.accept(cancelNotification("same"));
  assert.equal(originalSignal?.aborted, false);

  // 5. In a separate focused fixture, close() against a responding slot must
  // not abort its controller, must still honor the fixed drain deadline, and
  // permanent backpressure must not make shutdown unbounded. The reuse
  // fixture (`server`) above stays open for step 7.
  const closeOutput = new PermanentBackpressureWritable();
  const closeWriter = new SerializedJsonWriter(closeOutput);
  let closeSignal: AbortSignal | undefined;
  const closeServer = serverWith(fakeRegistry({
    recall: (_args, signal) => {
      closeSignal = signal;
      return toolResult({ completed: true });
    },
  }), (message) => closeWriter.write(message), undefined, 25);
  closeServer.accept(modernToolCall("closing", "recall", {}));
  await waitFor(() => closeOutput.chunks.length === 1);
  const closeStartedAt = Date.now();
  assert.equal(await closeServer.close(), "timed_out");
  assert.ok(Date.now() - closeStartedAt < 2_000, "close exceeded fixed bound");
  assert.equal(closeSignal?.aborted, false);

  // 6. Releasing backpressure yields exactly one original success response
  // and exactly one duplicate -32600 response, with no second first-lifetime
  // tool call.
  output.releaseDrain();
  await server.whenIdle();
  assert.equal(calls, 1);
  assert.equal(output.chunks.length, 2);
  assert.deepEqual(parseLine(output.chunks[0]), expectedRecallSuccess("same"));
  assert.deepEqual(parseLine(output.chunks[1]), {
    jsonrpc: "2.0",
    id: "same",
    error: { code: JSON_RPC_ERROR.INVALID_REQUEST, message: "Invalid Request" },
  });

  // 7. After all sends settle, ID "same" is reusable: the tool is called
  // again for the new request and it receives one normal response.
  server.accept(modernToolCall("same", "recall", { query: "three" }));
  await waitFor(() => output.chunks.length === 3);
  await server.whenIdle();
  assert.equal(calls, 2);
  assert.deepEqual(parseLine(output.chunks[2]), expectedRecallSuccess("same"));
});

test("a rejected response send still releases the reservation in finally", async () => {
  const diagnostics: string[] = [];
  let calls = 0;
  const server = serverWith(fakeRegistry({
    recall: () => {
      calls += 1;
      return toolResult({ completed: true });
    },
  }), async () => { throw new Error("write failed: /private/secret-path"); }, (message) => { diagnostics.push(message); });

  server.accept(modernToolCall("same", "recall", { query: "one" }));
  await server.whenIdle();

  assert.equal(calls, 1);
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0] ?? "", /write failed/);

  server.accept(modernToolCall("same", "recall", { query: "two" }));
  await server.whenIdle();
  assert.equal(calls, 2);
});

test("cancellation after response enqueue does not retract the response", async () => {
  const releaseSend = deferred<void>();
  const sent: JsonRpcResponse[] = [];
  let signal: AbortSignal | undefined;
  const server = serverWith(fakeRegistry({
    stats: (_args, requestSignal) => {
      signal = requestSignal;
      return toolResult(statsPayload);
    },
  }), async (message) => {
    sent.push(message);
    await releaseSend.promise;
  });

  server.accept(modernToolCall("race", "stats"));
  await waitFor(() => sent.length === 1);
  server.accept(cancelNotification("race"));
  assert.equal(signal?.aborted, false);
  releaseSend.resolve();
  await server.whenIdle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.id, "race");
});

test("unknown cancellation has no output and does not affect live work", async () => {
  const live = deferred<ToolCallResult>();
  let signal: AbortSignal | undefined;
  const sent: JsonRpcResponse[] = [];
  const server = serverWith(fakeRegistry({
    recall: (_args, requestSignal) => {
      signal = requestSignal;
      return live.promise;
    },
  }), async (message) => { sent.push(message); });

  server.accept(modernToolCall("live", "recall", { query: "one" }));
  await waitFor(() => signal !== undefined);
  server.accept(cancelNotification("unknown"));
  assert.equal(signal?.aborted, false);
  live.resolve(toolResult({ completed: true }));
  await server.whenIdle();
  assert.deepEqual(sent.map((message) => message.id), ["live"]);
});

test("dispatcher emits discovery, catalog, initialize, and ping envelopes", async () => {
  const tools = fakeRegistry({});
  const modernSent: JsonRpcResponse[] = [];
  const modern = serverWith(tools, async (message) => { modernSent.push(message); });
  modern.accept(modernRequest("discover", "server/discover"));
  modern.accept(modernRequest("list", "tools/list"));
  await modern.whenIdle();
  assert.deepEqual(modernSent, [
    {
      jsonrpc: "2.0",
      id: "discover",
      result: {
        supportedVersions: [MODERN_PROTOCOL_VERSION],
        capabilities: { tools: { listChanged: false } },
        instructions: SERVER_INSTRUCTIONS,
        resultType: "complete",
        _meta: { "io.modelcontextprotocol/serverInfo": serverInfo },
      },
    },
    {
      jsonrpc: "2.0",
      id: "list",
      result: {
        tools: [],
        resultType: "complete",
        _meta: { "io.modelcontextprotocol/serverInfo": serverInfo },
      },
    },
  ]);

  const legacySent: JsonRpcResponse[] = [];
  const legacy = serverWith(tools, async (message) => { legacySent.push(message); });
  legacyReady(legacy);
  legacy.accept({ jsonrpc: "2.0", id: "ping", method: "ping", params: {} });
  await legacy.whenIdle();
  assert.deepEqual(legacySent, [
    {
      jsonrpc: "2.0",
      id: "init",
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: { listChanged: false } },
        serverInfo,
        instructions: SERVER_INSTRUCTIONS,
      },
    },
    { jsonrpc: "2.0", id: "ping", result: {} },
  ]);
});

function realRegistryWithStats(stats: () => typeof statsPayload) {
  return createToolRegistry({
    exposure: "sanitized",
    memory: {
      recall: () => [],
      recentFailures: () => [],
      stats,
      searchKnowledge: () => [],
      fetchRecord: () => undefined,
      whyFile: () => [],
    },
    recallWithAi: disabledRecallWithAi,
  });
}

for (const era of ["modern", "legacy"] as const) {
  test(`${era} invalid tool and malformed known-tool arguments map to -32602`, async () => {
    const sent: JsonRpcResponse[] = [];
    const server = serverWith(realRegistryWithStats(() => statsPayload), async (message) => { sent.push(message); });
    if (era === "legacy") legacyReady(server);
    server.accept(eraToolCall(era, "unknown", "not_a_tool", {}));
    server.accept(eraToolCall(era, "malformed", "stats", { extra: true }));
    server.accept(eraToolCall(era, "null-arguments", "stats", null));
    await server.whenIdle();

    for (const id of ["unknown", "malformed", "null-arguments"]) {
      assert.deepEqual(sent.find((message) => message.id === id), {
        jsonrpc: "2.0",
        id,
        error: { code: JSON_RPC_ERROR.INVALID_PARAMS, message: "Invalid params" },
      });
    }
  });

  test(`${era} operational ToolExecutionError stays a successful isError tool result`, async () => {
    const sent: JsonRpcResponse[] = [];
    const server = serverWith(createToolRegistry({
      exposure: "sanitized",
      memory: createMemoryQueries(() => { throw new ToolExecutionError("memory_unavailable", "memory unavailable"); }),
      recallWithAi: disabledRecallWithAi,
    }), async (message) => { sent.push(message); });
    if (era === "legacy") legacyReady(server);
    server.accept(eraToolCall(era, "operational", "stats", {}));
    await server.whenIdle();

    const response = sent.find((message) => message.id === "operational");
    assert.ok(response !== undefined && "result" in response);
    assert.equal(response.result.isError, true);
    const unknownCoverage = {
      version: 1,
      scanned: 0,
      skipped: 0,
      truncated: 1,
      bytesScanned: 0,
      bytesTotal: 0,
      complete: false,
      reason: "read-race",
    };
    assert.deepEqual(response.result.structuredContent, {
      error: { code: "memory_unavailable", message: "memory unavailable" },
      coverage: unknownCoverage,
      memoryCoverage: unknownCoverage,
      memoryVersion: 1,
      memoryCoverageIncomplete: true,
    });
    if (era === "modern") {
      assert.equal(response.result.resultType, "complete");
      assert.deepEqual(response.result._meta, { "io.modelcontextprotocol/serverInfo": serverInfo });
    } else {
      assert.equal("resultType" in response.result, false);
      assert.equal("_meta" in response.result, false);
    }
  });

  test(`${era} unexpected provider exception fails open without diagnostics`, async () => {
    const sent: JsonRpcResponse[] = [];
    const diagnostics: string[] = [];
    const server = serverWith(realRegistryWithStats(() => {
      throw new Error("invariant failed at /private/rocky-secret.json");
    }), async (message) => { sent.push(message); }, (message) => { diagnostics.push(message); });
    if (era === "legacy") legacyReady(server);
    server.accept(eraToolCall(era, "unexpected", "stats", {}));
    await server.whenIdle();

    const response = sent.find((message) => message.id === "unexpected");
    assert.ok(response !== undefined && "result" in response);
    assert.equal(response.result.isError, undefined);
    assert.equal((response.result.structuredContent as Record<string, unknown>).total, 0);
    assert.doesNotMatch(JSON.stringify(sent), /private|rocky-secret|invariant/);
    assert.equal(diagnostics.length, 0);
  });
}

test("close aborts every request, stops acceptance, and returns at its fixed deadline", async () => {
  let calls = 0;
  let signal: AbortSignal | undefined;
  const server = serverWith(fakeRegistry({
    recall_with_ai: (_args, requestSignal) => {
      calls += 1;
      signal = requestSignal;
      return new Promise<ToolCallResult>(() => undefined);
    },
    stats: () => {
      calls += 1;
      return toolResult(statsPayload);
    },
  }), undefined, undefined, 25);

  server.accept(modernToolCall("stuck", "recall_with_ai", { query: "one" }));
  await waitFor(() => signal !== undefined);
  const startedAt = Date.now();
  assert.equal(await server.close(), "timed_out");
  const elapsed = Date.now() - startedAt;

  assert.equal(signal?.aborted, true);
  assert.ok(elapsed < 2_000, `close exceeded fixed bound: ${elapsed}ms`);
  server.accept(modernToolCall("after-close", "stats"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
});

test("input failure aborts active work, skips decoder EOF flush, and rethrows within the drain bound", async () => {
  const releaseFailure = deferred<void>();
  const inputError = new Error("input stream failed");
  const output = new RecordingWritable();
  const diagnostics = new RecordingWritable();
  let signal: AbortSignal | undefined;
  async function* rejectingInput(): AsyncGenerator<string> {
    yield `${JSON.stringify(modernToolCall("active", "recall_with_ai", { query: "one" }))}\n{"partial":`;
    await releaseFailure.promise;
    throw inputError;
  }
  const running = runMcpStdio({
    input: Readable.from(rejectingInput()),
    output,
    diagnostics,
  }, {
    serverInfo,
    tools: fakeRegistry({
      recall_with_ai: (_args, requestSignal) => {
        signal = requestSignal;
        return new Promise<ToolCallResult>(() => undefined);
      },
    }),
  }, { drainTimeoutMs: 30 });

  await waitFor(() => signal !== undefined);
  const startedAt = Date.now();
  releaseFailure.resolve();
  await assert.rejects(running, (error) => error === inputError);
  const elapsed = Date.now() - startedAt;

  assert.equal(signal?.aborted, true);
  assert.ok(elapsed < 2_000, `input failure cleanup exceeded fixed bound: ${elapsed}ms`);
  assert.equal(output.text(), "");
  assert.equal(diagnostics.text(), "");
});

test("runMcpStdio flushes EOF and aborts an active request without a late response", async () => {
  const output = new RecordingWritable();
  const diagnostics = new RecordingWritable();
  let signal: AbortSignal | undefined;
  await runMcpStdio({
    input: Readable.from([JSON.stringify(modernToolCall("eof", "recall_with_ai", { query: "one" }))]),
    output,
    diagnostics,
  }, {
    serverInfo,
    tools: fakeRegistry({
      recall_with_ai: (_args, requestSignal) => {
        signal = requestSignal;
        return toolResult({ late: true });
      },
    }),
  }, { drainTimeoutMs: 100 });

  assert.equal(signal?.aborted, true);
  assert.equal(output.text(), "");
  assert.equal(diagnostics.text(), "");
});

test("runMcpStdio writes parse and oversize errors with exact null-ID envelopes", async () => {
  const oversized = `"${"x".repeat(1_048_575)}"`;
  const output = new RecordingWritable();
  const diagnostics = new RecordingWritable();
  await runMcpStdio({
    input: Readable.from([`{"id":"guess",]\n${oversized}\n`]),
    output,
    diagnostics,
  }, {
    serverInfo,
    tools: fakeRegistry({}),
  });

  assert.deepEqual(output.messages(), [
    { jsonrpc: "2.0", id: null, error: { code: JSON_RPC_ERROR.PARSE_ERROR, message: "Parse error" } },
    {
      jsonrpc: "2.0",
      id: null,
      error: { code: JSON_RPC_ERROR.INVALID_REQUEST, message: "Input line exceeds 1048576 bytes" },
    },
  ]);
  assert.equal(diagnostics.text(), "");
});

test("EOF shares one deadline across abort-ignoring work and permanent output backpressure", async () => {
  const input = new PassThrough();
  const output = new PermanentBackpressureWritable();
  const diagnostics = new RecordingWritable();
  let ignoredSignal: AbortSignal | undefined;
  const running = runMcpStdio({ input, output, diagnostics }, {
    serverInfo,
    tools: fakeRegistry({
      stats: () => toolResult(statsPayload),
      recall_with_ai: (_args, signal) => {
        ignoredSignal = signal;
        return new Promise<ToolCallResult>(() => undefined);
      },
    }),
  }, { drainTimeoutMs: 30 });

  input.write([
    JSON.stringify(modernToolCall("backpressure", "stats")),
    JSON.stringify(modernToolCall("ignores-abort", "recall_with_ai", { query: "one" })),
    "",
  ].join("\n"));
  await waitFor(() => output.chunks.length === 1 && ignoredSignal !== undefined);

  const startedAt = Date.now();
  input.end();
  await running;
  const elapsed = Date.now() - startedAt;

  assert.equal(ignoredSignal?.aborted, true);
  assert.ok(elapsed < 2_000, `stdio drain exceeded fixed bound: ${elapsed}ms`);
  assert.equal(output.chunks.length, 1);
  assert.equal(diagnostics.text(), "");
});
