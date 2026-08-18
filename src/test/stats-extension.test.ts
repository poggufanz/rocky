import test from "node:test";
import assert from "node:assert/strict";
import { queryStats } from "../core/memory-query.js";
import type { MemoryRecord } from "../core/memory-read.js";

const NOW = 1_800_000_000_000;

function failure(id: string): MemoryRecord {
  return {
    kind: "failure", id, ts: NOW - 1000, cwd: "/repo", cmd: "npm test", exitCode: 1,
    fingerprint: `fp-${id}`, signature: ["err"], excerpt: "err",
  };
}

test("queryStats reports per-kind counts including new kinds", () => {
  const records: MemoryRecord[] = [
    failure("f1"),
    failure("f2"),
    { v: 1, kind: "brief_run", id: "b1", ts: NOW - 500, cwd: "/repo", sinceTs: NOW - 9000, commits: 3, files: 7 },
    { v: 1, kind: "invariant_touch", id: "i1", ts: NOW - 400, cwd: "/repo", invariant: "inv", path: "src/a.ts" },
  ];
  const result = queryStats(records, { now: NOW });
  assert.deepEqual(result.byKind, { failure: 2, brief_run: 1, invariant_touch: 1 });
});
