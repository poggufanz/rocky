import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recall } from "../commands/recall.js";
import { stats } from "../commands/stats.js";
import { run } from "../commands/run.js";
import { loadMemory } from "../core/memory-read.js";
import { createMemoryQueries } from "../core/memory-query.js";
import { disabledRecallWithAi } from "../ai/port.js";
import { createToolRegistry } from "../mcp/tools.js";
import { validateRockyPhrase } from "../ui/phrases.js";

const DISCLOSURE = "memory file does not open for me. I answer from nothing.";

async function captureStderr<T>(fn: () => Promise<T> | T): Promise<{ result: T; stderr: string }> {
  const original = process.stderr.write;
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = await fn();
    return { result, stderr };
  } finally {
    process.stderr.write = original;
  }
}

let originalRockyHome: string | undefined;
let root: string;

before(() => {
  originalRockyHome = process.env.ROCKY_HOME;
  root = mkdtempSync(join(tmpdir(), "rocky-memory-unreadable-"));
});

after(() => {
  if (originalRockyHome === undefined) delete process.env.ROCKY_HOME;
  else process.env.ROCKY_HOME = originalRockyHome;
  rmSync(root, { recursive: true, force: true });
});

function unreadableHome(name: string): string {
  const home = join(root, name);
  mkdirSync(home, { recursive: true });
  // A directory where the memory file belongs is portable, unlike chmod 000
  // which root ignores; the descriptor loader rejects it before opening.
  mkdirSync(join(home, "memory.jsonl"), { recursive: true });
  return home;
}

test("recall() treats a non-regular memory path as empty without raw Node error text", async () => {
  // recall()'s default dependencies resolve the memory path from ROCKY_HOME,
  // so this exercises the actual path rather than an injected query seam.
  const home = unreadableHome("recall-unreadable");
  process.env.ROCKY_HOME = home;

  const { result, stderr } = await captureStderr(() => recall(["anything"]));

  assert.equal(result, 0);
  assert.doesNotMatch(stderr, /memory file does not open for me\. I answer from nothing\./);
  assert.doesNotMatch(stderr, /EISDIR/);
  assert.doesNotMatch(stderr, /Error:/);
});

test("stats() treats a non-regular memory path as empty", async () => {
  const home = unreadableHome("stats-unreadable");
  process.env.ROCKY_HOME = home;

  const { result, stderr } = await captureStderr(() => stats());

  assert.equal(result, 0);
  assert.doesNotMatch(stderr, /memory file does not open for me\. I answer from nothing\./);
  assert.doesNotMatch(stderr, /EISDIR/);
  assert.doesNotMatch(stderr, /Error:/);
});

test("recall() and stats() behave as today when memory.jsonl is simply absent", async () => {
  const home = join(root, "absent-memory");
  mkdirSync(home, { recursive: true });
  process.env.ROCKY_HOME = home;

  const { result: recallResult } = await captureStderr(() => recall(["anything"]));
  assert.equal(recallResult, 0);

  const { result: statsResult } = await captureStderr(() => stats());
  assert.equal(statsResult, 0);
});

test("loadMemory fails closed for a memory symlink", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "rocky-memory-symlink-read-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const target = join(directory, "target.jsonl");
  const link = join(directory, "memory.jsonl");
  writeFileSync(target, JSON.stringify({
    kind: "failure", id: "symlink-target", ts: 1, cwd: "/w", cmd: "false", exitCode: 1,
    fingerprint: "fp", signature: ["false"], excerpt: "failed",
  }) + "\n", "utf8");
  try {
    symlinkSync(target, link);
  } catch {
    t.skip("symlink creation unsupported on this platform");
    return;
  }

  assert.deepEqual(loadMemory(link), []);
});

test("loadMemory returns promptly for a FIFO memory path", (t) => {
  if (process.platform === "win32") {
    t.skip("Windows has no portable mkfifo fixture; implementation uses lstat/fstat checks without POSIX flags");
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), "rocky-memory-fifo-read-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fifo = join(directory, "memory.jsonl");
  const made = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
  if (made.error !== undefined || made.status !== 0) {
    t.skip("host has no filesystem FIFO capability");
    return;
  }

  const modulePath = fileURLToPath(new URL("../core/memory-read.js", import.meta.url));
  const script = `import { loadMemory } from ${JSON.stringify(pathToFileURL(modulePath).href)};\n` +
    `const records = loadMemory(${JSON.stringify(fifo)});\n` +
    `if (records.length !== 0) process.exit(2);\n`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
    timeout: 1_000,
  });

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
});

test("run() of a succeeding command keeps the wrapped exit code when memory is non-regular", async () => {
  const home = unreadableHome("run-unreadable");
  process.env.ROCKY_HOME = home;

  const { result, stderr } = await captureStderr(() => run("exit 0"));

  assert.equal(result, 0);
  assert.doesNotMatch(stderr, /memory file does not open for me\. I answer from nothing\./);
  assert.doesNotMatch(stderr, /I cannot write memory/);
  assert.doesNotMatch(stderr, /EISDIR/);
  assert.doesNotMatch(stderr, /Error:/);
});

test("MCP tool path treats the same non-regular memory as empty", async () => {
  const home = unreadableHome("mcp-unreadable");
  const memoryPath = join(home, "memory.jsonl");
  const registry = createToolRegistry({
    exposure: "sanitized",
    memory: createMemoryQueries(() => loadMemory(memoryPath)),
    recallWithAi: disabledRecallWithAi,
  });

  const result = await registry.call("recall", { query: "missing" }, new AbortController().signal);

  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, { exposure: "sanitized", items: [], truncated: false });
  assert.doesNotMatch(JSON.stringify(result), /EISDIR/);
});

test("the disclosure line itself follows Rocky's voice rules", () => {
  assert.deepEqual(validateRockyPhrase(DISCLOSURE), []);
});
