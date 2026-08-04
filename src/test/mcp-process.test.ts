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

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(repoRoot, "dist", "index.js");
const fixtureMemory = join(repoRoot, "test", "fixtures", "mcp", "memory.jsonl");
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
    ai: { enabled: true, provider: "ollama", model: "never-contact", exposure: "raw" },
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

class McpCliProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stdoutLines: string[] = [];
  private readonly lineIterator: AsyncIterator<string>;
  private readonly stdoutChunks: Buffer[] = [];
  private readonly stderrChunks: Buffer[] = [];
  private readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  constructor(home: string, exposure = "sanitized") {
    this.child = spawn(process.execPath, [cli, "mcp"], {
      cwd: repoRoot,
      env: { ...process.env, ROCKY_HOME: home, ROCKY_MCP_EXPOSURE: exposure },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.lineIterator = createInterface({ input: this.child.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
    this.child.stdout.on("data", (chunk: Buffer) => this.stdoutChunks.push(Buffer.from(chunk)));
    this.child.stderr.on("data", (chunk: Buffer) => this.stderrChunks.push(Buffer.from(chunk)));
    this.exited = new Promise((resolve, reject) => {
      this.child.once("error", reject);
      this.child.once("exit", (code, signal) => resolve({ code, signal }));
    });
  }

  notify(message: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async request(message: Record<string, unknown>): Promise<JsonRpcResponse> {
    this.notify(message);
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
    return withTimeout(this.exited, 2_000, "MCP EOF exit");
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
