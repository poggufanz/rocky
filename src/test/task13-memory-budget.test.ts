import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadMemoryChecked,
  memoryReadMetrics,
  MAX_MEMORY_FILE_BYTES,
  MAX_MEMORY_RECORDS,
  type MemoryCoverage,
} from "../core/memory-read.js";
import { createMemoryQueries } from "../core/memory-query.js";
import { disabledRecallWithAi } from "../ai/port.js";
import { createToolRegistry } from "../mcp/tools.js";

function failure(id: string): string {
  return JSON.stringify({
    kind: "failure", id, ts: 1, cwd: "/budget", cmd: "false", exitCode: 1,
    fingerprint: id.padStart(16, "0"), signature: ["false"], excerpt: "false",
  });
}

function coverage(result: ReturnType<typeof loadMemoryChecked>): MemoryCoverage {
  assert.ok(result.coverage);
  return result.coverage;
}

test("memory reader reports corrupt and oversized lines instead of hiding them", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rocky-task13-lines-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "memory.jsonl");
  writeFileSync(path, [failure("valid"), "{not-json}", `${failure("oversize")}${"x".repeat(1_048_576)}`].join("\n") + "\n");

  const result = loadMemoryChecked(path);
  const measured = coverage(result);
  assert.equal(result.records.length, 1);
  assert.ok(measured.scanned >= 3);
  assert.ok(measured.skipped >= 2);
  assert.equal(measured.truncated, 0);
  assert.equal(measured.complete, true);
});

test("cache invalidates after append, replace, and truncate", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rocky-task13-cache-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "memory.jsonl");
  writeFileSync(path, `${failure("one")}\n`);
  assert.equal(loadMemoryChecked(path).records.length, 1);

  appendFileSync(path, `${failure("two")}\n`);
  assert.equal(loadMemoryChecked(path).records.length, 2);

  writeFileSync(path, `${failure("three")}\n`);
  assert.deepEqual(loadMemoryChecked(path).records.map((record) => record.id), ["three"]);

  // Same-size replacement still changes inode timestamps and must not reuse
  // an immutable snapshot from the previous file contents.
  writeFileSync(path, `${failure("aaaa")}\n`);
  assert.deepEqual(loadMemoryChecked(path).records.map((record) => record.id), ["aaaa"]);
  writeFileSync(path, `${failure("bbbb")}\n`);
  assert.deepEqual(loadMemoryChecked(path).records.map((record) => record.id), ["bbbb"]);

  const replacement = join(root, "replacement.jsonl");
  writeFileSync(replacement, `${failure("new-identity")}\n`);
  rmSync(path);
  renameSync(replacement, path);
  assert.deepEqual(loadMemoryChecked(path).records.map((record) => record.id), ["new-identity"]);

  writeFileSync(path, "");
  assert.deepEqual(loadMemoryChecked(path).records, []);
});

test("over-cap memory returns a bounded incomplete snapshot", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rocky-task13-cap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "memory.jsonl");
  const line = `${failure("cap")}\n`;
  writeFileSync(path, line.repeat(Math.ceil(MAX_MEMORY_FILE_BYTES / Buffer.byteLength(line, "utf8")) + 1));

  const result = loadMemoryChecked(path);
  const measured = coverage(result);
  assert.equal(result.complete, false);
  assert.equal(measured.complete, false);
  assert.ok(measured.truncated > 0);
  assert.ok(measured.bytesScanned <= MAX_MEMORY_FILE_BYTES);
});

test("record-cap diagnostics are explicit", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rocky-task13-record-cap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "memory.jsonl");
  const records = Array.from({ length: MAX_MEMORY_RECORDS + 1 }, (_, index) => failure(`r${index}`));
  writeFileSync(path, records.join("\n") + "\n");

  const result = loadMemoryChecked(path);
  const measured = coverage(result);
  assert.equal(result.complete, false);
  assert.ok(measured.truncated > 0);
  assert.equal(result.records.length, MAX_MEMORY_RECORDS);
});

test("cached triple witnesses retain identity and deep immutability", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rocky-task13-freeze-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "memory.jsonl");
  writeFileSync(path, `${JSON.stringify({
    kind: "triple",
    id: "triple-freeze",
    ts: 1,
    cwd: "/budget",
    schemaV: 1,
    agent: "codex",
    origin: "agent-hook",
    platform: "linux",
    intent: { text: "keep intent" },
    rationale: { text: "keep rationale", tags: ["why"], source: "notify" },
    mechanism: {
      files: [{
        path: "src/app.ts",
        plusMinus: [1, 2],
        props: ["changed"],
        identityHash: "0123456789abcdef0123456789abcdef",
        provenance: "tool-observed",
      }],
      truncatedFiles: 0,
      baseline: "captured",
      coverageStatus: "complete",
    },
  })}\n`);

  const record = loadMemoryChecked(path).records[0];
  assert.equal(record?.kind, "triple");
  if (record?.kind !== "triple") return;
  const file = record.mechanism.files[0];
  assert.equal(file.identityHash, "0123456789abcdef0123456789abcdef");
  assert.equal(Object.getOwnPropertyDescriptor(file, "identityHash")?.enumerable, false);
  assert.equal(Object.isFrozen(record), true);
  assert.equal(Object.isFrozen(record.mechanism), true);
  assert.equal(Object.isFrozen(record.mechanism.files), true);
  assert.equal(Object.isFrozen(file), true);
  assert.equal(Object.isFrozen(record.intent), true);
  assert.equal(Object.isFrozen(record.rationale), true);
  assert.equal(Object.isFrozen(record.rationale?.tags), true);
  assert.throws(() => { file.props.push("poison"); }, TypeError);
  assert.throws(() => { record.intent!.text = "poison"; }, TypeError);
  assert.throws(() => { record.rationale!.tags.push("poison"); }, TypeError);
});

test("memory scorecard exercises 10k, 50k, 250k, and over-cap workers", () => {
  const script = join(process.cwd(), "scripts", "benchmark-memory-budget.mjs");
  const result = spawnSync(process.execPath, [script, "--assert"], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 8 * 60 * 1000,
    windowsHide: true,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.limits.maxRecords, MAX_MEMORY_RECORDS);
  assert.equal(report.scorecard.length, 4);
  const scorecard = new Map<string, { coverage: { complete: boolean; truncated: number } }>(
    report.scorecard.map((entry: { envelope: string | number; coverage: { complete: boolean; truncated: number } }) =>
      [String(entry.envelope), entry] as [string, { coverage: { complete: boolean; truncated: number } }]),
  );
  const twoFiftyK = scorecard.get("250000");
  const overCap = scorecard.get("over-cap");
  assert.ok(twoFiftyK);
  assert.ok(overCap);
  assert.equal(twoFiftyK.coverage.complete, false);
  assert.equal(twoFiftyK.coverage.truncated > 0, true);
  assert.equal(overCap.coverage.complete, false);
  assert.equal(overCap.coverage.truncated > 0, true);
});

test("canonical fetch not-found carries skipped-line coverage", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rocky-task13-fetch-coverage-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "memory.jsonl"), `${failure("known")}\n{not-json}\n`);
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = root;
  t.after(() => {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
  });
  const tools = createToolRegistry({ exposure: "sanitized", memory: createMemoryQueries(), recallWithAi: disabledRecallWithAi });
  const result = await tools.call("fetch_record", { id: "missing" }, new AbortController().signal);
  assert.equal(result.isError, true);
  const structured = result.structuredContent as {
    error: { code: string };
    memoryCoverageIncomplete: boolean;
    memoryCoverage: { skipped: number; complete: boolean };
  };
  assert.equal(structured.error.code, "not_found");
  assert.equal(structured.memoryCoverageIncomplete, true);
  assert.equal(structured.memoryCoverage.skipped, 1);
  assert.equal(structured.memoryCoverage.complete, true);
});

test("durable query cache re-resolves fixes across time travel", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rocky-task13-time-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "memory.jsonl"), [
    failure("time-failure"),
    JSON.stringify({ kind: "fix", id: "time-fix", ts: 200, cwd: "/budget", cmd: "false", failureIds: ["time-failure"] }),
  ].join("\n") + "\n");
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = root;
  t.after(() => {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
  });
  const queries = createMemoryQueries();
  assert.equal(queries.stats({ now: 100 }).resolved, 0);
  assert.equal(queries.stats({ now: 300 }).resolved, 1);
  assert.equal(queries.stats({ now: 100 }).resolved, 0);
  assert.equal(queries.stats({ now: 400 }).resolved, 1);
});

test("production query cache reuses one parsed snapshot for 200 concurrent MCP stats calls", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rocky-task13-concurrent-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "memory.jsonl"), `${failure("concurrent")}\n`);
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = root;
  t.after(() => {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
  });
  const before = memoryReadMetrics();
  const queries = createMemoryQueries();
  const tools = createToolRegistry({ exposure: "sanitized", memory: queries, recallWithAi: disabledRecallWithAi });
  const signal = new AbortController().signal;
  const first = await tools.call("stats", {}, signal);
  const values = await Promise.all(Array.from({ length: 200 }, () => tools.call("stats", {}, signal)));
  const after = memoryReadMetrics();
  assert.deepEqual(values.map((value) => value.structuredContent.total), values.map(() => first.structuredContent.total));
  assert.equal(after.parses - before.parses, 1);
  assert.equal(after.cacheHits - before.cacheHits, 0);
});
