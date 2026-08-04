import test from "node:test";
import assert from "node:assert/strict";
import type { MemoryRecord } from "../core/memory-read.js";
import { createMemoryQueries } from "../core/memory-query.js";
import { disabledRecallWithAi, type RecallWithAiPort } from "../ai/port.js";
import { createToolRegistry, McpInvalidParamsError, TOOL_ENVELOPE_RESERVE_BYTES } from "../mcp/tools.js";
import { MAX_RESPONSE_BYTES } from "../mcp/privacy.js";

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

function registry(exposure: "sanitized" | "raw" = "sanitized") {
  return createToolRegistry({
    exposure,
    memory: createMemoryQueries(() => records),
    recallWithAi: disabledRecallWithAi,
  });
}

test("sanitized catalog excludes cwd and stays in frozen order", () => {
  const definitions = registry().list();
  assert.deepEqual(definitions.map((tool) => tool.name), ["recall", "recent_failures", "stats", "recall_with_ai"]);
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
  assert.deepEqual(definitions.map((tool) => tool.name), ["recall", "recent_failures", "stats", "recall_with_ai"]);
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

test("complete tool result cap removes whole trailing items and keeps both representations synchronized", async () => {
  const field = "x".repeat(16 * 1024);
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
    _meta: { protocolVersion: "2025-03-26", serverInfo: { name: "rocky", version: "0.2.1" }, complete: true },
  };
  const legacy = { jsonrpc: "2.0", id: 1, result };
  assert.ok(Buffer.byteLength(`${JSON.stringify(modern)}\n`, "utf8") <= MAX_RESPONSE_BYTES);
  assert.ok(Buffer.byteLength(`${JSON.stringify(legacy)}\n`, "utf8") <= MAX_RESPONSE_BYTES);
});

test("known-tool operational failures become safe error results", async () => {
  const broken = createToolRegistry({
    exposure: "sanitized",
    memory: { recall() { throw new Error("/private/config.json"); }, recentFailures() { return []; }, stats() { return { failures: 0, fixEvents: 0, resolved: 0, unresolved: 0 }; } },
    recallWithAi: disabledRecallWithAi,
  });
  const result = await broken.call("recall", { query: "missing" }, new AbortController().signal);
  assert.equal(result.isError, true);
  assert.doesNotMatch(JSON.stringify(result), /private|config/);
});
