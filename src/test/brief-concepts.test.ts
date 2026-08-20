import test from "node:test";
import assert from "node:assert/strict";
import { buildConceptIndex } from "../core/concept-index.js";
import { repeatedConceptLines } from "../commands/brief.js";
import type { MemoryRecord } from "../core/memory-read.js";

test("repeatedConceptLines emits only concepts heard twice or more in window", () => {
  const triple = (id: string, ts: number, text: string) => ({
    kind: "triple", id, ts, cwd: "/p", schemaV: 1, agent: "claude-code", origin: "agent-hook",
    intent: { text }, mechanism: { files: [], truncatedFiles: 0 },
  } as unknown as MemoryRecord);
  const records = [
    triple("t1", 100, "idempotent retry, no duplicate commit"),
    triple("t2", 200, "idempotency on webhook replay"),
    triple("t3", 300, "cache stale after write"),
  ];
  const lines = repeatedConceptLines(buildConceptIndex(records, 0));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /idempotency heard 2 times/);
});
