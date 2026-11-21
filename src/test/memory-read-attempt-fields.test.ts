import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { rationaleSourceLabel } from "../commands/dictionary.js";
import {
  isCompleteMemoryCoverage,
  isKnownRationaleSource,
  loadMemoryChecked,
  MAX_EXPECTED_COMMAND_CODE_POINTS,
  parseMemoryRecord,
  RATIONALE_SOURCE_PATTERN,
  type AgentStamp,
  type AssociationRecord,
  type FailureRecord,
  type FixRecord,
  type RationaleRecord,
} from "../core/memory-read.js";
import { failureLine } from "./memory-cap-fixture.js";

const failure = JSON.parse(failureLine(1)) as Record<string, unknown>;
const fix: Record<string, unknown> = {
  kind: "fix",
  id: "x1",
  ts: 2,
  cwd: "/cap-fixture",
  cmd: "true",
  failureIds: ["r1"],
};
const association: Record<string, unknown> = {
  kind: "association",
  id: "a1",
  ts: 3,
  cwd: "/cap-fixture",
  cmd: "true",
  candidateFailureIds: ["r1"],
  links: [{ id: "r1", basis: "program", confidence: "possible" }],
};
const rationale: Record<string, unknown> = {
  kind: "rationale",
  v: 1,
  id: "rat1",
  ts: 4,
  cwd: "/cap-fixture",
  agent: "claude-code",
  rationale_fidelity: "summary",
  source: "notify",
  excerpt: "retry lacked backoff",
};

test("agent origin is kept", () => {
  assert.equal((parseMemoryRecord({ ...failure, origin: "agent" }) as FailureRecord).origin, "agent");
});

test("unknown origin still reads as run", () => {
  assert.equal((parseMemoryRecord({ ...failure, origin: "zzz" }) as FailureRecord).origin, "run");
});

test("agent stamp round-trips on failure, fix, association", () => {
  const agent: AgentStamp = { vendor: "claude-code", session: "s1", agentId: "a1", toolUseId: "t1" };
  for (const base of [failure, fix, association]) {
    assert.deepEqual((parseMemoryRecord({ ...base, agent }) as { agent?: unknown }).agent, agent);
  }
  const minimalAgent: AgentStamp = { vendor: "codex", session: "s2" };
  const parsedFix = parseMemoryRecord({ ...fix, agent: minimalAgent }) as FixRecord;
  assert.deepEqual(parsedFix.agent, minimalAgent);
  const parsedAssoc = parseMemoryRecord({ ...association, agent: { vendor: "generic", session: "s3" } }) as AssociationRecord;
  assert.deepEqual(parsedAssoc.agent, { vendor: "generic", session: "s3" });
});

test("malformed stamp keeps record", () => {
  for (const agent of [
    { vendor: "x", session: "s" },
    { vendor: "codex" },
    { vendor: "codex", session: "" },
    { vendor: "codex", session: "a\u0007b" },
    { vendor: "codex", session: "s".repeat(129) },
    { vendor: "codex", session: "s", agentId: "" },
    { vendor: "codex", session: "s", toolUseId: "a\u007fb" },
    "s1",
  ]) {
    const parsed = parseMemoryRecord({ ...failure, agent });
    assert.ok(parsed);
    assert.equal((parsed as FailureRecord).agent, undefined);
  }
});

test("mcp source with expectedCommand round-trips", () => {
  const r = parseMemoryRecord({ ...rationale, source: "mcp", expectedCommand: "npm test" }) as RationaleRecord;
  assert.equal(r.source, "mcp");
  assert.equal(r.expectedCommand, "npm test");
  assert.equal(isKnownRationaleSource("mcp"), true);
  assert.equal(isKnownRationaleSource("future-lane"), false);
  assert.equal(MAX_EXPECTED_COMMAND_CODE_POINTS, 200);
});

test("unknown source pattern", () => {
  assert.equal((parseMemoryRecord({ ...rationale, source: "future-lane" }) as RationaleRecord).source, "future-lane");
  assert.equal(RATIONALE_SOURCE_PATTERN.test("future-lane"), true);
  for (const source of ["Future", "1abc", "a_b", "a".repeat(33), ""]) {
    assert.equal(parseMemoryRecord({ ...rationale, source }), undefined);
  }
});

test("bad expectedCommand is dropped, record kept", () => {
  for (const expectedCommand of [7, "", "x".repeat(201), "a\u0000b"]) {
    const r = parseMemoryRecord({ ...rationale, expectedCommand }) as RationaleRecord;
    assert.ok(r);
    assert.equal(r.expectedCommand, undefined);
  }
  assert.equal((parseMemoryRecord({ ...rationale, expectedCommand: "é".repeat(200) }) as RationaleRecord).expectedCommand?.length, 200);
  const astral = parseMemoryRecord({ ...rationale, expectedCommand: "🚀".repeat(200) }) as RationaleRecord;
  assert.equal([...(astral.expectedCommand ?? "")].length, 200);
  const overAstral = parseMemoryRecord({ ...rationale, expectedCommand: "🚀".repeat(201) }) as RationaleRecord;
  assert.ok(overAstral);
  assert.equal(overAstral.expectedCommand, undefined);
});

test("loadMemoryChecked stays complete with new values", () => {
  const root = mkdtempSync(join(tmpdir(), "rocky-attempt-fields-"));
  try {
    const file = join(root, "memory.jsonl");
    const stamp: AgentStamp = { vendor: "claude-code", session: "s1", agentId: "a1", toolUseId: "t1" };
    const lines = [
      JSON.stringify({ ...failure, id: "f-agent", origin: "agent", agent: stamp }),
      JSON.stringify({ ...fix, id: "x-agent", agent: stamp }),
      JSON.stringify({ ...association, id: "a-agent", agent: stamp }),
      JSON.stringify({ ...rationale, id: "r-mcp", source: "mcp", expectedCommand: "npm test" }),
      JSON.stringify({ ...rationale, id: "r-future", source: "future-lane" }),
    ];
    writeFileSync(file, lines.join("\n") + "\n");
    const result = loadMemoryChecked(file);
    assert.equal(isCompleteMemoryCoverage(result.coverage), true);
    assert.equal(result.coverage.skipped, 0);
    assert.equal(result.records.length, 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rationaleSourceLabel names mcp and unknown sources", () => {
  assert.equal(rationaleSourceLabel("mcp"), "agent noted");
  assert.equal(rationaleSourceLabel("future-lane"), "noted (future-lane)");
});
