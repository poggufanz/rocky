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

test("sinceTs boundary: ts equal is included, one below is excluded", () => {
  const records = [
    triple("t-old", 199, "make retry idempotent, no duplicate commit"),
    triple("t-edge", 200, "make retry idempotent, no duplicate commit"),
  ];
  const index = buildConceptIndex(records, 200);
  assert.equal(index.counts.get("idempotency"), 1);
  const ev = index.evidence.get("idempotency")!;
  assert.equal(ev.length, 1);
  assert.equal(ev[0].recordId, "t-edge");
});

test("snippet truncation is UTF-8 byte-safe across an astral-character boundary", () => {
  // Two idempotency keywords so the match clears the score threshold, then
  // ASCII filler padded so the string is exactly 119 UTF-16 code units long
  // (the raw-slice bug: `text.slice(0, 120)` would then grab index 119, the
  // *high* surrogate half of the next character, and drop its low half).
  const keywords = "idempotent duplicate ";
  const prefix = keywords + "x".repeat(119 - keywords.length);
  assert.equal(prefix.length, 119);
  const text = `${prefix}\u{1F600}${"y".repeat(50)}`; // 🙂-style astral char straddles the 120 boundary

  const index = buildConceptIndex([triple("t1", 100, text)]);
  const ev = index.evidence.get("idempotency")!;
  assert.equal(ev.length, 1);
  const snippet = ev[0].snippet;

  // No unpaired surrogate half and no replacement character leaked through.
  assert.doesNotMatch(snippet, /[\uD800-\uDFFF]/);
  assert.doesNotMatch(snippet, /�/);
  // Byte budget respected (this is a byte cap, not a UTF-16 code-unit cap).
  assert.ok(
    Buffer.byteLength(snippet, "utf8") <= 120,
    `expected snippet <= 120 UTF-8 bytes, got ${Buffer.byteLength(snippet, "utf8")}`,
  );
  // The astral character that would have split at the boundary is dropped
  // whole rather than corrupted; the ASCII prefix survives intact.
  assert.equal(snippet, prefix);
});
