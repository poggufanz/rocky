import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queryStats } from "../core/memory-query.js";
import type { FailureRecord, MemoryRecord } from "../core/memory-read.js";
import { memoryAgeDays, stats } from "../commands/stats.js";
import { resolveRockyPaths } from "../core/state-paths.js";

const NOW = 1_800_000_000_000;

function failure(id: string): FailureRecord {
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

test("byKind respects cwd scoping", () => {
  const records: MemoryRecord[] = [
    failure("f1"),
    failure("f2"),
    { ...failure("f3"), cwd: "/other" },
    { v: 1, kind: "brief_run", id: "b1", ts: NOW - 500, cwd: "/other", sinceTs: NOW - 9000, commits: 3, files: 7 },
  ];
  assert.deepEqual(queryStats(records, { now: NOW, cwd: "/repo" }).byKind, { failure: 2 });
  assert.deepEqual(queryStats(records, { now: NOW, cwd: "/other" }).byKind, { failure: 1, brief_run: 1 });
});

test("byKind excludes future-dated records", () => {
  const records: MemoryRecord[] = [
    failure("f1"),
    { ...failure("f2"), ts: NOW + 1 },
    { v: 1, kind: "brief_run", id: "b1", ts: NOW + 2, cwd: "/repo", sinceTs: NOW - 9000, commits: 3, files: 7 },
  ];
  assert.deepEqual(queryStats(records, { now: NOW }).byKind, { failure: 1 });
});

function rationale(id: string, fidelity: "raw" | "summary" | "none", ts = NOW - 100): MemoryRecord {
  return {
    kind: "rationale", id, ts, v: 1, cwd: "/repo", agent: "human",
    rationale_fidelity: fidelity, source: "human", excerpt: id,
  } as unknown as MemoryRecord;
}

function alias(id: string, ts = NOW - 100): MemoryRecord {
  return { kind: "alias", id, ts, v: 1, alias: id, concept: "timeout", action: "add" } as unknown as MemoryRecord;
}

test("queryStats breaks rationale down by fidelity, from the same deduped/operational set as byKind", () => {
  const records: MemoryRecord[] = [
    rationale("r1", "raw"),
    rationale("r2", "raw"),
    rationale("r3", "summary"),
    rationale("r4", "none"),
    alias("a1"),
  ];
  const result = queryStats(records, { now: NOW });
  assert.deepEqual(result.rationaleByFidelity, { raw: 2, summary: 1, none: 1 });
  // byKind's rationale total must agree with the fidelity breakdown's sum —
  // both come from the same `scoped` set, so they can never disagree.
  assert.equal(result.byKind?.rationale, 4);
  assert.equal(result.byKind?.alias, 1);
});

test("queryStats defaults rationaleByFidelity to all zeros when memory holds no rationale", () => {
  const records: MemoryRecord[] = [failure("f1")];
  const result = queryStats(records, { now: NOW });
  assert.deepEqual(result.rationaleByFidelity, { raw: 0, summary: 0, none: 0 });
});

function captureStderr<T>(fn: () => T): { result: T; stderr: string } {
  const original = process.stderr.write;
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: fn(), stderr };
  } finally {
    process.stderr.write = original;
  }
}

test("stats() prints rationale-by-fidelity and alias totals from real memory", () => {
  const home = mkdtempSync(join(tmpdir(), "rocky-stats-rationale-"));
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  try {
    // stats() reads Date.now() internally (queryStats(records) is called
    // without an injected `now`), so these must be real-clock-relative —
    // unlike the fixed NOW sentinel this file's other tests inject explicitly.
    const realNow = Date.now();
    const records = [
      rationale("r1", "raw", realNow - 400),
      rationale("r2", "raw", realNow - 300),
      rationale("r3", "summary", realNow - 200),
      rationale("r4", "none", realNow - 100),
      alias("a1", realNow - 50),
      alias("a2", realNow - 40),
    ];
    writeFileSync(resolveRockyPaths().memory, records.map((record) => `${JSON.stringify(record)}\n`).join(""), "utf8");
    const { result, stderr } = captureStderr(() => stats());
    assert.equal(result, 0);
    assert.match(stderr, /rationale heard 4 times\. raw 2, summary 1, none 1\. alias 2 remembered\./);
  } finally {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
  }
});

test("memoryAgeDays pins the age-display edge cases", () => {
  assert.equal(memoryAgeDays([], NOW), 0);
  assert.equal(memoryAgeDays([NOW + 60_000], NOW), 0);
  assert.equal(memoryAgeDays([NOW - 3 * 86_400_000], NOW), 3);
  assert.equal(memoryAgeDays([NOW - 86_400_000, NOW - 5 * 86_400_000, NOW - 1000], NOW), 5);
  assert.equal(memoryAgeDays([NOW - 36 * 3_600_000], NOW), 1);
});
