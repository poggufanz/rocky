import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExplainRecord, FailureRecord, MemoryRecord, RationaleRecord, TripleRecord } from "../core/memory-read.js";
import { createMemoryQueries } from "../core/memory-query.js";
import type { MemoryQueries } from "../core/memory-query.js";
import { canonicalPath, pathIdentityHash } from "../core/memory-read.js";
import { resolveRockyPaths } from "../core/state-paths.js";
import type { CardsForFile, StoredBlock, StoredCard } from "../desk/cards-read.js";
import { cardsFilePath } from "../listening/cards-path.js";
import { disabledRecallWithAi, type RecallWithAiPort } from "../ai/port.js";
import { createToolRegistry, McpInvalidParamsError, ToolExecutionError, TOOL_ENVELOPE_RESERVE_BYTES } from "../mcp/tools.js";
import { MAX_FIELD_BYTES, MAX_RESPONSE_BYTES } from "../mcp/privacy.js";

const records: MemoryRecord[] = [
  {
    kind: "failure", id: "f1", ts: 100, cwd: "/private/a", cmd: "npm test missing module",
    exitCode: 1, fingerprint: "fp-one", signature: ["missing module"], excerpt: "missing module",
  },
  {
    kind: "failure", id: "f2", ts: 200, cwd: "/private/b", cmd: "npm test type error",
    exitCode: 1, fingerprint: "fp-two", signature: ["type error"], excerpt: "type error",
  },
];

const triple: TripleRecord = {
  kind: "triple", id: "triple-1", ts: 300, cwd: "/private/project", schemaV: 1,
  agent: "codex", origin: "agent-hook", intent: { text: "naikin button" },
  rationale: { text: "spacing", tags: ["margin"], source: "transcript" },
  mechanism: {
    files: [{ path: "src/app.css", plusMinus: [2, 1], props: ["margin-top"] }],
    truncatedFiles: 0,
  },
};
const knowledgeRecords: MemoryRecord[] = [...records, triple];

const emptyCards = (): CardsForFile => ({ cards: [], matched: new Map(), coverage: { complete: true, skipped: 0 } });

function registry(exposure: "sanitized" | "raw" = "sanitized") {
  return createToolRegistry({
    exposure,
    memory: createMemoryQueries(() => records),
    recallWithAi: disabledRecallWithAi,
    cards: emptyCards,
  });
}

function knowledgeRegistry(exposure: "sanitized" | "raw" = "sanitized") {
  return createToolRegistry({
    exposure,
    memory: createMemoryQueries(() => knowledgeRecords),
    recallWithAi: disabledRecallWithAi,
    cards: emptyCards,
  });
}

function completeWhyTriple(id: string): TripleRecord {
  return {
    ...triple,
    id,
    cwd: "/repo",
    platform: "linux",
    mechanism: {
      files: [{ path: "src/known.ts", plusMinus: [1, 0], props: ["known"], provenance: "tool-observed" }],
      truncatedFiles: 0,
      baseline: "captured",
      coverageStatus: "complete",
    },
  };
}

async function mapUnexpectedToolFailureToWire(call: () => Promise<unknown>, id: string): Promise<string> {
  try {
    await call();
  } catch (error) {
    assert.match(error instanceof Error ? error.message : "", /response too large/);
    return `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"error":{"code":-32603,"message":"Internal error"}}\n`;
  }
  assert.fail("expected registry rejection");
}

test("sanitized catalog excludes cwd and stays in frozen order", () => {
  const definitions = registry().list();
  assert.deepEqual(definitions.map((tool) => tool.name), [
    "recall", "recent_failures", "stats", "recall_with_ai", "search_knowledge", "fetch_record", "why_file", "teach_lookup",
    "activity_recent", "activity_for_file", "bundles_list", "bundle_get", "session_timeline",
  ]);
  assert.equal(JSON.stringify(definitions).includes('"cwd"'), false);
  assert.ok(definitions.every((tool) =>
    tool.annotations.readOnlyHint && !tool.annotations.destructiveHint &&
    tool.annotations.idempotentHint && !tool.annotations.openWorldHint,
  ));
  assert.ok(Object.isFrozen(definitions));
  assert.ok(Object.isFrozen(definitions[0]));
  assert.ok(Object.isFrozen(definitions[0].inputSchema));
});

test("raw catalog adds cwd only to queries that support it", () => {
  const definitions = registry("raw").list();
  assert.equal(JSON.stringify(definitions).includes('"cwd"'), true);
  assert.deepEqual(definitions.map((tool) => tool.name), [
    "recall", "recent_failures", "stats", "recall_with_ai", "search_knowledge", "fetch_record", "why_file", "teach_lookup",
    "activity_recent", "activity_for_file", "bundles_list", "bundle_get", "session_timeline",
  ]);
});

test("new tool descriptions are concrete and schemas expose their bounds", () => {
  const definitions = registry().list();
  const search = definitions.find((tool) => tool.name === "search_knowledge");
  const fetch = definitions.find((tool) => tool.name === "fetch_record");
  const why = definitions.find((tool) => tool.name === "why_file");
  const teach = definitions.find((tool) => tool.name === "teach_lookup");
  assert.ok(search && fetch && why && teach);
  assert.match(search.description, /Example/);
  assert.match(fetch.description, /Example/);
  assert.match(why.description, /Example/);
  // why_file answers with triples and with stated reasons, and a relative path has one meaning.
  assert.match(why.description, /triples/);
  assert.match(why.description, /rationales/);
  assert.match(why.description, /relative path resolves against the server's working directory/);
  assert.match(teach.description, /Example/);
  assert.match(teach.description, /Reasons are quotes recorded from a human or agent, not verified facts\./);
  assert.deepEqual(teach.inputSchema, {
    type: "object", additionalProperties: false, required: ["path"], properties: {
      path: { type: "string", maxLength: MAX_FIELD_BYTES },
      line: { type: "integer", minimum: 1 },
      snippet: { type: "string", maxLength: MAX_FIELD_BYTES },
    },
  });
  assert.deepEqual(search.inputSchema, {
    type: "object", additionalProperties: false, required: ["query"], properties: {
      query: { type: "string", minLength: 1, maxLength: 500 },
      kind: { type: "string", enum: ["failure", "fix", "triple", "note", "rationale", "explain"] },
      limit: { type: "integer", minimum: 1, maximum: 20 },
    },
  });
  assert.deepEqual(fetch.inputSchema, {
    type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" } },
  });
  assert.deepEqual(why.inputSchema, {
    type: "object", additionalProperties: false, required: ["path"], properties: {
      path: { type: "string", maxLength: MAX_FIELD_BYTES }, limit: { type: "integer", minimum: 1, maximum: 10 },
      diff: { type: "boolean" },
    },
  });
});

test("knowledge tools search, fetch, and explain one file", async () => {
  const signal = new AbortController().signal;
  const search = await knowledgeRegistry().call("search_knowledge", { query: "naikin" }, signal);
  assert.equal(search.isError, undefined);
  assert.deepEqual(search.structuredContent.items, [{
    id: "triple-1", ts: 300, kind: "triple", snippet: "naikin button — Rationale: spacing", score: 0.5625,
    agent: "codex", source: "agent-hook", filesCovered: ["src/app.css"], truncatedFiles: 0, complete: false, coverageStatus: "unknown", truncatedFields: [],
  }]);

  const fetched = await knowledgeRegistry().call("fetch_record", { id: "triple-1" }, signal);
  assert.equal(fetched.isError, undefined);
  assert.equal((fetched.structuredContent.record as { id: string }).id, "triple-1");
  assert.equal((fetched.structuredContent.record as { files: unknown[] }).files.length, 1);
  assert.equal("cwd" in (fetched.structuredContent.record as object), false);
  assert.equal("excerpt" in ((fetched.structuredContent.record as { files: object[] }).files[0] ?? {}), false);

  const why = await knowledgeRegistry().call("why_file", { path: "src/app.css", limit: 1 }, signal);
  assert.equal(why.isError, undefined);
  assert.equal((why.structuredContent.items as unknown[]).length, 1);
});

function teachMemory(records: readonly MemoryRecord[]): MemoryQueries & { records: () => readonly MemoryRecord[] } {
  return { ...createMemoryQueries(() => []), records: () => records };
}

const WITNESS_EXPLAIN: ExplainRecord = {
  kind: "explain", id: "550e8400-e29b-41d4-a716-446655440000", ts: 1_700_000_000_000, v: 1,
  cwd: "/private/secret-project", path: "src/app.ts", source: "agent:claude-code",
  code: "Bearer TOP-LEVEL-TOPSECRET-AAAABBBBCCCCDDDD; documents rows",
  business: "filter rows at the boundary",
  snippet: "const rows = await fetchRows();",
  contentHash: "0123456789abcdef0123456789abcdef",
};

test("teach_lookup renders a sanitized witness card and keeps cwd and id opaque", async () => {
  const signal = new AbortController().signal;
  const memory = teachMemory([WITNESS_EXPLAIN]);
  const sanitized = await createToolRegistry({ exposure: "sanitized", memory, recallWithAi: disabledRecallWithAi })
    .call("teach_lookup", { path: "src/app.ts" }, signal);
  assert.equal(sanitized.isError, undefined);
  assert.equal(sanitized.structuredContent.header, "Witnessed: an agent stated why, and rocky recorded it.");
  assert.equal(sanitized.structuredContent.match, "similarity");
  const sanitizedLines = sanitized.structuredContent.lines as string[];
  assert.equal(sanitizedLines[0]?.startsWith("code: Bearer [redacted]"), true);
  assert.equal(sanitizedLines[1], "business: filter rows at the boundary");
  assert.match(sanitized.structuredContent.evidence as string, /^source: agent:claude-code ·/);
  assert.equal(sanitized.structuredContent.recordId, WITNESS_EXPLAIN.id);
  assert.doesNotMatch(JSON.stringify(sanitized), /TOP-LEVEL-TOPSECRET|Bearer TOP|\/private|secret-project/u);

  const raw = await createToolRegistry({ exposure: "raw", memory, recallWithAi: disabledRecallWithAi })
    .call("teach_lookup", { path: "src/app.ts" }, signal);
  assert.equal(raw.isError, undefined);
  assert.match(JSON.stringify(raw), /TOP-LEVEL-TOPSECRET/u);
  assert.doesNotMatch(JSON.stringify(raw), /\/private|secret-project/u);
});

test("teach_lookup assembles a ladder card when no witness matches", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rocky-mcp-teach-"));
  const file = join(dir, "ladder.ts");
  writeFileSync(file, [
    "export async function loadFeed() {",
    "  const rows = await fetchRows();",
    "  return rows;",
    "}",
  ].join("\n"), "utf8");
  const result = await registry().call("teach_lookup", { path: file, line: 2 }, new AbortController().signal);
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.header, "Assembled from evidence, not witnessed.");
  assert.equal(result.structuredContent.match, "ladder");
  assert.ok((result.structuredContent.lines as string[])[0]?.includes("· line 2"));
  assert.ok((result.structuredContent.lines as string[])[1]?.startsWith("reason:"));
  assert.match(result.structuredContent.evidence as string, /^evidence: /);
});

test("teach_lookup forwards git provenance through the fifth projectExplain argument", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rocky-mcp-teach-git-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test Author"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "author@example.com"], { cwd: dir });
  writeFileSync(join(dir, "feed.ts"), [
    "export async function loadFeed() {",
    "  const rows = await fetchRows();",
    "  return rows;",
    "}",
  ].join("\n"), "utf8");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "add feed"], { cwd: dir });
  const prevCwd = process.cwd();
  process.chdir(dir);
  try {
    const result = await createToolRegistry({
      exposure: "sanitized", memory: teachMemory([]), recallWithAi: disabledRecallWithAi,
    }).call("teach_lookup", { path: "feed.ts", line: 2 }, new AbortController().signal);
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.match, "ladder");
    assert.match(result.structuredContent.evidence as string, /git/);
    assert.match(result.structuredContent.evidence as string, /evidence-exhausted/);
    const provenance = result.structuredContent.provenance as
      | { commit: string; author: string; date: string; subject: string } | undefined;
    assert.ok(provenance !== undefined, "ladder git hit must project provenance");
    assert.match(provenance.commit, /^[0-9a-f]{7}$/);
    assert.equal(provenance.author, "Test Author");
    assert.match(provenance.subject, /add feed/);
  } finally {
    process.chdir(prevCwd);
  }
});

test("teach_lookup witness hit suppresses git and carries no provenance", async () => {
  const result = await createToolRegistry({
    exposure: "sanitized", memory: teachMemory([WITNESS_EXPLAIN]), recallWithAi: disabledRecallWithAi,
  }).call("teach_lookup", { path: "src/app.ts" }, new AbortController().signal);
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.provenance, undefined);
});

test("teach_lookup bounds oversized witness fields and fits the wire cap", async () => {
  const big = "word ".repeat(5_000);
  const oversized: ExplainRecord = {
    ...WITNESS_EXPLAIN,
    id: "teach-big-id",
    code: big,
    business: big,
  };
  const result = await createToolRegistry({
    exposure: "sanitized", memory: teachMemory([oversized]), recallWithAi: disabledRecallWithAi,
  }).call("teach_lookup", { path: "src/app.ts" }, new AbortController().signal);
  assert.equal(result.isError, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= MAX_RESPONSE_BYTES - TOOL_ENVELOPE_RESERVE_BYTES);
  assert.ok((result.structuredContent.truncatedFields as string[]).length > 0);
});

test("custom fetch_record snapshots triple fields before sanitized or raw projection", async () => {
  const base = completeWhyTriple("fetch-snapshot");
  const reads = new Map<string, number>();
  const getters = new Map<string, () => unknown>();
  const changing = (name: string, first: unknown, later: unknown) => {
    const existing = getters.get(name);
    if (existing !== undefined) return existing;
    const getter = () => {
      const count = (reads.get(name) ?? 0) + 1;
      reads.set(name, count);
      return count === 1 ? first : later;
    };
    getters.set(name, getter);
    return getter;
  };
  const file = new Proxy(base.mechanism.files[0]!, {
    get(target, property, receiver) {
      if (property === "path") return changing("file.path", "src/fetch.ts", "Bearer FILE-TOPSECRET")();
      return Reflect.get(target, property, receiver);
    },
    ownKeys() { throw new Error("file must not be enumerated"); },
  });
  const mechanism = new Proxy({ ...base.mechanism, files: [file] }, {
    get(target, property, receiver) {
      if (property === "files") return changing("mechanism.files", target.files, [file])();
      return Reflect.get(target, property, receiver);
    },
    ownKeys() { throw new Error("mechanism must not be enumerated"); },
  });
  const candidate = new Proxy({ ...base, mechanism }, {
    get(target, property, receiver) {
      if (property === "agent") return changing("triple.agent", "codex", "Bearer AGENT-TOPSECRET")();
      if (property === "cwd") return changing("triple.cwd", "/repo", "Bearer CWD-TOPSECRET")();
      if (property === "kind") return changing("triple.kind", "triple", "triple")();
      if (property === "mechanism") return changing("triple.mechanism", mechanism, { secret: "TOPSECRET" })();
      return Reflect.get(target, property, receiver);
    },
    ownKeys() { throw new Error("triple must not be enumerated"); },
  });
  const memory = {
    ...createMemoryQueries(() => []),
    fetchRecord: () => candidate as unknown as MemoryRecord,
  };
  const sanitized = await createToolRegistry({
    exposure: "sanitized", memory, recallWithAi: disabledRecallWithAi,
  }).call("fetch_record", { id: base.id }, new AbortController().signal);
  assert.equal(sanitized.isError, undefined);
  assert.doesNotMatch(JSON.stringify(sanitized), /TOPSECRET|Bearer/u);
  assert.equal((sanitized.structuredContent.record as { agent: string }).agent, "codex");
  assert.equal(((sanitized.structuredContent.record as { files: Array<{ path: string }> }).files[0])?.path, "src/fetch.ts");

  reads.clear();
  getters.clear();
  const raw = await createToolRegistry({
    exposure: "raw", memory, recallWithAi: disabledRecallWithAi,
  }).call("fetch_record", { id: base.id }, new AbortController().signal);
  assert.equal(raw.isError, undefined);
  assert.doesNotMatch(JSON.stringify(raw), /TOPSECRET|Bearer/u);
  assert.equal((raw.structuredContent.record as { agent: string }).agent, "codex");
  assert.equal((raw.structuredContent.record as { cwd: string }).cwd, "/repo");
  assert.equal(reads.get("triple.agent"), 1);
  assert.equal(reads.get("triple.cwd"), 1);
  assert.equal(reads.get("file.path"), 1);
});

test("custom fetch_record snapshots failure origin before projection", async () => {
  const failure: FailureRecord = {
    kind: "failure", id: "failure-origin-snapshot", ts: 10, cwd: "/repo", cmd: "npm test",
    exitCode: 1, fingerprint: "0123456789abcdef", signature: ["failure"], excerpt: "failure",
  };
  let originReads = 0;
  const candidate = new Proxy(failure, {
    get(target, property, receiver) {
      if (property === "origin") {
        originReads += 1;
        return originReads === 1 ? undefined : "Bearer ORIGIN-TOPSECRET";
      }
      return Reflect.get(target, property, receiver);
    },
    ownKeys() { throw new Error("failure must not be enumerated"); },
  });
  const memory = {
    ...createMemoryQueries(() => []),
    fetchRecord: () => candidate,
  };
  const result = await createToolRegistry({
    exposure: "sanitized", memory, recallWithAi: disabledRecallWithAi,
  }).call("fetch_record", { id: failure.id }, new AbortController().signal);
  assert.equal(result.isError, undefined);
  assert.equal(originReads, 1);
  assert.doesNotMatch(JSON.stringify(result), /Bearer|TOPSECRET/u);
  assert.equal((result.structuredContent.record as { id: string }).id, failure.id);
});

test("custom fetch_record snapshots discriminator before routing a kind-swapped record", async () => {
  const base = completeWhyTriple("fetch-kind-snapshot");
  let kindReads = 0;
  let agentReads = 0;
  const candidate = new Proxy(base, {
    get(target, property, receiver) {
      if (property === "kind") {
        kindReads += 1;
        return kindReads === 1 ? "fix" : "triple";
      }
      if (property === "agent") {
        agentReads += 1;
        return agentReads === 1 ? "codex" : "Bearer KIND-SWAP-TOPSECRET";
      }
      return Reflect.get(target, property, receiver);
    },
    ownKeys() { throw new Error("kind-swapped record must not be enumerated"); },
  });
  const result = await createToolRegistry({
    exposure: "sanitized",
    memory: { ...createMemoryQueries(() => []), fetchRecord: () => candidate as unknown as MemoryRecord },
    recallWithAi: disabledRecallWithAi,
  }).call("fetch_record", { id: base.id }, new AbortController().signal);
  assert.equal(kindReads, 1);
  assert.equal(agentReads, 0);
  assert.doesNotMatch(JSON.stringify(result), /KIND-SWAP-TOPSECRET|Bearer/u);
  assert.ok(result.structuredContent.record === null || result.structuredContent.error !== undefined);
});

test("why_file keeps two index suffixes ambiguous and future knowledge inert", async () => {
  const first: TripleRecord = {
    ...triple, id: "index-one", ts: 10, cwd: "/repo", platform: "linux", mechanism: {
      files: [{ path: "one/index.ts", plusMinus: [1, 0], props: [], provenance: "tool-observed" }],
      truncatedFiles: 0, baseline: "captured", coverageStatus: "complete",
    },
  };
  const second: TripleRecord = {
    ...first, id: "index-two", mechanism: {
      files: [{ path: "two/index.ts", plusMinus: [1, 0], props: [], provenance: "tool-observed" }],
      truncatedFiles: 0, baseline: "captured", coverageStatus: "complete",
    },
  };
  const ambiguous = createToolRegistry({
    exposure: "sanitized",
    memory: createMemoryQueries(() => [first, second]),
    recallWithAi: disabledRecallWithAi,
    cards: emptyCards,
  });
  const result = await ambiguous.call("why_file", { path: "index.ts" }, new AbortController().signal);
  assert.deepEqual(result.structuredContent.items, []);
  assert.equal(result.structuredContent.ambiguousPath, true);
  assert.equal(result.structuredContent.coverageIncomplete, true);

  const futureNote: MemoryRecord = {
    kind: "note", id: "future-search-note", ts: Date.now() + 60_000, cwd: "/private",
    cmd: "rocky note", file: "src/app.ts", line: 1, subject: "future", answer: "banana",
  };
  const futureTriple: TripleRecord = {
    ...triple, id: "future-search-triple", ts: Date.now() + 60_000,
    intent: { text: "future path" },
    mechanism: {
      files: [{ path: "src/future.ts", plusMinus: [1, 0], props: ["future"], provenance: "tool-observed" }],
      truncatedFiles: 0, baseline: "captured", coverageStatus: "complete",
    },
  };
  const futureSearch = createToolRegistry({
    exposure: "sanitized",
    memory: createMemoryQueries(() => [futureNote, futureTriple]),
    recallWithAi: disabledRecallWithAi,
    cards: emptyCards,
  });
  const search = await futureSearch.call("search_knowledge", { query: "banana", kind: "note" }, new AbortController().signal);
  assert.deepEqual(search.structuredContent.items, []);
  const tripleSearch = await futureSearch.call("search_knowledge", { query: "future path", kind: "triple" }, new AbortController().signal);
  assert.deepEqual(tripleSearch.structuredContent.items, []);
  const futureWhy = await futureSearch.call("why_file", { path: "src/future.ts" }, new AbortController().signal);
  assert.deepEqual(futureWhy.structuredContent.items, []);
  assert.equal(futureWhy.structuredContent.coverageIncomplete, true);

  const customFutureTs = Date.now() + 60_000;
  const customFuture = createToolRegistry({
    exposure: "sanitized",
    memory: {
      recall() { return []; },
      recentFailures() { return []; },
      stats() { return { failures: 0, fixEvents: 0, resolved: 0, unresolved: 0 }; },
      searchKnowledge() {
        return [{ id: "custom-future", ts: customFutureTs, kind: "triple", snippet: "future", score: 1 }];
      },
      fetchRecord() { return undefined; },
      whyFile() { return [futureTriple]; },
      whyFileEvidence() {
        return {
          matches: [futureTriple], possible: [],
          coverage: { status: "complete", complete: true, filesCovered: 1, truncatedFiles: 0 },
          coverageIncomplete: false,
        };
      },
    },
    recallWithAi: disabledRecallWithAi,
    cards: emptyCards,
  });
  const customSearch = await customFuture.call("search_knowledge", { query: "future" }, new AbortController().signal);
  assert.deepEqual(customSearch.structuredContent.items, []);
  const customWhy = await customFuture.call("why_file", { path: "src/future.ts" }, new AbortController().signal);
  assert.deepEqual(customWhy.structuredContent.items, []);
  assert.equal(customWhy.structuredContent.coverageIncomplete, true);
});

test("why_file suppresses custom matches marked ambiguous", async () => {
  const known: TripleRecord = {
    ...triple,
    id: "custom-ambiguous",
    ts: 10,
    cwd: "/repo",
    platform: "linux",
    mechanism: {
      files: [{ path: "src/known.ts", plusMinus: [1, 0], props: ["known"], provenance: "tool-observed" }],
      truncatedFiles: 0, baseline: "captured", coverageStatus: "complete",
    },
  };
  const memory = {
    ...createMemoryQueries(() => [known]),
    whyFile: () => [known],
    whyFileEvidence: () => ({
      matches: [known], possible: [], ambiguousPath: true,
      coverage: { status: "complete" as const, complete: true, filesCovered: 1, truncatedFiles: 0 },
      coverageIncomplete: false,
    }),
  };
  const result = await createToolRegistry({
    exposure: "sanitized", memory, recallWithAi: disabledRecallWithAi, cards: emptyCards,
  }).call("why_file", { path: "src/known.ts" }, new AbortController().signal);
  assert.deepEqual(result.structuredContent.items, []);
  assert.equal(result.structuredContent.ambiguousPath, true);
  assert.equal(result.structuredContent.coverageIncomplete, true);
  assert.equal(result.structuredContent.coverageStatus, "unknown");
});

test("why_file custom evidence fails closed on a malformed match", async () => {
  const known = completeWhyTriple("custom-malformed-match");
  const memory = {
    ...createMemoryQueries(() => [known]),
    whyFile: () => [known, null] as unknown as TripleRecord[],
    whyFileEvidence: () => ({
      matches: [known, null] as unknown as TripleRecord[],
      possible: [],
      coverage: { status: "complete" as const, complete: true, filesCovered: 1, truncatedFiles: 0 },
      coverageIncomplete: false,
    }),
  };
  const result = await createToolRegistry({
    exposure: "sanitized", memory, recallWithAi: disabledRecallWithAi, cards: emptyCards,
  }).call("why_file", { path: "src/known.ts" }, new AbortController().signal);
  assert.deepEqual(result.structuredContent.items, []);
  assert.equal(result.structuredContent.coverageStatus, "unknown");
  assert.equal(result.structuredContent.coverageIncomplete, true);
  assert.equal((result.structuredContent.coverage as { complete: boolean }).complete, false);
});

test("why_file fallback fails closed on a malformed match", async () => {
  const known = completeWhyTriple("fallback-malformed-match");
  const memory = {
    ...createMemoryQueries(() => [known]),
    whyFile: () => [known, null] as unknown as TripleRecord[],
    whyFileEvidence: undefined,
  };
  const result = await createToolRegistry({
    exposure: "sanitized", memory, recallWithAi: disabledRecallWithAi, cards: emptyCards,
  }).call("why_file", { path: "src/known.ts" }, new AbortController().signal);
  assert.deepEqual(result.structuredContent.items, []);
  assert.equal(result.structuredContent.coverageStatus, "unknown");
  assert.equal(result.structuredContent.coverageIncomplete, true);
  assert.equal((result.structuredContent.coverage as { complete: boolean }).complete, false);
});

test("why_file rejects oversized provider cwd/path evidence before canonicalization", async () => {
  const known = completeWhyTriple("oversized-provider-known");
  const oversizedCwd = "c".repeat(MAX_FIELD_BYTES * 2 + 1);
  const oversizedPath = "p".repeat(1_025);
  const hostileCwd = { ...known, cwd: oversizedCwd };
  const hostilePath = {
    ...known,
    id: "oversized-provider-path",
    mechanism: {
      ...known.mechanism,
      files: [{ path: oversizedPath, plusMinus: [1, 0] as [number, number], props: ["oversized"], provenance: "tool-observed" as const }],
    },
  };
  const makeEvidence = (matches: unknown[]) => ({
    matches: matches as TripleRecord[], possible: [],
    coverage: { status: "complete" as const, complete: true, filesCovered: 1, truncatedFiles: 0 },
    coverageIncomplete: false,
  });
  const cwdResult = await createToolRegistry({
    exposure: "sanitized",
    memory: { ...createMemoryQueries(() => []), whyFileEvidence: () => makeEvidence([hostileCwd]) },
    recallWithAi: disabledRecallWithAi,
    cards: emptyCards,
  }).call("why_file", { path: "src/known.ts" }, new AbortController().signal);
  assert.deepEqual(cwdResult.structuredContent.items, []);
  assert.equal(cwdResult.structuredContent.coverageStatus, "unknown");
  assert.equal(cwdResult.structuredContent.coverageIncomplete, true);

  const mixedResult = await createToolRegistry({
    exposure: "sanitized",
    memory: { ...createMemoryQueries(() => []), whyFileEvidence: () => makeEvidence([known, hostilePath]) },
    recallWithAi: disabledRecallWithAi,
    cards: emptyCards,
  }).call("why_file", { path: "src/known.ts" }, new AbortController().signal);
  assert.deepEqual(mixedResult.structuredContent.items, []);
  assert.equal(mixedResult.structuredContent.coverageStatus, "unknown");
  assert.equal(mixedResult.structuredContent.coverageIncomplete, true);

  const longPath = `src/${"u".repeat(1_010)}.ts`;
  const bounded = {
    ...known,
    id: "bounded-long-provider-path",
    mechanism: {
      ...known.mechanism,
      files: [{ path: longPath, plusMinus: [1, 0] as [number, number], props: ["bounded"], provenance: "tool-observed" as const }],
    },
  };
  const boundedResult = await createToolRegistry({
    exposure: "sanitized",
    memory: { ...createMemoryQueries(() => []), whyFileEvidence: () => makeEvidence([bounded]) },
    recallWithAi: disabledRecallWithAi,
    cards: emptyCards,
  }).call("why_file", { path: longPath }, new AbortController().signal);
  assert.equal((boundedResult.structuredContent.items as unknown[]).length, 1);
  assert.equal(boundedResult.structuredContent.coverageStatus, "complete");
});

test("why_file keeps a bounded witness from an over-cap valid file array and discloses omission", async () => {
  let beyondCapReads = 0;
  const files = Array.from({ length: 257 }, (_, index) => ({
    path: index === 2 ? "src/target.ts" : `src/other-${index}.ts`,
    plusMinus: [1, 0] as [number, number],
    props: ["known"],
    provenance: "tool-observed" as const,
  }));
  const hostileFiles = new Proxy(files, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/u.test(property) && Number(property) >= 256) beyondCapReads += 1;
      return Reflect.get(target, property, receiver);
    },
    ownKeys() { throw new Error("provider files must not be enumerated"); },
  });
  const candidate: TripleRecord = {
    ...completeWhyTriple("over-cap-valid-files"),
    mechanism: {
      files: hostileFiles as unknown as TripleRecord["mechanism"]["files"],
      truncatedFiles: 0, baseline: "captured", coverageStatus: "complete",
    },
  };
  const result = await createToolRegistry({
    exposure: "sanitized",
    memory: {
      ...createMemoryQueries(() => []),
      whyFileEvidence: () => ({
        matches: [candidate], possible: [],
        coverage: { status: "complete" as const, complete: true, filesCovered: 257, truncatedFiles: 0 },
        coverageIncomplete: false,
      }),
    },
    recallWithAi: disabledRecallWithAi,
    cards: emptyCards,
  }).call("why_file", { path: "src/target.ts" }, new AbortController().signal);
  const item = (result.structuredContent.items as Array<{
    files: Array<{ path: string }>; truncatedFiles: number; complete: boolean; confidence: string; reason: string;
  }>)[0];
  assert.ok(item?.files.some((file) => file.path === "src/target.ts"));
  assert.ok((item?.truncatedFiles ?? 0) > 0);
  assert.equal(item?.complete, false);
  assert.equal(item?.confidence, "incomplete");
  assert.equal(item?.reason, "file coverage incomplete; the full change was not recorded");
  assert.equal(result.structuredContent.coverageIncomplete, true);
  assert.notEqual(result.structuredContent.coverageStatus, "complete");
  assert.equal(beyondCapReads, 0);
});

test("why_file snapshots every custom triple field once before normalization", async () => {
  const reads = new Map<string, number>();
  const oversized = "x".repeat(MAX_FIELD_BYTES * 2 + 1);
  const changing = (name: string, first: unknown, second: unknown = oversized): (() => unknown) => () => {
    const count = (reads.get(name) ?? 0) + 1;
    reads.set(name, count);
    return count === 1 ? first : second;
  };
  const file = new Proxy({}, {
    get(_target, property: string | symbol) {
      if (typeof property !== "string") throw new Error("unexpected symbol getter");
      const getters: Record<string, () => unknown> = {
        path: changing("file.path", "src/snapshot.ts"),
        plusMinus: changing("file.plusMinus", [1, 0] as [number, number]),
        props: changing("file.props", ["snapshot"]),
        excerpt: changing("file.excerpt", "small excerpt"),
        provenance: changing("file.provenance", "tool-observed"),
        identityHash: changing("file.identityHash", pathIdentityHash("/repo/src/snapshot.ts", { platform: "linux" })),
      };
      const getter = getters[property];
      if (!getter) throw new Error(`irrelevant file getter: ${property}`);
      return getter();
    },
    ownKeys() { throw new Error("untrusted file must not be enumerated"); },
  });
  const mechanism = new Proxy({}, {
    get(_target, property: string | symbol) {
      if (typeof property !== "string") throw new Error("unexpected symbol getter");
      const getters: Record<string, () => unknown> = {
        head: changing("mechanism.head", "Edit"),
        files: changing("mechanism.files", [file]),
        truncatedFiles: changing("mechanism.truncatedFiles", 0),
        baseline: changing("mechanism.baseline", "captured"),
        coverageStatus: changing("mechanism.coverageStatus", "complete"),
      };
      const getter = getters[property];
      if (!getter) throw new Error(`irrelevant mechanism getter: ${property}`);
      return getter();
    },
    ownKeys() { throw new Error("untrusted mechanism must not be enumerated"); },
  });
  const intent = new Proxy({}, {
    get(_target, property: string | symbol) {
      if (property === "text") return changing("intent.text", "change snapshot")();
      throw new Error(`irrelevant intent getter: ${String(property)}`);
    },
    ownKeys() { throw new Error("untrusted intent must not be enumerated"); },
  });
  const rationale = new Proxy({}, {
    get(_target, property: string | symbol) {
      const getters: Record<string, () => unknown> = {
        text: changing("rationale.text", "captured reason"),
        tags: changing("rationale.tags", ["snapshot"]),
        source: changing("rationale.source", "transcript"),
      };
      if (typeof property !== "string" || getters[property] === undefined) {
        throw new Error(`irrelevant rationale getter: ${String(property)}`);
      }
      return getters[property]();
    },
    ownKeys() { throw new Error("untrusted rationale must not be enumerated"); },
  });
  const candidate = new Proxy({}, {
    get(_target, property: string | symbol) {
      if (typeof property !== "string") throw new Error("unexpected symbol getter");
      const getters: Record<string, () => unknown> = {
        kind: changing("kind", "triple"),
        id: changing("id", "snapshot-once"),
        ts: changing("ts", 10),
        cwd: changing("cwd", "/repo"),
        schemaV: changing("schemaV", 1),
        agent: changing("agent", "codex", "Bearer TOPSECRET\u001b[31mcredential"),
        origin: changing("origin", "agent-hook"),
        platform: changing("platform", "linux"),
        mechanism: changing("mechanism", mechanism),
        intent: changing("intent", intent),
        rationale: changing("rationale", rationale),
      };
      const getter = getters[property];
      if (!getter) throw new Error(`irrelevant triple getter: ${property}`);
      return getter();
    },
    ownKeys() { throw new Error("untrusted triple must not be enumerated"); },
  });
  const registry = createToolRegistry({
    exposure: "sanitized",
    memory: {
      ...createMemoryQueries(() => []),
      whyFileEvidence: () => ({
        matches: [candidate as unknown as TripleRecord], possible: [],
        coverage: { status: "complete" as const, complete: true, filesCovered: 1, truncatedFiles: 0 },
        coverageIncomplete: false,
      }),
    },
    recallWithAi: disabledRecallWithAi,
    cards: emptyCards,
  });
  const result = await registry.call("why_file", { path: "src/snapshot.ts" }, new AbortController().signal);
  assert.equal((result.structuredContent.items as unknown[]).length, 1);
  assert.equal(result.structuredContent.coverageStatus, "complete");
  assert.equal(result.structuredContent.coverageIncomplete, false);
  const expected = [
    "kind", "id", "ts", "cwd", "schemaV", "agent", "origin", "platform", "mechanism", "intent", "rationale",
    "mechanism.head", "mechanism.files", "mechanism.truncatedFiles", "mechanism.baseline", "mechanism.coverageStatus",
    "file.path", "file.plusMinus", "file.props", "file.excerpt", "file.provenance", "file.identityHash",
    "intent.text", "rationale.text", "rationale.tags", "rationale.source",
  ];
  for (const key of expected) assert.equal(reads.get(key), 1, `${key} getter count`);
  assert.equal(reads.size, expected.length);
  assert.doesNotMatch(JSON.stringify(result), /TOPSECRET|\u001b/gu);
});

test("why_file never falls back from malformed custom evidence", async () => {
  const known = completeWhyTriple("custom-top-level-malformed");
  const throwing = new Proxy({}, {
    get(_target, property: string | symbol) {
      if (property === "matches") throw new Error("matches getter failed");
      return undefined;
    },
  });
  const malformed: unknown[] = [undefined, null, [], throwing];
  for (const value of malformed) {
    const registry = createToolRegistry({
      exposure: "sanitized",
      memory: {
        ...createMemoryQueries(() => [known]),
        whyFile: () => [known],
        whyFileEvidence: () => value as never,
      },
      recallWithAi: disabledRecallWithAi,
      cards: emptyCards,
    });
    const result = await registry.call("why_file", { path: "src/known.ts" }, new AbortController().signal);
    assert.deepEqual(result.structuredContent.items, []);
    assert.equal(result.structuredContent.coverageStatus, "unknown");
    assert.equal(result.structuredContent.coverageIncomplete, true);
  }
  const legacy = createToolRegistry({
    exposure: "sanitized",
    memory: {
      ...createMemoryQueries(() => [known]),
      whyFile: () => [known],
      whyFileEvidence: undefined,
    },
    recallWithAi: disabledRecallWithAi,
    cards: emptyCards,
  });
  const legacyResult = await legacy.call("why_file", { path: "src/known.ts" }, new AbortController().signal);
  assert.equal((legacyResult.structuredContent.items as unknown[]).length, 1);
  assert.equal(legacyResult.structuredContent.coverageStatus, "complete");
});

test("why_file does not emit an accessor-swapped agent credential", async () => {
  const known = completeWhyTriple("agent-swap");
  let agentReads = 0;
  const candidate = new Proxy(known, {
    get(target, property, receiver) {
      if (property === "agent") {
        agentReads += 1;
        return agentReads === 1 ? "codex" : "Bearer TOPSECRET\u001b[31mcredential";
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const result = await createToolRegistry({
    exposure: "sanitized",
    memory: {
      ...createMemoryQueries(() => []),
      whyFileEvidence: () => ({
        matches: [candidate], possible: [],
        coverage: { status: "complete" as const, complete: true, filesCovered: 1, truncatedFiles: 0 },
        coverageIncomplete: false,
      }),
    },
    recallWithAi: disabledRecallWithAi,
    cards: emptyCards,
  }).call("why_file", { path: "src/known.ts" }, new AbortController().signal);
  assert.equal((result.structuredContent.items as Array<{ agent: string }>)[0]?.agent, "codex");
  assert.doesNotMatch(JSON.stringify(result), /TOPSECRET|\u001b/gu);
  assert.equal(agentReads, 1);
});

test("why_file fails closed when an untrusted nested snapshot getter throws", async () => {
  let pathReads = 0;
  const throwingFile = new Proxy({}, {
    get(_target, property: string | symbol) {
      if (property === "path") {
        pathReads += 1;
        throw new Error("path getter failed");
      }
      throw new Error(`irrelevant getter: ${String(property)}`);
    },
    ownKeys() { throw new Error("untrusted file must not be enumerated"); },
  });
  const known = completeWhyTriple("throwing-snapshot");
  const candidate = {
    ...known,
    mechanism: { ...known.mechanism, files: [throwingFile as unknown as TripleRecord["mechanism"]["files"][number]] },
  };
  const registry = createToolRegistry({
    exposure: "sanitized",
    memory: {
      ...createMemoryQueries(() => []),
      whyFileEvidence: () => ({
        matches: [candidate], possible: [],
        coverage: { status: "complete" as const, complete: true, filesCovered: 1, truncatedFiles: 0 },
        coverageIncomplete: false,
      }),
    },
    recallWithAi: disabledRecallWithAi,
    cards: emptyCards,
  });
  const result = await registry.call("why_file", { path: "src/known.ts" }, new AbortController().signal);
  assert.deepEqual(result.structuredContent.items, []);
  assert.equal(result.structuredContent.coverageStatus, "unknown");
  assert.equal(result.structuredContent.coverageIncomplete, true);
  assert.equal(pathReads, 1);
});

test("why_file accepts ordinary and Unicode paths at the byte boundary", async () => {
  const registry = createToolRegistry({
    exposure: "sanitized",
    memory: createMemoryQueries(() => []),
    recallWithAi: disabledRecallWithAi,
    cards: emptyCards,
  });
  const signal = new AbortController().signal;
  const unicodeBoundary = "é".repeat(MAX_FIELD_BYTES / 2);
  const unicodeResult = await registry.call("why_file", { path: unicodeBoundary }, signal);
  assert.equal(unicodeResult.isError, undefined);
  assert.equal(unicodeResult.structuredContent.coverageStatus, "unknown");
  const ordinaryBoundary = "x".repeat(MAX_FIELD_BYTES);
  const ordinaryResult = await registry.call("why_file", { path: ordinaryBoundary }, signal);
  assert.equal(ordinaryResult.isError, undefined);
  assert.equal(ordinaryResult.structuredContent.coverageStatus, "unknown");
});

test("why_file keeps unmatched relative-root paths unknown", async () => {
  const known: TripleRecord = {
    ...triple,
    id: "known-relative-mcp",
    ts: 10,
    cwd: "project",
    platform: "linux",
    mechanism: {
      files: [{ path: "src/known.ts", plusMinus: [1, 0], props: ["known"], provenance: "tool-observed" }],
      truncatedFiles: 0, baseline: "captured", coverageStatus: "complete",
    },
  };
  const result = await createToolRegistry({
    exposure: "sanitized",
    memory: createMemoryQueries(() => [known]),
    recallWithAi: disabledRecallWithAi,
    cards: emptyCards,
  }).call("why_file", { path: "src/missing.ts" }, new AbortController().signal);
  assert.deepEqual(result.structuredContent.items, []);
  assert.equal(result.structuredContent.coverageIncomplete, true);
  assert.equal(result.structuredContent.coverageStatus, "unknown");
});

test("why_file retains the shared identity-hash witness triple", async () => {
  const known: TripleRecord = {
    ...triple,
    id: "hashed-witness-mcp",
    ts: 10,
    cwd: "/repo",
    platform: "linux",
    mechanism: {
      files: [
        {
          path: "[redacted]",
          identityHash: pathIdentityHash("/repo/src/index.ts", { platform: "linux", canonical: true }),
          plusMinus: [9, 2], props: ["hashed"], provenance: "tool-observed",
        },
        { path: "web/src/index.ts", plusMinus: [1, 0], props: ["suffix"], provenance: "tool-observed" },
      ],
      truncatedFiles: 0, baseline: "captured", coverageStatus: "complete",
    },
  };
  const result = await createToolRegistry({
    exposure: "sanitized",
    memory: createMemoryQueries(() => [known]),
    recallWithAi: disabledRecallWithAi,
    cards: emptyCards,
  }).call("why_file", { path: "src/index.ts" }, new AbortController().signal);
  const item = (result.structuredContent.items as Array<{ id: string; files: Array<{ path: string; plusMinus: [number, number] }> }>)[0];
  assert.equal(item?.id, "hashed-witness-mcp");
  assert.ok(item?.files.some((file) => file.path === "[redacted]" && file.plusMinus[0] === 9 && file.plusMinus[1] === 2));
  assert.ok(item?.files.some((file) => file.path === "web/src/index.ts" && file.plusMinus[0] === 1 && file.plusMinus[1] === 0));
});

test("why_file fallback rejects absolute cross-root legacy suffixes without platform", async () => {
  const crossRoot: TripleRecord = {
    ...triple,
    id: "cross-root-legacy-mcp",
    ts: 10,
    cwd: "/repo",
    mechanism: {
      files: [{ path: "/other/src/index.ts", plusMinus: [1, 0], props: ["other"], provenance: "tool-observed" }],
      truncatedFiles: 0, baseline: "captured", coverageStatus: "complete",
    },
  };
  const memory = {
    ...createMemoryQueries(() => [crossRoot]),
    whyFile: () => [crossRoot],
    whyFileEvidence: undefined,
  };
  const result = await createToolRegistry({
    exposure: "sanitized", memory, recallWithAi: disabledRecallWithAi, cards: emptyCards,
  }).call("why_file", { path: "src/index.ts" }, new AbortController().signal);
  assert.deepEqual(result.structuredContent.items, []);
  assert.equal(result.structuredContent.coverageIncomplete, true);
  assert.equal(result.structuredContent.coverageStatus, "unknown");
});

test("why_file sanitizes custom possible IDs while raw remains explicit", async () => {
  const evidence = {
    matches: [],
    possible: [{ id: "user-secret-answer", ts: 10, source: "agent-hook" as const, reason: "path_may_be_omitted" as const }],
    coverage: { status: "unknown" as const, complete: false, filesCovered: 0, truncatedFiles: 0 },
    coverageIncomplete: true,
  };
  const memory = {
    ...createMemoryQueries(() => []),
    whyFile: () => [],
    whyFileEvidence: () => evidence,
  };
  const sanitized = await createToolRegistry({
    exposure: "sanitized", memory, recallWithAi: disabledRecallWithAi, cards: emptyCards,
  }).call("why_file", { path: "src/missing.ts" }, new AbortController().signal);
  assert.doesNotMatch(JSON.stringify(sanitized), /user-secret-answer/u);
  const raw = await createToolRegistry({
    exposure: "raw", memory, recallWithAi: disabledRecallWithAi, cards: emptyCards,
  }).call("why_file", { path: "src/missing.ts" }, new AbortController().signal);
  assert.match(JSON.stringify(raw), /user-secret-answer/u);
});

test("sanitized reserved custom IDs use opaque fetch handles while raw remains explicit", async () => {
  const ids = ["note-secret", "triple-api-key", "failure-password", "sk-ant-abcdefghijklmnopqrstuvwxyz1234567890"];
  for (const id of ids) {
    const record: MemoryRecord = {
      kind: "failure", id, ts: 10, cwd: "/repo", cmd: "npm test", exitCode: 1,
      fingerprint: "0123456789abcdef", signature: ["failure"], excerpt: "failure", origin: "run",
    };
    const memory = {
      ...createMemoryQueries(() => []),
      searchKnowledge: () => [{ id, ts: 10, kind: "failure" as const, snippet: "failure", score: 1, source: "run" }],
      fetchRecord: (requested: string) => requested === id ? record : undefined,
    };
    const sanitized = createToolRegistry({ exposure: "sanitized", memory, recallWithAi: disabledRecallWithAi });
    const search = await sanitized.call("search_knowledge", { query: "failure" }, new AbortController().signal);
    const handle = (search.structuredContent.items as Array<{ id: string }>)[0]?.id;
    assert.ok(handle?.startsWith("rk-h-"), `${id} must use opaque handle`);
    assert.doesNotMatch(JSON.stringify(search), new RegExp(id, "u"));
    const fetched = await sanitized.call("fetch_record", { id: handle }, new AbortController().signal);
    assert.ok(fetched.structuredContent.record !== null && fetched.structuredContent.record !== undefined);

    const raw = await createToolRegistry({ exposure: "raw", memory, recallWithAi: disabledRecallWithAi })
      .call("search_knowledge", { query: "failure" }, new AbortController().signal);
    assert.equal((raw.structuredContent.items as Array<{ id: string }>)[0]?.id, id);
  }
});

test("stats keeps legacy fields and adds bounded knowledge counters for old query implementations", async () => {
  const memory = {
    recall() { return []; },
    recentFailures() { return []; },
    stats() { return { failures: 2, fixEvents: 1, resolved: 1, unresolved: 1 }; },
    searchKnowledge() { return []; },
    fetchRecord() { return undefined; },
    whyFile() { return []; },
  };
  const result = await createToolRegistry({
    exposure: "sanitized", memory, recallWithAi: disabledRecallWithAi,
  }).call("stats", {}, new AbortController().signal);
  assert.deepEqual(result.structuredContent, {
    exposure: "sanitized", failures: 2, fixEvents: 1, resolved: 1, unresolved: 1,
    confirmedFixes: 1, possibleFixes: 0, triples: 0, notes: 0, total: 3,
  });
});

test("malformed custom stats disclose incomplete coverage instead of clean zero totals", async () => {
  for (const malformed of [undefined, null]) {
    const result = await createToolRegistry({
      exposure: "sanitized",
      memory: {
        ...createMemoryQueries(() => []),
        stats: () => malformed as never,
      },
      recallWithAi: disabledRecallWithAi,
    }).call("stats", {}, new AbortController().signal);
    assert.equal(result.structuredContent.failures, 0);
    assert.equal(result.structuredContent.total, 0);
    assert.equal(result.structuredContent.memoryCoverageIncomplete, true);
    assert.equal((result.structuredContent.memoryCoverage as { complete: boolean }).complete, false);
  }
});

test("custom stats and coverage snapshot primitive fields once and reject hostile shapes", async () => {
  const reads = new Map<string, number>();
  const getters = new Map<string, () => unknown>();
  const counted = (name: string, first: unknown, later = first) => {
    const existing = getters.get(name);
    if (existing !== undefined) return existing;
    const getter = () => {
      const count = (reads.get(name) ?? 0) + 1;
      reads.set(name, count);
      return count === 1 ? first : later;
    };
    reads.set(name, 0);
    getters.set(name, getter);
    return getter;
  };
  const stats = new Proxy({}, {
    get(_target, property: string | symbol) {
      if (property === "toJSON") return () => ({ secret: "TOPSECRET" });
      if (typeof property !== "string") return undefined;
      return counted(`stats.${property}`, 0, "Bearer TOPSECRET")();
    },
    ownKeys() { throw new Error("stats must not be enumerated"); },
  });
  const coverage = new Proxy({}, {
    get(_target, property: string | symbol) {
      if (typeof property !== "string") return undefined;
      const values: Record<string, unknown> = {
        version: 1, scanned: 2, skipped: 0, truncated: 0,
        bytesScanned: 10, bytesTotal: 10, complete: true, reason: undefined,
      };
      if (!(property in values)) throw new Error(`unexpected coverage getter: ${property}`);
      return counted(`coverage.${property}`, values[property], "Bearer TOPSECRET")();
    },
    ownKeys() { throw new Error("coverage must not be enumerated"); },
  });
  const memory = {
    ...createMemoryQueries(() => []),
    stats: () => stats as never,
    coverage: () => coverage as never,
  };
  const result = await createToolRegistry({
    exposure: "sanitized", memory, recallWithAi: disabledRecallWithAi,
  }).call("stats", {}, new AbortController().signal);
  assert.equal(result.structuredContent.failures, 0);
  assert.equal(result.structuredContent.total, 0);
  assert.deepEqual(result.structuredContent.memoryCoverage, {
    version: 1, scanned: 2, skipped: 0, truncated: 0,
    bytesScanned: 10, bytesTotal: 10, complete: true,
  });
  assert.equal(result.structuredContent.memoryCoverageIncomplete, false);
  assert.doesNotMatch(JSON.stringify(result), /TOPSECRET|Bearer|secret/u);
  for (const field of ["failures", "fixEvents", "resolved", "unresolved", "confirmedFixes", "possibleFixes", "triples", "notes", "total"]) {
    assert.equal(reads.get(`stats.${field}`), 1, `stats.${field} getter count`);
  }
  for (const field of ["version", "scanned", "skipped", "truncated", "bytesScanned", "bytesTotal", "complete", "reason"]) {
    assert.equal(reads.get(`coverage.${field}`), 1, `coverage.${field} getter count`);
  }

  const malformedValues: unknown[] = [[], "scalar", 42, null, undefined, new Proxy({}, {
    get() { throw new Error("stats getter failed"); },
    ownKeys() { throw new Error("must not enumerate throwing stats"); },
  })];
  for (const malformed of malformedValues) {
    const malformedResult = await createToolRegistry({
      exposure: "sanitized",
      memory: { ...createMemoryQueries(() => []), stats: () => malformed as never },
      recallWithAi: disabledRecallWithAi,
    }).call("stats", {}, new AbortController().signal);
    assert.equal(malformedResult.structuredContent.failures, 0);
    assert.equal(malformedResult.structuredContent.total, 0);
    assert.equal(malformedResult.structuredContent.memoryCoverageIncomplete, true);
    assert.equal((malformedResult.structuredContent.memoryCoverage as { complete: boolean }).complete, false);
  }
  let coveragePropertyReads = 0;
  const changingCoverage = {
    ...createMemoryQueries(() => []),
    stats: () => ({ failures: Number.NaN }) as never,
    get coverage() {
      coveragePropertyReads += 1;
      return coveragePropertyReads === 1 ? undefined : (() => ({ secret: "COVERAGE-TOPSECRET" })) as never;
    },
  };
  const changingCoverageResult = await createToolRegistry({
    exposure: "sanitized", memory: changingCoverage, recallWithAi: disabledRecallWithAi,
  }).call("stats", {}, new AbortController().signal);
  assert.equal(coveragePropertyReads, 1);
  assert.equal((changingCoverageResult.structuredContent.memoryCoverage as { complete: boolean }).complete, false);
  assert.doesNotMatch(JSON.stringify(changingCoverageResult), /COVERAGE-TOPSECRET|secret/u);
});

test("present malformed custom stats counters force unknown coverage", async () => {
  const complete = Object.freeze({
    version: 1 as const, scanned: 1, skipped: 0, truncated: 0,
    bytesScanned: 10, bytesTotal: 10, complete: true as const,
  });
  const fields = ["failures", "fixEvents", "resolved", "unresolved", "confirmedFixes", "possibleFixes", "triples", "notes", "total"] as const;
  for (const field of fields) {
    const stats = {
      failures: 0, fixEvents: 0, resolved: 0, unresolved: 0, confirmedFixes: 0,
      possibleFixes: 0, triples: 0, notes: 0, total: 0,
      [field]: field === "total" ? "Bearer STATS-TOPSECRET" : Number.NaN,
    };
    const result = await createToolRegistry({
      exposure: "sanitized",
      memory: { ...createMemoryQueries(() => []), stats: () => stats as never, coverage: () => complete },
      recallWithAi: disabledRecallWithAi,
    }).call("stats", {}, new AbortController().signal);
    assert.equal(result.structuredContent.failures, 0);
    assert.equal(result.structuredContent.total, 0);
    assert.equal(result.structuredContent.memoryCoverageIncomplete, true, field);
    assert.equal((result.structuredContent.memoryCoverage as { complete: boolean }).complete, false, field);
    assert.doesNotMatch(JSON.stringify(result), /STATS-TOPSECRET|NaN/u);
  }
  const legacy = await createToolRegistry({
    exposure: "sanitized",
    memory: {
      ...createMemoryQueries(() => []),
      stats: () => ({ failures: 1, fixEvents: 0, resolved: 0, unresolved: 1 }),
    },
    recallWithAi: disabledRecallWithAi,
  }).call("stats", {}, new AbortController().signal);
  assert.equal(legacy.structuredContent.failures, 1);
  assert.equal(legacy.structuredContent.confirmedFixes, 0);
  assert.equal(legacy.structuredContent.total, 1);
});

test("oversized custom rationale tags fail why coverage closed", async () => {
  const known = completeWhyTriple("oversized-rationale-tags");
  const oversized = { ...known, rationale: { ...known.rationale!, tags: Array.from({ length: 1_000 }, (_, index) => `tag-${index}`) } };
  const result = await createToolRegistry({
    exposure: "sanitized",
    memory: {
      ...createMemoryQueries(() => []),
      whyFileEvidence: () => ({
        matches: [oversized], possible: [],
        coverage: { status: "complete" as const, complete: true, filesCovered: 1, truncatedFiles: 0 },
        coverageIncomplete: false,
      }),
    },
    recallWithAi: disabledRecallWithAi,
    cards: emptyCards,
  }).call("why_file", { path: "src/known.ts" }, new AbortController().signal);
  assert.deepEqual(result.structuredContent.items, []);
  assert.equal(result.structuredContent.coverageStatus, "unknown");
  assert.equal(result.structuredContent.coverageIncomplete, true);
});

test("note-only knowledge search stays bounded and sanitized", async () => {
  const note: MemoryRecord = {
    kind: "note", id: "note-search", ts: 304, cwd: "/private", cmd: "rocky note",
    file: "src/app.ts", line: 4, subject: "cache", answer: "banana",
  };
  const result = await createToolRegistry({
    exposure: "sanitized", memory: createMemoryQueries(() => [note]), recallWithAi: disabledRecallWithAi,
  }).call("search_knowledge", { query: "banana", kind: "note" }, new AbortController().signal);
  assert.deepEqual(result.structuredContent.items, [{
    id: "note-search", ts: 304, kind: "note", snippet: "cache: banana", score: 0.5714285714285714,
    source: "note", truncatedFields: [],
  }]);
  assert.equal(result.structuredContent.truncated, false);
});

test("search_knowledge discloses malformed or throwing provider output", async () => {
  const malformed = createToolRegistry({
    exposure: "sanitized",
    memory: { ...createMemoryQueries(() => []), searchKnowledge: () => null as never },
    recallWithAi: disabledRecallWithAi,
  });
  const malformedResult = await malformed.call("search_knowledge", { query: "anything" }, new AbortController().signal);
  assert.deepEqual(malformedResult.structuredContent.items, []);
  assert.equal(malformedResult.structuredContent.truncated, true);

  const throwing = createToolRegistry({
    exposure: "sanitized",
    memory: { ...createMemoryQueries(() => []), searchKnowledge: () => { throw new Error("provider failure"); } },
    recallWithAi: disabledRecallWithAi,
  });
  const throwingResult = await throwing.call("search_knowledge", { query: "anything" }, new AbortController().signal);
  assert.equal(throwingResult.isError, undefined);
  assert.deepEqual(throwingResult.structuredContent.items, []);
  assert.equal(throwingResult.structuredContent.truncated, true);
});

test("search snippets and fetched failures use sanitized explicit projections", async () => {
  const sensitive: MemoryRecord = {
    kind: "failure", id: "opaque-failure", ts: 301, cwd: "/private/project", cmd: "npm test --token=fixture-secret-value-12345678901234567890",
    exitCode: 1, fingerprint: "fp", signature: ["secret fixture"], excerpt: "Bearer fixture-secret-value-12345678901234567890",
  };
  const tools = createToolRegistry({
    exposure: "sanitized",
    memory: createMemoryQueries(() => [sensitive]),
    recallWithAi: disabledRecallWithAi,
  });
  const search = await tools.call("search_knowledge", { query: "token" }, new AbortController().signal);
  assert.equal((search.structuredContent.items as { id: string }[])[0]?.id, sensitive.id);
  assert.doesNotMatch(JSON.stringify(search), /fixture-secret-value|\/private\/project/);
  const fetched = await tools.call("fetch_record", { id: sensitive.id }, new AbortController().signal);
  assert.equal((fetched.structuredContent.record as { id: string }).id, sensitive.id);
  assert.equal("cwd" in (fetched.structuredContent.record as object), false);
  assert.equal("excerpt" in (fetched.structuredContent.record as object), false);
  assert.doesNotMatch(JSON.stringify(fetched), /fixture-secret-value|\/private\/project/);
});

test("sanitized knowledge projections remove C1 terminal strings and invisible format controls", async () => {
  const hostile = [
    "hostile ",
    "\u009b31m",
    "\u009d8;;https://evil.example/title-payload\u009c",
    "\u009d52;c;clipboard-payload\u009c",
    "\u061c\u200b\u200d\u2060\ufeff",
    " text",
  ].join("");
  const hostileTriple: TripleRecord = {
    kind: "triple", id: "hostile-triple", ts: 303, cwd: "/private/project", schemaV: 1,
    agent: "codex", origin: "agent-hook", intent: { text: `${hostile}button` },
    rationale: { text: hostile, tags: [hostile], source: "transcript" },
    mechanism: {
      files: [{ path: "src/hostile.ts", plusMinus: [1, 1], props: [hostile] }],
      truncatedFiles: 0,
    },
  };
  const tools = createToolRegistry({
    exposure: "sanitized",
    memory: createMemoryQueries(() => [hostileTriple]),
    recallWithAi: disabledRecallWithAi,
    cards: emptyCards,
  });
  const signal = new AbortController().signal;
  const search = await tools.call("search_knowledge", { query: "hostile" }, signal);
  const fetched = await tools.call("fetch_record", { id: hostileTriple.id }, signal);
  const why = await tools.call("why_file", { path: "src/hostile.ts" }, signal);
  const serialized = JSON.stringify({ search, fetched, why });

  assert.doesNotMatch(serialized, /[\u0080-\u009f\u061c\u200b-\u200f\u2060-\u206f\ufeff]/u);
  assert.doesNotMatch(serialized, /31m|title-payload|clipboard-payload/);
});

test("unsupported notes are indistinguishable from unknown fetch IDs", async () => {
  const note: MemoryRecord = {
    kind: "note", id: "note-id", ts: 302, cwd: "/private", cmd: "rocky note",
    file: "src/app.ts", line: 1, subject: "subject", answer: "answer",
  };
  const tools = createToolRegistry({
    exposure: "sanitized", memory: createMemoryQueries(() => [note]), recallWithAi: disabledRecallWithAi,
  });
  const unknown = await tools.call("fetch_record", { id: "missing" }, new AbortController().signal);
  const unsupported = await tools.call("fetch_record", { id: "note-id" }, new AbortController().signal);
  assert.equal(unknown.isError, true);
  assert.equal(unsupported.isError, true);
  assert.deepEqual(unsupported.structuredContent, unknown.structuredContent);
  assert.doesNotMatch(JSON.stringify(unsupported), /note-id|subject|answer/);
});

test("oversized single fetch returns a bounded deterministic fallback", async () => {
  const giant = {
    ...triple,
    id: "giant-triple",
    mechanism: {
      files: Array.from({ length: 40 }, () => ({
        path: "p".repeat(16 * 1024), plusMinus: [1, 1] as [number, number],
        props: ["q".repeat(16 * 1024)], excerpt: "e".repeat(16 * 1024),
      })),
      truncatedFiles: 0,
    },
  } satisfies TripleRecord;
  const tools = createToolRegistry({
    exposure: "raw", memory: createMemoryQueries(() => [giant]), recallWithAi: disabledRecallWithAi,
  });
  const result = await tools.call("fetch_record", { id: giant.id }, new AbortController().signal);
  const projected = result.structuredContent.record as { files: unknown[]; truncatedFiles: number; coverageStatus?: string; complete: boolean };
  assert.ok(projected);
  assert.equal(projected.files.length, 1);
  assert.equal(projected.truncatedFiles, 0);
  assert.equal(projected.coverageStatus, "unknown");
  assert.equal(projected.complete, false);
  assert.equal(result.structuredContent.truncated, false);
  assert.equal(result.isError, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= MAX_RESPONSE_BYTES - TOOL_ENVELOPE_RESERVE_BYTES);
});

test("fetch unknown and unsupported IDs return the same safe not-found error", async () => {
  const signal = new AbortController().signal;
  const unknown = await knowledgeRegistry().call("fetch_record", { id: "hostile-id-\u001b[31msecret" }, signal);
  assert.equal(unknown.isError, true);
  assert.deepEqual(unknown.structuredContent, { error: { code: "not_found", message: "record not found" } });
  assert.doesNotMatch(JSON.stringify(unknown), /hostile-id|secret/);
});

test("fetch not-found answers disclose incomplete canonical memory coverage", async () => {
  const coverage = {
    version: 1 as const,
    scanned: 50_000,
    skipped: 2,
    truncated: 1,
    bytesScanned: 64 * 1024 * 1024,
    bytesTotal: 70 * 1024 * 1024,
    complete: false,
    reason: "file-size-cap" as const,
  };
  const memory = {
    recall() { return []; },
    recentFailures() { return []; },
    stats() { return { failures: 0, fixEvents: 0, resolved: 0, unresolved: 0 }; },
    searchKnowledge() { return []; },
    fetchRecord() { return undefined; },
    whyFile() { return []; },
    coverage() { return coverage; },
  };
  const result = await createToolRegistry({
    exposure: "sanitized", memory, recallWithAi: disabledRecallWithAi,
  }).call("fetch_record", { id: "missing" }, new AbortController().signal);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.memoryCoverageIncomplete, true);
  assert.deepEqual(result.structuredContent.memoryCoverage, coverage);
  assert.equal(result.structuredContent.memoryVersion, 1);
});

test("knowledge tool validators reject malformed, out-of-range, and unknown arguments", async () => {
  const signal = new AbortController().signal;
  const invalid = [
    ["search_knowledge", { query: "" }],
    ["search_knowledge", { query: "x", limit: 21 }],
    ["fetch_record", {}],
    ["fetch_record", { id: 1 }],
    ["why_file", {}],
    ["why_file", { path: "x", limit: 11 }],
    ["why_file", { path: "x".repeat(MAX_FIELD_BYTES + 1) }],
    ["teach_lookup", {}],
    ["teach_lookup", { path: "x", line: 0 }],
    ["teach_lookup", { path: "x", line: 1.5 }],
    ["teach_lookup", { path: "x", snippet: 1 }],
    ["teach_lookup", { path: "x".repeat(MAX_FIELD_BYTES + 1) }],
    ["teach_lookup", { path: "x", snippet: "y".repeat(MAX_FIELD_BYTES + 1) }],
    ["teach_lookup", { path: "x", extra: true }],
  ] as const;
  for (const [name, args] of invalid) await assert.rejects(knowledgeRegistry().call(name, args, signal), McpInvalidParamsError);
});

test("raw runtime accepts cwd while sanitized runtime does not", async () => {
  const result = await registry("raw").call("recall", { query: "missing", cwd: "/private/a" }, new AbortController().signal);
  assert.equal((result.structuredContent.items as { cwd?: string }[])[0].cwd, "/private/a");
  await assert.rejects(
    registry("raw").call("stats", { cwd: 1 }, new AbortController().signal),
    McpInvalidParamsError,
  );
});

test("catalog schemas match runtime required query and numeric bounds", () => {
  const definitions = registry().list();
  const recall = definitions[0].inputSchema;
  const recent = definitions[1].inputSchema;
  const ai = definitions[3].inputSchema;
  assert.deepEqual(recall, {
    type: "object", additionalProperties: false, required: ["query"], properties: {
      query: { type: "string", minLength: 1, maxLength: 500 },
      limit: { type: "integer", minimum: 1, maximum: 10 },
    },
  });
  assert.deepEqual(recent, {
    type: "object", additionalProperties: false, properties: {
      limit: { type: "integer", minimum: 1, maximum: 50 },
      unresolvedOnly: { type: "boolean" },
    },
  });
  assert.deepEqual(ai, recall);
});

test("sanitized calls reject cwd as an unknown argument", async () => {
  await assert.rejects(
    registry().call("recall", { query: "missing", cwd: "/private" }, new AbortController().signal),
    McpInvalidParamsError,
  );
});

test("manual validators reject malformed and unknown arguments before queries", async () => {
  const invalid = [
    ["recall", { query: "" }],
    ["recall", { query: "x".repeat(501) }],
    ["recall", { query: "missing", limit: 0 }],
    ["recall", { query: "missing", limit: 11 }],
    ["recall", { query: "missing", limit: 1.5 }],
    ["recall", { query: 1 }],
    ["recent_failures", { limit: 0 }],
    ["recent_failures", { limit: 51 }],
    ["recent_failures", { limit: 1.5 }],
    ["recent_failures", { limit: "1" }],
    ["stats", { extra: true }],
    ["recall_with_ai", { query: "missing", extra: true }],
  ] as const;
  for (const [name, args] of invalid) {
    await assert.rejects(registry().call(name, args, new AbortController().signal), McpInvalidParamsError);
  }
  await assert.rejects(registry().call("unknown", {}, new AbortController().signal), McpInvalidParamsError);
});

test("query bounds count Unicode code points rather than UTF-16 code units", async () => {
  const result = await registry().call("recall", { query: "🙂".repeat(500) }, new AbortController().signal);
  assert.equal((result.structuredContent.items as unknown[]).length, 0);
});

test("recall_with_ai degrades to deterministic disabled result", async () => {
  const result = await registry().call("recall_with_ai", { query: "missing" }, new AbortController().signal);
  assert.equal(result.structuredContent.aiStatus, "disabled");
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
});

test("recall_with_ai returns no_hits when deterministic recall is empty", async () => {
  const result = await registry().call("recall_with_ai", { query: "not-present" }, new AbortController().signal);
  assert.equal(result.structuredContent.aiStatus, "no_hits");
});

test("recall_with_ai keeps deterministic evidence and paired coverage when AI fails", async () => {
  const base = createMemoryQueries(() => records);
  const paired = Object.freeze({
    version: 1 as const, scanned: records.length, skipped: 0, truncated: 0,
    bytesScanned: 10, bytesTotal: 10, complete: true as const,
  });
  const brokenAi: RecallWithAiPort = {
    async run() { throw new Error("plain provider failure"); },
  };
  const result = await createToolRegistry({
    exposure: "sanitized",
    memory: { ...base, coverage: () => paired },
    recallWithAi: brokenAi,
  }).call("recall_with_ai", { query: "missing module" }, new AbortController().signal);
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.aiStatus, "unavailable");
  assert.deepEqual(result.structuredContent.rankedCandidateIds, ["c1"]);
  assert.equal((result.structuredContent.items as unknown[]).length, 1);
  assert.deepEqual(result.structuredContent.coverage, paired);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
});

test("recall_with_ai treats malformed custom outcomes as bounded deterministic evidence", async () => {
  const malformed = {
    async run() { return undefined as never; },
  } as unknown as RecallWithAiPort;
  const result = await createToolRegistry({
    exposure: "sanitized", memory: createMemoryQueries(() => records), recallWithAi: malformed,
  }).call("recall_with_ai", { query: "missing module" }, new AbortController().signal);
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.aiStatus, "invalid_output");
  assert.deepEqual(result.structuredContent.rankedCandidateIds, ["c1"]);
  assert.equal((result.structuredContent.items as unknown[]).length, 1);
});

test("recall_with_ai allowlists custom outcome fields", async () => {
  const outcome = {
    aiStatus: "disabled", rankedCandidateIds: ["c1"], secret: "provider-only",
  } as unknown as Awaited<ReturnType<RecallWithAiPort["run"]>>;
  const result = await createToolRegistry({
    exposure: "sanitized", memory: createMemoryQueries(() => records),
    recallWithAi: { async run() { return outcome; } },
  }).call("recall_with_ai", { query: "missing module" }, new AbortController().signal);
  assert.equal(result.structuredContent.aiStatus, "disabled");
  assert.doesNotMatch(JSON.stringify(result), /provider-only/);
});

test("recall_with_ai keeps requested hits while limiting AI candidates to five", async () => {
  const manyRecords: MemoryRecord[] = Array.from({ length: 10 }, (_, index) => ({
    kind: "failure" as const, id: `many-${index}`, ts: index, cwd: "/private", cmd: `needle ${index}`,
    exitCode: 1, fingerprint: `many-fp-${index}`, signature: ["needle"], excerpt: "needle",
  }));
  const observed: number[] = [];
  const ai: RecallWithAiPort = {
    async run(input) {
      observed.push(input.hits.length);
      return { aiStatus: "disabled", rankedCandidateIds: input.hits.map((_, index) => `c${index + 1}`) };
    },
  };
  const many = createToolRegistry({ exposure: "sanitized", memory: createMemoryQueries(() => manyRecords), recallWithAi: ai });
  for (const limit of [6, 10]) {
    const result = await many.call("recall_with_ai", { query: "needle", limit }, new AbortController().signal);
    assert.equal((result.structuredContent.items as unknown[]).length, limit);
    assert.deepEqual(result.structuredContent.rankedCandidateIds, Array.from({ length: limit }, (_, index) => `c${index + 1}`));
  }
  assert.deepEqual(observed, [5, 5]);
});

test("recall_with_ai rejects evidence for a deterministic item not handed to AI", async () => {
  const sixRecords: MemoryRecord[] = Array.from({ length: 6 }, (_, index) => ({
    kind: "failure" as const, id: `evidence-${index}`, ts: index + 1, cwd: "/repo",
    cmd: `needle ${index}`, exitCode: 1, fingerprint: `evidence-fp-${index}`,
    signature: ["needle"], excerpt: "needle",
  }));
  const result = await createToolRegistry({
    exposure: "sanitized",
    memory: createMemoryQueries(() => sixRecords),
    recallWithAi: {
      async run() {
        return {
          aiStatus: "used" as const,
          rankedCandidateIds: ["c1"],
          evidenceRefs: ["c6.failure"],
          act: "unresolved" as const,
          confidence: 0.9,
          explanation: "must be discarded",
        };
      },
    },
  }).call("recall_with_ai", { query: "needle", limit: 6 }, new AbortController().signal);

  assert.equal(result.structuredContent.aiStatus, "invalid_output");
  assert.deepEqual(result.structuredContent.rankedCandidateIds, ["c1", "c2", "c3", "c4", "c5", "c6"]);
  assert.equal("evidenceRefs" in result.structuredContent, false);
});

test("recall_with_ai receives only a validated deterministic candidate prefix", async () => {
  const makeFailure = (id: string, ts: number): FailureRecord => ({
    kind: "failure", id, ts, cwd: "/repo", cmd: `needle ${id}`, exitCode: 1,
    fingerprint: `fp-${id}`, signature: ["needle"], excerpt: "needle", origin: "run",
  });
  const valid = Array.from({ length: 5 }, (_, index) => makeFailure(`ai-valid-${index}`, 10 + index));
  const future = makeFailure("ai-future", Date.now() + 60_000);
  const hostileFailure = new Proxy(makeFailure("ai-hostile", 20), {
    get(target, property, receiver) {
      if (property === "id") return "Bearer AI-TOPSECRET\u001b[31m";
      return Reflect.get(target, property, receiver);
    },
  });
  const hostile = { failure: hostileFailure, score: 1 } as unknown as ReturnType<MemoryQueries["recall"]>[number];
  const observed: string[][] = [];
  const ai: RecallWithAiPort = {
    async run(input) {
      observed.push(input.hits.map((hit) => hit.failure.id));
      assert.doesNotMatch(JSON.stringify(input.hits), /AI-TOPSECRET|Bearer|\u001b/u);
      return { aiStatus: "disabled", rankedCandidateIds: input.hits.map((_, index) => `c${index + 1}`) };
    },
  };
  const validFirst = createToolRegistry({
    exposure: "sanitized",
    memory: { ...createMemoryQueries(() => []), recall: () => [...valid.map((failure) => ({ failure, score: 1 })), { failure: future, score: 1 }, hostile] },
    recallWithAi: ai,
  });
  const firstResult = await validFirst.call("recall_with_ai", { query: "needle", limit: 10 }, new AbortController().signal);
  assert.deepEqual(observed[0], valid.map((failure) => failure.id));
  assert.deepEqual((firstResult.structuredContent.items as Array<{ candidateId: string }>).map((item) => item.candidateId), ["c1", "c2", "c3", "c4", "c5"]);

  const invalidFirst = createToolRegistry({
    exposure: "sanitized",
    memory: { ...createMemoryQueries(() => []), recall: () => [{ failure: future, score: 1 }, hostile, ...valid.map((failure) => ({ failure, score: 1 }))] },
    recallWithAi: ai,
  });
  const secondResult = await invalidFirst.call("recall_with_ai", { query: "needle", limit: 10 }, new AbortController().signal);
  assert.equal(observed.length, 1, "no model call when no validated prefix survives");
  assert.deepEqual((secondResult.structuredContent.items as Array<{ candidateId: string }>).map((item) => item.candidateId), ["c3", "c4", "c5", "c6", "c7"]);
  assert.deepEqual(secondResult.structuredContent.rankedCandidateIds, ["c3", "c4", "c5", "c6", "c7"]);
});

test("AI refs only name candidates retained by projection and response capping", async () => {
  const field = "x".repeat(16 * 1024);
  const projectionLimited: MemoryRecord[] = Array.from({ length: 5 }, (_, index) => ({
    kind: "failure" as const, id: `projection-${index}`, ts: index, cwd: field, cmd: `needle ${field}`,
    exitCode: 1, fingerprint: `projection-fp-${index}`, signature: [field], excerpt: field,
  }));
  const ai: RecallWithAiPort = {
    async run() {
      return { aiStatus: "disabled", rankedCandidateIds: ["c1", "c5"], evidenceRefs: ["c1.failure", "c5.fix"] };
    },
  };
  const result = await createToolRegistry({
    exposure: "raw", memory: createMemoryQueries(() => projectionLimited), recallWithAi: ai,
  }).call("recall_with_ai", { query: "needle", limit: 5 }, new AbortController().signal);
  const ids = new Set((result.structuredContent.items as { candidateId: string }[]).map((item) => item.candidateId));
  const refs = result.structuredContent.evidenceRefs as string[];
  assert.deepEqual(refs, ["c1.failure"]);
  assert.ok(refs.every((ref) => ids.has(ref.split(".")[0])));
  assert.equal(JSON.stringify(result).includes("c5"), false);
});

test("recall_with_ai preflights final envelope before sending large candidates", async () => {
  const field = "x".repeat(9_000);
  const largeRecords: FailureRecord[] = Array.from({ length: 5 }, (_, index) => ({
    kind: "failure", id: `ai-envelope-${index}`, ts: index + 1, cwd: "/repo", cmd: `needle ${field}`,
    exitCode: 1, fingerprint: `ai-envelope-fp-${index}`, signature: [field], excerpt: field, origin: "run",
  }));
  let observed: string[] = [];
  const ai: RecallWithAiPort = {
    async run(input) {
      observed = input.hits.map((hit) => hit.failure.id);
      return {
        aiStatus: "used", act: "unresolved", confidence: 2.2250738585072014e-308,
        explanation: "🙂".repeat(300),
        rankedCandidateIds: input.hits.map((_, index) => `c${index + 1}`),
      };
    },
  };
  const result = await createToolRegistry({
    exposure: "raw", memory: createMemoryQueries(() => largeRecords), recallWithAi: ai,
  }).call("recall_with_ai", { query: "needle", limit: 5 }, new AbortController().signal);
  const finalIds = (result.structuredContent.items as Array<{ rawRecord?: { failure?: { id?: string } } }>).map(
    (item) => item.rawRecord?.failure?.id ?? "",
  );
  assert.ok(observed.length < 5, `model received ${observed.length} candidates`);
  assert.ok(observed.every((id) => finalIds.includes(id)), `model candidates missing from final output: ${observed.join(",")}`);
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= MAX_RESPONSE_BYTES - TOOL_ENVELOPE_RESERVE_BYTES);
});

test("recall_with_ai snapshots hostile outcome metadata before final capping", async () => {
  const field = "x".repeat(9_000);
  const largeRecords: FailureRecord[] = Array.from({ length: 5 }, (_, index) => ({
    kind: "failure", id: `ai-snapshot-${index}`, ts: index + 1, cwd: "/repo", cmd: `needle ${field}`,
    exitCode: 1, fingerprint: `ai-snapshot-fp-${index}`, signature: [field], excerpt: field, origin: "run",
  }));
  let explanationReads = 0;
  const outcome = new Proxy({
    aiStatus: "used", act: "unresolved", confidence: 2.2250738585072014e-308,
    rankedCandidateIds: ["c1", "c2", "c3", "c4", "c5"],
    explanation: "🙂".repeat(300),
  }, {
    get(target, property, receiver) {
      if (property === "explanation") {
        explanationReads += 1;
        return explanationReads === 1 ? target.explanation : "Bearer AI-OUTCOME-TOPSECRET".repeat(100_000);
      }
      return Reflect.get(target, property, receiver);
    },
    ownKeys() { throw new Error("AI outcome must not be enumerated"); },
  });
  const result = await createToolRegistry({
    exposure: "raw", memory: createMemoryQueries(() => largeRecords),
    recallWithAi: { async run() { return outcome as never; } },
  }).call("recall_with_ai", { query: "needle", limit: 5 }, new AbortController().signal);
  assert.equal(explanationReads, 1);
  assert.doesNotMatch(JSON.stringify(result), /AI-OUTCOME-TOPSECRET|Bearer/u);
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= MAX_RESPONSE_BYTES - TOOL_ENVELOPE_RESERVE_BYTES);
});

test("complete tool result cap removes whole trailing items and fits modern and legacy wire envelopes", async () => {
  const field = "x".repeat(10 * 1024);
  const largeRecords: MemoryRecord[] = Array.from({ length: 10 }, (_, index) => ({
    kind: "failure" as const, id: `large-${index}`, ts: index, cwd: field, cmd: `needle ${field}`,
    exitCode: 1, fingerprint: `large-fp-${index}`, signature: [field], excerpt: field,
  }));
  const result = await createToolRegistry({
    exposure: "raw", memory: createMemoryQueries(() => largeRecords), recallWithAi: disabledRecallWithAi,
  }).call("recall_with_ai", { query: "needle", limit: 10 }, new AbortController().signal);
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= MAX_RESPONSE_BYTES - TOOL_ENVELOPE_RESERVE_BYTES);
  assert.equal(result.structuredContent.truncated, true);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  const candidateIds = result.structuredContent.rankedCandidateIds as string[];
  const itemIds = (result.structuredContent.items as { candidateId: string }[]).map((item) => item.candidateId);
  assert.deepEqual(candidateIds, itemIds);
  const modern = {
    jsonrpc: "2.0", id: "modern", result,
    resultType: "complete",
    _meta: {
      protocolVersion: "2026-07-28",
      "io.modelcontextprotocol/serverInfo": { name: "rocky", version: "0.2.1" },
    },
  };
  const legacy = { jsonrpc: "2.0", id: 1, result };
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") > 480 * 1024);
  assert.ok(Buffer.byteLength(`${JSON.stringify(modern)}\n`, "utf8") <= MAX_RESPONSE_BYTES);
  assert.ok(Buffer.byteLength(`${JSON.stringify(legacy)}\n`, "utf8") <= MAX_RESPONSE_BYTES);
});

test("explicit operational failures become safe error results", async () => {
  const broken = createToolRegistry({
    exposure: "sanitized",
    memory: createMemoryQueries(() => { throw new ToolExecutionError("memory_unavailable", "memory unavailable"); }),
    recallWithAi: disabledRecallWithAi,
  });
  const result = await broken.call("recall", { query: "missing" }, new AbortController().signal);
  assert.equal(result.isError, true);
  assert.doesNotMatch(JSON.stringify(result), /private|config/);
});

test("recognized storage failures are wrapped at the storage boundary", async () => {
  const storageError = Object.assign(new Error("/private/config.json"), { code: "EACCES" });
  const broken = createToolRegistry({
    exposure: "sanitized",
    memory: createMemoryQueries(() => { throw storageError; }),
    recallWithAi: disabledRecallWithAi,
  });
  const result = await broken.call("recall", { query: "missing" }, new AbortController().signal);
  assert.equal(result.isError, true);
  assert.equal((result.structuredContent.error as { code: string }).code, "memory_unavailable");
  assert.doesNotMatch(JSON.stringify(result), /private|config/);
});

test("custom provider cannot forge canonical operational error codes", async () => {
  const broken = createToolRegistry({
    exposure: "sanitized",
    memory: {
      recall() { throw Object.assign(new Error("forged EACCES"), { code: "EACCES" }); },
      recentFailures() { return []; },
      stats() { return { failures: 0, fixEvents: 0, resolved: 0, unresolved: 0 }; },
      searchKnowledge() { return []; }, fetchRecord() { return undefined; }, whyFile() { return []; },
    },
    recallWithAi: disabledRecallWithAi,
  });
  const result = await broken.call("recall", { query: "missing" }, new AbortController().signal);
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent.items, []);
  assert.doesNotMatch(JSON.stringify(result), /forged|EACCES/);
});

test("unexpected provider errors fail open to a bounded recall result", async () => {
  const broken = createToolRegistry({
    exposure: "sanitized",
    memory: {
      recall() { throw new Error("invariant violated"); }, recentFailures() { return []; },
      stats() { return { failures: 0, fixEvents: 0, resolved: 0, unresolved: 0 }; },
      searchKnowledge() { return []; }, fetchRecord() { return undefined; }, whyFile() { return []; },
    },
    recallWithAi: disabledRecallWithAi,
  });
  const result = await broken.call("recall", { query: "missing" }, new AbortController().signal);
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent.items, []);
  assert.doesNotMatch(JSON.stringify(result), /invariant violated/);
});

test("unrecognized provider codes fail open without leaking details", async () => {
  for (const error of [
    Object.assign(new Error("coded invariant"), { code: "BUG" }),
    { code: "BUG", message: "plain coded invariant" },
  ]) {
    const broken = createToolRegistry({
      exposure: "sanitized",
      memory: {
        recall() { throw error; }, recentFailures() { return []; },
        stats() { return { failures: 0, fixEvents: 0, resolved: 0, unresolved: 0 }; },
        searchKnowledge() { return []; }, fetchRecord() { return undefined; }, whyFile() { return []; },
      },
      recallWithAi: disabledRecallWithAi,
    });
    const result = await broken.call("recall", { query: "missing" }, new AbortController().signal);
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent.items, []);
    assert.doesNotMatch(JSON.stringify(result), /coded invariant|BUG/);
  }
});

test("recall_with_ai skips model output when deterministic recall is empty", async () => {
  let calls = 0;
  const ai: RecallWithAiPort = {
    async run() { calls += 1; return { aiStatus: "disabled", rankedCandidateIds: [], explanation: "x".repeat(MAX_RESPONSE_BYTES) }; },
  };
  const result = await createToolRegistry({ exposure: "sanitized", memory: createMemoryQueries(() => records), recallWithAi: ai })
    .call("recall_with_ai", { query: "not-present" }, new AbortController().signal);
  assert.equal(result.isError, undefined);
  assert.equal(calls, 0);
  assert.equal(result.structuredContent.aiStatus, "no_hits");
  assert.equal(result.structuredContent.truncated, false);
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= MAX_RESPONSE_BYTES);
});

// why_file also answers with the reasons a human (`why --add --files`) or the
// notify lane (`agent-event --files`) stated for the file: the same ones
// `rocky why <file>` speaks. Those records reach the server only through the
// durable reader's snapshot, so these tests read a real memory.jsonl under a
// throwaway ROCKY_HOME.

interface WhyReason { source: string; agent: string; ts: number; text: string; files: string[] }

/** Run `use` against a durable `createMemoryQueries()` whose memory.jsonl holds exactly `lines`. */
async function withDurableMemory<T>(lines: readonly string[], use: (memory: MemoryQueries) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "rocky-mcp-why-reasons-"));
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  try {
    writeFileSync(resolveRockyPaths({ ROCKY_HOME: home }).memory, lines.map((line) => `${line}\n`).join(""), "utf8");
    return await use(createMemoryQueries());
  } finally {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

/** A stated reason as the writers store it, anchored to this process's cwd, which is where the server resolves paths. */
function statedReason(
  id: string,
  ts: number,
  excerpt: string,
  files?: readonly string[],
  overrides: Partial<RationaleRecord> = {},
): RationaleRecord {
  return {
    kind: "rationale", id, ts, v: 1, cwd: process.cwd(),
    agent: "human", rationale_fidelity: "summary", source: "human", excerpt,
    ...(files === undefined ? {} : { files: [...files] }),
    ...overrides,
  };
}

async function whyFromDurable(
  lines: readonly string[],
  args: Record<string, unknown>,
  exposure: "sanitized" | "raw" = "sanitized",
): Promise<Record<string, unknown>> {
  return withDurableMemory(lines, async (memory) => {
    const result = await createToolRegistry({ exposure, memory, recallWithAi: disabledRecallWithAi })
      .call("why_file", args, new AbortController().signal);
    assert.equal(result.isError, undefined);
    return result.structuredContent;
  });
}

test("why_file returns the reason a human stated for the file and keeps every existing key", async () => {
  const reason = statedReason("human-1", Date.now() - 1_000, "keep the retry cap at three because the upstream rate-limits", ["src/a.ts"]);

  const content = await whyFromDurable([JSON.stringify(reason)], { path: "src/a.ts" });

  const rationales = content.rationales as WhyReason[];
  assert.equal(rationales.length, 1);
  assert.ok(rationales[0]?.text.includes("keep the retry cap at three"));
  assert.deepEqual(rationales[0], { source: "human", agent: "human", ts: reason.ts, text: reason.excerpt, files: ["src/a.ts"] });
  for (const key of [
    "exposure", "items", "possible", "coverage", "coverageStatus", "coverageIncomplete", "truncated",
    "memoryCoverage", "memoryCoverageIncomplete", "memoryVersion",
  ]) assert.ok(key in content, `why_file must keep ${key}`);
  assert.equal(content.truncated, false);
});

test("why_file keeps only human and notify reasons that name the file, newest first, within limit", async () => {
  const now = Date.now();
  const lines = [
    statedReason("older-notify", now - 3_000, "agent says parsing moved out of the hook", ["src/a.ts"], { source: "notify", agent: "claude-code" }),
    statedReason("newest-human", now - 1_000, "human says parsing stays out of the hook", ["src/b.ts", "src/a.ts"]),
    statedReason("agent-log", now - 500, "log recorded a change to a.ts", ["src/a.ts"], { source: "log-thinking", agent: "claude-code", rationale_fidelity: "raw" }),
    statedReason("other-file", now - 400, "this reason is about b only", ["src/b.ts"]),
    statedReason("unscoped", now - 300, "this reason names no file"),
  ].map((record) => JSON.stringify(record));

  const all = (await whyFromDurable(lines, { path: "src/a.ts" })).rationales as WhyReason[];
  assert.deepEqual(all.map((reason) => [reason.source, reason.agent, reason.text]), [
    ["human", "human", "human says parsing stays out of the hook"],
    ["notify", "claude-code", "agent says parsing moved out of the hook"],
  ]);
  assert.deepEqual(all[0]?.files, ["src/b.ts", "src/a.ts"]);

  const newest = (await whyFromDurable(lines, { path: "src/a.ts", limit: 1 })).rationales as WhyReason[];
  assert.deepEqual(newest.map((reason) => reason.text), ["human says parsing stays out of the hook"]);
});

test("why_file projects stated reasons at the exposure search_knowledge applies to rationale records", async () => {
  const secret = "sk-LIVEKEY0123456789ABCDEFGHIJKLMNO";
  const reason = statedReason(
    "leaky", Date.now() - 1_000,
    `rotate the key with token=${secret} then redeploy from /home/zed/app`,
    ["src/a.ts", "/home/zed/app/src/a.ts"],
  );
  for (const exposure of ["sanitized", "raw"] as const) {
    const { why, search } = await withDurableMemory([JSON.stringify(reason)], async (memory) => {
      const registry = createToolRegistry({ exposure, memory, recallWithAi: disabledRecallWithAi });
      const signal = new AbortController().signal;
      return {
        why: (await registry.call("why_file", { path: "src/a.ts" }, signal)).structuredContent,
        search: (await registry.call("search_knowledge", { query: "rotate redeploy", kind: "rationale" }, signal)).structuredContent,
      };
    });
    const [shown] = why.rationales as WhyReason[];
    const [found] = search.items as Array<{ filesCovered: string[] }>;
    assert.ok(shown !== undefined && found !== undefined, `${exposure}: both tools must find the reason`);
    // Whatever search_knowledge shows of the named files, why_file shows the same, and no more.
    assert.deepEqual(shown.files, found.filesCovered, `${exposure}: files`);
    if (exposure === "sanitized") {
      assert.doesNotMatch(JSON.stringify(why), /sk-LIVEKEY|\/home\/zed/u);
      assert.doesNotMatch(JSON.stringify(search), /sk-LIVEKEY|\/home\/zed/u);
      assert.match(shown.text, /redeploy from \[redacted\]$/u);
    } else {
      assert.equal(shown.text, reason.excerpt);
      assert.deepEqual(shown.files, ["src/a.ts", "/home/zed/app/src/a.ts"]);
    }
  }
});

test("why_file spells the files a reason names the way search_knowledge does: canonical, once each", async () => {
  // `./src/a.ts` and `src/a.ts` name one file. Left raw, the first reads as an absolute path to the
  // sanitizer and comes back as `.[redacted]`, so the two tools would disagree about the same record.
  const reason = statedReason("spelled", Date.now() - 1_000, "keep the cap at three for the upstream", ["./src/a.ts", "src/a.ts", "src//b.ts"]);
  for (const exposure of ["sanitized", "raw"] as const) {
    const { why, search } = await withDurableMemory([JSON.stringify(reason)], async (memory) => {
      const registry = createToolRegistry({ exposure, memory, recallWithAi: disabledRecallWithAi });
      const signal = new AbortController().signal;
      return {
        why: (await registry.call("why_file", { path: "src/a.ts" }, signal)).structuredContent,
        search: (await registry.call("search_knowledge", { query: "cap upstream", kind: "rationale" }, signal)).structuredContent,
      };
    });
    const [shown] = why.rationales as WhyReason[];
    const [found] = search.items as Array<{ filesCovered: string[] }>;
    assert.ok(shown !== undefined && found !== undefined, `${exposure}: both tools must find the reason`);
    assert.deepEqual(shown.files, ["src/a.ts", "src/b.ts"], `${exposure}: files`);
    assert.deepEqual(shown.files, found.filesCovered, `${exposure}: parity with search_knowledge`);
    assert.doesNotMatch(JSON.stringify(why.rationales), /redacted/u, `${exposure}: a relative name must not be redacted`);
  }
});

test("why_file does not let a returned reason hide an incomplete memory scan", async () => {
  const reason = statedReason("kept", Date.now() - 1_000, "kept despite a damaged neighbour line", ["src/a.ts"]);

  const content = await whyFromDurable([JSON.stringify(reason), "{ this line is not a record"], { path: "src/a.ts" });

  assert.equal((content.rationales as WhyReason[]).length, 1);
  assert.equal(content.memoryCoverageIncomplete, true);
  assert.ok((content.memoryCoverage as { skipped: number }).skipped >= 1);
  // No triple names the file, so the evidence disclosure must stay exactly as it was.
  assert.equal(content.coverageIncomplete, true);
  assert.notEqual(content.coverageStatus, "complete");
});

test("why_file answers an empty rationales array when no reason names the file or the provider is not the durable reader", async () => {
  const elsewhere = statedReason("elsewhere", Date.now() - 1_000, "this reason is about b only", ["src/b.ts"]);
  assert.deepEqual((await whyFromDurable([JSON.stringify(elsewhere)], { path: "src/a.ts" })).rationales, []);

  const custom = await knowledgeRegistry().call("why_file", { path: "src/app.css" }, new AbortController().signal);
  assert.deepEqual(custom.structuredContent.rationales, []);
});

test("why_file flags a stated reason the projection had to clip", async () => {
  // 16 Ki two-byte characters are a valid record, yet exceed the 16 KiB field cap once projected.
  const long = statedReason("long", Date.now() - 1_000, "é".repeat(16 * 1024), ["src/a.ts"]);

  const content = await whyFromDurable([JSON.stringify(long)], { path: "src/a.ts" });

  const [reason] = content.rationales as WhyReason[];
  assert.ok(reason !== undefined && Buffer.byteLength(reason.text, "utf8") <= MAX_FIELD_BYTES);
  assert.equal(content.truncated, true);
});

interface ProjectedCardBlock {
  seq: number;
  path: string;
  symbol: { kind: string; name: string; container: string | null } | null;
  labels: Array<{ id: string; args: Record<string, unknown> }>;
  importance: string;
  via: "edit" | "bash" | "other";
  line: number | null;
  added: number | null;
  removed: number | null;
  quote: string | null;
  bash_cmd: string | null;
}

interface ProjectedCard {
  card_id: string;
  ended_ms: number | null;
  started_ms: number;
  repo: string;
  prompt: string;
  prompt_kind: { kind: string; name?: string; args?: string };
  agent_type: string;
  blocks: ProjectedCardBlock[];
  more_blocks?: number;
}

function sampleStoredBlock(seq: number, overrides: Partial<StoredBlock> = {}): StoredBlock {
  return {
    seq,
    path: "src/a.ts",
    symbol: { kind: "function", name: `fn${seq}`, container: "Svc", exported: true, nth: 2 },
    labels: [{ id: "symbol_added", args: { kind: "function" } }],
    importance: "medium",
    via: "edit",
    tool_use_ids: ["tu-secret-1"],
    before: "deadbeef".repeat(5),
    after: "cafebabe".repeat(5),
    recorded: true,
    line: 10 + seq,
    added: 3,
    removed: 1,
    quote: { text: `Reason ${seq}`, shared: false },
    bash: null,
    ...overrides,
  };
}

function sampleStoredCard(cardId: string, overrides: Partial<StoredCard> = {}): StoredCard {
  const blocks = overrides.blocks ?? [sampleStoredBlock(1)];
  return {
    v: 1,
    card_id: cardId,
    rev: 1,
    repo_id: "repo-1",
    root: "/tmp/wt-feature",
    main_root: "C:\\Users\\dev\\work\\rocky\\",
    branch: "feat/cards",
    session_id: "sess-1",
    agent_id: "agent-1",
    agent_type: "",
    parent_card_id: null,
    started_ms: 1_700_000_000_000,
    ended_ms: 1_700_000_010_000,
    status: "done",
    prompt: "Tighten validation on the config loader",
    prompt_truncated: false,
    importance: "high",
    blocks,
    more_count: 0,
    flow: [{ kind: "cmd", text: "npm test", ok: true, dur_ms: 100, seqs: [1] }],
    flow_more: 0,
    outside_count: 0,
    coverage: { state: "full", reasons: [] },
    ...overrides,
  };
}

function cardRegistry(
  cards: (path: string, limit: number) => CardsForFile,
  exposure: "sanitized" | "raw" = "sanitized",
  memory: MemoryQueries = createMemoryQueries(() => []),
) {
  return createToolRegistry({
    exposure,
    memory,
    recallWithAi: disabledRecallWithAi,
    cards,
  });
}

test("why_file description notes recorded agent change cards, read-only, with no code", () => {
  const why = registry().list().find((tool) => tool.name === "why_file");
  assert.ok(why !== undefined);
  assert.match(why.description, /recorded agent change cards, read-only, with no code/i);
});

test("why_file returns change cards when present or absent and strips stored code fields", async () => {
  const signal = new AbortController().signal;
  const empty = await cardRegistry(
    () => ({ cards: [], matched: new Map(), coverage: { complete: true, skipped: 0 } }),
  ).call("why_file", { path: "src/a.ts" }, signal);
  assert.equal(empty.isError, undefined);
  assert.deepEqual(empty.structuredContent.cards, []);
  assert.deepEqual(empty.structuredContent.cardsCoverage, { complete: true, skipped: 0 });
  assert.equal(empty.structuredContent.truncated, false);

  const seenCalls: Array<{ path: string; limit: number }> = [];
  const twelveMatching = Array.from({ length: 12 }, (_, idx) => sampleStoredBlock(idx + 1, {
    quote: idx === 0 ? { text: "word ".repeat(140), shared: true } : { text: `q-${idx + 1}`, shared: false },
    ...(idx === 1 ? { via: "bash", bash: { cmd: "git mv old.ts src/a.ts", candidates: 1 }, quote: null } : {}),
  }));
  const unrelatedBlock = sampleStoredBlock(99, { path: "src/other.ts" });
  const cardMain = sampleStoredCard("4e5e1a6d22cea72d7a8b3985c9c27fcf", {
    ended_ms: null,
    prompt: `${"word ".repeat(55)} trailing details`,
    blocks: [...twelveMatching, unrelatedBlock],
  });
  const cardSub = sampleStoredCard("card-sub-2", {
    main_root: null,
    root: "/Users/dev/src/alpha-service/",
    agent_type: "Explore",
    prompt: "<command-name>/review</command-name><command-args>src/a.ts --strict</command-args>",
    blocks: [sampleStoredBlock(1, { symbol: null, labels: [{ id: "file_edited" }], line: null, added: null, removed: null, quote: null })],
  });

  const matched = new Map<string, StoredBlock[]>([
    [cardMain.card_id, twelveMatching],
    [cardSub.card_id, cardSub.blocks],
  ]);
  const res = await cardRegistry((path, limit) => {
    seenCalls.push({ path, limit });
    return {
      cards: [cardMain, cardSub],
      matched,
      coverage: { complete: false, reason: "line-cap", skipped: 2 },
    };
  }).call("why_file", { path: "src/a.ts", limit: 3 }, signal);

  assert.deepEqual(seenCalls, [{ path: "src/a.ts", limit: 3 }]);
  assert.equal(res.isError, undefined);
  assert.deepEqual(res.structuredContent.cardsCoverage, { complete: false, reason: "line-cap", skipped: 2 });
  assert.equal(res.structuredContent.truncated, true);

  const cards = res.structuredContent.cards as ProjectedCard[];
  assert.equal(cards.length, 2);

  const [first, second] = cards;
  assert.ok(first && second);
  assert.equal(first.card_id, cardMain.card_id);
  assert.equal(first.ended_ms, null);
  assert.equal(first.started_ms, cardMain.started_ms);
  assert.equal(first.repo, "rocky");
  assert.equal(first.agent_type, "");
  assert.deepEqual(first.prompt_kind, { kind: "plain" });
  assert.equal(Array.from(first.prompt).length, 200);
  assert.equal(first.blocks.length, 10);
  assert.equal(first.more_blocks, 2);

  const [b0, b1] = first.blocks;
  assert.ok(b0 && b1);
  assert.deepEqual(b0.symbol, { kind: "function", name: "fn1", container: "Svc" });
  assert.equal("exported" in (b0.symbol as object), false);
  assert.equal("nth" in (b0.symbol as object), false);
  assert.equal(b0.via, "edit");
  assert.equal(b0.bash_cmd, null);
  assert.equal(Array.from(b0.quote ?? "").length, 500);
  assert.equal(b1.via, "bash");
  assert.equal(b1.bash_cmd, "git mv old.ts src/a.ts");
  assert.equal(b1.quote, null);

  for (const forbidden of ["before", "after", "tool_use_ids", "flow"]) {
    assert.equal(JSON.stringify(cards).includes(`"${forbidden}"`), false, `must not serialize ${forbidden}`);
  }

  assert.equal(second.repo, "alpha-service");
  assert.equal(second.agent_type, "Explore");
  assert.equal(second.prompt, "/review src/a.ts --strict");
  assert.deepEqual(second.prompt_kind, { kind: "slash_command", name: "/review", args: "src/a.ts --strict" });
  assert.equal(second.more_blocks, undefined);
  assert.equal("more_blocks" in second, false);
  assert.deepEqual(second.blocks[0]?.labels, [{ id: "file_edited", args: {} }]);
  assert.equal(second.blocks[0]?.symbol, null);
  assert.equal(second.blocks[0]?.line, null);
  assert.equal(second.blocks[0]?.added, null);
  assert.equal(second.blocks[0]?.removed, null);

  const rawSlash = await cardRegistry(
    () => ({ cards: [cardSub], matched: new Map([[cardSub.card_id, cardSub.blocks]]), coverage: { complete: true, skipped: 0 } }),
    "raw",
  ).call("why_file", { path: "src/a.ts", limit: 3 }, signal);
  const [rawSecond] = rawSlash.structuredContent.cards as ProjectedCard[];
  assert.equal(rawSecond?.prompt, "/review src/a.ts --strict");
  assert.deepEqual(rawSecond?.prompt_kind, { kind: "slash_command", name: "/review", args: "src/a.ts --strict" });
});

test("why_file passes default limit 5 to cards reader and keeps working with diff enabled", async () => {
  const calls: number[] = [];
  const res = await cardRegistry((_path, limit) => {
    calls.push(limit);
    return {
      cards: [sampleStoredCard("card-diff-1")],
      matched: new Map([["card-diff-1", [sampleStoredBlock(1)]]]),
      coverage: { complete: true, skipped: 0 },
    };
  }).call("why_file", { path: "src/a.ts", diff: true }, new AbortController().signal);
  assert.deepEqual(calls, [5]);
  assert.equal(res.isError, undefined);
  assert.equal((res.structuredContent.cards as ProjectedCard[]).length, 1);
});

test("why_file projects card strings according to exposure (sanitized vs raw)", async () => {
  const secret = "sk-LIVEKEY0123456789ABCDEFGHIJKLMNO";
  const secretCard = sampleStoredCard("card-sec", {
    main_root: null,
    root: `/home/zed/work/repo-${secret}`,
    prompt: `<command-name>/deploy</command-name><command-args>token=${secret}</command-args>`,
    blocks: [
      sampleStoredBlock(1, {
        path: `/home/zed/repo/src/a.ts`,
        symbol: { kind: "function", name: `use_${secret}`, container: `/home/zed` },
        labels: [
          { id: "note", args: { detail: `key=${secret}` } },
          { id: "config_changed", args: { key: `token_${secret}`, before: `old_${secret}`, after: `new_${secret}` } },
        ],
        via: "bash",
        bash: { cmd: `curl -H "Authorization: Bearer ${secret}" https://x.example`, candidates: 1 },
        quote: { text: `rotate ${secret} at /home/zed/app`, shared: true },
      }),
    ],
  });
  const provider = (): CardsForFile => ({
    cards: [secretCard],
    matched: new Map([[secretCard.card_id, secretCard.blocks]]),
    coverage: { complete: true, skipped: 0 },
  });

  const sanitized = (await cardRegistry(provider, "sanitized").call("why_file", { path: "src/a.ts" }, new AbortController().signal)).structuredContent;
  assert.doesNotMatch(JSON.stringify(sanitized.cards), /sk-LIVEKEY|\/home\/zed/u);
  const [sCard] = sanitized.cards as ProjectedCard[];
  assert.ok(sCard?.blocks[0]?.quote?.includes("[redacted]"));
  assert.ok(sCard?.blocks[0]?.bash_cmd?.includes("[redacted]"));
  assert.deepEqual(sCard?.blocks[0]?.labels, [
    { id: "note", args: {} },
    { id: "config_changed", args: { key: "[redacted]" } },
  ]);

  const raw = (await cardRegistry(provider, "raw").call("why_file", { path: "src/a.ts" }, new AbortController().signal)).structuredContent;
  const [rCard] = raw.cards as ProjectedCard[];
  assert.ok(rCard?.blocks[0]?.quote?.includes(secret));
  assert.ok(rCard?.blocks[0]?.bash_cmd?.includes(secret));
  assert.deepEqual(rCard?.blocks[0]?.labels, [
    { id: "note", args: {} },
    { id: "config_changed", args: { key: `token_${secret}` } },
  ]);
});

test("why_file preserves 32-hex card_id and redacts other opaque card_id strings under sanitized exposure", async () => {
  const hex32 = "4e5e1a6d22cea72d7a8b3985c9c27fcf";
  const mixed41 = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ABCDE";
  const upper32 = "4E5E1A6D22CEA72D7A8B3985C9C27FCF";
  const uuid36 = "550e8400-e29b-41d4-a716-446655440000";
  const cards = [
    sampleStoredCard(hex32),
    sampleStoredCard(mixed41),
    sampleStoredCard(upper32),
    sampleStoredCard(uuid36),
  ];
  const provider = (): CardsForFile => ({
    cards,
    matched: new Map(cards.map((card) => [card.card_id, card.blocks])),
    coverage: { complete: true, skipped: 0 },
  });

  const sanitized = (await cardRegistry(provider, "sanitized").call("why_file", { path: "src/a.ts", limit: 10 }, new AbortController().signal)).structuredContent;
  assert.deepEqual((sanitized.cards as ProjectedCard[]).map((c) => c.card_id), [
    hex32,
    "[redacted]",
    "[redacted]",
    "[redacted]",
  ]);

  const raw = (await cardRegistry(provider, "raw").call("why_file", { path: "src/a.ts", limit: 10 }, new AbortController().signal)).structuredContent;
  assert.deepEqual((raw.cards as ProjectedCard[]).map((c) => c.card_id), [
    hex32,
    mixed41,
    upper32,
    uuid36,
  ]);
});

test("why_file sets truncated when card prompt or quote exceeds character limit below 16 KiB", async () => {
  const promptClipped = sampleStoredCard("4e5e1a6d22cea72d7a8b3985c9c27fcf", {
    prompt: `${"w ".repeat(112)}z`,
    blocks: [sampleStoredBlock(1, { quote: { text: "short quote", shared: false } })],
  });
  const promptRes = (await cardRegistry(() => ({
    cards: [promptClipped],
    matched: new Map([[promptClipped.card_id, promptClipped.blocks]]),
    coverage: { complete: true, skipped: 0 },
  })).call("why_file", { path: "src/a.ts" }, new AbortController().signal)).structuredContent;
  assert.equal(Array.from((promptRes.cards as ProjectedCard[])[0]?.prompt ?? "").length, 200);
  assert.equal(promptRes.truncated, true);

  const quoteClipped = sampleStoredCard("97394ac43381e6ac7a3b66cb264cd2b9", {
    prompt: "short prompt",
    blocks: [sampleStoredBlock(1, { quote: { text: `${"w ".repeat(299)}zz`, shared: false } })],
  });
  const quoteRes = (await cardRegistry(() => ({
    cards: [quoteClipped],
    matched: new Map([[quoteClipped.card_id, quoteClipped.blocks]]),
    coverage: { complete: true, skipped: 0 },
  })).call("why_file", { path: "src/a.ts" }, new AbortController().signal)).structuredContent;
  assert.equal(Array.from((quoteRes.cards as ProjectedCard[])[0]?.blocks[0]?.quote ?? "").length, 500);
  assert.equal(quoteRes.truncated, true);

  const exactBounds = sampleStoredCard("085fd43e5e4c84caf8d98e99af9d6ff2", {
    prompt: "🙂".repeat(200),
    blocks: [sampleStoredBlock(1, { quote: { text: "🙂".repeat(500), shared: false } })],
  });
  const exactRes = (await cardRegistry(() => ({
    cards: [exactBounds],
    matched: new Map([[exactBounds.card_id, exactBounds.blocks]]),
    coverage: { complete: true, skipped: 0 },
  })).call("why_file", { path: "src/a.ts" }, new AbortController().signal)).structuredContent;
  assert.equal(Array.from((exactRes.cards as ProjectedCard[])[0]?.prompt ?? "").length, 200);
  assert.equal(Array.from((exactRes.cards as ProjectedCard[])[0]?.blocks[0]?.quote ?? "").length, 500);
  assert.equal(exactRes.truncated, false);
});

test("why_file handles cards reader failure without failing tool or altering existing fields", async () => {
  const reason = statedReason("keep-1", Date.now() - 1_000, "retry limit stays three", ["src/a.ts"]);
  const content = await withDurableMemory([JSON.stringify(reason)], async (memory) => {
    const res = await cardRegistry(() => {
      throw new Error("cards store unreadable");
    }, "sanitized", memory).call("why_file", { path: "src/a.ts" }, new AbortController().signal);
    assert.equal(res.isError, undefined);
    return res.structuredContent;
  });

  assert.deepEqual(content.cards, []);
  assert.deepEqual(content.cardsCoverage, { complete: false, skipped: 0 });
  assert.equal((content.rationales as WhyReason[]).length, 1);
  assert.equal(content.truncated, false);
});

test("why_file drops oldest change cards first when response size cap is exceeded and preserves existing evidence", async () => {
  const existingItem: TripleRecord = {
    ...triple,
    id: "existing-item-1",
    ts: 1_700_000_000_000,
    cwd: "/repo",
    platform: "linux",
    mechanism: {
      files: [{ path: "src/a.ts", plusMinus: [2, 1], props: ["retry-cap"], provenance: "tool-observed" }],
      truncatedFiles: 0,
      baseline: "captured",
      coverageStatus: "complete",
    },
  };
  const memoryWithItem = createMemoryQueries(() => [existingItem]);
  const bigCmd = `node script.mjs ${"arg ".repeat(3_500)}`;
  const cards = Array.from({ length: 10 }, (_, idx) => sampleStoredCard(`card-${idx}`, {
    started_ms: 1_700_000_100_000 - idx * 1_000,
    ended_ms: 1_700_000_110_000 - idx * 1_000,
    blocks: Array.from({ length: 10 }, (__, seq) => sampleStoredBlock(seq + 1, {
      via: "bash",
      bash: { cmd: bigCmd, candidates: 1 },
      quote: null,
    })),
  }));
  const matched = new Map(cards.map((card) => [card.card_id, card.blocks]));

  const res = await cardRegistry(() => ({
    cards,
    matched,
    coverage: { complete: true, skipped: 0 },
  }), "sanitized", memoryWithItem).call("why_file", { path: "src/a.ts", limit: 10 }, new AbortController().signal);

  assert.equal(res.isError, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(res), "utf8") <= MAX_RESPONSE_BYTES - TOOL_ENVELOPE_RESERVE_BYTES);
  const keptItems = res.structuredContent.items as Array<{ id: string }>;
  assert.equal(keptItems.length, 1);
  assert.equal(keptItems[0]?.id, "existing-item-1");
  const kept = res.structuredContent.cards as ProjectedCard[];
  assert.ok(kept.length > 0 && kept.length < 10);
  assert.deepEqual(kept.map((c) => c.card_id), cards.slice(0, kept.length).map((c) => c.card_id));
  assert.equal(res.structuredContent.truncated, true);

  // Even when a single oversized card would exceed the cap alongside large existing evidence,
  // all cards drop before existing items or possible evidence are evicted.
  const largeProps = Array.from({ length: 4 }, (_, idx) => `${idx}-${"p ".repeat(7_000).trim()}`);
  const largeExistingItem: TripleRecord = {
    ...existingItem,
    id: "existing-large-item",
    mechanism: {
      files: [
        { path: "src/a.ts", plusMinus: [2, 1], props: largeProps, provenance: "tool-observed" },
        { path: "src/b.ts", plusMinus: [1, 0], props: largeProps, provenance: "tool-observed" },
        { path: "src/c.ts", plusMinus: [1, 0], props: largeProps, provenance: "tool-observed" },
      ],
      truncatedFiles: 0,
      baseline: "captured",
      coverageStatus: "complete",
    },
  };
  const oneHugeCard = sampleStoredCard("4e5e1a6d22cea72d7a8b3985c9c27fcf", {
    blocks: Array.from({ length: 10 }, (_, seq) => sampleStoredBlock(seq + 1, {
      via: "bash",
      bash: { cmd: bigCmd, candidates: 1 },
      quote: null,
    })),
  });
  const heavyMemory: MemoryQueries = {
    ...createMemoryQueries(() => [largeExistingItem]),
    whyFileEvidence: () => ({
      matches: [largeExistingItem],
      possible: [{ id: "possible-keep-1", ts: 10, source: "agent-hook", reason: "path_may_be_omitted" }],
      coverage: { status: "complete", complete: true, filesCovered: 1, truncatedFiles: 0 },
      coverageIncomplete: false,
    }),
  };
  const dropAllCardsRes = await cardRegistry(() => ({
    cards: [oneHugeCard],
    matched: new Map([[oneHugeCard.card_id, oneHugeCard.blocks]]),
    coverage: { complete: true, skipped: 0 },
  }), "sanitized", heavyMemory).call("why_file", { path: "src/a.ts", limit: 10 }, new AbortController().signal);

  assert.equal(dropAllCardsRes.isError, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(dropAllCardsRes), "utf8") <= MAX_RESPONSE_BYTES - TOOL_ENVELOPE_RESERVE_BYTES);
  assert.equal((dropAllCardsRes.structuredContent.cards as ProjectedCard[]).length, 0);
  assert.equal((dropAllCardsRes.structuredContent.items as Array<{ id: string }>).length, 1);
  assert.equal((dropAllCardsRes.structuredContent.possible as Array<{ id: string }>).length, 1);
  assert.equal(dropAllCardsRes.structuredContent.truncated, true);
});

test("why_file reads change cards end-to-end through default reader under temp ROCKY_HOME and repo", async () => {
  const home = mkdtempSync(join(tmpdir(), "rocky-mcp-cards-e2e-home-"));
  const rawRepo = mkdtempSync(join(tmpdir(), "rocky-mcp-cards-e2e-repo-"));
  const prevHome = process.env.ROCKY_HOME;
  const prevCwd = process.cwd();
  try {
    mkdirSync(join(rawRepo, ".git"), { recursive: true });
    mkdirSync(join(rawRepo, "src"), { recursive: true });
    const repo = realpathSync(rawRepo);
    process.env.ROCKY_HOME = home;
    process.chdir(repo);

    const cardsPath = cardsFilePath(canonicalPath(repo), home);
    mkdirSync(dirname(cardsPath), { recursive: true });

    const rev1 = sampleStoredCard("e2e-card-new", {
      rev: 1,
      root: repo,
      main_root: null,
      ended_ms: 2_000_000,
      started_ms: 1_999_000,
      prompt: "Draft change",
      blocks: [sampleStoredBlock(1, { path: "src/target.ts" })],
    });
    const rev2 = sampleStoredCard("e2e-card-new", {
      rev: 2,
      root: repo,
      main_root: null,
      ended_ms: 2_000_000,
      started_ms: 1_999_000,
      prompt: "Refine timeout guard in src/target.ts",
      blocks: [
        sampleStoredBlock(1, { path: "src/target.ts", quote: { text: "Guard prevents hanging socket", shared: true } }),
        sampleStoredBlock(2, { path: "src/unrelated.ts", quote: { text: "Should not appear", shared: true } }),
      ],
    });
    const older = sampleStoredCard("e2e-card-old", {
      rev: 1,
      root: repo,
      main_root: null,
      ended_ms: 1_000_000,
      started_ms: 999_000,
      prompt: "Initial scaffold",
      blocks: [sampleStoredBlock(1, { path: "src/target.ts", symbol: null, quote: null })],
    });

    writeFileSync(cardsPath, `${[rev1, older, rev2].map((c) => JSON.stringify(c)).join("\n")}\n`, "utf8");

    const memoryPath = resolveRockyPaths({ ROCKY_HOME: home }).memory;
    writeFileSync(memoryPath, "", "utf8");
    const reg = createToolRegistry({
      exposure: "sanitized",
      memory: createMemoryQueries(),
      recallWithAi: disabledRecallWithAi,
    });
    const res = await reg.call("why_file", { path: "src/target.ts", limit: 5 }, new AbortController().signal);
    assert.equal(res.isError, undefined);
    assert.deepEqual(res.structuredContent.cardsCoverage, { complete: true, skipped: 0 });
    const cards = res.structuredContent.cards as ProjectedCard[];
    assert.equal(cards.length, 2);
    assert.equal(cards[0]?.card_id, "e2e-card-new");
    assert.equal(cards[0]?.prompt, "Refine timeout guard in src/target.ts");
    assert.equal(cards[0]?.blocks.length, 1);
    assert.equal(cards[0]?.blocks[0]?.quote, "Guard prevents hanging socket");
    assert.equal(cards[1]?.card_id, "e2e-card-old");
  } finally {
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(rawRepo, { recursive: true, force: true });
  }
});

test("registry helper isolates why_file from ambient ROCKY_HOME desk change cards", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rocky-mcp-iso-home-")));
  const nonRepo = realpathSync(mkdtempSync(join(tmpdir(), "rocky-mcp-iso-dir-")));
  const target = join(nonRepo, "isolated.ts");
  const prevHome = process.env.ROCKY_HOME;
  try {
    mkdirSync(join(home, "desk", "cards"), { recursive: true });
    writeFileSync(
      join(home, "desk", "cards", "_none.jsonl"),
      `${JSON.stringify({
        v: 1,
        card_id: "isolated-mcp-card",
        rev: 1,
        root: nonRepo,
        main_root: null,
        started_ms: 1000,
        ended_ms: 2000,
        prompt: "Leaked card from ambient ROCKY_HOME",
        blocks: [{ seq: 1, path: target, symbol: null, labels: [{ id: "file_edited" }], importance: "normal", via: "edit", line: 1, added: 1, removed: 0, quote: null }],
      })}\n`,
      "utf8",
    );
    process.env.ROCKY_HOME = home;
    const res = await registry().call("why_file", { path: target }, new AbortController().signal);
    assert.deepEqual(res.structuredContent.cards, []);
    assert.deepEqual(res.structuredContent.cardsCoverage, { complete: true, skipped: 0 });
  } finally {
    if (prevHome === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(nonRepo, { recursive: true, force: true });
  }
});

test("why_file drops literal before/after/version and un-allowlisted label args under both sanitized and raw exposure", async () => {
  const signal = new AbortController().signal;
  const labels = [
    { id: "config_changed", args: { key: "db.password", before: "hunter2-secret-value", after: "correct-horse-battery" } },
    { id: "value_changed", args: { name: "RETRY_LIMIT", before: "old_val_pw", after: "new_val_pw" } },
    { id: "dep_version", args: { name: "lodash", before: "4.17.20-secret", after: "4.17.21-secret" } },
    { id: "dep_added", args: { name: "zod", version: "3.23.0-private" } },
    { id: "dep_removed", args: { name: "leftpad", extra: "drop" } },
    { id: "params_changed", args: { added: 1, removed: 0, changed: 2, before: "drop", bad: -1, frac: 1.5 } },
    { id: "await_changed", args: { added: 2, removed: 1, after: "drop" } },
    { id: "rewrite", args: { pct: 75, after: "drop" } },
    { id: "lines_changed", args: { added: 10, removed: 3, version: "drop" } },
    { id: "symbol_renamed", args: { from: "/Users/alice/oldName", extra: "drop" } },
    { id: "file_renamed", args: { from: "src/old.ts", before: "drop" } },
    { id: "call_added", args: { name: "fetchUser", before: "drop" } },
    { id: "call_removed", args: { name: "legacyCall", after: "drop" } },
    { id: "import_added", args: { module: "node:fs", version: "drop" } },
    { id: "import_removed", args: { module: "./legacy", before: "drop" } },
    { id: "test_added", args: { name: "handles empty list" } },
    { id: "test_removed", args: { name: "obsolete test" } },
    { id: "test_skipped", args: { name: "flaky test" } },
    { id: "test_only", args: { name: "focused test" } },
    { id: "symbol_added", args: { kind: "function", secret: "drop" } },
    { id: "unknown_future_label", args: { before: "p1", after: "p2", version: "1.0", foo: "bar" } },
  ];
  const card = sampleStoredCard("4e5e1a6d22cea72d7a8b3985c9c27fcf", {
    prompt: "Update config and deps",
    blocks: [sampleStoredBlock(1, { labels, quote: null })],
  });
  const provider = (): CardsForFile => ({
    cards: [card],
    matched: new Map([[card.card_id, card.blocks]]),
    coverage: { complete: true, skipped: 0 },
  });

  for (const exposure of ["sanitized", "raw"] as const) {
    const res = (await cardRegistry(provider, exposure).call("why_file", { path: "src/a.ts" }, signal)).structuredContent;
    assert.equal(res.truncated, false, `exposure=${exposure} dropping disallowed args must not set truncated`);
    const [projCard] = res.cards as ProjectedCard[];
    const serialized = JSON.stringify(projCard?.blocks[0]?.labels);
    for (const forbidden of [
      "\"before\"",
      "\"after\"",
      "\"version\"",
      "hunter2-secret-value",
      "correct-horse-battery",
      "old_val_pw",
      "new_val_pw",
      "4.17.20-secret",
      "4.17.21-secret",
      "3.23.0-private",
      "\"extra\"",
      "\"drop\"",
      "\"bad\"",
      "\"frac\"",
      "\"kind\"",
      "\"foo\"",
      "\"bar\"",
    ]) {
      assert.equal(serialized.includes(forbidden), false, `exposure=${exposure} must not include ${forbidden}`);
    }
    assert.deepEqual(projCard?.blocks[0]?.labels, [
      { id: "config_changed", args: { key: "db.password" } },
      { id: "value_changed", args: { name: "RETRY_LIMIT" } },
      { id: "dep_version", args: { name: "lodash" } },
      { id: "dep_added", args: { name: "zod" } },
      { id: "dep_removed", args: { name: "leftpad" } },
      { id: "params_changed", args: { added: 1, removed: 0, changed: 2 } },
      { id: "await_changed", args: { added: 2, removed: 1 } },
      { id: "rewrite", args: { pct: 75 } },
      { id: "lines_changed", args: { added: 10, removed: 3 } },
      { id: "symbol_renamed", args: { from: exposure === "sanitized" ? "[redacted]" : "/Users/alice/oldName" } },
      { id: "file_renamed", args: { from: "src/old.ts" } },
      { id: "call_added", args: { name: "fetchUser" } },
      { id: "call_removed", args: { name: "legacyCall" } },
      { id: "import_added", args: { module: "node:fs" } },
      { id: "import_removed", args: { module: exposure === "sanitized" ? ".[redacted]" : "./legacy" } },
      { id: "test_added", args: { name: "handles empty list" } },
      { id: "test_removed", args: { name: "obsolete test" } },
      { id: "test_skipped", args: { name: "flaky test" } },
      { id: "test_only", args: { name: "focused test" } },
      { id: "symbol_added", args: {} },
      { id: "unknown_future_label", args: {} },
    ]);
  }
});

test("why_file sets truncated and more_blocks when matching blocks exceed 10 even with short prompt and no quote", async () => {
  const signal = new AbortController().signal;
  const fourteen = Array.from({ length: 14 }, (_, idx) => sampleStoredBlock(idx + 1, {
    labels: [{ id: "file_edited", args: {} }],
    quote: null,
  }));
  const card14 = sampleStoredCard("4e5e1a6d22cea72d7a8b3985c9c27fcf", {
    prompt: "short",
    blocks: fourteen,
  });
  for (const exposure of ["sanitized", "raw"] as const) {
    const res = (await cardRegistry(() => ({
      cards: [card14],
      matched: new Map([[card14.card_id, fourteen]]),
      coverage: { complete: true, skipped: 0 },
    }), exposure).call("why_file", { path: "src/a.ts" }, signal)).structuredContent;
    assert.equal(res.truncated, true, `exposure=${exposure} must set truncated=true on >10 blocks`);
    const [proj] = res.cards as ProjectedCard[];
    assert.equal(proj?.blocks.length, 10);
    assert.equal(proj?.more_blocks, 4);
  }

  const tenPlusBad = [
    ...Array.from({ length: 10 }, (_, idx) => sampleStoredBlock(idx + 1, {
      labels: [{ id: "file_edited", args: {} }],
      quote: null,
    })),
    { bad: true } as unknown as StoredBlock,
  ];
  const card10 = sampleStoredCard("97394ac43381e6ac7a3b66cb264cd2b9", {
    prompt: "short",
    blocks: tenPlusBad,
  });
  const res10 = (await cardRegistry(() => ({
    cards: [card10],
    matched: new Map([[card10.card_id, tenPlusBad]]),
    coverage: { complete: true, skipped: 0 },
  })).call("why_file", { path: "src/a.ts" }, signal)).structuredContent;
  assert.equal(res10.truncated, false);
  const [proj10] = res10.cards as ProjectedCard[];
  assert.ok(proj10);
  assert.equal(proj10.blocks.length, 10);
  assert.equal(proj10.more_blocks, undefined);
  assert.equal("more_blocks" in proj10, false);
});

test("why_file preserves valid slash command names under sanitized exposure while sanitizing args and invalid names", async () => {
  const signal = new AbortController().signal;
  const secret = "sk-LIVEKEY0123456789ABCDEFGHIJKLMNO";
  const maxValid = `/${"a".repeat(64)}`;
  const tooLong = `/${"b".repeat(65)}`;
  const cards = [
    sampleStoredCard("4e5e1a6d22cea72d7a8b3985c9c27fcf", {
      started_ms: 5_000,
      ended_ms: 5_100,
      prompt: `<command-name>/gsd:plan_1.2-ok</command-name><command-args>/Users/dev/secret token=${secret}</command-args>`,
    }),
    sampleStoredCard("97394ac43381e6ac7a3b66cb264cd2b9", {
      started_ms: 4_000,
      ended_ms: 4_100,
      prompt: `<command-name>/compact</command-name>`,
    }),
    sampleStoredCard("085fd43e5e4c84caf8d98e99af9d6ff2", {
      started_ms: 3_000,
      ended_ms: 3_100,
      prompt: `<command-name>${maxValid}</command-name><command-args>ok</command-args>`,
    }),
    sampleStoredCard("11111111111111111111111111111111", {
      started_ms: 2_500,
      ended_ms: 2_600,
      prompt: `<command-name>${tooLong}</command-name><command-args>ok</command-args>`,
    }),
    sampleStoredCard("22222222222222222222222222222222", {
      started_ms: 2_000,
      ended_ms: 2_100,
      prompt: `<command-name>/bad cmd?x=1\u001b[31m</command-name><command-args>ok</command-args>`,
    }),
    sampleStoredCard("33333333333333333333333333333333", {
      started_ms: 1_500,
      ended_ms: 1_600,
      prompt: `<command-name>/Users/alice/secret</command-name><command-args>ok</command-args>`,
    }),
  ];
  const matched = new Map(cards.map((card) => [card.card_id, card.blocks]));
  const res = (await cardRegistry(() => ({
    cards,
    matched,
    coverage: { complete: true, skipped: 0 },
  }), "sanitized").call("why_file", { path: "src/a.ts", limit: 10 }, signal)).structuredContent;

  const proj = res.cards as ProjectedCard[];
  assert.equal(proj.length, 6);

  assert.equal(proj[0]?.prompt, "/gsd:plan_1.2-ok [redacted] [redacted]");
  assert.deepEqual(proj[0]?.prompt_kind, {
    kind: "slash_command",
    name: "/gsd:plan_1.2-ok",
    args: "[redacted] [redacted]",
  });

  assert.equal(proj[1]?.prompt, "/compact");
  assert.deepEqual(proj[1]?.prompt_kind, { kind: "slash_command", name: "/compact", args: "" });

  assert.equal(proj[2]?.prompt, `${maxValid} ok`);
  assert.deepEqual(proj[2]?.prompt_kind, { kind: "slash_command", name: maxValid, args: "ok" });

  assert.equal(proj[3]?.prompt, "[redacted] ok");
  assert.deepEqual(proj[3]?.prompt_kind, { kind: "slash_command", name: "[redacted]", args: "ok" });

  assert.equal(/\/bad|\u001b/u.test(JSON.stringify(proj[4])), false);
  assert.equal(proj[4]?.prompt, "[redacted] cmd?x=1 ok");
  assert.deepEqual(proj[4]?.prompt_kind, { kind: "slash_command", name: "[redacted] cmd?x=1", args: "ok" });

  assert.equal(proj[5]?.prompt, "[redacted] ok");
  assert.deepEqual(proj[5]?.prompt_kind, { kind: "slash_command", name: "[redacted]", args: "ok" });
});

test("why_file maps unknown string block via values to other under both exposures", async () => {
  const signal = new AbortController().signal;
  const card = sampleStoredCard("4e5e1a6d22cea72d7a8b3985c9c27fcf", {
    blocks: [sampleStoredBlock(1, { via: "python" as unknown as "edit", labels: [{ id: "file_edited", args: {} }], quote: null })],
  });
  for (const exposure of ["sanitized", "raw"] as const) {
    const res = (await cardRegistry(() => ({
      cards: [card],
      matched: new Map([[card.card_id, card.blocks]]),
      coverage: { complete: true, skipped: 0 },
    }), exposure).call("why_file", { path: "src/a.ts" }, signal)).structuredContent;
    const [proj] = res.cards as ProjectedCard[];
    assert.equal(proj?.blocks[0]?.via, "other");
  }
});
