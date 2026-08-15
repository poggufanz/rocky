import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import {
  loadMemoryChecked,
  memoryReadMetrics,
  MAX_MEMORY_FILE_BYTES,
  MAX_MEMORY_RECORDS,
  MAX_SUPPORTED_MEMORY_RECORDS,
  type MemoryCoverage,
} from "../core/memory-read.js";
import { createMemoryQueries } from "../core/memory-query.js";
import { clearPendingIfResolved, recordFix, recordNote, recordTripleOnce, resolveFixOnSuccess } from "../core/memory.js";
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
  assert.equal(measured.complete, false);
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

  const before = memoryReadMetrics();
  const result = loadMemoryChecked(path);
  const repeat = loadMemoryChecked(path);
  const measured = coverage(result);
  assert.equal(result.complete, false);
  assert.equal(measured.complete, false);
  assert.ok(measured.truncated > 0);
  assert.ok(measured.bytesScanned <= MAX_MEMORY_FILE_BYTES);
  assert.equal(repeat.coverage.complete, false);
  assert.equal(memoryReadMetrics().parses - before.parses, 1);
});

test("record-cap diagnostics are explicit", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rocky-task13-record-cap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "memory.jsonl");
  const records = Array.from({ length: MAX_SUPPORTED_MEMORY_RECORDS + 1 }, (_, index) => failure(`r${index}`));
  writeFileSync(path, records.join("\n") + "\n");

  const result = loadMemoryChecked(path);
  const measured = coverage(result);
  assert.equal(result.complete, false);
  assert.ok(measured.truncated > 0);
  assert.equal(result.records.length, MAX_SUPPORTED_MEMORY_RECORDS);
});

test("incomplete snapshots fail closed for fix, reconciliation, and once-only claims", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rocky-task13-transaction-cap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = root;
  t.after(() => {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
  });
  const records = Array.from({ length: MAX_MEMORY_RECORDS + 1 }, (_, index) => failure(`tail-${index}`));
  writeFileSync(join(root, "memory.jsonl"), records.map((value) => `${value}\n`).join(""));
  writeFileSync(join(root, "pending"), "", "utf8");
  const loaded = loadMemoryChecked(join(root, "memory.jsonl"));
  assert.equal(loaded.complete, false);
  assert.equal(loaded.coverage.complete, false);
  assert.ok(loaded.coverage.truncated > 0);
  const first = loaded.records.find((record) => record.kind === "failure");
  assert.ok(first);
  assert.throws(() => recordFix("false", [{ failure: first, basis: "identity", confidence: "confirmed" }]));
  assert.equal(readFileSync(join(root, "memory.jsonl"), "utf8").includes('"kind":"fix"'), false);
  assert.deepEqual(resolveFixOnSuccess("false", "/budget"), { confirmedResolved: 0, possibleAssociated: 0 });
  clearPendingIfResolved([], undefined, Date.now());
  assert.equal(existsSync(join(root, "pending")), true);
  assert.throws(() => recordTripleOnce({ agent: "codex", cwd: root, mechanism: { files: [{ path: "src/x.ts", plusMinus: [1, 1], props: [] }], truncatedFiles: 0 } }, "cap-claim"));
  // Append-only new evidence remains available even though absence claims do
  // not: this note must survive the same incomplete snapshot.
  recordNote({ cwd: root, cmd: "note", file: "src/x.ts", line: 1, subject: "subject", answer: "answer" });
  assert.equal(readFileSync(join(root, "memory.jsonl"), "utf8").includes('"kind":"note"'), true);
});

test("skipped corrupt evidence is incomplete for transactions and keeps pending", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rocky-task13-transaction-corrupt-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = root;
  t.after(() => {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
  });
  const known = failure("known-corrupt");
  writeFileSync(join(root, "memory.jsonl"), `${known}\n{not-json}\n`, "utf8");
  writeFileSync(join(root, "pending"), "", "utf8");
  const loaded = loadMemoryChecked(join(root, "memory.jsonl"));
  assert.equal(loaded.coverage.skipped, 1);
  assert.equal(loaded.complete, false);
  const knownRecord = loaded.records.find((record) => record.kind === "failure");
  assert.ok(knownRecord);
  assert.throws(() => recordFix("false", [{ failure: knownRecord, basis: "identity", confidence: "confirmed" }]));
  assert.equal(readFileSync(join(root, "memory.jsonl"), "utf8").includes('"kind":"fix"'), false);
  resolveFixOnSuccess("false", "/budget");
  clearPendingIfResolved([], undefined, Date.now());
  assert.equal(existsSync(join(root, "pending")), true);
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

test("memory scorecard keeps heavy workers explicit and reports bounded RSS", () => {
  const script = join(process.cwd(), "scripts", "benchmark-memory-budget.mjs");
  const source = readFileSync(script, "utf8");
  assert.match(source, /\["--expose-gc"/u);
  assert.match(source, /rssAfterGcBytes/u);
  assert.match(source, /resourceMaxRssBytes/u);
  assert.match(source, /recallMs >= 2_000/u);
  assert.equal(MAX_MEMORY_RECORDS, 50_000);
  const referenceRuntime = process.platform === "linux" && process.versions.node.startsWith("22.");
  assert.equal(MAX_SUPPORTED_MEMORY_RECORDS, referenceRuntime ? MAX_MEMORY_RECORDS : 10_000);
});

test("run, hook, and watch incomplete diagnostics disclose memory version", () => {
  for (const command of ["run", "hook", "watch"]) {
    const source = readFileSync(join(process.cwd(), "src", "commands", `${command}.ts`), "utf8");
    assert.match(source, /memory coverage[^`\n]*version \$\{loaded\.coverage\.version\}/u, `${command} coverage version`);
  }
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
  assert.equal(structured.memoryCoverage.complete, false);
});

test("hostile coverage stays explicit on bounded and AI-error MCP paths", async () => {
  const malformed = {
    version: 1 as const,
    scanned: 0,
    skipped: 1,
    truncated: 0,
    bytesScanned: 9,
    bytesTotal: 1,
    complete: true,
  };
  const memory = {
    recall: () => [],
    recentFailures: () => [],
    stats: () => ({ failures: 0, fixEvents: 0, resolved: 0, unresolved: 0 }),
    searchKnowledge: () => [],
    fetchRecord: () => undefined,
    whyFile: () => [],
    coverage: () => malformed,
  };
  const tools = createToolRegistry({
    exposure: "sanitized",
    memory,
    recallWithAi: { run: async () => { const error = new Error("storage"); (error as Error & { code?: string }).code = "EIO"; throw error; } },
  });
  const stats = await tools.call("stats", {}, new AbortController().signal);
  const statsContent = stats.structuredContent as { memoryCoverageIncomplete?: boolean; memoryCoverage?: { complete?: boolean; truncated?: number; reason?: string } };
  assert.equal(statsContent.memoryCoverageIncomplete, true);
  assert.equal(statsContent.memoryCoverage?.complete, false);
  assert.ok((statsContent.memoryCoverage?.truncated ?? 0) > 0);
  const ai = await tools.call("recall_with_ai", { query: "needle" }, new AbortController().signal);
  assert.equal(ai.isError, true);
  const aiContent = ai.structuredContent as { memoryCoverageIncomplete?: boolean; memoryCoverage?: { complete?: boolean; truncated?: number } };
  assert.equal(aiContent.memoryCoverageIncomplete, true);
  assert.equal(aiContent.memoryCoverage?.complete, false);
  assert.ok((aiContent.memoryCoverage?.truncated ?? 0) > 0);
});

test("MCP rejects clean coverage with impossible byte equality", async () => {
  const impossible = {
    version: 1 as const,
    scanned: 0,
    skipped: 0,
    truncated: 0,
    bytesScanned: 0,
    bytesTotal: 10,
    complete: true,
  };
  const memory = {
    recall: () => [],
    recentFailures: () => [],
    stats: () => ({ failures: 0, fixEvents: 0, resolved: 0, unresolved: 0 }),
    searchKnowledge: () => [],
    fetchRecord: () => undefined,
    whyFile: () => [],
    coverage: () => impossible,
  };
  const result = await createToolRegistry({ exposure: "sanitized", memory, recallWithAi: disabledRecallWithAi })
    .call("stats", {}, new AbortController().signal);
  const structured = result.structuredContent as { memoryCoverageIncomplete?: boolean; memoryCoverage?: { complete?: boolean; truncated?: number } };
  assert.equal(structured.memoryCoverageIncomplete, true);
  assert.equal(structured.memoryCoverage?.complete, false);
  assert.ok((structured.memoryCoverage?.truncated ?? 0) > 0);

  const atBoundary = {
    ...impossible,
    bytesScanned: MAX_MEMORY_FILE_BYTES,
    bytesTotal: MAX_MEMORY_FILE_BYTES,
    complete: false,
    truncated: 1,
    reason: "file-size-cap" as const,
  };
  const boundaryResult = await createToolRegistry({
    exposure: "sanitized",
    memory: { ...memory, coverage: () => atBoundary },
    recallWithAi: disabledRecallWithAi,
  }).call("stats", {}, new AbortController().signal);
  const boundaryContent = boundaryResult.structuredContent as { memoryCoverage?: { reason?: string; complete?: boolean } };
  assert.equal(boundaryContent.memoryCoverage?.complete, false);
  assert.equal(boundaryContent.memoryCoverage?.reason, "read-race");
});

test("MCP provider read errors cannot become clean fallback answers", async () => {
  const clean = {
    version: 1 as const,
    scanned: 0,
    skipped: 0,
    truncated: 0,
    bytesScanned: 0,
    bytesTotal: 0,
    complete: true,
  };
  const memory = {
    recall: () => { throw new Error("provider read"); },
    recentFailures: () => [],
    stats: () => { throw new Error("provider read"); },
    searchKnowledge: () => [],
    fetchRecord: () => undefined,
    whyFile: () => [],
    coverage: () => clean,
  };
  const registry = createToolRegistry({
    exposure: "sanitized",
    memory,
    recallWithAi: { run: async () => { const error = new Error("AI down"); (error as Error & { code?: string }).code = "EIO"; throw error; } },
  });
  const stats = await registry.call("stats", {}, new AbortController().signal);
  const statsContent = stats.structuredContent as { memoryCoverageIncomplete?: boolean; memoryCoverage?: { complete?: boolean; reason?: string } };
  assert.equal(statsContent.memoryCoverageIncomplete, true);
  assert.equal(statsContent.memoryCoverage?.complete, false);
  assert.equal(statsContent.memoryCoverage?.reason, "read-race");
  const ai = await registry.call("recall_with_ai", { query: "needle" }, new AbortController().signal);
  const aiContent = ai.structuredContent as { memoryCoverageIncomplete?: boolean; memoryCoverage?: { complete?: boolean; reason?: string } };
  assert.equal(ai.isError, true);
  assert.equal(aiContent.memoryCoverageIncomplete, true);
  assert.equal(aiContent.memoryCoverage?.complete, false);
  assert.equal(aiContent.memoryCoverage?.reason, "read-race");
});

test("legitimate skipped-only coverage is preserved", async () => {
  const memory = {
    recall: () => [],
    recentFailures: () => [],
    stats: () => ({ failures: 0, fixEvents: 0, resolved: 0, unresolved: 0 }),
    searchKnowledge: () => [],
    fetchRecord: () => undefined,
    whyFile: () => [],
    coverage: () => ({
      version: 1 as const,
      // Providers may count only valid records as scanned and report
      // malformed lines separately; this is valid incomplete coverage.
      scanned: 0,
      skipped: 10,
      truncated: 0,
      bytesScanned: 10,
      bytesTotal: 10,
      complete: false,
    }),
  };
  const tools = createToolRegistry({ exposure: "sanitized", memory, recallWithAi: disabledRecallWithAi });
  const result = await tools.call("stats", {}, new AbortController().signal);
  const structured = result.structuredContent as {
    memoryCoverageIncomplete?: boolean;
    memoryCoverage?: { scanned: number; skipped: number; complete: boolean; reason?: string };
  };
  assert.equal(structured.memoryCoverageIncomplete, true);
  assert.deepEqual(structured.memoryCoverage, {
    version: 1,
    scanned: 0,
    skipped: 10,
    truncated: 0,
    bytesScanned: 10,
    bytesTotal: 10,
    complete: false,
  });
});

test("unexpected short read is incomplete once and is not cached", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rocky-task13-short-read-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "memory.jsonl");
  const marker = join(root, "short-read-fired");
  writeFileSync(path, `${failure("short-read")}\n`, "utf8");
  const preload = join(root, "short-read.cjs");
  writeFileSync(preload, [
    "const fs = require('node:fs');",
    "const { syncBuiltinESMExports } = require('node:module');",
    "const originalOpen = fs.openSync.bind(fs);",
    "const originalRead = fs.readSync.bind(fs);",
    "const fds = new Set();",
    "let fired = false;",
    "fs.openSync = (value, ...args) => { const fd = originalOpen(value, ...args); if (String(value) === process.env.ROCKY_TEST_MEMORY) fds.add(fd); return fd; };",
    "fs.readSync = (fd, ...args) => { if (!fired && fds.has(fd)) { fired = true; fs.writeFileSync(process.env.ROCKY_TEST_SHORT_READ_MARKER, 'fired'); return 0; } return originalRead(fd, ...args); };",
    "syncBuiltinESMExports();",
  ].join("\n"), "utf8");
  const modulePath = join(process.cwd(), "dist", "core", "memory-query.js");
  const replacement = `${failure("after-race")}\n`;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", [
    `const { createMemoryQueries } = await import(${JSON.stringify(pathToFileURL(modulePath).href)});`,
    `const fs = await import("node:fs");`,
    "const queries = createMemoryQueries();",
    "const first = queries.stats();",
    `fs.writeFileSync(process.env.ROCKY_TEST_MEMORY, process.env.ROCKY_TEST_REPLACEMENT, "utf8");`,
    "const firstCoverage = queries.coverage?.();",
    "const second = queries.stats();",
    "const secondCoverage = queries.coverage?.();",
    "process.stdout.write(JSON.stringify({ first, firstCoverage, second, secondCoverage }));",
  ].join("\n")], {
    env: { ...process.env, NODE_OPTIONS: `--require=${preload}`, ROCKY_HOME: root, ROCKY_TEST_MEMORY: path, ROCKY_TEST_SHORT_READ_MARKER: marker, ROCKY_TEST_REPLACEMENT: replacement },
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(existsSync(marker), true, "short-read seam must fire");
  const output = JSON.parse(child.stdout) as {
    first: { total?: number };
    firstCoverage?: { complete?: boolean; reason?: string; truncated?: number };
    second: { total?: number };
    secondCoverage?: { complete?: boolean };
  };
  assert.equal(output.first.total, 0);
  assert.equal(output.firstCoverage?.complete, false);
  assert.equal(output.firstCoverage?.reason, "read-race");
  assert.ok((output.firstCoverage?.truncated ?? 0) > 0);
  assert.equal(output.second.total, 1);
  assert.equal(output.secondCoverage?.complete, true);
});

test("bounded reader rejects same-metadata rewrites before fix linking", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rocky-task13-witness-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "memory.jsonl");
  const first = failure("a29");
  const replacement = JSON.stringify({
    kind: "failure", id: "b29", ts: 1, cwd: "/budget", cmd: "other", exitCode: 1,
    fingerprint: "b".repeat(16), signature: ["other"], excerpt: "other",
  });
  assert.equal(Buffer.byteLength(first), Buffer.byteLength(replacement));
  writeFileSync(path, `${first}\n`, "utf8");
  const preload = join(root, "same-metadata.cjs");
  writeFileSync(preload, [
    "const fs = require('node:fs');",
    "const { syncBuiltinESMExports } = require('node:module');",
    "const originalLstat = fs.lstatSync.bind(fs);",
    "const originalFstat = fs.fstatSync.bind(fs);",
    "const target = process.env.ROCKY_TEST_MEMORY;",
    "const spoof = (stats) => new Proxy(stats, { get(target, property, receiver) {",
    "  if (property === 'dev') return 701n;",
    "  if (property === 'ino') return 702n;",
    "  if (property === 'mtimeNs') return 703n;",
    "  if (property === 'ctimeNs') return 704n;",
    "  return Reflect.get(target, property, receiver);",
    "} });",
    "fs.lstatSync = (value, ...args) => { const stats = originalLstat(value, ...args); return String(value) === target ? spoof(stats) : stats; };",
    "const originalOpen = fs.openSync.bind(fs);",
    "const originalClose = fs.closeSync.bind(fs);",
    "const descriptors = new Set();",
    "fs.openSync = (value, ...args) => { const fd = originalOpen(value, ...args); if (String(value) === target) descriptors.add(fd); return fd; };",
    "fs.fstatSync = (value, ...args) => { const stats = originalFstat(value, ...args); return descriptors.has(value) ? spoof(stats) : stats; };",
    "fs.closeSync = (value) => { descriptors.delete(value); return originalClose(value); };",
    "syncBuiltinESMExports();",
  ].join("\n"), "utf8");
  const modulePath = join(process.cwd(), "dist", "core", "memory-read.js");
  const memoryModule = join(process.cwd(), "dist", "core", "memory.js");
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", [
    `const fs = await import("node:fs");`,
    `const { loadMemoryChecked } = await import(${JSON.stringify(pathToFileURL(modulePath).href)});`,
    `const { resolveFixOnSuccess, touchPending } = await import(${JSON.stringify(pathToFileURL(memoryModule).href)});`,
    `const first = loadMemoryChecked(${JSON.stringify(path)}).records.map((record) => record.id);`,
    "touchPending();",
    `fs.writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(`${replacement}\n`)}, "utf8");`,
    `resolveFixOnSuccess("false", "/budget", { now: 2 });`,
    `const durable = fs.readFileSync(${JSON.stringify(path)}, "utf8");`,
    `const second = loadMemoryChecked(${JSON.stringify(path)}).records.map((record) => record.id);`,
    `process.stdout.write(JSON.stringify({ first, second, linkedAbsent: !durable.includes('\\\"failureIds\\\":[\\\"a29\\\"]'), pending: fs.existsSync(${JSON.stringify(join(root, "pending"))}) }));`,
  ].join("\n")], {
    env: { ...process.env, NODE_OPTIONS: `--require=${preload}`, ROCKY_HOME: root, ROCKY_TEST_MEMORY: path },
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
  });
  assert.equal(child.status, 0, child.stderr);
  const output = JSON.parse(child.stdout) as { first: string[]; second: string[]; linkedAbsent: boolean; pending: boolean };
  assert.deepEqual(output.first, ["a29"]);
  assert.deepEqual(output.second, ["b29"]);
  assert.equal(output.linkedAbsent, true);
  assert.equal(output.pending, true);
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
  writeFileSync(join(root, "memory.jsonl"), Array.from({ length: 10_000 }, (_, index) => `${failure(`concurrent-${index}`)}\n`).join(""));
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
  const started = performance.now();
  const values = await Promise.all(Array.from({ length: 200 }, () => tools.call("stats", {}, signal)));
  const elapsedMs = performance.now() - started;
  const after = memoryReadMetrics();
  assert.deepEqual(values.map((value) => value.structuredContent.total), values.map(() => first.structuredContent.total));
  assert.equal(after.parses - before.parses, 1);
  assert.ok(after.cacheHits - before.cacheHits >= 200);
  assert.ok(elapsedMs < 10_000, `bounded cache calls took ${elapsedMs.toFixed(1)}ms`);
});
