import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryRecord, RationaleRecord, RationaleSource, TripleRecord } from "../core/memory-read.js";
import { rationaleSourceLabel, why } from "../commands/dictionary.js";

test("why --add writes human rationale linked to latest failure", async () => {
  process.env.ROCKY_HOME = realpathSync(mkdtempSync(join(tmpdir(), "rocky-why-")));
  const { recordWatchFailure } = await import("../core/memory.js");
  const failure = recordWatchFailure("npm test", 1, "Error: boom", process.cwd());
  const code = why(["--add", "flaky because tmpdir symlink"]);
  assert.equal(code, 0);
  const { loadMemory } = await import("../core/memory-read.js");
  const rec = loadMemory().find((r) => r.kind === "rationale");
  assert.ok(rec);
  assert.equal((rec as { source: string }).source, "human");
  assert.equal((rec as { links?: { failureId?: string } }).links?.failureId, failure.id);
});

test("why --add with empty memory still records unlinked", async () => {
  process.env.ROCKY_HOME = realpathSync(mkdtempSync(join(tmpdir(), "rocky-why2-")));
  assert.equal(why(["--add", "context note"]), 0);
  const { loadMemory } = await import("../core/memory-read.js");
  const rec = loadMemory().find((r) => r.kind === "rationale");
  assert.ok(rec);
  assert.equal((rec as RationaleRecord).links, undefined);
});

test("why --add refuses empty text and writes nothing", async () => {
  process.env.ROCKY_HOME = realpathSync(mkdtempSync(join(tmpdir(), "rocky-why3-")));
  assert.equal(why(["--add"]), 1);
  assert.equal(why(["--add", "   "]), 1);
  const { loadMemory } = await import("../core/memory-read.js");
  assert.equal(loadMemory().some((r) => r.kind === "rationale"), false);
});

test("rationaleSourceLabel returns the four voice-approved labels", () => {
  assert.equal(rationaleSourceLabel("log-thinking"), "heard from thinking");
  assert.equal(rationaleSourceLabel("log-response"), "agent said in reply");
  assert.equal(rationaleSourceLabel("notify"), "agent said");
  assert.equal(rationaleSourceLabel("human"), "you said");
});

test("why labels source of every rationale record linked to a matched triple", () => {
  const now = Date.now();
  const path = "src/app.css";
  const triple: TripleRecord = {
    kind: "triple", id: "triple-1", ts: now - 1000, cwd: "/repo", platform: "linux",
    schemaV: 1, agent: "codex", origin: "agent-hook",
    intent: { text: "fix margin" },
    mechanism: {
      files: [{ path, plusMinus: [3, 1], props: ["margin-top"], provenance: "tool-observed" }],
      truncatedFiles: 0, baseline: "captured", coverageStatus: "complete",
    },
  };
  const makeRationale = (id: string, source: RationaleSource, excerpt: string, tripleId = "triple-1"): RationaleRecord => ({
    kind: "rationale", id, ts: now, v: 1, cwd: "/repo",
    agent: source === "human" ? "human" : "claude-code",
    rationale_fidelity: "summary", source, excerpt,
    links: { tripleId },
  });
  const memory: MemoryRecord[] = [
    triple,
    makeRationale("r-think", "log-thinking", "excerpt-think"),
    makeRationale("r-reply", "log-response", "excerpt-reply"),
    makeRationale("r-notify", "notify", "excerpt-notify"),
    makeRationale("r-human", "human", "excerpt-human"),
    makeRationale("r-unlinked", "human", "excerpt-unlinked", "some-other-triple"),
  ];
  const sayLines: string[] = [];
  assert.equal(why([path], { load: () => memory, say: (line) => sayLines.push(line), now }), 0);
  assert.ok(sayLines.includes("heard from thinking: excerpt-think"));
  assert.ok(sayLines.includes("agent said in reply: excerpt-reply"));
  assert.ok(sayLines.includes("agent said: excerpt-notify"));
  assert.ok(sayLines.includes("you said: excerpt-human"));
  assert.ok(!sayLines.some((line) => line.includes("excerpt-unlinked")));
});

test("why with no linked rationale prints exactly what it printed before this feature", () => {
  const now = Date.now();
  const path = "src/app.css";
  const triple: TripleRecord = {
    kind: "triple", id: "triple-2", ts: now - 1000, cwd: "/repo", platform: "linux",
    schemaV: 1, agent: "codex", origin: "agent-hook",
    intent: { text: "fix margin" },
    mechanism: {
      files: [{ path, plusMinus: [3, 1], props: ["margin-top"], provenance: "tool-observed" }],
      truncatedFiles: 0, baseline: "captured", coverageStatus: "complete",
    },
  };
  const sayLines: string[] = [];
  assert.equal(why([path], { load: () => [triple], say: (line) => sayLines.push(line), now }), 0);
  assert.deepEqual(sayLines, ["change happen. no reason I hear."]);
});
