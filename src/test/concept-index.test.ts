import test from "node:test";
import assert from "node:assert/strict";
import { activeAliases, buildConceptIndex } from "../core/concept-index.js";
import type { MemoryRecord } from "../core/memory-read.js";

const triple = (id: string, ts: number, intent: string): MemoryRecord => ({
  kind: "triple", id, ts, cwd: "/p", schemaV: 1, agent: "claude-code", origin: "agent-hook",
  intent: { text: intent }, mechanism: { files: [], truncatedFiles: 0 },
} as MemoryRecord);

test("alias fold: last action wins", () => {
  const records = [
    { kind: "alias", id: "a1", ts: 1, v: 1, alias: "dua kali", concept: "idempotency", action: "add" },
    { kind: "alias", id: "a2", ts: 2, v: 1, alias: "dua kali", concept: "idempotency", action: "retract" },
  ] as unknown as MemoryRecord[];
  assert.equal(activeAliases(records).size, 0);
});

test("index counts distinct records and returns newest-first evidence", () => {
  const records = [
    triple("t1", 100, "make retry idempotent, no duplicate commit"),
    triple("t2", 200, "idempotency again on webhook replay"),
    triple("t3", 300, "rename readme heading"),
  ];
  const index = buildConceptIndex(records);
  assert.equal(index.counts.get("idempotency"), 2);
  const ev = index.evidence.get("idempotency")!;
  assert.equal(ev[0].recordId, "t2");
});
