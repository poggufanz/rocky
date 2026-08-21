import test from "node:test";
import assert from "node:assert/strict";
import { coveredWhyIdentities, hasFreshAgentEvidence, missingWhyPaths, whyNudgeLine } from "../check/why-coverage.js";
import type { MemoryRecord } from "../core/memory-read.js";

const NOW = 1_800_000_000_000;
const CWD = "C:\\work\\repo";

function rationaleRecord(files: string[], ts = NOW - 60_000): MemoryRecord {
  return {
    kind: "rationale", id: `r-${ts}`, ts, v: 1, cwd: CWD,
    agent: "generic", rationale_fidelity: "summary", source: "notify",
    excerpt: "why text", files,
  } as MemoryRecord;
}

function tripleRecord(paths: string[], ts = NOW - 60_000): MemoryRecord {
  return {
    kind: "triple", id: `t-${ts}`, ts, schemaV: 1, cwd: CWD,
    agent: "claude-code", origin: "agent-hook",
    mechanism: { files: paths.map((path) => ({ path, plusMinus: [1, 0], props: [] })) },
  } as unknown as MemoryRecord;
}

test("rationale files and triple mechanism files both count as why coverage", () => {
  const records = [rationaleRecord(["src\\a.ts"]), tripleRecord(["src\\b.ts"])];
  const missing = missingWhyPaths(["src\\a.ts", "src\\b.ts", "src\\c.ts"], records, CWD, NOW);
  assert.deepEqual(missing, ["src\\c.ts"]);
});

test("stale evidence outside the window does not cover", () => {
  const nineHoursAgo = NOW - 9 * 60 * 60 * 1000;
  const records = [rationaleRecord(["src\\a.ts"], nineHoursAgo)];
  const missing = missingWhyPaths(["src\\a.ts"], records, CWD, NOW);
  assert.deepEqual(missing, ["src\\a.ts"]);
});

test("coverage from another cwd does not accidentally match", () => {
  const other = { ...rationaleRecord(["src\\a.ts"]), cwd: "C:\\elsewhere" } as MemoryRecord;
  const missing = missingWhyPaths(["src\\a.ts"], [other], CWD, NOW);
  assert.deepEqual(missing, ["src\\a.ts"]);
});

test("empty memory leaves every changed path missing, empty changes leave none", () => {
  assert.deepEqual(missingWhyPaths(["src\\a.ts"], [], CWD, NOW), ["src\\a.ts"]);
  assert.deepEqual(missingWhyPaths([], [rationaleRecord(["src\\a.ts"])], CWD, NOW), []);
  assert.equal(coveredWhyIdentities([], NOW).size, 0);
});

test("nudge line names at most three paths, elides the rest, silent when covered", () => {
  assert.equal(whyNudgeLine([]), undefined);
  const line = whyNudgeLine(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
  assert.ok(line !== undefined);
  assert.ok(line.startsWith("5 changed, why not heard."));
  assert.ok(line.includes("a.ts,b.ts,c.ts,…"));
  assert.ok(!line.includes("d.ts"));
  assert.ok(line.includes('rocky hook agent-event generic --rationale'));
  assert.ok(!line.includes("?"), "voice rule: no bare question marks");
});

test("hasFreshAgentEvidence gates the nudge: silent without fresh agent records", () => {
  assert.equal(hasFreshAgentEvidence([], NOW), false);
  const failure = { kind: "failure", id: "f", ts: NOW, cwd: CWD } as unknown as MemoryRecord;
  assert.equal(hasFreshAgentEvidence([failure], NOW), false, "plain failures are not agent activity");
  assert.equal(hasFreshAgentEvidence([rationaleRecord(["a.ts"])], NOW), true);
  assert.equal(hasFreshAgentEvidence([tripleRecord(["a.ts"])], NOW), true);
  const stale = rationaleRecord(["a.ts"], NOW - 9 * 60 * 60 * 1000);
  assert.equal(hasFreshAgentEvidence([stale], NOW), false, "stale agent records stay silent");
});
