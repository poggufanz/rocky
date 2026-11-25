import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { disabledRecallWithAi } from "../ai/port.js";
import { createMemoryQueries } from "../core/memory-query.js";
import { loadMemory, type FailureRecord } from "../core/memory-read.js";
import type { ProjectedProblemEntry } from "../mcp/attempts-projection.js";
import { createExpectationBroker, type ExpectationBroker } from "../mcp/expectation-broker.js";
import { JSON_RPC_ERROR, LEGACY_PROTOCOL_VERSION, MODERN_PROTOCOL_VERSION, type JsonRpcResponse } from "../mcp/protocol.js";
import { createMcpMessageServer, runMcpStdio } from "../mcp/server.js";
import { createToolRegistry, type McpToolRegistry } from "../mcp/tools.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const childFixture = join(packageRoot, "test", "fixtures", "mcp", "expectation-child.mjs");
const serverInfo = { name: "rocky", version: "1.0.0" };
const notice = "Stored as the agent's own statement. Rocky does not check or act on it.";
const noteArgs = { text: "The next run should pass.", command: "npm test", failureId: "failure-expectation" };
const payload = { ...noteArgs, agent: "codex" as const };
const brokerFailed = { recorded: false, reason: "broker_failed", linkedFailure: false };
const timedOut = { recorded: false, reason: "timeout", linkedFailure: false };

function fakeBroker(id = "rationale-example") {
  const calls: unknown[] = [];
  return {
    calls,
    async note(input: unknown) {
      calls.push(input);
      return { recorded: true, id, linkedFailure: true };
    },
  };
}

function registry(writeToolsEnabled: boolean, expectationBroker?: ExpectationBroker) {
  return createToolRegistry({
    exposure: "sanitized",
    memory: createMemoryQueries(() => []),
    recallWithAi: disabledRecallWithAi,
    writeToolsEnabled,
    expectationBroker,
  });
}

function messageServer(tools: McpToolRegistry) {
  const responses: JsonRpcResponse[] = [];
  const server = createMcpMessageServer({
    tools, serverInfo,
    async send(response) { responses.push(response); },
    diagnostic() {},
  });
  return { server, responses };
}

function modern(id: number, method: string, params: Record<string, unknown> = {}, clientName?: string) {
  return {
    jsonrpc: "2.0", id, method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
        "io.modelcontextprotocol/clientCapabilities": {},
        ...(clientName === undefined ? {} : {
          "io.modelcontextprotocol/clientInfo": { name: clientName, version: "1.0.0" },
        }),
      },
    },
  };
}

function noteParams(args: unknown = noteArgs) {
  return { name: "note_expectation", arguments: args };
}

function result(response: JsonRpcResponse | undefined) {
  assert.ok(response && "result" in response, JSON.stringify(response));
  return response.result;
}

function invalidParams(id: number) {
  return { jsonrpc: "2.0", id, error: { code: JSON_RPC_ERROR.INVALID_PARAMS, message: "Invalid params" } };
}

test("disabling writes hides note_expectation and rejects calls before reaching the broker", async () => {
  const broker = fakeBroker();
  const { server, responses } = messageServer(registry(false, broker));
  server.accept(modern(1, "tools/list"));
  server.accept(modern(2, "tools/call", noteParams()));
  await server.whenIdle();
  const tools = result(responses.find(({ id }) => id === 1)).tools as { name: string }[];
  assert.equal(tools.length, 14);
  assert.ok(tools.every(({ name }) => name !== "note_expectation"));
  assert.deepEqual(responses.find(({ id }) => id === 2), invalidParams(2));
  assert.deepEqual(broker.calls, []);
});

test("note_expectation enforces field names, identifier syntax, and text and command code point limits", async () => {
  const broker = fakeBroker();
  const { server, responses } = messageServer(registry(true, broker));
  const invalid = [
    { ...noteArgs, failureId: "a b" },
    { ...noteArgs, text: "\u{1F9EA}".repeat(201) },
    { ...noteArgs, command: "\u{1F9EA}".repeat(201) },
    { ...noteArgs, text: "" },
    { ...noteArgs, command: "" },
    { ...noteArgs, agent: "codex" },
    {},
    null,
  ];
  invalid.forEach((args, i) => server.accept(modern(i, "tools/call", noteParams(args))));
  const boundary = { text: "\u{1F9EA}".repeat(200), command: "\u{1F9EA}".repeat(200) };
  server.accept(modern(10, "tools/call", noteParams(boundary)));
  await server.whenIdle();
  invalid.forEach((_, i) => assert.deepEqual(responses.find(({ id }) => id === i), invalidParams(i)));
  assert.deepEqual(result(responses.find(({ id }) => id === 10)).structuredContent, {
    recorded: true, id: "rationale-example", linkedFailure: true, notice,
  });
  assert.deepEqual(broker.calls, [{ ...boundary, agent: "generic" }]);
});

test("legacy initialize supplies the Claude label and sanitized calls project the reply ID", async () => {
  const broker = fakeBroker("id-with-secret");
  const { server, responses } = messageServer(registry(true, broker));
  server.accept({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: LEGACY_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "claude-code", version: "1.0.0" } },
  });
  server.accept({ jsonrpc: "2.0", method: "notifications/initialized" });
  server.accept({ jsonrpc: "2.0", id: 2, method: "tools/call", params: noteParams() });
  await server.whenIdle();
  assert.deepEqual(broker.calls, [{ ...noteArgs, agent: "claude-code" }]);
  assert.deepEqual(result(responses.find(({ id }) => id === 2)).structuredContent, {
    recorded: true, id: "[redacted]", linkedFailure: true, notice,
  });
});

test("modern client names persist until another request provides a name", async () => {
  const broker = fakeBroker();
  const { server, responses } = messageServer(registry(true, broker));
  server.accept(modern(1, "tools/call", noteParams({ text: "no name" })));
  server.accept(modern(2, "server/discover", {}, "CoDeX desktop"));
  server.accept(modern(3, "tools/call", noteParams({ text: "remember discover" })));
  server.accept(modern(4, "tools/call", noteParams({ text: "replace name" }), "Claude Desktop"));
  server.accept(modern(5, "tools/list", {}, "unrecognized client"));
  server.accept(modern(6, "tools/call", noteParams({ text: "remember list" })));
  await server.whenIdle();
  for (const id of [1, 3, 4, 6]) assert.equal(result(responses.find((response) => response.id === id)).structuredContent !== undefined, true);
  assert.deepEqual(broker.calls, [
    { text: "no name", agent: "generic" },
    { text: "remember discover", agent: "codex" },
    { text: "replace name", agent: "claude-code" },
    { text: "remember list", agent: "generic" },
  ]);
});

test("an enabled tool without a broker gives a broker_failed result", async () => {
  const { server, responses } = messageServer(registry(true));
  server.accept(modern(1, "tools/call", noteParams()));
  await server.whenIdle();
  assert.deepEqual(result(responses[0]).structuredContent, { ...brokerFailed, notice });
});

function brokerOptions(mode: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, EXPECTATION_CHILD_MODE: mode };
  return {
    execPath: process.execPath,
    entry: childFixture,
    cwd: packageRoot,
    env,
    timeoutMs: 2000,
  };
}

function isolatedDirectory(t: TestContext) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "rocky-mcp-expectation-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function isolatedMemory(t: TestContext) {
  const home = isolatedDirectory(t);
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
  });
  return home;
}

test("broker sends stdin and returns the parsed reply", async () => {
  const response = await createExpectationBroker(brokerOptions("echo")).note(payload, new AbortController().signal);
  assert.deepEqual(response, { recorded: true, id: payload.text, linkedFailure: true });
});

test("broker returns broker_failed for an unknown child reason", async () => {
  const broker = createExpectationBroker(brokerOptions("decline"));
  const response = await broker.note({ ...payload, text: "unexpected child diagnostic" }, new AbortController().signal);
  assert.deepEqual(response, brokerFailed);
});

test("broker preserves the five child decline reasons", async () => {
  const broker = createExpectationBroker(brokerOptions("decline"));
  const signal = new AbortController().signal;
  for (const reason of ["duplicate", "cap", "disabled", "invalid_input", "memory_unavailable"]) {
    const response = await broker.note({ ...payload, text: reason }, signal);
    assert.deepEqual(response, { recorded: false, reason, linkedFailure: false });
  }
});

test("broker rejects inconsistent success and decline reply fields", async () => {
  const broker = createExpectationBroker(brokerOptions("reply"));
  const signal = new AbortController().signal;
  for (const reply of [
    { recorded: true, linkedFailure: false },
    { recorded: true, id: "", linkedFailure: false },
    { recorded: true, id: "rationale-1", reason: "cap", linkedFailure: false },
    { recorded: true, reason: "cap", linkedFailure: false },
    { recorded: false, linkedFailure: false },
    { recorded: false, id: "rationale-1", reason: "duplicate", linkedFailure: false },
    { recorded: false, reason: "disabled", linkedFailure: true },
  ]) {
    assert.deepEqual(await broker.note({ ...payload, text: JSON.stringify(reply) }, signal), brokerFailed);
  }
});

for (const mode of ["garbage", "malformed", "oversized", "exit-1"]) {
  test(`broker returns broker_failed for ${mode} child output`, async () => {
    const response = await createExpectationBroker(brokerOptions(mode)).note(payload, new AbortController().signal);
    assert.deepEqual(response, brokerFailed);
  });
}

test("broker returns broker_failed for a missing entry or unavailable executable", async () => {
  const options = brokerOptions("echo");
  const signal = new AbortController().signal;
  assert.deepEqual(await createExpectationBroker({ ...options, entry: undefined }).note(payload, signal), brokerFailed);
  assert.deepEqual(await createExpectationBroker({ ...options, execPath: join(packageRoot, "missing-executable") })
    .note(payload, signal), brokerFailed);
});

for (const stop of ["timeout", "abort"] as const) {
  test(`broker kills a hanging child on ${stop}`, { timeout: 5000 }, async (t) => {
    const pidFile = join(isolatedDirectory(t), "pid");
    const options = brokerOptions("hang");
    const broker = createExpectationBroker({
      ...options,
      timeoutMs: stop === "abort" ? 10_000 : options.timeoutMs,
      env: { ...options.env, EXPECTATION_CHILD_PID_FILE: pidFile },
    });
    const controller = new AbortController();
    const started = performance.now();
    const pending = broker.note(payload, controller.signal);
    if (stop === "abort") {
      const deadline = started + 1750;
      while (!existsSync(pidFile) && performance.now() < deadline) await delay(10);
      controller.abort();
      assert.ok(existsSync(pidFile), "child did not start before abort");
    }
    assert.deepEqual(await pending, timedOut);
    assert.ok(performance.now() - started < 2500, `broker did not settle promptly on ${stop}`);
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  });
}

test("broker caps active writer children at four and reuses a slot after the child closes", { timeout: 10_000 }, async (t) => {
  const pidFile = join(isolatedDirectory(t), "pids");
  const options = brokerOptions("hang");
  const broker = createExpectationBroker({
    ...options, timeoutMs: 15_000,
    env: { ...options.env, EXPECTATION_CHILD_PID_FILE: pidFile },
  });
  const children = Array.from({ length: 4 }, () => new AbortController());
  const pending = children.map(({ signal }) => broker.note(payload, signal));
  const overflow = new AbortController();
  const replacement = new AbortController();
  const readPids = () => existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim().split(/\s+/u).filter(Boolean) : [];
  const waitForPids = async (count: number) => {
    const deadline = performance.now() + 3500;
    while (readPids().length < count && performance.now() < deadline) await delay(10);
    assert.equal(new Set(readPids()).size, count);
  };
  let next: Promise<unknown> | undefined;
  let denied: Promise<unknown> | undefined;
  try {
    await waitForPids(4);
    denied = broker.note(payload, overflow.signal);
    assert.deepEqual(await Promise.race([denied, delay(500, "still waiting", { ref: false })]), brokerFailed);
    children[0]!.abort();
    assert.deepEqual(await pending[0], timedOut);
    next = broker.note(payload, replacement.signal);
    await waitForPids(5);
    replacement.abort();
    assert.deepEqual(await next, timedOut);
  } finally {
    for (const child of [...children, overflow, replacement]) child.abort();
    await Promise.all([...pending, denied, next]);
  }
});

test("GitLab tokens in expectations stay out of memory, CLI output, and both MCP exposures", async (t) => {
  const home = isolatedMemory(t);
  const entry = join(packageRoot, "dist", "index.js");
  const memoryPath = join(home, "memory.jsonl");
  const options = brokerOptions("");
  const env = { ...options.env, ROCKY_HOME: home, ROCKY_MCP_WRITE: undefined };
  const token = "glpat-Fixture_0123-4567";
  const failure: FailureRecord = {
    kind: "failure", id: noteArgs.failureId, ts: Date.now() - 60_000, cwd: home, cmd: noteArgs.command,
    exitCode: 1, fingerprint: "0123456789abcdef", signature: ["test failed"], excerpt: "test failed",
  };
  writeFileSync(memoryPath, JSON.stringify(failure) + "\n");
  const expectationBroker = createExpectationBroker({ ...options, entry, cwd: home, env });
  const note = await expectationBroker.note({
    ...payload, text: "expect " + token + " to work", command: "check " + token,
  }, new AbortController().signal);
  assert.equal(note.recorded, true);
  assert.equal(note.linkedFailure, true);
  assert.equal(readFileSync(memoryPath, "utf8").includes(token), false);
  const stored = loadMemory(memoryPath).find((record) => record.kind === "rationale");
  assert.ok(stored);
  assert.equal(stored.excerpt, "expect [redacted gitlab token] to work");
  assert.equal(stored.expectedCommand, "check [redacted gitlab token]");

  const cli = spawnSync(process.execPath, [entry, "attempts", failure.fingerprint, "--json"], {
    cwd: home, env, encoding: "utf8", timeout: 10_000,
  });
  assert.ifError(cli.error);
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal((cli.stdout + cli.stderr).includes(token), false);
  assert.match(cli.stdout, /expect \[redacted gitlab token\] to work/u);
  assert.match(cli.stdout, /check \[redacted gitlab token\]/u);

  for (const exposure of ["sanitized", "raw"] as const) {
    const { server, responses } = messageServer(createToolRegistry({
      exposure,
      memory: createMemoryQueries(),
      recallWithAi: disabledRecallWithAi,
      writeToolsEnabled: false,
    }));
    server.accept(modern(1, "tools/call", {
      name: "attempt_history", arguments: { fingerprint: failure.fingerprint },
    }));
    await server.whenIdle();
    const { entries } = result(responses[0]).structuredContent as { entries: ProjectedProblemEntry[] };
    assert.equal(JSON.stringify(responses).includes(token), false);
    const [expectation] = entries[0]!.attempts[0]!.expectations!;
    const redaction = exposure === "raw" ? "[redacted gitlab token]" : "[redacted]";
    assert.equal(expectation.text, "expect " + redaction + " to work");
    assert.equal(expectation.command, "check " + redaction);
  }
});

test("runMcpStdio writes one MCP rationale through the CLI and reads it as testimony", { timeout: 10_000 }, async (t) => {
  const home = isolatedMemory(t);
  const memoryPath = join(home, "memory.jsonl");
  const failure: FailureRecord = {
    kind: "failure", id: noteArgs.failureId, ts: Date.now() - 60_000, cwd: home, cmd: noteArgs.command,
    exitCode: 1, fingerprint: "0123456789abcdef", signature: ["test failed"], excerpt: "test failed",
  };
  writeFileSync(memoryPath, JSON.stringify(failure) + "\n");
  const expectationBroker = createExpectationBroker({
    ...brokerOptions(""),
    entry: join(packageRoot, "dist", "index.js"),
    cwd: home,
    env: { ...process.env, ROCKY_MCP_WRITE: undefined },
  });
  const tools = createToolRegistry({
    exposure: "sanitized",
    memory: createMemoryQueries(),
    recallWithAi: disabledRecallWithAi,
    writeToolsEnabled: true,
    expectationBroker,
  });
  const input = new PassThrough();
  const output = new PassThrough();
  const diagnostics = new PassThrough();
  const lines = createInterface({ input: output });
  const reader = lines[Symbol.asyncIterator]();
  const running = runMcpStdio({ input, output, diagnostics }, { tools, serverInfo });
  async function request(message: ReturnType<typeof modern>) {
    input.write(JSON.stringify(message) + "\n");
    const line = await reader.next();
    assert.equal(line.done, false);
    return result(JSON.parse(line.value) as JsonRpcResponse).structuredContent;
  }
  try {
    const note = await request(modern(1, "tools/call", noteParams(), "Codex CLI"));
    const rationales = loadMemory(memoryPath).filter((record) => record.kind === "rationale");
    assert.equal(rationales.length, 1);
    const [rationale] = rationales;
    assert.deepEqual(note, { recorded: true, id: rationale.id, linkedFailure: true, notice });
    assert.equal(rationale.source, "mcp");
    assert.equal(rationale.agent, "codex");
    const history = await request(modern(2, "tools/call", {
      name: "attempt_history", arguments: { fingerprint: failure.fingerprint },
    })) as { entries: ProjectedProblemEntry[] };
    assert.deepEqual(history.entries[0]?.attempts[0]?.expectations, [{
      text: noteArgs.text, command: noteArgs.command, rationaleId: rationale.id, observed: "no_matching_run", testimony: true,
    }]);
    assert.equal(diagnostics.read(), null);
  } finally {
    input.end();
    await running;
    lines.close();
  }
});
