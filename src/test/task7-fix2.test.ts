import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { annotateBatch } from "../agent/annotate.js";
import { appendEvent } from "../agent/spool.js";
import { parseAgentEvent, type AgentEvent } from "../agent/schema.js";
import { why } from "../commands/dictionary.js";
import { loadMemory, recordTriple } from "../core/memory.js";
import type { MemoryRecord, TripleFile, TripleRecord } from "../core/memory-read.js";
import { createMemoryQueries, searchKnowledge } from "../core/memory-query.js";
import { resolveRockyPaths, type RockyPaths } from "../core/state-paths.js";
import { disabledRecallWithAi } from "../ai/port.js";
import { createToolRegistry } from "../mcp/tools.js";
import { projectKnowledgeHits, projectTriple } from "../mcp/privacy.js";

function freshPaths(t: TestContext): RockyPaths {
  const home = mkdtempSync(join(tmpdir(), "rocky-task7-fix2-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return resolveRockyPaths({ ROCKY_HOME: home });
}

function file(path: string, index = 1): TripleFile {
  return { path, plusMinus: [index, index], props: [`prop-${index}`], provenance: "tool-observed" };
}

function triple(files: TripleFile[], extra: Record<string, unknown> = {}): TripleRecord {
  return {
    kind: "triple", id: `triple-${Math.random().toString(16).slice(2)}`, ts: 1, cwd: "/work", schemaV: 1,
    agent: "codex", origin: "agent-hook", intent: { text: "remember changed files" },
    mechanism: { files, truncatedFiles: 0, baseline: "captured", ...extra } as TripleRecord["mechanism"],
  };
}

function append(events: readonly AgentEvent[], paths: RockyPaths, key: string): void {
  for (const event of events) assert.equal(appendEvent(key, event, paths), true);
}

function gitCurrent(paths: readonly string[]): (args: string[], cwd: string) => string | undefined {
  return (args) => {
    if (args[0] === "rev-parse") return "new-head";
    if (args[0] === "diff" && args[1] === "--numstat" && args[2] === undefined) {
      return paths.map((path) => `1\t1\t${path}`).join("\n");
    }
    if (args[0] === "diff" && args[1] === "--cached") return "";
    if (args[0] === "ls-files") return "";
    return undefined;
  };
}

test("why discloses incomplete coverage when requested path was omitted", () => {
  const records: MemoryRecord[] = [triple(Array.from({ length: 10 }, (_, index) => file(`src/file-${index}.ts`)))];
  const said: string[] = [];
  const code = why(["src/file-9.ts"], { load: () => records, say: (line) => said.push(line), out: () => {} });
  assert.equal(code, 0);
  assert.ok(said.some((line) => /coverage|incomplete|unknown|possible/iu.test(line)), said.join("\n"));
  assert.equal(said.some((line) => /nobody touch/iu.test(line)), false, said.join("\n"));
});

test("MCP why_file returns coverage summary independently of response truncation", async () => {
  const records: MemoryRecord[] = [triple(Array.from({ length: 10 }, (_, index) => file(`src/file-${index}.ts`)))];
  const registry = createToolRegistry({
    exposure: "sanitized", memory: createMemoryQueries(() => records), recallWithAi: disabledRecallWithAi,
  });
  const empty = await registry.call("why_file", { path: "src/file-9.ts" }, new AbortController().signal);
  assert.equal(empty.structuredContent.truncated, false);
  assert.equal(typeof empty.structuredContent.coverage, "object");
  const coverage = empty.structuredContent.coverage as Record<string, unknown>;
  assert.equal(coverage.complete, false);
  assert.ok(coverage.status === "truncated" || coverage.status === "unknown");

  const hit = await registry.call("why_file", { path: "src/file-0.ts" }, new AbortController().signal);
  assert.equal(hit.structuredContent.truncated, false);
  assert.equal(typeof hit.structuredContent.coverage, "object");
  assert.equal((hit.structuredContent.coverage as Record<string, unknown>).complete, false);
});

test("searchKnowledge normalizes direct 20k-file records to bounded status", () => {
  const record = triple(Array.from({ length: 20_000 }, (_, index) => file(`src/${index}.ts`)));
  const hits = searchKnowledge([record], { query: "remember changed files", limit: 5 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.filesCovered?.length, 8);
  assert.equal(hits[0]?.truncatedFiles, 19_992);
  assert.equal(hits[0]?.coverageStatus, "unknown");
  assert.equal(hits[0]?.complete, false);
});

test("projectKnowledgeHits independently bounds forged file arrays and contradictions", () => {
  const hit = {
    id: "wide", ts: 1, kind: "triple" as const, snippet: "wide", score: 1,
    filesCovered: Array.from({ length: 20_000 }, (_, index) => `src/${index}.ts`),
    truncatedFiles: 0, coverageStatus: "complete" as const, complete: true,
  };
  const projected = projectKnowledgeHits([hit], "raw");
  assert.equal(projected.items.length, 1);
  const item = projected.items[0] as unknown as Record<string, unknown>;
  assert.equal((item.filesCovered as string[]).length, 8);
  assert.equal(item.truncatedFiles, 19_992);
  assert.equal(item.complete, false);
  assert.equal(item.coverageStatus, "truncated");
});

test("missing coveragePathsComplete is unproven even when Git recovers omitted paths", async (t) => {
  const paths = freshPaths(t);
  const candidates = Array.from({ length: 70 }, (_, index) => `missing-${index}.ts`);
  append([
    { v: 1, agent: "codex", kind: "intent", ts: 1, cwd: paths.home, text: "capture paths", baseline: { status: "captured", head: "old-head", files: [] } },
    {
      v: 1, agent: "codex", kind: "mechanism", ts: 2, tool: "MultiEdit", path: candidates[0] as string,
      provenance: "tool-observed", truncatedFiles: 6, coveragePaths: candidates,
    },
  ], paths, "metadata-missing");
  const result = await annotateBatch("metadata-missing", { paths, git: gitCurrent(candidates.slice(0, 67)), queueLabel: () => {} });
  assert.ok(result);
  assert.equal(result.mechanism.coverageStatus, "unknown");
  assert.equal(result.mechanism.truncatedFiles, 62);
});

test("explicit complete metadata with duplicate aliases or missing event path is unknown", async (t) => {
  const paths = freshPaths(t);
  const cases = [
    { key: "duplicate-metadata", path: "src/a.ts", coveragePaths: ["src/a.ts", "./src/a.ts"] },
    { key: "missing-event-path", path: "src/a.ts", coveragePaths: ["src/b.ts"] },
  ] as const;
  for (const item of cases) {
    append([
      { v: 1, agent: "codex", kind: "intent", ts: 1, cwd: paths.home, text: "capture paths", baseline: { status: "captured", head: "head", files: [] } },
      {
        v: 1, agent: "codex", kind: "mechanism", ts: 2, tool: "Edit", path: item.path,
        provenance: "tool-observed", truncatedFiles: 0, coveragePaths: [...item.coveragePaths], coveragePathsComplete: true,
      },
    ], paths, item.key);
    const result = await annotateBatch(item.key, { paths, git: gitCurrent([]), queueLabel: () => {} });
    assert.ok(result);
    assert.equal(result.mechanism.coverageStatus, "unknown", item.key);
  }
});

test("count-only overflow with partial Git recovery stays unknown", async (t) => {
  const paths = freshPaths(t);
  const all = Array.from({ length: 70 }, (_, index) => `count-${index}.ts`);
  const events: AgentEvent[] = [{
    v: 1, agent: "codex", kind: "intent", ts: 1, cwd: paths.home, text: "count only",
    baseline: { status: "captured", head: "old-head", files: [] },
  }];
  for (let index = 0; index < 64; index += 1) {
    events.push({ v: 1, agent: "codex", kind: "mechanism", ts: index + 2, tool: "Edit", path: all[index] as string,
      provenance: "tool-observed", ...(index === 0 ? { truncatedFiles: 6 } : {}) });
  }
  append(events, paths, "count-partial");
  const result = await annotateBatch("count-partial", { paths, git: gitCurrent(all.slice(0, 67)), queueLabel: () => {} });
  assert.ok(result);
  assert.equal(result.mechanism.coverageStatus, "unknown");
  assert.ok((result.mechanism.truncatedFiles ?? 0) >= 59);
});

test("coverage witnesses materialize first bounded paths when event append omitted them", async (t) => {
  const paths = freshPaths(t);
  const candidates = Array.from({ length: 10 }, (_, index) => `witness-${index}.ts`);
  append([
    { v: 1, agent: "codex", kind: "intent", ts: 1, cwd: paths.home, text: "materialize witnesses", baseline: { status: "captured", head: "head", files: [] } },
    { v: 1, agent: "codex", kind: "mechanism", ts: 2, tool: "Edit", path: candidates[0] as string, provenance: "tool-observed",
      coveragePaths: candidates, coveragePathsComplete: true },
  ], paths, "witnesses");
  const result = await annotateBatch("witnesses", { paths, git: gitCurrent([]), queueLabel: () => {} });
  assert.ok(result);
  assert.equal(result.mechanism.files.length, 8);
  assert.deepEqual(result.mechanism.files.map((item) => item.path), candidates.slice(0, 8));
  assert.equal(result.mechanism.files[1]?.provenance, "tool-observed");
  assert.deepEqual(result.mechanism.files[1]?.plusMinus, [0, 0]);
  assert.equal(result.mechanism.truncatedFiles, 2);
});

test("invalid persisted counts and stats cannot forge complete coverage", () => {
  for (const invalid of [Number.POSITIVE_INFINITY, -1, Number.MAX_SAFE_INTEGER + 1, 1.5]) {
    const record = triple([file("src/one.ts")], { truncatedFiles: invalid, coverageStatus: "complete" });
    assert.doesNotThrow(() => projectTriple(record, "raw"));
    const projected = projectTriple(record, "raw");
    assert.equal(projected.complete, false);
    assert.equal(projected.coverageStatus, "unknown");
  }
  const badStats = triple([{ ...file("src/one.ts"), plusMinus: [-1, Number.POSITIVE_INFINITY] }], {
    truncatedFiles: 0, coverageStatus: "complete",
  });
  assert.doesNotThrow(() => projectTriple(badStats, "raw"));
  const projected = projectTriple(badStats, "raw");
  assert.equal(projected.complete, false);
  assert.equal(projected.coverageStatus, "unknown");
});

test("canonical aliases do not inflate durable file cap", (t) => {
  const paths = freshPaths(t);
  const record = recordTriple({
    agent: "codex", cwd: paths.home, intent: { text: "canonical aliases" },
    mechanism: {
      files: [file("./src\\foo.ts", 1), file("src//foo.ts", 2), file(" SRC/foo.ts ", 3), file("src/bar.ts", 4)],
      truncatedFiles: 0, baseline: "captured", coverageStatus: "complete",
    },
  }, paths);
  assert.equal(record.mechanism.files.length, process.platform === "win32" ? 2 : 3);
  assert.equal(record.mechanism.files[0]?.plusMinus[0], process.platform === "win32" ? 3 : 2);
});

test("redacted display collisions retain distinct bounded identities after reload", async (t) => {
  const paths = freshPaths(t);
  append([
    { v: 1, agent: "codex", kind: "mechanism", ts: 1, tool: "Edit", path: "src/sk-ant-abcdefghijklmnopqrst123.ts", excerpt: "one" },
    { v: 1, agent: "codex", kind: "mechanism", ts: 2, tool: "Edit", path: "src/sk-ant-abcdefghijklmnopqrst456.ts", excerpt: "two" },
  ], paths, "redacted-collision");
  const result = await annotateBatch("redacted-collision", { paths, git: () => undefined, queueLabel: () => {} });
  assert.ok(result);
  assert.equal(result.mechanism.files.length, 2);
    const reloaded = loadMemory(paths.memory)
      .find((record): record is TripleRecord => record.kind === "triple");
    assert.ok(reloaded);
    assert.match(readFileSync(paths.memory, "utf8"), /identityHash/);
  assert.equal(reloaded.mechanism.files.length, 2);
  assert.equal(new Set(reloaded.mechanism.files.map((item) => item.identityHash)).size, 2);
  // Individual mechanism events without a turn sidecar/complete marker are
  // now deliberately conservative after round-6 recovery hardening.
  assert.equal(reloaded.mechanism.coverageStatus, "unknown");
});

test("parser bounds oversized coverage witness lists without claiming completeness", () => {
  const event = parseAgentEvent({
    v: 1, agent: "codex", kind: "mechanism", ts: 1, tool: "Edit", path: "src/0.ts",
    coveragePaths: Array.from({ length: 257 }, (_, index) => `src/${index}.ts`), coveragePathsComplete: true,
  });
  assert.ok(event?.kind === "mechanism");
  assert.equal(event.coveragePaths?.length, 256);
  assert.equal(event.coveragePathsComplete, false);
});
