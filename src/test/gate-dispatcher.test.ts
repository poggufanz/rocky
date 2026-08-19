import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function preToolUse(file: string): string {
  return JSON.stringify({ session_id: "s1", tool_name: "Edit", tool_input: { file_path: file }, cwd: "/work/repo" });
}

function withRockyHome(t: import("node:test").TestContext, home: string): void {
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
  });
}

test("first edit denied with instruction, retry after rationale allowed", async (t) => {
  withRockyHome(t, realpathSync(mkdtempSync(join(tmpdir(), "rocky-gate-"))));
  const { gateEvent } = await import("../agent/gate.js");
  const first = gateEvent("claude-code", preToolUse("/work/repo/src/q.ts"));
  assert.equal(first.exitCode, 0);
  const parsed = JSON.parse(first.stdout);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /rocky hook agent-event/);
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /, question/);
  const second = gateEvent("claude-code", preToolUse("/work/repo/src/q.ts"));
  assert.equal(second.stdout, "{}", "same file second time allowed");
  const other = gateEvent("claude-code", preToolUse("/work/repo/src/other.ts"));
  assert.equal(JSON.parse(other.stdout).hookSpecificOutput.permissionDecision, "deny", "new file gated");
});

test("opt-out env allows everything", async (t) => {
  withRockyHome(t, realpathSync(mkdtempSync(join(tmpdir(), "rocky-gate2-"))));
  const previousGate = process.env.ROCKY_RATIONALE_GATE;
  process.env.ROCKY_RATIONALE_GATE = "off";
  t.after(() => {
    if (previousGate === undefined) delete process.env.ROCKY_RATIONALE_GATE;
    else process.env.ROCKY_RATIONALE_GATE = previousGate;
  });
  const { gateEvent } = await import("../agent/gate.js");
  assert.equal(gateEvent("claude-code", preToolUse("/a.ts")).stdout, "{}");
});

test("corrupt stdin and corrupt state fail open", async (t) => {
  withRockyHome(t, realpathSync(mkdtempSync(join(tmpdir(), "rocky-gate3-"))));
  const { gateEvent } = await import("../agent/gate.js");
  assert.equal(gateEvent("claude-code", "NOT JSON").stdout, "{}");
  const stateDir = join(process.env.ROCKY_HOME!, "gate-state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "s1.jsonl"), "garbage\n");
  assert.equal(gateEvent("claude-code", preToolUse("/b.ts")).exitCode, 0);
});

test("unsafe or missing session_id fails open without touching gate-state", async (t) => {
  withRockyHome(t, realpathSync(mkdtempSync(join(tmpdir(), "rocky-gate4-"))));
  const { gateEvent } = await import("../agent/gate.js");
  const noSession = JSON.stringify({ tool_name: "Edit", tool_input: { file_path: "/c.ts" }, cwd: "/work/repo" });
  assert.equal(gateEvent("claude-code", noSession).stdout, "{}");
  const traversal = JSON.stringify({
    session_id: "../../../evil",
    tool_name: "Edit",
    tool_input: { file_path: "/c.ts" },
    cwd: "/work/repo",
  });
  const result = gateEvent("claude-code", traversal);
  assert.equal(result.exitCode, 0);
});

test("non-gated tool and missing file_path allow", async (t) => {
  withRockyHome(t, realpathSync(mkdtempSync(join(tmpdir(), "rocky-gate5-"))));
  const { gateEvent } = await import("../agent/gate.js");
  const bash = JSON.stringify({ session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" }, cwd: "/work/repo" });
  assert.equal(gateEvent("claude-code", bash).stdout, "{}");
  const noPath = JSON.stringify({ session_id: "s1", tool_name: "Edit", tool_input: {}, cwd: "/work/repo" });
  assert.equal(gateEvent("claude-code", noPath).stdout, "{}");
});

test("MultiEdit gates on its single tool_input.file_path", async (t) => {
  withRockyHome(t, realpathSync(mkdtempSync(join(tmpdir(), "rocky-gate6-"))));
  const { gateEvent } = await import("../agent/gate.js");
  const multi = JSON.stringify({
    session_id: "s1",
    tool_name: "MultiEdit",
    tool_input: { file_path: "/work/repo/src/m.ts", edits: [{ old_string: "a", new_string: "b" }] },
    cwd: "/work/repo",
  });
  const first = gateEvent("claude-code", multi);
  assert.equal(JSON.parse(first.stdout).hookSpecificOutput.permissionDecision, "deny");
  const second = gateEvent("claude-code", multi);
  assert.equal(second.stdout, "{}");
});
