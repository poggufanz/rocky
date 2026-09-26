import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disabledRecallWithAi } from "../ai/port.js";
import { createMemoryQueries } from "../core/memory-query.js";
import { createToolRegistry } from "../mcp/tools.js";
import {
  MCP_TOOL_CATALOG,
  MCP_TOOL_CATALOG_CONTRACT,
  MCP_TOOL_CATALOG_VERSION,
} from "../mcp/tools.js";

const OLD = [
  "recall",
  "recent_failures",
  "stats",
  "recall_with_ai",
  "search_knowledge",
  "fetch_record",
  "why_file",
  "teach_lookup",
] as const;
const NEW = [
  "activity_recent",
  "activity_for_file",
  "bundles_list",
  "bundle_get",
  "session_timeline",
] as const;

function registry() {
  return createToolRegistry({
    exposure: "sanitized",
    memory: createMemoryQueries(() => []),
    recallWithAi: disabledRecallWithAi,
  });
}

test("catalog appends 5 listening tools after 8 frozen originals", () => {
  assert.equal(MCP_TOOL_CATALOG_VERSION, 1);
  assert.deepEqual([...MCP_TOOL_CATALOG.slice(0, 8)], [...OLD]);
  assert.deepEqual([...MCP_TOOL_CATALOG.slice(8)], [...NEW]);
  assert.deepEqual(registry().list().map((d) => d.name), [...OLD, ...NEW]);
  assert.equal(Object.isFrozen(MCP_TOOL_CATALOG_CONTRACT.tools), true);
});

test("listening descriptors carry bounds and read-only annotations", () => {
  for (const def of registry().list().slice(8)) {
    assert.ok(def.annotations.readOnlyHint && !def.annotations.destructiveHint);
    assert.match(def.description, /no scan/i);
    const props = (def.inputSchema.properties ?? {}) as Record<string, unknown>;
    assert.ok(typeof def.inputSchema.required !== "undefined" || Object.keys(props).length > 0);
  }
});

test("listening calls are read-only metadata-first without consent", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "rocky-listen-mcp-"));
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });
  const reg = registry();
  const signal = new AbortController().signal;
  const recent = await reg.call("activity_recent", { repo: "/nope" }, signal);
  const body = recent.structuredContent as Record<string, unknown>;
  assert.deepEqual(body.events, []);
  assert.equal(body.consent, false);
  const text = JSON.stringify(recent);
  assert.ok(!text.includes("transcript") && !text.includes("reasoning"));
  for (const [name, args] of [
    ["activity_for_file", { repo: "/nope", path: "a.ts" }],
    ["bundles_list", { repo: "/nope" }],
    ["bundle_get", { repo: "/nope", bundle: "e1" }],
    ["session_timeline", { repo: "/nope", session: "s1" }],
  ] as const) {
    const result = await reg.call(name, args, signal);
    assert.equal((result.structuredContent as Record<string, unknown>).consent, false);
  }
});
