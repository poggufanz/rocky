import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queryStats } from "../core/memory-query.js";
import type { FailureRecord, MemoryRecord } from "../core/memory-read.js";
import { memoryAgeDays, stats } from "../commands/stats.js";
import { resolveRockyPaths } from "../core/state-paths.js";
import { validateOutputLine } from "../ui/phrases.js";
import { setVerbose } from "./verbose-switch.js";

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

test("stats() prints rationale-by-fidelity and alias totals from real memory under ROCKY_VERBOSE", (t) => {
  setVerbose(t, "1");
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
    assert.match(stderr, /Rationale recorded 4 times: raw 2, summary 1, none 1\. Aliases recorded: 2\./);
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

const SKIPPED_ONLY_WORDS = "memory coverage incomplete: 1 line could not be used. These counts do not cover all of memory.";
const SKIPPED_ONLY_COUNTERS = "memory coverage: version 1, scanned 2, skipped 1, truncated 0, complete false";

/** One valid failure and one line that is not JSON: a read whole except for a line that cannot be used. */
function statsOverSkippedLine(t: TestContext, argv: readonly string[]): { result: number; lines: string[] } {
  const home = mkdtempSync(join(tmpdir(), "rocky-stats-coverage-"));
  const previousHome = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  t.after(() => {
    if (previousHome === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });
  writeFileSync(resolveRockyPaths().memory, `${JSON.stringify(failure("f1"))}\nthis line is not json\n`, "utf8");
  let stderr = "";
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = stats(argv);
    return { result, lines: stderr.split(/\r?\n/u) };
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

/** A triple the reader accepts, recorded `age` milliseconds before the real clock, which stats() reads itself. */
function triple(id: string, age: number): Record<string, unknown> {
  return {
    kind: "triple", id, ts: Date.now() - age, cwd: "/repo", schemaV: 1, agent: "claude-code", origin: "agent-hook",
    intent: { text: "tighten spacing" }, mechanism: { files: [], truncatedFiles: 0 },
  };
}

function note(id: string, age: number): Record<string, unknown> {
  return { kind: "note", id, ts: Date.now() - age, cwd: "/repo", cmd: "rocky note", file: "src/a.ts", line: 1, subject: "spacing", answer: "gap" };
}

/** What `stats()` says on stderr over a memory file holding `records`, plus one reclaim tombstone beside it. */
function statsOutputOver(t: TestContext, records: readonly Record<string, unknown>[]): string {
  const home = mkdtempSync(join(tmpdir(), "rocky-stats-words-"));
  const previousHome = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  t.after(() => {
    if (previousHome === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });
  writeFileSync(resolveRockyPaths().memory, records.map((record) => `${JSON.stringify(record)}\n`).join(""), "utf8");
  writeFileSync(join(home, "memory.jsonl.reclaim.tombstone.1.abcdef"), "", "utf8");
  let stderr = "";
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    assert.equal(stats(), 0);
    return stderr;
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

const MIXED_MEMORY = (): Record<string, unknown>[] => [
  triple("t1", 400), triple("t2", 300), note("n1", 200), rationale("r1", "raw", Date.now() - 100) as unknown as Record<string, unknown>,
  alias("a1", Date.now() - 50) as unknown as Record<string, unknown>,
];

test("stats says intents, and keeps the kind tally, the fidelity split and the tombstone count out of default output", (t) => {
  setVerbose(t, undefined);
  const output = statsOutputOver(t, MIXED_MEMORY());
  assert.match(output, /Memory holds 5 recorded items\. 0 confirmed fixes\. 0 possible fixes\. 2 intents\. 1 note\./u);
  assert.doesNotMatch(output, /triple/u);
  assert.doesNotMatch(output, /events by kind/u);
  assert.doesNotMatch(output, /Rationale recorded|summary \d|Aliases recorded/u);
  assert.doesNotMatch(output, /tombstone/u);
  assert.match(output, /Memory is \d+ days? old\./u);
});

test("stats says 1 intent, not 1 intents", (t) => {
  setVerbose(t, undefined);
  const output = statsOutputOver(t, [triple("t1", 400)]);
  assert.match(output, /\. 1 intent\. 0 notes\./u);
});

test("stats keeps the triple word, the kind tally, the fidelity split and the tombstone count under ROCKY_VERBOSE", (t) => {
  setVerbose(t, "1");
  const output = statsOutputOver(t, MIXED_MEMORY());
  const lines = output.split(/\r?\n/u);
  assert.ok(lines.some((line) => line.endsWith("Memory holds 5 recorded items. 0 confirmed fixes. 0 possible fixes. 2 triples. 1 note.")), output);
  assert.ok(lines.some((line) => line.endsWith("events by kind: alias 1, note 1, rationale 1, triple 2.")), output);
  assert.ok(lines.some((line) => line.endsWith("Rationale recorded 1 time: raw 1, summary 0, none 0. Aliases recorded: 1.")), output);
  assert.ok(lines.includes("tombstones waiting sweep: 1"), output);
});

test("stats says 1 triple under ROCKY_VERBOSE", (t) => {
  setVerbose(t, "1");
  const output = statsOutputOver(t, [triple("t1", 400)]);
  assert.match(output, /\. 1 triple\. 0 notes\./u);
});

test("stats default output is plain sentences with correct singulars, and every rocky line follows the output rules", (t) => {
  setVerbose(t, undefined);
  const realNow = Date.now();
  const resolved = {
    kind: "failure", id: "sf1", ts: realNow - 2_000, cwd: "/repo", cmd: "npm test", exitCode: 1,
    fingerprint: "fp-sf1", signature: ["err"], excerpt: "err", resolvedBy: "sx1",
  };
  const fix = {
    kind: "fix", id: "sx1", ts: realNow - 1_000, cwd: "/repo", cmd: "npm test", failureIds: ["sf1"],
    links: [{ id: "sf1", basis: "identity", confidence: "confirmed" }],
  };
  const unresolved = { ...resolved, id: "sf2", fingerprint: "fp-sf2", resolvedBy: undefined };
  const output = statsOutputOver(t, [resolved, fix, unresolved]);

  assert.match(output, /rocky: 2 errors recorded\. 1 has a fix\. 1 fix event total\.\r?\n/u);
  assert.match(output, /rocky: Memory holds 3 recorded items\. 1 confirmed fix\. 0 possible fixes\. 0 intents\. 0 notes\.\r?\n/u);
  assert.match(output, /rocky: Memory is 0 days old\. 0 brief runs\. 0 journal notes\.\r?\n/u);
  assert.match(output, /rocky: Guard has not stopped any command yet\.\r?\n/u);
  assert.match(output, /rocky: 1 error still without a fix\.\r?\n/u);
  const spoken = output.split(/\r?\n/u).filter((line) => line.startsWith("rocky: ") && !line.startsWith("rocky: memory file: "));
  assert.ok(spoken.length >= 5, output);
  for (const line of spoken) assert.deepEqual(validateOutputLine(line.slice("rocky: ".length)), [], line);
});

for (const argv of [[], ["--cycles"]] as const) {
  const surface = argv.length === 0 ? "stats" : "stats --cycles";

  test(`${surface} says memory coverage once and warns the counts are not all`, (t) => {
    setVerbose(t, undefined);
    const { result, lines } = statsOverSkippedLine(t, argv);
    assert.equal(result, 0);
    const said = lines.filter((line) => line.includes("memory coverage"));
    assert.equal(said.length, 1, lines.join("\n"));
    assert.ok(said[0]?.endsWith(SKIPPED_ONLY_WORDS), said[0]);
  });

  test(`${surface} adds the raw counter line to the same plain words under ROCKY_VERBOSE`, (t) => {
    setVerbose(t, "1");
    const { result, lines } = statsOverSkippedLine(t, argv);
    assert.equal(result, 0);
    assert.equal(lines.filter((line) => line.endsWith(SKIPPED_ONLY_WORDS)).length, 1, lines.join("\n"));
    assert.equal(lines.filter((line) => line === SKIPPED_ONLY_COUNTERS).length, 1, lines.join("\n"));
  });
}
