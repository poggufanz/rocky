import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureMemory = join(repoRoot, "test", "fixtures", "mcp", "memory.jsonl");
const slowFetch = join(repoRoot, "test", "fixtures", "mcp", "slow-fetch.cjs");
const slowFetchAborted = "SLOW_FETCH_GENERATE_ABORTED";
const modernMeta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "rocky-recall-ai-process-test", version: "1.0.0" },
};

interface SnapshotEntry {
  path: string;
  type: "directory" | "file" | "symlink" | "other";
  bytes: string;
  mtimeNs: string;
}

function seedHome(t: test.TestContext): string {
  const home = mkdtempSync(join(tmpdir(), "rocky-recall-ai-process-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, "unrelated", "sentinels"), { recursive: true });
  writeFileSync(join(home, "memory.jsonl"), readFileSync(fixtureMemory));
  writeFileSync(join(home, "config.json"), JSON.stringify({
    version: 1,
    ai: { enabled: true, provider: "ollama", model: "test-model", exposure: "sanitized" },
  }) + "\n");
  writeFileSync(join(home, "pending"), "pending-sentinel\n");
  writeFileSync(join(home, "unrelated", "sentinels", "keep.bin"), Buffer.from([0, 1, 2, 255]));
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
      bytes: type === "file" ? readFileSync(path).toString("base64") : type === "symlink"
        ? Buffer.from(readlinkSync(path), "utf8").toString("base64") : "",
      mtimeNs: stat.mtimeNs.toString(),
    });
    if (type === "directory") for (const name of readdirSync(path).sort()) visit(join(path, name));
  };
  visit(root);
  return entries;
}

function modernRequest(id: string, method: string, params: Record<string, unknown> = {}): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method, params: { _meta: modernMeta, ...params } };
}

function waitForChild(child: ChildProcessWithoutNullStreams): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

// Hang guard only -- every use below bounds how long one step of the real
// MCP child process's lifecycle may take before the wait gives up; none of
// these values are assertions about correctness. On a loaded windows-latest
// CI runner, Node startup plus CLI initialization alone can exceed the
// previous 2_000ms bound, turning a healthy child into a false timeout.
// 20s per step is generous enough to absorb that contention while still
// catching a genuine hang; the test's own { timeout } option is widened to
// give enough headroom for the several such steps this test performs in
// sequence.
const PROCESS_HANG_GUARD_MS = 20_000;

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + PROCESS_HANG_GUARD_MS;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`${label} exceeded ${PROCESS_HANG_GUARD_MS}ms`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${PROCESS_HANG_GUARD_MS}ms`)), PROCESS_HANG_GUARD_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function stopChild(child: ChildProcessWithoutNullStreams, closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
}> {
  child.stdin.end();
  try {
    return await withTimeout(closed, "MCP EOF close");
  } catch {
    child.kill();
    return await withTimeout(closed, "forced MCP close");
  }
}

test("cancelled MCP local-AI request leaves all state untouched and never emits a response", { timeout: PROCESS_HANG_GUARD_MS * 3 }, async (t) => {
  const home = seedHome(t);
  const before = snapshotTree(home);
  const testEnv = { ...process.env, ROCKY_HOME: home, ROCKY_MCP_EXPOSURE: "sanitized" };
  const child = spawn(process.execPath, [
    "--require", slowFetch,
    join(repoRoot, "dist", "index.js"), "mcp",
  ], { cwd: repoRoot, env: testEnv, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
  const stderr: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
  const closed = waitForChild(child);
  let closedByTest = false;

  try {
    child.stdin.write(`${JSON.stringify(modernRequest("cancel-me", "tools/call", {
      name: "recall_with_ai", arguments: { query: "missing module" },
    }))}\n`);
    await waitFor(() => Buffer.concat(stderr).toString("utf8").includes("SLOW_FETCH_PROMPT_BASE64 "), "slow local AI request start");
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "cancel-me", reason: "test cancellation" },
    })}\n`);
    await waitFor(
      () => Buffer.concat(stderr).toString("utf8").includes(slowFetchAborted),
      "notification cancellation reaching local AI request",
    );
    child.stdin.write(`${JSON.stringify(modernRequest("stats-after-cancel", "tools/call", { name: "stats", arguments: {} }))}\n`);

    const statsLine = await withTimeout(lines.next(), "stats response");
    assert.equal(statsLine.done, false);
    const stats = JSON.parse(statsLine.value ?? "") as { id: string; result?: { structuredContent?: { failures?: number } } };
    assert.equal(stats.id, "stats-after-cancel");
    assert.equal(stats.result?.structuredContent?.failures, 2);

    const exit = await stopChild(child, closed);
    closedByTest = true;
    assert.deepEqual(exit, { code: 0, signal: null });
    const remaining = await withTimeout(lines.next(), "MCP stdout EOF");
    assert.equal(remaining.done, true);
    assert.deepEqual(snapshotTree(home), before);
  } finally {
    if (!closedByTest) await stopChild(child, closed);
  }
});
