import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { annotateBatch } from "../agent/annotate.js";
import { appendEvent, readBatch } from "../agent/spool.js";
import { batchKey, type AgentEvent } from "../agent/schema.js";
import { agentEvent } from "../commands/agent-hook.js";
import { recordTriple, loadMemory, parseMemoryRecord } from "../core/memory.js";
import type { MemoryRecord, TripleFile, TripleRecord } from "../core/memory-read.js";
import { fetchRecord, searchKnowledge, whyFile } from "../core/memory-query.js";
import { projectTriple } from "../mcp/privacy.js";
import { resolveRockyPaths, type RockyPaths } from "../core/state-paths.js";

function freshPaths(t: TestContext): RockyPaths {
  const home = mkdtempSync(join(tmpdir(), "rocky-task7-fix1-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return resolveRockyPaths({ ROCKY_HOME: home });
}

function file(path: string): TripleFile {
  return { path, plusMinus: [1, 1], props: ["value"], provenance: "tool-observed" };
}

function tripleInput(files: TripleFile[], truncatedFiles = 0): Omit<TripleRecord, "kind" | "id" | "ts" | "schemaV" | "origin"> {
  return {
    agent: "codex",
    cwd: "/work",
    intent: { text: "remember this" },
    mechanism: { files, truncatedFiles, baseline: "captured" },
  };
}

test("durable triple writer bounds hand-written 10, 100, and 20k-file records", (t) => {
  const paths = freshPaths(t);
  for (const count of [10, 100, 20_000]) {
    const record = recordTriple(tripleInput(
      Array.from({ length: count }, (_, index) => file(`src/${index}.ts`)),
    ), paths);
    assert.equal(record.mechanism.files.length, 8, `writer files for ${count}`);
    assert.equal(record.mechanism.truncatedFiles, count - 8, `writer truncation for ${count}`);
  }

  const persisted = loadMemory(paths.memory).filter((record): record is TripleRecord => record.kind === "triple");
  assert.equal(persisted.length, 3);
  assert.ok(persisted.every((record) => record.mechanism.files.length === 8));
  assert.deepEqual(persisted.map((record) => record.mechanism.truncatedFiles), [2, 92, 19_992]);
});

test("reader and every knowledge boundary keep forged oversized triples bounded", () => {
  const files = Array.from({ length: 10 }, (_, index) => file(`src/${index}.ts`));
  const raw = {
    kind: "triple",
    id: "forged-wide",
    ts: 1,
    cwd: "/work",
    schemaV: 1,
    agent: "codex",
    origin: "agent-hook",
    intent: { text: "remember this" },
    mechanism: { files, truncatedFiles: 0, baseline: "captured" },
  } as const;

  const parsed = parseMemoryRecord(raw);
  assert.ok(parsed?.kind === "triple");
  assert.equal(parsed.mechanism.files.length, 8);
  assert.equal(parsed.mechanism.truncatedFiles, 2);
  const forgedParsed = parseMemoryRecord({
    ...raw,
    mechanism: { ...raw.mechanism, coverageStatus: "complete" },
  });
  assert.equal(forgedParsed?.kind === "triple" ? forgedParsed.mechanism.coverageStatus : undefined, "unknown");

  // The projection/query APIs also receive hand-built records from callers in
  // tests and integrations, so they must enforce the same contract themselves.
  const forged = raw as unknown as TripleRecord;
  const projected = projectTriple(forged, "raw");
  assert.equal(projected.files.length, 8);
  assert.equal(projected.filesCovered.length, 8);
  assert.equal(projected.coverageStatus, "unknown");
  assert.equal(projected.complete, false);
  const hit = searchKnowledge([forged], { query: "remember this", now: 2 })[0];
  assert.equal(hit?.filesCovered?.length, 8);
  assert.equal(hit?.truncatedFiles, 2);
  assert.equal(hit?.complete, false);
  assert.equal((fetchRecord([forged], "forged-wide") as TripleRecord).mechanism.files.length, 8);
  assert.equal(whyFile([forged], "src/0.ts")[0]?.mechanism.files.length, 8);
});

function numstat(paths: readonly string[]): string {
  return paths.map((path) => `1\t1\t${path}`).join("\n");
}

function gitWithCurrentDiff(paths: readonly string[]): (args: string[], cwd: string) => string | undefined {
  return (args) => {
    if (args[0] === "rev-parse") return "new-head";
    if (args[0] === "diff" && args[1] === "--numstat" && args[2] === undefined) return numstat(paths);
    if (args[0] === "diff" && args[1] === "--cached") return "";
    if (args[0] === "ls-files") return "";
    return undefined;
  };
}

function append(events: readonly AgentEvent[], paths: RockyPaths, key: string): void {
  for (const event of events) assert.equal(appendEvent(key, event, paths), true);
}

function seedOverflowBatch(paths: RockyPaths, key: string, payloads: readonly (readonly string[])[]): string[] {
  const allPaths = [...new Set(payloads.flat())];
  append([{
    v: 1, agent: "codex", kind: "intent", ts: 1, cwd: paths.home, text: "capture agent paths",
    baseline: { status: "captured", head: "old-head", files: [] },
  }], paths, key);
  for (const payload of payloads) {
    const events = payload.slice(0, 64).map((path, index) => ({
      v: 1 as const,
      agent: "codex" as const,
      kind: "mechanism" as const,
      ts: 2 + index,
      tool: "MultiEdit",
      path,
      provenance: "tool-observed" as const,
      ...(payload.length > 64 && index === 0 ? {
        truncatedFiles: payload.length - 64,
        coveragePaths: payload.slice(0, 256),
        coveragePathsComplete: payload.length <= 256,
      } : {}),
    }));
    append(events, paths, key);
  }
  return allPaths;
}

test("Git recovery does not double-count one adapter overflow", async (t) => {
  const paths = freshPaths(t);
  const payload = Array.from({ length: 70 }, (_, index) => `one-${index}.ts`);
  const allPaths = seedOverflowBatch(paths, "recover-one", [payload]);
  const triple = await annotateBatch("recover-one", {
    paths,
    git: gitWithCurrentDiff(allPaths),
    queueLabel: () => {},
  });
  assert.ok(triple);
  assert.equal(triple.mechanism.files.length, 8);
  assert.equal(triple.mechanism.truncatedFiles, 62);
});

test("partial Git recovery keeps adapter candidates exact instead of undercounting", async (t) => {
  const paths = freshPaths(t);
  const payload = Array.from({ length: 70 }, (_, index) => `partial-${index}.ts`);
  const allPaths = seedOverflowBatch(paths, "recover-partial", [payload]);
  const triple = await annotateBatch("recover-partial", {
    paths,
    git: gitWithCurrentDiff(allPaths.slice(0, 67)),
    queueLabel: () => {},
  });
  assert.ok(triple);
  assert.equal(triple.mechanism.files.length, 8);
  assert.equal(triple.mechanism.truncatedFiles, 62);
  assert.equal(triple.mechanism.coverageStatus, "truncated");
});

test("multiple distinct overflow payloads preserve exact unique truncation", async (t) => {
  const paths = freshPaths(t);
  const first = Array.from({ length: 70 }, (_, index) => `first-${index}.ts`);
  const second = Array.from({ length: 70 }, (_, index) => `second-${index}.ts`);
  const allPaths = seedOverflowBatch(paths, "recover-two", [first, second]);
  const triple = await annotateBatch("recover-two", {
    paths,
    git: gitWithCurrentDiff(allPaths),
    queueLabel: () => {},
  });
  assert.ok(triple);
  assert.equal(triple.mechanism.files.length, 8);
  assert.equal(triple.mechanism.truncatedFiles, 132);
});

test("duplicate paths across overflow payloads count once", async (t) => {
  const paths = freshPaths(t);
  const first = Array.from({ length: 70 }, (_, index) => `shared-${index}.ts`);
  const second = Array.from({ length: 70 }, (_, index) => `shared-${index + 62}.ts`);
  const allPaths = seedOverflowBatch(paths, "recover-duplicates", [first, second]);
  const triple = await annotateBatch("recover-duplicates", {
    paths,
    git: gitWithCurrentDiff(allPaths),
    queueLabel: () => {},
  });
  assert.ok(triple);
  assert.equal(triple.mechanism.files.length, 8);
  assert.equal(triple.mechanism.truncatedFiles, allPaths.length - 8);
});

async function captureStdout(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  let out = "";
  const original = process.stdout.write;
  (process.stdout as unknown as { write: (chunk: string, callback?: (error?: Error) => void) => boolean }).write = (chunk, callback) => {
    out += chunk;
    callback?.();
    return true;
  };
  try {
    return { code: await fn(), out };
  } finally {
    process.stdout.write = original;
  }
}

test("turn baseline merges staged and unstaged counts for one path", async (t) => {
  const paths = freshPaths(t);
  const result = await captureStdout(() => agentEvent("claude-code", {
    paths,
    stdin: async () => JSON.stringify({
      session_id: "session", prompt_id: "baseline", hook_event_name: "UserPromptSubmit",
      cwd: paths.home, prompt: "remember baseline",
    }),
    git: (args) => {
      if (args[0] === "rev-parse") return "head";
      if (args[0] === "diff" && args[1] === "--numstat") return "2\t1\tshared.ts";
      if (args[0] === "diff" && args[1] === "--cached") return "3\t4\tshared.ts";
      if (args[0] === "ls-files") return "";
      return undefined;
    },
  }));
  assert.equal(result.code, 0);
  assert.equal(result.out, "{}");
  const events = readBatch(batchKey("claude-code", "session", "baseline"), paths);
  const intent = events.find((event) => event.kind === "intent");
  assert.equal(intent?.kind, "intent");
  assert.deepEqual(intent?.kind === "intent" ? intent.baseline?.files : undefined, [{ path: "shared.ts", plusMinus: [5, 5] }]);
});

async function annotateAmbiguous(
  paths: RockyPaths,
  key: string,
  baseline: [number, number],
  current: [number, number],
): Promise<TripleRecord | undefined> {
  append([
    {
      v: 1, agent: "codex", kind: "intent", ts: 1, cwd: paths.home, text: "edit shared",
      baseline: { status: "captured", head: "head", files: [{ path: "shared.ts", plusMinus: baseline }] },
    },
    { v: 1, agent: "codex", kind: "mechanism", ts: 2, tool: "Edit", path: "shared.ts", provenance: "tool-observed" },
  ], paths, key);
  return annotateBatch(key, {
    paths,
    git: (args) => {
      if (args[0] === "rev-parse") return "head";
      if (args[0] === "diff" && args[1] === "--numstat") return `${current[0]}\t${current[1]}\tshared.ts`;
      if (args[0] === "diff" && args[1] === "--cached") return "";
      if (args[0] === "ls-files") return "";
      return undefined;
    },
    queueLabel: () => {},
  });
}

test("same-count pre-existing edit makes baseline provenance unknown", async (t) => {
  const paths = freshPaths(t);
  const triple = await annotateAmbiguous(paths, "same-count", [1, 1], [1, 1]);
  assert.ok(triple);
  assert.equal(triple.mechanism.baseline, "unknown");
});

test("decreasing aggregate numstat makes baseline provenance unknown", async (t) => {
  const paths = freshPaths(t);
  const triple = await annotateAmbiguous(paths, "decreasing", [3, 2], [1, 1]);
  assert.ok(triple);
  assert.equal(triple.mechanism.baseline, "unknown");
});

test("growing pre-existing shell overlap stays baseline-unknown", async (t) => {
  const paths = freshPaths(t);
  append([{
    v: 1, agent: "codex", kind: "intent", ts: 1, cwd: paths.home, text: "shell overlap",
    baseline: { status: "captured", head: "head", files: [{ path: "shared.ts", plusMinus: [1, 1] }] },
  }], paths, "growing-shell");
  const triple = await annotateBatch("growing-shell", {
    paths,
    git: (args) => {
      if (args[0] === "rev-parse") return "head";
      if (args[0] === "diff" && args[1] === "--numstat") return "3\t3\tshared.ts";
      if (args[0] === "diff" && args[1] === "--cached") return "";
      if (args[0] === "ls-files") return "";
      return undefined;
    },
    queueLabel: () => {},
  });
  assert.ok(triple);
  assert.equal(triple.mechanism.files[0]?.provenance, "git-diff-inferred");
  assert.equal(triple.mechanism.baseline, "unknown");
});

test("completed intent and rationale persist zero-file unknown coverage", async (t) => {
  const paths = freshPaths(t);
  append([
    { v: 1, agent: "codex", kind: "intent", ts: 1, cwd: paths.home, text: "run shell edit", baseline: { status: "unknown" } },
    { v: 1, agent: "codex", kind: "rationale", ts: 2, source: "notify", text: "shell edit completed" },
  ], paths, "zero-file");
  const triple = await annotateBatch("zero-file", { paths, git: () => undefined, queueLabel: () => {} });
  assert.ok(triple);
  assert.deepEqual(triple.mechanism.files, []);
  assert.equal(triple.mechanism.truncatedFiles, 0);
  assert.equal(triple.mechanism.baseline, "unknown");
  assert.equal(loadMemory(paths.memory).filter((record) => record.kind === "triple").length, 1);
});

test("append failure remains fail-open with exactly one empty JSON response", async (t) => {
  const paths = freshPaths(t);
  writeFileSync(paths.spoolDir, "blocked", "utf8");
  const result = await captureStdout(() => agentEvent("claude-code", {
    paths,
    stdin: async () => JSON.stringify({
      session_id: "session", prompt_id: "append-failure", hook_event_name: "UserPromptSubmit",
      cwd: paths.home, prompt: "cannot spool",
    }),
  }));
  assert.equal(result.code, 0);
  assert.equal(result.out, "{}");
});

test("intent-only garbage remains fail-open without a zero-file triple", async (t) => {
  const paths = freshPaths(t);
  append([
    { v: 1, agent: "codex", kind: "intent", ts: 1, cwd: paths.home, text: "unfinished", baseline: { status: "unknown" } },
  ], paths, "unfinished");
  assert.equal(await annotateBatch("unfinished", { paths, git: () => undefined, queueLabel: () => {} }), undefined);
  assert.equal(loadMemory(paths.memory).length, 0);
});

test("near-cap spool loss is retained as explicit unknown coverage", async (t) => {
  const paths = freshPaths(t);
  const key = "near-cap";
  append([{
    v: 1, agent: "codex", kind: "intent", ts: 1, cwd: paths.home, text: "large shell turn",
    baseline: { status: "unknown" },
  }], paths, key);
  let appended = 0;
  for (let index = 0; index < 503; index += 1) {
    const event = {
      v: 1 as const,
      agent: "codex" as const,
      kind: "mechanism" as const,
      ts: index + 2,
      tool: "Edit",
      path: `near-${index}.ts`,
      excerpt: "x".repeat(400),
      provenance: "tool-observed" as const,
      ...(index === 0 ? { truncatedFiles: 6 } : {}),
    };
    if (!appendEvent(key, event, paths)) break;
    appended += 1;
  }
  assert.ok(appended < 503);
  const triple = await annotateBatch(key, { paths, git: () => undefined, queueLabel: () => {} });
  assert.ok(triple);
  assert.equal(triple.mechanism.files.length, 8);
  assert.equal(triple.mechanism.coverageStatus, "unknown");
  assert.ok(triple.mechanism.truncatedFiles >= 6);
});
