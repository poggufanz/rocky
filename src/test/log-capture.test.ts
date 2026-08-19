import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RationaleRecord } from "../core/memory-read.js";

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

test("captures a structural link when a touched file matches a recorded triple, taking precedence over a weaker time-only match", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rocky-cap-struct-")));
  process.env.ROCKY_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = home;
  const repo = "/work/repo2";
  const { recordTriple, recordWatchFailure } = await import("../core/memory.js");
  const tripleTs = 2_000_000;
  const triple = recordTriple({
    ts: tripleTs,
    cwd: repo,
    agent: "claude-code",
    mechanism: { files: [{ path: "/work/repo2/src/q.ts", plusMinus: [1, 1], props: [] }], truncatedFiles: 0 },
  });
  // A same-cwd failure sits closer in time than the triple, so a naive
  // nearest-in-time rule would weak-link to it instead — structural
  // matching on the touched file must win regardless.
  recordWatchFailure("npm test", 1, "Error: unrelated", repo);
  const dir = join(home, "projects", "-work-repo2");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "s1.jsonl"),
    JSON.stringify({ sessionId: "s1", uuid: "u1", cwd: repo, timestamp: new Date(tripleTs + 5 * 60_000).toISOString(), type: "assistant",
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
  assert.equal(rationale?.links?.tripleId, triple.id, "structural file match wins over a weak time-only match");
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
