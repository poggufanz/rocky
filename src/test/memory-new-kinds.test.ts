import test from "node:test";
import assert from "node:assert/strict";
import { parseMemoryRecord } from "../core/memory-read.js";

test("parseMemoryRecord accepts a valid brief_run record", () => {
  const parsed = parseMemoryRecord({
    v: 1, kind: "brief_run", id: "b1", ts: 1_800_000_000_000, cwd: "/repo",
    sinceTs: 1_799_900_000_000, commits: 4, files: 9,
  });
  assert.ok(parsed);
  assert.equal(parsed.kind, "brief_run");
  if (parsed.kind === "brief_run") {
    assert.equal(parsed.commits, 4);
    assert.equal(parsed.files, 9);
    assert.equal(parsed.sinceTs, 1_799_900_000_000);
  }
});

test("parseMemoryRecord accepts a valid invariant_touch record", () => {
  const parsed = parseMemoryRecord({
    v: 1, kind: "invariant_touch", id: "i1", ts: 1_800_000_000_000, cwd: "/repo",
    invariant: "payment may commit at most once", path: "src/retry-worker.ts",
  });
  assert.ok(parsed);
  assert.equal(parsed.kind, "invariant_touch");
});

test("parseMemoryRecord rejects new kinds missing v or with bad payload", () => {
  assert.equal(parseMemoryRecord({ kind: "brief_run", id: "b", ts: 1, cwd: "/", sinceTs: 0, commits: 1, files: 1 }), undefined);
  assert.equal(parseMemoryRecord({ v: 1, kind: "brief_run", id: "b", ts: 1, cwd: "/", sinceTs: -5, commits: 1, files: 1 }), undefined);
  assert.equal(parseMemoryRecord({ v: 1, kind: "invariant_touch", id: "i", ts: 1, cwd: "/", invariant: "", path: "x" }), undefined);
  assert.equal(parseMemoryRecord({ v: 1, kind: "invariant_touch", id: "i", ts: 1, cwd: "/", invariant: "x", path: "" }), undefined);
});

test("legacy kinds still parse unchanged next to new kinds", () => {
  const parsed = parseMemoryRecord({
    kind: "note", id: "n1", ts: 2, cwd: "/", cmd: "c", file: "f.ts", line: 3, subject: "s", answer: "a",
  });
  assert.ok(parsed);
  assert.equal(parsed.kind, "note");
});
