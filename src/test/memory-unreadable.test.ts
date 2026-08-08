import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
  // A directory where the memory file belongs makes readFileSync throw EISDIR —
  // portable, unlike chmod 000 which root ignores.
  mkdirSync(join(home, "memory.jsonl"), { recursive: true });
  return home;
}

test("recall() returns 1 and speaks the disclosure, never raw Node error text", async () => {
  // recall()'s default dependencies (and the disclosure it prints on a read
  // failure) resolve the memory path from ROCKY_HOME, so the sandbox is wired
  // through the environment rather than through RecallDependencies here —
  // that's what makes the printed path provably the one that failed to open.
  const home = unreadableHome("recall-unreadable");
  process.env.ROCKY_HOME = home;

  const { result, stderr } = await captureStderr(() => recall(["anything"]));

  assert.equal(result, 1);
  assert.match(stderr, /memory file does not open for me\. I answer from nothing\./);
  assert.match(stderr, new RegExp(join(home, "memory.jsonl").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(stderr, /EISDIR/);
  assert.doesNotMatch(stderr, /Error:/);
});

test("stats() returns 1 and speaks the same disclosure", async () => {
  const home = unreadableHome("stats-unreadable");
  process.env.ROCKY_HOME = home;

  const { result, stderr } = await captureStderr(() => stats());

  assert.equal(result, 1);
  assert.match(stderr, /memory file does not open for me\. I answer from nothing\./);
  assert.match(stderr, new RegExp(join(home, "memory.jsonl").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
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

test("run() of a succeeding command keeps the wrapped exit code and speaks the read disclosure, not the write message", async () => {
  const home = unreadableHome("run-unreadable");
  process.env.ROCKY_HOME = home;

  const { result, stderr } = await captureStderr(() => run("exit 0"));

  assert.equal(result, 0);
  assert.match(stderr, /memory file does not open for me\. I answer from nothing\./);
  assert.doesNotMatch(stderr, /I cannot write memory/);
  assert.doesNotMatch(stderr, /EISDIR/);
  assert.doesNotMatch(stderr, /Error:/);
});

test("MCP tool path surfaces memory_unavailable for the same unreadable memory", async () => {
  const home = unreadableHome("mcp-unreadable");
  const memoryPath = join(home, "memory.jsonl");
  const registry = createToolRegistry({
    exposure: "sanitized",
    memory: createMemoryQueries(() => loadMemory(memoryPath)),
    recallWithAi: disabledRecallWithAi,
  });

  const result = await registry.call("recall", { query: "missing" }, new AbortController().signal);

  assert.equal(result.isError, true);
  assert.equal((result.structuredContent.error as { code: string }).code, "memory_unavailable");
  assert.doesNotMatch(JSON.stringify(result), /EISDIR/);
});

test("the disclosure line itself follows Rocky's voice rules", () => {
  assert.deepEqual(validateRockyPhrase(DISCLOSURE), []);
});
