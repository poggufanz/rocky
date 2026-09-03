import test from "node:test";
import assert from "node:assert/strict";
import { parseMemoryRecord } from "../core/memory-read.js";

test("parseMemoryRecord keeps a valid git anchor on rationale", () => {
  const rec = parseMemoryRecord({
    kind: "rationale", id: "r1", ts: 1, v: 1, cwd: "/repo",
    agent: "generic", rationale_fidelity: "summary", source: "notify",
    excerpt: "why",
    git: { base: "abc123", dirty: true, snapshot: "@@ -1 +1 @@\n-a\n+b" },
  });
  if (!rec || rec.kind !== "rationale") throw new Error("expected a rationale record");
  assert.deepEqual(rec.git, { base: "abc123", dirty: true, snapshot: "@@ -1 +1 @@\n-a\n+b" });
});

test("parseMemoryRecord keeps a valid git anchor on explain", () => {
  const rec = parseMemoryRecord({
    kind: "explain", id: "e1", ts: 1, v: 1, cwd: "/repo",
    path: "src/a.ts", source: "agent:generic", code: "c", business: "b",
    git: { base: "unborn", dirty: true },
  });
  if (!rec || rec.kind !== "explain") throw new Error("expected an explain record");
  assert.deepEqual(rec.git, { base: "unborn", dirty: true });
});

test("parseMemoryRecord accepts legacy records without git", () => {
  const rec = parseMemoryRecord({
    kind: "rationale", id: "r2", ts: 1, v: 1, cwd: "/repo",
    agent: "generic", rationale_fidelity: "summary", source: "notify", excerpt: "why",
  });
  if (!rec || rec.kind !== "rationale") throw new Error("expected a rationale record");
  assert.equal("git" in rec, false);
});

test("parseMemoryRecord rejects malformed git anchors", () => {
  assert.equal(parseMemoryRecord({
    kind: "rationale", id: "r3", ts: 1, v: 1, cwd: "/repo",
    agent: "generic", rationale_fidelity: "summary", source: "notify", excerpt: "why",
    git: { base: 42 },
  }), undefined);
  assert.equal(parseMemoryRecord({
    kind: "explain", id: "e2", ts: 1, v: 1, cwd: "/repo",
    path: "src/a.ts", source: "agent:generic", code: "c", business: "b",
    git: { snapshot: "x".repeat(9000) },
  }), undefined);
});
