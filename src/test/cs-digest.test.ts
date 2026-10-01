import test from "node:test";
import assert from "node:assert/strict";
import { csConceptCounts } from "../core/dictionary.js";
import { digest } from "../commands/dictionary.js";
import type { MemoryRecord } from "../core/memory-read.js";

test("counts CS concepts in week window", () => {
  const now = Date.now();
  const records: any[] = [
    { kind: "triple", id: "t1", ts: now - 1000, intent: { text: "loop iteration over rows" }, rationale: { tags: [] }, mechanism: { files: [{ path: "a.js", props: ["loop"], plusMinus: [1, 0] }], coverageStatus: "complete", truncatedFiles: 0, baseline: "captured" }, origin: "agent", cwd: "/tmp" },
  ];
  const counts = csConceptCounts(records as any, now);
  assert.ok((counts.get("control-flow") ?? 0) >= 1);
});

test("ignores records older than window or future records", () => {
  const now = Date.now();
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const records: any[] = [
    { kind: "triple", id: "t-old", ts: now - weekMs - 1000, intent: { text: "loop iteration" }, rationale: { tags: [] }, mechanism: { files: [] } },
    { kind: "triple", id: "t-future", ts: now + 5000, intent: { text: "loop iteration" }, rationale: { tags: [] }, mechanism: { files: [] } },
    { kind: "triple", id: "t-valid", ts: now - 1000, intent: { text: "loop iteration" }, rationale: { tags: [] }, mechanism: { files: [] } },
  ];
  const counts = csConceptCounts(records as any, now);
  assert.equal(counts.get("control-flow"), 1);
});

test("deduplicates records by id", () => {
  const now = Date.now();
  const records: any[] = [
    { kind: "triple", id: "dup-1", ts: now - 1000, intent: { text: "loop iteration" }, rationale: { tags: [] }, mechanism: { files: [] } },
    { kind: "triple", id: "dup-1", ts: now - 1000, intent: { text: "loop iteration" }, rationale: { tags: [] }, mechanism: { files: [] } },
  ];
  const counts = csConceptCounts(records as any, now);
  assert.equal(counts.get("control-flow"), 1);
});

test("counts concepts from note records", () => {
  const now = Date.now();
  const records: any[] = [
    { kind: "note", id: "n1", ts: now - 1000, cwd: "/tmp", cmd: "test", file: "a.js", line: 1, subject: "state mutation", answer: "update variable" },
  ];
  const counts = csConceptCounts(records as any, now);
  assert.ok((counts.get("program-state") ?? 0) >= 1);
});

test("ignores non-CS concepts", () => {
  const now = Date.now();
  const records: any[] = [
    { kind: "triple", id: "t-non-cs", ts: now - 1000, intent: { text: "idempotent retry backoff" }, rationale: { tags: ["auth"] }, mechanism: { files: [] } },
  ];
  const counts = csConceptCounts(records as any, now);
  assert.equal(counts.size, 0);
});

test("digest outputs cs pattern line when CS concepts are present", () => {
  const now = Date.now();
  const records: any[] = [
    {
      kind: "triple",
      id: "t1",
      ts: now - 1000,
      cwd: "/tmp",
      intent: { text: "loop iteration condition" },
      rationale: { text: "r", tags: ["control-flow"], source: "transcript" },
      mechanism: { files: [{ path: "a.js", props: ["loop"], plusMinus: [1, 0] }], coverageStatus: "complete", truncatedFiles: 0, baseline: "captured" },
      origin: "agent-hook",
      schemaV: 1,
      agent: "claude-code",
    },
  ];
  const sayLines: string[] = [];
  const outLines: string[] = [];
  const deps = {
    load: () => records as MemoryRecord[],
    say: (l: string) => sayLines.push(l),
    out: (l: string) => outLines.push(l),
    now,
  };

  const code = digest([], deps);
  assert.equal(code, 0);
  assert.ok(outLines.some((l) => l === "cs pattern: control-flow x1 this week. full explain in dash, question"));
  assert.ok(![...sayLines, ...outLines].join("\n").includes("?"));
});

test("digest omits cs pattern line when no CS concepts are present", () => {
  const now = Date.now();
  const records: any[] = [
    {
      kind: "triple",
      id: "t1",
      ts: now - 1000,
      cwd: "/tmp",
      intent: { text: "flexbox alignment" },
      rationale: { text: "r", tags: ["styling"], source: "transcript" },
      mechanism: { files: [{ path: "a.js", props: ["flexbox"], plusMinus: [1, 0] }], coverageStatus: "complete", truncatedFiles: 0, baseline: "captured" },
      origin: "agent-hook",
      schemaV: 1,
      agent: "claude-code",
    },
  ];
  const sayLines: string[] = [];
  const outLines: string[] = [];
  const deps = {
    load: () => records as MemoryRecord[],
    say: (l: string) => sayLines.push(l),
    out: (l: string) => outLines.push(l),
    now,
  };

  const code = digest([], deps);
  assert.equal(code, 0);
  assert.ok(!outLines.some((l) => l.startsWith("cs pattern:")));
});

test("digest sorts multiple CS concepts by count descending, then alphabetical", () => {
  const now = Date.now();
  const records: any[] = [
    {
      kind: "triple",
      id: "t1",
      ts: now - 1000,
      cwd: "/tmp",
      intent: { text: "loop iteration" },
      rationale: { text: "r", tags: ["loop"], source: "transcript" },
      mechanism: { files: [{ path: "a.js", props: ["loop"], plusMinus: [1, 0] }], coverageStatus: "complete", truncatedFiles: 0, baseline: "captured" },
      origin: "agent-hook",
      schemaV: 1,
      agent: "claude-code",
    },
    {
      kind: "triple",
      id: "t2",
      ts: now - 2000,
      cwd: "/tmp",
      intent: { text: "state mutation invariant update" },
      rationale: { text: "r", tags: ["state"], source: "transcript" },
      mechanism: { files: [{ path: "b.js", props: ["state"], plusMinus: [1, 0] }], coverageStatus: "complete", truncatedFiles: 0, baseline: "captured" },
      origin: "agent-hook",
      schemaV: 1,
      agent: "claude-code",
    },
    {
      kind: "triple",
      id: "t3",
      ts: now - 3000,
      cwd: "/tmp",
      intent: { text: "mutation update state" },
      rationale: { text: "r", tags: ["state"], source: "transcript" },
      mechanism: { files: [{ path: "c.js", props: ["state"], plusMinus: [1, 0] }], coverageStatus: "complete", truncatedFiles: 0, baseline: "captured" },
      origin: "agent-hook",
      schemaV: 1,
      agent: "claude-code",
    },
  ];
  const sayLines: string[] = [];
  const outLines: string[] = [];
  const deps = {
    load: () => records as MemoryRecord[],
    say: (l: string) => sayLines.push(l),
    out: (l: string) => outLines.push(l),
    now,
  };

  const code = digest([], deps);
  assert.equal(code, 0);
  assert.ok(outLines.some((l) => l === "cs pattern: program-state x2 this week. full explain in dash, question"));
});
