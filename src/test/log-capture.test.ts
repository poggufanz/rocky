import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RationaleRecord } from "../core/memory-read.js";
import type { CanonicalRationaleEvent, LogAdapter } from "../agent/logs/types.js";

function isRationale(record: { kind: string }): record is RationaleRecord {
  return record.kind === "rationale";
}

test("capture links structurally, weak-links by window, leaves ambiguity unlinked, dedupes on rerun", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rocky-cap-")));
  process.env.ROCKY_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = home;
  const repo = "/work/repo";
  const { recordWatchFailure } = await import("../core/memory.js");
  const failure = recordWatchFailure("npm test", 1, "Error: q timeout", repo);
  const dir = join(home, "projects", "-work-repo");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "s1.jsonl"),
    JSON.stringify({ sessionId: "s1", uuid: "u1", cwd: repo, timestamp: new Date(failure.ts + 60_000).toISOString(), type: "assistant",
      message: { content: [{ type: "thinking", thinking: "queue timeout because retry storm" }] } }) + "\n" +
    JSON.stringify({ sessionId: "s1", uuid: "u2", cwd: repo, timestamp: new Date(failure.ts + 3 * 3600_000).toISOString(), type: "assistant",
      message: { content: [{ type: "thinking", thinking: "unrelated far-future thought" }] } }) + "\n");
  const { captureRationales } = await import("../agent/logs/capture.js");
  const first = captureRationales(repo, failure.ts + 4 * 3600_000);
  assert.equal(first.written, 2);
  assert.equal(first.unlinked, 1); // far-future one has no window match
  const again = captureRationales(repo, failure.ts + 4 * 3600_000);
  assert.equal(again.written, 0, "offset dedupe: nothing new");
  const { loadMemory } = await import("../core/memory-read.js");
  const rationales = loadMemory().filter(isRationale);
  assert.equal(rationales.length, 2);
  const linked = rationales.find((r) => r.links?.failureId === failure.id);
  assert.ok(linked, "near-in-time thinking weak-links to failure");
});

test("captures a structural link when a touched file matches a recorded triple, taking precedence over a genuinely closer-in-time weak candidate", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rocky-cap-struct-")));
  process.env.ROCKY_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = home;
  const repo = "/work/repo2";
  const { recordTriple } = await import("../core/memory.js");
  const tripleTs = 2_000_000;
  const eventTs = tripleTs + 5 * 60_000; // event is 5 min after the triple
  const triple = recordTriple({
    ts: tripleTs,
    cwd: repo,
    agent: "claude-code",
    mechanism: { files: [{ path: "/work/repo2/src/q.ts", plusMinus: [1, 1], props: [] }], truncatedFiles: 0 },
  });
  // Seed a same-cwd failure only 1 minute before the event (vs. the triple's
  // 5 minutes) — a genuine, eligible weak-link candidate that is strictly
  // NEARER in time than the triple. recordWatchFailure always stamps
  // ts = Date.now(), which would land far outside this test's controlled
  // 2026-epoch-relative clock and never be a real candidate at all, so this
  // failure is appended directly with an explicit ts inside the frame.
  // If correlation ever regressed to "nearest evidence overall" instead of
  // "structural first, unconditionally", this closer failure would win
  // instead of the triple — that regression is exactly what this asserts against.
  const competingFailureTs = eventTs - 60_000;
  assert.ok(Math.abs(competingFailureTs - eventTs) < Math.abs(tripleTs - eventTs), "failure is set up closer in time than the triple");
  const competingFailure = {
    kind: "failure", id: "competing-failure-1", ts: competingFailureTs, cwd: repo,
    cmd: "npm test", exitCode: 1, fingerprint: "unrelated-fingerprint",
    signature: ["Error: unrelated"], excerpt: "Error: unrelated",
  };
  appendFileSync(join(home, "memory.jsonl"), `${JSON.stringify(competingFailure)}\n`, "utf8");
  const dir = join(home, "projects", "-work-repo2");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "s1.jsonl"),
    JSON.stringify({ sessionId: "s1", uuid: "u1", cwd: repo, timestamp: new Date(eventTs).toISOString(), type: "assistant",
      message: { content: [
        { type: "thinking", thinking: "fix queue timeout in q.ts" },
        { type: "tool_use", name: "Edit", input: { file_path: "/work/repo2/src/q.ts" } },
      ] } }) + "\n");
  const { captureRationales } = await import("../agent/logs/capture.js");
  const result = captureRationales(repo, tripleTs + 6 * 60_000);
  assert.equal(result.written, 1);
  assert.equal(result.unlinked, 0);
  const { loadMemory } = await import("../core/memory-read.js");
  const rationale = loadMemory().filter(isRationale).find((r) => r.pointer?.turnRef === "u1");
  assert.ok(rationale, "event was recorded");
  assert.equal(rationale?.links?.tripleId, triple.id, "structural file match wins over a nearer-in-time weak candidate");
  assert.equal(rationale?.links?.failureId, undefined, "the closer failure never wins despite being nearer in time");
});

test("an adapter/scan failure never throws, records a skip reason, still completes the other adapter's file, and never advances the failed file's offset", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rocky-cap-fail-")));
  process.env.ROCKY_HOME = home;
  const repo = "/work/repo3";
  const failingLogPath = "/fake/failing.jsonl";
  const workingLogPath = "/fake/working.jsonl";
  const failingAdapter: LogAdapter = {
    agent: "claude-code",
    discover: () => [failingLogPath],
    scan: () => { throw new Error("boom: scan exploded"); },
  };
  const workingEvent: CanonicalRationaleEvent = {
    agent: "dsh", sessionId: "s9", turnRef: "9", ts: 1000, text: "a working thought",
    fidelity: "raw", source: "log-thinking", logPath: workingLogPath,
  };
  const workingAdapter: LogAdapter = {
    agent: "dsh",
    discover: () => [workingLogPath],
    scan: () => ({ events: [workingEvent], nextOffset: 42 }),
  };
  const { captureRationales } = await import("../agent/logs/capture.js");
  const result = captureRationales(repo, 5000, { adapters: [failingAdapter, workingAdapter] });
  assert.equal(result.written, 1, "the working adapter's event is still written despite the other adapter failing");
  assert.equal(result.unlinked, 1);
  assert.ok(
    result.skipped.some((line) => line.includes(failingLogPath) && line.includes("boom: scan exploded")),
    "skip reason names the failing file and the underlying error",
  );
  const { readAdapterOffsets } = await import("../agent/logs/scan.js");
  const offsets = readAdapterOffsets();
  assert.equal(offsets[failingLogPath], undefined, "the failed file's offset never advances");
  assert.equal(offsets[workingLogPath], 42, "the succeeding file's offset still advances");
});

test("captureRationales never throws and reports a bounded result on a repo with no discoverable logs", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rocky-cap-empty-")));
  process.env.ROCKY_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = home;
  const { captureRationales } = await import("../agent/logs/capture.js");
  const result = captureRationales("/no/such/repo");
  assert.equal(result.written, 0);
  assert.equal(result.unlinked, 0);
  assert.deepEqual(result.skipped, []);
});
