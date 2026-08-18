import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordBriefRun, recordInvariantTouch } from "../core/memory.js";
import { loadMemoryChecked, parseMemoryRecord } from "../core/memory-read.js";

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

test("parseMemoryRecord rejects new kinds with wrong schema version", () => {
  assert.equal(parseMemoryRecord({ v: 2, kind: "brief_run", id: "b", ts: 1, cwd: "/", sinceTs: 0, commits: 1, files: 1 }), undefined);
  assert.equal(parseMemoryRecord({ v: 2, kind: "invariant_touch", id: "i", ts: 1, cwd: "/", invariant: "x", path: "y" }), undefined);
});

test("parseMemoryRecord rejects invariant_touch fields over the item length cap", () => {
  const overLong = "x".repeat(16_385);
  assert.equal(parseMemoryRecord({ v: 1, kind: "invariant_touch", id: "i", ts: 1, cwd: "/", invariant: overLong, path: "y" }), undefined);
  assert.equal(parseMemoryRecord({ v: 1, kind: "invariant_touch", id: "i", ts: 1, cwd: "/", invariant: "x", path: overLong }), undefined);
});

test("recordBriefRun and recordInvariantTouch round-trip through memory.jsonl", () => {
  const home = mkdtempSync(join(tmpdir(), "rocky-home-"));
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  try {
    const briefRun = recordBriefRun({ sinceTs: 1_799_000_000_000, commits: 2, files: 5, cwd: "/repo" });
    const touch = recordInvariantTouch({ invariant: "payment may commit at most once", path: "src/retry-worker.ts", cwd: "/repo" });
    const loaded = loadMemoryChecked(join(home, "memory.jsonl"));
    const kinds = loaded.records.map((record) => record.kind).sort();
    assert.deepEqual(kinds, ["brief_run", "invariant_touch"]);
    assert.ok(loaded.records.some((record) => record.id === briefRun.id));
    assert.ok(loaded.records.some((record) => record.id === touch.id));
    assert.equal(loaded.coverage.skipped, 0);
  } finally {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
  }
});
