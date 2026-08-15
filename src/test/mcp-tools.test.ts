import test from "node:test";
import assert from "node:assert/strict";
import type { FailureRecord, MemoryRecord, TripleRecord } from "../core/memory-read.js";
import { createMemoryQueries } from "../core/memory-query.js";
import type { MemoryQueries } from "../core/memory-query.js";
import { pathIdentityHash } from "../core/memory-read.js";
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

function registry(exposure: "sanitized" | "raw" = "sanitized") {
  return createToolRegistry({
    exposure,
    memory: createMemoryQueries(() => records),
    recallWithAi: disabledRecallWithAi,
  });
}

function knowledgeRegistry(exposure: "sanitized" | "raw" = "sanitized") {
  return createToolRegistry({
    exposure,
    memory: createMemoryQueries(() => knowledgeRecords),
    recallWithAi: disabledRecallWithAi,
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
    "recall", "recent_failures", "stats", "recall_with_ai", "search_knowledge", "fetch_record", "why_file",
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
    "recall", "recent_failures", "stats", "recall_with_ai", "search_knowledge", "fetch_record", "why_file",
  ]);
});

test("new tool descriptions are concrete and schemas expose their bounds", () => {
  const definitions = registry().list();
  const search = definitions.find((tool) => tool.name === "search_knowledge");
  const fetch = definitions.find((tool) => tool.name === "fetch_record");
  const why = definitions.find((tool) => tool.name === "why_file");
  assert.ok(search && fetch && why);
  assert.match(search.description, /Example/);
  assert.match(fetch.description, /Example/);
  assert.match(why.description, /Example/);
  assert.deepEqual(search.inputSchema, {
    type: "object", additionalProperties: false, required: ["query"], properties: {
      query: { type: "string", minLength: 1, maxLength: 500 },
      kind: { type: "string", enum: ["failure", "fix", "triple", "note"] },
      limit: { type: "integer", minimum: 1, maximum: 20 },
    },
  });
  assert.deepEqual(fetch.inputSchema, {
    type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" } },
  });
  assert.deepEqual(why.inputSchema, {
    type: "object", additionalProperties: false, required: ["path"], properties: {
      path: { type: "string", maxLength: MAX_FIELD_BYTES }, limit: { type: "integer", minimum: 1, maximum: 10 },
    },
  });
});

test("knowledge tools search, fetch, and explain one file", async () => {
  const signal = new AbortController().signal;
  const search = await knowledgeRegistry().call("search_knowledge", { query: "naikin" }, signal);
  assert.equal(search.isError, undefined);
  assert.deepEqual(search.structuredContent.items, [{
    id: "triple-1", ts: 300, kind: "triple", snippet: "naikin button", score: 1 / 3,
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
    exposure: "sanitized", memory, recallWithAi: disabledRecallWithAi,
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
    exposure: "sanitized", memory, recallWithAi: disabledRecallWithAi,
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
    exposure: "sanitized", memory, recallWithAi: disabledRecallWithAi,
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
  }).call("why_file", { path: "src/known.ts" }, new AbortController().signal);
  assert.deepEqual(cwdResult.structuredContent.items, []);
  assert.equal(cwdResult.structuredContent.coverageStatus, "unknown");
  assert.equal(cwdResult.structuredContent.coverageIncomplete, true);

  const mixedResult = await createToolRegistry({
    exposure: "sanitized",
    memory: { ...createMemoryQueries(() => []), whyFileEvidence: () => makeEvidence([known, hostilePath]) },
    recallWithAi: disabledRecallWithAi,
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
  }).call("why_file", { path: "src/target.ts" }, new AbortController().signal);
  const item = (result.structuredContent.items as Array<{ files: Array<{ path: string }>; truncatedFiles: number; complete: boolean }>)[0];
  assert.ok(item?.files.some((file) => file.path === "src/target.ts"));
  assert.ok((item?.truncatedFiles ?? 0) > 0);
  assert.equal(item?.complete, false);
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
    exposure: "sanitized", memory, recallWithAi: disabledRecallWithAi,
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
    exposure: "sanitized", memory, recallWithAi: disabledRecallWithAi,
  }).call("why_file", { path: "src/missing.ts" }, new AbortController().signal);
  assert.doesNotMatch(JSON.stringify(sanitized), /user-secret-answer/u);
  const raw = await createToolRegistry({
    exposure: "raw", memory, recallWithAi: disabledRecallWithAi,
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
    id: "note-search", ts: 304, kind: "note", snippet: "cache: banana", score: 1 / 6,
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
  assert.deepEqual(observed[1], []);
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

test("non-item response overflow fails open to a bounded fallback", async () => {
  const ai: RecallWithAiPort = {
    async run() { return { aiStatus: "disabled", rankedCandidateIds: [], explanation: "x".repeat(MAX_RESPONSE_BYTES) }; },
  };
  const result = await createToolRegistry({ exposure: "sanitized", memory: createMemoryQueries(() => records), recallWithAi: ai })
    .call("recall_with_ai", { query: "not-present" }, new AbortController().signal);
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= MAX_RESPONSE_BYTES);
});
