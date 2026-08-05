import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { singleFlightRecallAi } from "../ai/recall-ai.js";
import type { RecallWithAiPort } from "../ai/port.js";
import type { MemoryRecord } from "../core/memory-read.js";
import { createMemoryQueries } from "../core/memory-query.js";
import { createToolRegistry } from "../mcp/tools.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(repoRoot, "dist", "index.js");
const fixtureMemory = join(repoRoot, "test", "fixtures", "mcp", "memory.jsonl");
const slowFetch = join(repoRoot, "test", "fixtures", "mcp", "slow-fetch.cjs");
const modernMeta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "rocky-process-test", version: "1.0.0" },
};

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface SnapshotEntry {
  path: string;
  type: "directory" | "file" | "symlink" | "other";
  bytes: string;
  mtimeNs: string;
}

function seedHome(t: test.TestContext): string {
  const home = mkdtempSync(join(tmpdir(), "rocky-mcp-process-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, "nested", "sentinels"), { recursive: true });
  writeFileSync(join(home, "memory.jsonl"), readFileSync(fixtureMemory));
  writeFileSync(join(home, "config.json"), JSON.stringify({
    version: 1,
    ai: { enabled: false },
  }) + "\n");
  writeFileSync(join(home, "pending"), "pending-sentinel\n");
  writeFileSync(join(home, "guard.rules"), "^rm -rf\\tguard sentinel\n");
  writeFileSync(join(home, "nested", "sentinels", "unrelated.bin"), Buffer.from([0, 1, 2, 255]));
  return home;
}

function snapshotTree(root: string): SnapshotEntry[] {
  const entries: SnapshotEntry[] = [];
  const visit = (path: string): void => {
    const stat = lstatSync(path, { bigint: true });
    const type = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : stat.isSymbolicLink() ? "symlink" : "other";
    entries.push({
      path: relative(root, path) || ".",
      type,
      bytes: type === "file"
        ? readFileSync(path).toString("base64")
        : type === "symlink" ? Buffer.from(readlinkSync(path), "utf8").toString("base64") : "",
      mtimeNs: stat.mtimeNs.toString(),
    });
    if (type === "directory") {
      for (const name of readdirSync(path).sort()) visit(join(path, name));
    }
  };
  visit(root);
  return entries;
}

function modernRequest(id: string, method: string, params: Record<string, unknown> = {}): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method, params: { _meta: modernMeta, ...params } };
}

function legacyRequest(id: string, method: string, params: Record<string, unknown> = {}): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method, params };
}

function waitForChildCompletion(child: ChildProcessWithoutNullStreams): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
}> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

class McpCliProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stdoutLines: string[] = [];
  private readonly lineIterator: AsyncIterator<string>;
  private readonly stdoutChunks: Buffer[] = [];
  private readonly stderrChunks: Buffer[] = [];
  private readonly closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  constructor(home: string, exposure = "sanitized", preload?: string) {
    this.child = spawn(process.execPath, [
      ...(preload === undefined ? [] : ["--require", preload]),
      cli, "mcp",
    ], {
      cwd: repoRoot,
      env: { ...process.env, ROCKY_HOME: home, ROCKY_MCP_EXPOSURE: exposure },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.lineIterator = createInterface({ input: this.child.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
    this.child.stdout.on("data", (chunk: Buffer) => this.stdoutChunks.push(Buffer.from(chunk)));
    this.child.stderr.on("data", (chunk: Buffer) => this.stderrChunks.push(Buffer.from(chunk)));
    this.closed = waitForChildCompletion(this.child);
  }

  notify(message: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async request(message: Record<string, unknown>): Promise<JsonRpcResponse> {
    this.notify(message);
    return this.nextResponse();
  }

  async nextResponse(): Promise<JsonRpcResponse> {
    const next = await withTimeout(this.lineIterator.next(), 2_000, "MCP response");
    assert.equal(next.done, false, `server closed before response; stderr: ${this.stderr()}`);
    const line = next.value ?? "";
    this.stdoutLines.push(line);
    let parsed: unknown;
    assert.doesNotThrow(() => { parsed = JSON.parse(line); }, `stdout is not JSON: ${line}`);
    assert.equal(typeof parsed, "object");
    assert.notEqual(parsed, null);
    return parsed as JsonRpcResponse;
  }

  async close(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    this.child.stdin.end();
    return withTimeout(this.closed, 2_000, "MCP EOF close");
  }

  stderr(): string {
    return Buffer.concat(this.stderrChunks).toString("utf8");
  }

  assertJsonOnlyStdout(): void {
    const output = Buffer.concat(this.stdoutChunks).toString("utf8");
    assert.ok(output.endsWith("\n"), "protocol responses must be newline framed");
    const lines = output.split("\n").filter((line) => line.length > 0);
    assert.equal(lines.length, this.stdoutLines.length, "unexpected protocol stdout line");
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line), `stdout is not JSON: ${line}`);
    }
  }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`${label} exceeded 2000ms`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function slowFetchPrompt(stderr: string): Record<string, unknown> {
  const prefix = "SLOW_FETCH_PROMPT_BASE64 ";
  const line = stderr.split("\n").find((value) => value.startsWith(prefix));
  assert.notEqual(line, undefined, "slow fetch did not capture an AI prompt");
  return JSON.parse(Buffer.from(line!.slice(prefix.length), "base64").toString("utf8")) as Record<string, unknown>;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function assertToolCatalog(response: JsonRpcResponse): void {
  assert.deepEqual((response.result?.tools as { name: string }[]).map((tool) => tool.name), [
    "recall", "recent_failures", "stats", "recall_with_ai",
  ]);
  assert.equal(JSON.stringify(response).includes('"cwd"'), false);
}

function structured(response: JsonRpcResponse): Record<string, unknown> {
  assert.ok(response.result !== undefined, JSON.stringify(response));
  const value = response.result.structuredContent;
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  return value as Record<string, unknown>;
}

const calls = [
  ["recall", { query: "missing module" }],
  ["recent_failures", {}],
  ["stats", {}],
  ["recall_with_ai", { query: "missing module" }],
] as const;

test("compiled CLI serves modern discovery, listing, and every read-only tool without mutating state", { timeout: 10_000 }, async (t) => {
  const home = seedHome(t);
  const before = snapshotTree(home);
  const server = new McpCliProcess(home);

  const discovery = await server.request(modernRequest("modern-discover", "server/discover"));
  assert.deepEqual(discovery.result?.supportedVersions, ["2026-07-28"]);
  assert.deepEqual(discovery.result?._meta, {
    "io.modelcontextprotocol/serverInfo": { name: "@poggufanz/rocky-cli", version: "0.2.1-beta.0" },
  });
  assertToolCatalog(await server.request(modernRequest("modern-list", "tools/list")));

  const responses = new Map<string, JsonRpcResponse>();
  for (const [name, args] of calls) {
    responses.set(name, await server.request(modernRequest(`modern-${name}`, "tools/call", { name, arguments: args })));
  }
  assert.equal((structured(responses.get("stats")!).failures), 2);
  assert.equal(structured(responses.get("recall_with_ai")!).aiStatus, "disabled");
  assert.equal(JSON.stringify([...responses.values()]).includes("fixture-secret-value"), false);
  assert.equal(JSON.stringify([...responses.values()]).includes("/private/rocky"), false);

  const exit = await server.close();
  assert.deepEqual(exit, { code: 0, signal: null });
  assert.equal(server.stderr(), "");
  assert.ok(server.stdoutLines.length > 0);
  server.assertJsonOnlyStdout();
  assert.deepEqual(snapshotTree(home), before);
});

test("MCP keeps stats responsive during one local-AI request and sends strictest sanitized evidence", { timeout: 10_000 }, async (t) => {
  const home = seedHome(t);
  writeFileSync(join(home, "config.json"), JSON.stringify({
    version: 1,
    ai: { enabled: true, provider: "ollama", model: "test-model", exposure: "sanitized" },
  }) + "\n");
  const before = snapshotTree(home);
  const server = new McpCliProcess(home, "raw", slowFetch);

  server.notify(modernRequest("ai-first", "tools/call", {
    name: "recall_with_ai", arguments: { query: "missing module" },
  }));
  await waitFor(() => server.stderr().includes("SLOW_FETCH_PROMPT_BASE64 "), "slow local AI request start");

  const prompt = JSON.stringify(slowFetchPrompt(server.stderr()));
  assert.doesNotMatch(prompt, /"cwd"|"excerpt"|\/private\/rocky|fixture-secret-value|Bearer fixture-secret-value/);

  server.notify(modernRequest("ai-busy", "tools/call", {
    name: "recall_with_ai", arguments: { query: "missing module" },
  }));
  server.notify(modernRequest("responsive-stats", "tools/call", { name: "stats", arguments: {} }));

  const responses = new Map<string | number | null, JsonRpcResponse>();
  const first = await server.nextResponse();
  const second = await server.nextResponse();
  responses.set(first.id, first);
  responses.set(second.id, second);

  const busy = responses.get("ai-busy");
  const stats = responses.get("responsive-stats");
  assert.equal(structured(busy!).aiStatus, "busy");
  assert.deepEqual(structured(busy!).rankedCandidateIds, ["c1"]);
  assert.equal(structured(stats!).failures, 2);

  server.notify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "ai-first" } });
  const exit = await server.close();
  assert.deepEqual(exit, { code: 0, signal: null });
  server.assertJsonOnlyStdout();
  assert.deepEqual(snapshotTree(home), before);
});

test("MCP tool registry returns busy without queuing and only accepts a fully valid AI reorder", async () => {
  const records: MemoryRecord[] = [
    {
      kind: "failure", id: "candidate-one", ts: 1, cwd: "/private/one", cmd: "needle first", exitCode: 1,
      fingerprint: "first", signature: ["needle"], excerpt: "first",
    },
    {
      kind: "failure", id: "candidate-two", ts: 2, cwd: "/private/two", cmd: "needle second", exitCode: 1,
      fingerprint: "second", signature: ["needle"], excerpt: "second",
    },
  ];
  let finishFirst: ((value: Awaited<ReturnType<RecallWithAiPort["run"]>>) => void) | undefined;
  const deferred: RecallWithAiPort = {
    async run() {
      return await new Promise((resolve) => { finishFirst = resolve; });
    },
  };
  const registry = createToolRegistry({
    exposure: "sanitized",
    memory: createMemoryQueries(() => records),
    recallWithAi: singleFlightRecallAi(deferred),
  });
  const first = registry.call("recall_with_ai", { query: "needle" }, new AbortController().signal);
  const busy = await registry.call("recall_with_ai", { query: "needle" }, new AbortController().signal);
  const stats = await registry.call("stats", {}, new AbortController().signal);
  assert.equal(busy.structuredContent.aiStatus, "busy");
  assert.deepEqual(busy.structuredContent.rankedCandidateIds, ["c1", "c2"]);
  assert.equal(stats.structuredContent.failures, 2);
  finishFirst?.({ aiStatus: "used", rankedCandidateIds: ["c2", "c1"] });
  assert.deepEqual((await first).structuredContent.rankedCandidateIds, ["c2", "c1"]);

  const reordered = await createToolRegistry({
    exposure: "sanitized",
    memory: createMemoryQueries(() => records),
    recallWithAi: { async run() { return { aiStatus: "used", rankedCandidateIds: ["c2", "c1"] }; } },
  }).call("recall_with_ai", { query: "needle" }, new AbortController().signal);
  assert.deepEqual((reordered.structuredContent.items as { candidateId: string }[]).map((item) => item.candidateId), ["c2", "c1"]);

  for (const outcome of [
    { aiStatus: "used" as const, rankedCandidateIds: ["c2", "not-a-candidate"] },
    { aiStatus: "used" as const, rankedCandidateIds: ["c2", "c1"], evidenceRefs: ["c2.failure", "outside.failure"] },
  ]) {
    const rejected = await createToolRegistry({
      exposure: "sanitized",
      memory: createMemoryQueries(() => records),
      recallWithAi: { async run() { return outcome; } },
    }).call("recall_with_ai", { query: "needle" }, new AbortController().signal);
    assert.deepEqual(rejected.structuredContent.rankedCandidateIds, ["c1", "c2"]);
    assert.deepEqual((rejected.structuredContent.items as { candidateId: string }[]).map((item) => item.candidateId), ["c1", "c2"]);
    assert.deepEqual(rejected.structuredContent.evidenceRefs ?? [], outcome.evidenceRefs === undefined ? [] : ["c2.failure"]);
  }
});

test("compiled CLI serves a separate legacy lifecycle and reloads externally appended memory", { timeout: 10_000 }, async (t) => {
  const home = seedHome(t);
  const server = new McpCliProcess(home);

  const initialized = await server.request({
    jsonrpc: "2.0",
    id: "legacy-initialize",
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "rocky-process-test", version: "1.0.0" },
    },
  });
  assert.equal(initialized.result?.protocolVersion, "2025-11-25");
  server.notify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  assert.deepEqual((await server.request(legacyRequest("legacy-ping", "ping"))).result, {});
  assertToolCatalog(await server.request(legacyRequest("legacy-list", "tools/list")));

  const initialStats = structured(await server.request(legacyRequest("legacy-stats-before", "tools/call", {
    name: "stats", arguments: {},
  })));
  assert.equal(initialStats.failures, 2);

  appendFileSync(join(home, "memory.jsonl"), JSON.stringify({
    kind: "failure",
    id: "externally-appended",
    ts: 1700000003000,
    cwd: "/external/private/path",
    cmd: "node external.js",
    exitCode: 1,
    fingerprint: "external-fingerprint",
    signature: ["ExternalError"],
    excerpt: "external append",
  }) + "\n");
  const afterExternalAppend = snapshotTree(home);

  const responses = new Map<string, JsonRpcResponse>();
  for (const [name, args] of calls) {
    responses.set(name, await server.request(legacyRequest(`legacy-${name}`, "tools/call", { name, arguments: args })));
  }
  assert.equal(structured(responses.get("stats")!).failures, 3);
  assert.equal(structured(responses.get("recall_with_ai")!).aiStatus, "disabled");
  assert.equal(JSON.stringify([...responses.values()]).includes("/external/private/path"), false);

  const exit = await server.close();
  assert.deepEqual(exit, { code: 0, signal: null });
  assert.equal(server.stderr(), "");
  server.assertJsonOnlyStdout();
  assert.deepEqual(snapshotTree(home), afterExternalAppend);
});

test("uppercase RAW exposure fails before protocol output with one concise diagnostic", { timeout: 5_000 }, async (t) => {
  const home = seedHome(t);
  const result = spawnSync(process.execPath, [cli, "mcp"], {
    cwd: repoRoot,
    env: { ...process.env, ROCKY_HOME: home, ROCKY_MCP_EXPOSURE: "RAW" },
    input: "",
    encoding: "utf8",
    timeout: 2_000,
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^\[Rocky MCP\] Error: invalid exposure: RAW\n$/);
});

test("help advertises MCP as a stream-only command", () => {
  const result = spawnSync(process.execPath, [cli, "--help"], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rocky mcp\s+serve read-only memory tools over stdio\./);
});

test("child completion waits for inherited stdout and stderr pipes before trailing-output audit", { timeout: 5_000 }, async () => {
  const grandchildScript = [
    "setTimeout(() => {",
    "  process.stdout.write('trailing persona\\n');",
    "  process.stderr.write('trailing diagnostic\\n');",
    "}, 100);",
  ].join("\n");
  const childScript = [
    "const { spawn } = require('node:child_process');",
    `const tail = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { detached: true, stdio: ['ignore', 1, 2] });`,
    "tail.unref();",
    "process.stdout.write('{\"jsonrpc\":\"2.0\"}\\n');",
  ].join("\n");
  const child = spawn(process.execPath, ["-e", childScript], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let stdoutEnded = false;
  let stderrEnded = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  child.stdout.once("end", () => { stdoutEnded = true; });
  child.stderr.once("end", () => { stderrEnded = true; });

  const completed = await withTimeout(waitForChildCompletion(child), 2_000, "fixture child close");

  assert.deepEqual(completed, { code: 0, signal: null });
  assert.equal(stdoutEnded, true, "completion preceded stdout EOF");
  assert.equal(stderrEnded, true, "completion preceded stderr EOF");
  assert.match(stdout, /trailing persona\n$/);
  assert.match(stderr, /trailing diagnostic\n$/);
});
