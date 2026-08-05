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

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`${label} exceeded 2000ms`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

test("cancelled MCP local-AI request leaves all state untouched and never emits a response", { timeout: 10_000 }, async (t) => {
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

  child.stdin.write(`${JSON.stringify(modernRequest("cancel-me", "tools/call", {
    name: "recall_with_ai", arguments: { query: "missing module" },
  }))}\n`);
  await waitFor(() => Buffer.concat(stderr).toString("utf8").includes("SLOW_FETCH_PROMPT_BASE64 "), "slow local AI request start");
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "cancel-me", reason: "test cancellation" },
  })}\n`);
  child.stdin.write(`${JSON.stringify(modernRequest("stats-after-cancel", "tools/call", { name: "stats", arguments: {} }))}\n`);

  const statsLine = await Promise.race([
    lines.next(),
    new Promise<IteratorResult<string>>((_, reject) => setTimeout(() => reject(new Error("stats response exceeded 2000ms")), 2_000)),
  ]);
  assert.equal(statsLine.done, false);
  const stats = JSON.parse(statsLine.value ?? "") as { id: string; result?: { structuredContent?: { failures?: number } } };
  assert.equal(stats.id, "stats-after-cancel");
  assert.equal(stats.result?.structuredContent?.failures, 2);

  child.stdin.end();
  assert.deepEqual(await closed, { code: 0, signal: null });
  const remaining = await lines.next();
  assert.equal(remaining.done, true);
  assert.deepEqual(snapshotTree(home), before);
});
