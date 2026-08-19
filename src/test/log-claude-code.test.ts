import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function line(obj: object): string { return JSON.stringify(obj) + "\n"; }

test("extracts thinking as raw and reply text as summary fallback, cwd-filtered", async (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rocky-cclog-")));
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = home;
  t.after(() => {
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  });
  const repo = "/work/repo";
  const dir = join(home, "projects", "-work-repo");
  mkdirSync(dir, { recursive: true });
  const log = join(dir, "sess-1.jsonl");
  writeFileSync(log,
    line({ sessionId: "sess-1", uuid: "u1", cwd: repo, timestamp: "2026-08-19T01:00:00Z", type: "assistant",
      message: { content: [{ type: "thinking", thinking: "retry lacks backoff, choose exponential" }, { type: "tool_use", name: "Edit", input: { file_path: "/work/repo/src/q.ts" } }] } }) +
    line({ sessionId: "sess-1", uuid: "u2", cwd: repo, timestamp: "2026-08-19T01:01:00Z", type: "assistant",
      message: { content: [{ type: "text", text: "changed q.ts because queue redelivered jobs" }] } }) +
    line({ sessionId: "sess-1", uuid: "u3", cwd: "/other", timestamp: "2026-08-19T01:02:00Z", type: "assistant",
      message: { content: [{ type: "thinking", thinking: "other repo noise" }] } }));
  const { claudeCodeLogAdapter } = await import("../agent/logs/claude-code.js");
  const files = claudeCodeLogAdapter.discover(repo);
  assert.deepEqual(files, [log]);
  const { events } = claudeCodeLogAdapter.scan(repo, log, 0, 1024 * 1024);
  const raw = events.find((e) => e.fidelity === "raw");
  const summary = events.find((e) => e.fidelity === "summary");
  assert.ok(raw && raw.turnRef === "u1" && raw.source === "log-thinking");
  assert.ok(summary && summary.turnRef === "u2" && summary.source === "log-response");
  assert.equal(events.length, 2, "cross-repo record filtered out");
});
