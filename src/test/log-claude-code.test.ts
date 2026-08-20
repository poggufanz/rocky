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
  assert.deepEqual(raw?.touchedFiles, ["/work/repo/src/q.ts"], "Edit tool_use in the same turn is captured");
  assert.equal(summary?.touchedFiles, undefined, "u2's turn touched no files");
});

test("discover falls back to head probe when the slug misses, tolerating a summary first record", async (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rocky-cclog-probe-")));
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = home;
  t.after(() => {
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  });
  const repo = "/work/probe-repo";
  // Dir name deliberately does NOT match the slug for repo.
  const dir = join(home, "projects", "odd-dir-name");
  mkdirSync(dir, { recursive: true });
  const log = join(dir, "sess-2.jsonl");
  writeFileSync(log,
    // Post-compaction head: a summary record carries no cwd at all.
    line({ type: "summary", summary: "compacted earlier context", leafUuid: "u0" }) +
    line({ sessionId: "sess-2", uuid: "u1", cwd: repo, timestamp: "2026-08-19T01:00:00Z", type: "assistant",
      message: { content: [{ type: "text", text: "hi" }] } }));
  const { claudeCodeLogAdapter } = await import("../agent/logs/claude-code.js");
  assert.deepEqual(claudeCodeLogAdapter.discover(repo), [log]);
});

test("one turn with two thinking entries emits two raw events and suppresses the reply text", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rocky-cclog-multi-")));
  const dir = join(home, "projects", "-work-repo");
  mkdirSync(dir, { recursive: true });
  const repo = "/work/repo";
  const log = join(dir, "sess-3.jsonl");
  writeFileSync(log,
    line({ sessionId: "sess-3", uuid: "u1", cwd: repo, timestamp: "2026-08-19T01:00:00Z", type: "assistant",
      message: { content: [
        { type: "thinking", thinking: "first thought" },
        { type: "text", text: "reply that must not be emitted" },
        { type: "thinking", thinking: "second thought" },
      ] } }));
  const { claudeCodeLogAdapter } = await import("../agent/logs/claude-code.js");
  const { events } = claudeCodeLogAdapter.scan(repo, log, 0, 1024 * 1024);
  assert.equal(events.length, 2);
  assert.ok(events.every((e) => e.fidelity === "raw" && e.source === "log-thinking" && e.turnRef === "u1"));
  assert.deepEqual(events.map((e) => e.text), ["first thought", "second thought"]);
});

if (process.platform === "win32") {
  test("cwd comparison is case-insensitive on Windows drive letters", async (t) => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "rocky-cclog-case-")));
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = home;
    t.after(() => {
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    });
    const repo = "C:\\Work\\Repo";
    // Slug cannot match (drive-letter case variance); probe must accept.
    const dir = join(home, "projects", "c--work-repo-other");
    mkdirSync(dir, { recursive: true });
    const log = join(dir, "sess-4.jsonl");
    writeFileSync(log,
      line({ sessionId: "sess-4", uuid: "u1", cwd: "c:\\work\\repo", timestamp: "2026-08-19T01:00:00Z", type: "assistant",
        message: { content: [{ type: "thinking", thinking: "case variant cwd" }] } }));
    const { claudeCodeLogAdapter } = await import("../agent/logs/claude-code.js");
    assert.deepEqual(claudeCodeLogAdapter.discover(repo), [log]);
    const { events } = claudeCodeLogAdapter.scan(repo, log, 0, 1024 * 1024);
    assert.equal(events.length, 1);
    assert.equal(events[0].text, "case variant cwd");
  });
}
