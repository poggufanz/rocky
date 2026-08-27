import { test } from "node:test";
import assert from "node:assert/strict";
import { teachLookup, TEACH_SIMILARITY_THRESHOLD } from "../core/teach.js";
import { explainContentHash } from "../core/memory.js";
import type { MemoryRecord } from "../core/memory-read.js";

function explain(over: Record<string, unknown>): MemoryRecord {
  return {
    kind: "explain", id: String(over.id ?? "e1"), ts: Number(over.ts ?? 1), v: 1,
    cwd: "C:/p", path: String(over.path ?? "src/a.ts"), source: "agent:claude-code",
    code: "code why", business: "business why",
    ...over,
  } as MemoryRecord;
}

test("exact contentHash beats similarity and newest hash wins", () => {
  const snip = "return reclaimTriplePath(lock.path, current.stats);";
  const recs = [
    explain({ id: "old", ts: 1, snippet: snip, contentHash: explainContentHash(snip) }),
    explain({ id: "new", ts: 2, snippet: snip, contentHash: explainContentHash(snip) }),
    explain({ id: "sim", ts: 3, snippet: "return reclaimTriplePath(other);" }),
  ];
  const hit = teachLookup(recs, { path: "src/a.ts", snippet: snip });
  assert.ok(hit && hit.match === "hash" && hit.record.id === "new");
});

test("token similarity fallback respects threshold and same file", () => {
  const recs = [explain({ snippet: "const total = sumInvoice(lines);" })];
  const near = teachLookup(recs, { path: "src/a.ts", snippet: "const total = sumInvoice(rows);" });
  assert.ok(near && near.match === "similarity" && near.score >= TEACH_SIMILARITY_THRESHOLD);
  assert.equal(teachLookup(recs, { path: "src/a.ts", snippet: "zzz qqq www" }), undefined);
  assert.equal(teachLookup(recs, { path: "src/OTHER.ts", snippet: "const total = sumInvoice(rows);" }), undefined);
});

test("no snippet: newest explain for the file, file-level witness", () => {
  const recs = [explain({ id: "a", ts: 1 }), explain({ id: "b", ts: 5 })];
  const hit = teachLookup(recs, { path: "src/a.ts" });
  assert.ok(hit && hit.record.id === "b");
});
