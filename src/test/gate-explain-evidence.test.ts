import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { explainCheck, gateEvent, rationaleCheck, type GateInput, type GateState } from "../agent/gate.js";
import { recordExplain, recordRationale } from "../core/memory.js";

function memState(): GateState {
  const seen = new Set<string>();
  return {
    has: (key) => seen.has(key),
    mark: (key) => { seen.add(key); return true; },
  };
}

function gateInput(cwd: string, filePath: string): GateInput {
  return { vendor: "claude-code", toolName: "Edit", filePath, sessionKey: "s-1", cwd };
}

function withSandboxHome<T>(fn: () => T): T {
  const home = mkdtempSync(join(tmpdir(), "rocky-gate-explain-"));
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

test("gate allows first sight when fresh file-linked explain evidence exists", () => {
  withSandboxHome(() => {
    const cwd = "C:\\work\\repo";
    recordExplain({
      cwd, path: "src\\parser.ts", source: "notify",
      code: "switch retry to idempotency key", business: "duplicate settlement seen",
      ts: Date.now() - 60_000,
    });
    const decision = explainCheck.evaluate(gateInput(cwd, "src\\parser.ts"), memState());
    assert.deepEqual(decision, { deny: false });
  });
});

test("gate denies once with followable instruction when no explain evidence exists", () => {
  withSandboxHome(() => {
    const cwd = "C:\\work\\repo";
    const state = memState();
    const first = explainCheck.evaluate(gateInput(cwd, "src\\lonely.ts"), state);
    assert.equal(first.deny, true);
    if (first.deny === true) {
      assert.match(first.reason, /rocky hook agent-event/);
      assert.match(first.reason, /--explain-code/);
      assert.match(first.reason, /, question/);
    }
    const second = explainCheck.evaluate(gateInput(cwd, "src\\lonely.ts"), state);
    assert.deepEqual(second, { deny: false });
  });
});

test("stale explain evidence outside the window does not satisfy the gate", () => {
  withSandboxHome(() => {
    const cwd = "C:\\work\\repo";
    recordExplain({
      cwd, path: "src\\old.ts", source: "notify",
      code: "old shape reason", business: "old concern",
      ts: Date.now() - 9 * 60 * 60 * 1000,
    });
    const decision = explainCheck.evaluate(gateInput(cwd, "src\\old.ts"), memState());
    assert.equal(decision.deny, true);
  });
});

test("explain and rationale keys do not collide", () => {
  withSandboxHome(() => {
    const cwd = "C:\\work\\repo";
    recordRationale({
      cwd, agent: "generic", rationale_fidelity: "summary", source: "notify",
      text: "rationale only, no explain", files: ["src\\solo.ts"], ts: Date.now() - 60_000,
    });
    assert.equal(rationaleCheck.evaluate(gateInput(cwd, "src\\solo.ts"), memState()).deny, false);
    assert.equal(explainCheck.evaluate(gateInput(cwd, "src\\solo.ts"), memState()).deny, true);
  });
});

test("gateEvent recognizes and gates tool_input.path when file_path is omitted", () => {
  withSandboxHome(() => {
    const stdin = JSON.stringify({
      session_id: "s-path-fallback",
      tool_name: "Edit",
      tool_input: { path: "src/fallback.ts" },
      cwd: "C:\\work\\repo",
    });
    const result = gateEvent("claude-code", stdin);
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
    assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /src\/fallback\.ts/);
  });
});

test("strict mode denies persistently until explain evidence lands", async () => {
  const home = mkdtempSync(join(tmpdir(), "rocky-gate-strict-"));
  const previousHome = process.env.ROCKY_HOME;
  const previousMode = process.env.ROCKY_GATE_MODE;
  process.env.ROCKY_HOME = home;
  process.env.ROCKY_GATE_MODE = "strict";
  try {
    const { gateEvent } = await import("../agent/gate.js");
    const { recordExplain } = await import("../core/memory.js");
    const stdin = JSON.stringify({ session_id: "strict-1", tool_name: "Edit", tool_input: { file_path: "/work/repo/src/hard.ts" }, cwd: "/work/repo" });
    assert.equal(JSON.parse(gateEvent("claude-code", stdin).stdout).hookSpecificOutput.permissionDecision, "deny");
    assert.equal(JSON.parse(gateEvent("claude-code", stdin).stdout).hookSpecificOutput.permissionDecision, "deny", "strict never fails open without evidence");
    recordExplain({ cwd: "/work/repo", path: "/work/repo/src/hard.ts", source: "notify", code: "why this shape is needed", business: "what concern this serves", ts: Date.now() });
    const cwd = "/work/repo";
    const { explainCheck: strictExplain } = await import("../agent/gate.js");
    assert.deepEqual(strictExplain.evaluate(
      { vendor: "claude-code", toolName: "Edit", filePath: "/work/repo/src/hard.ts", sessionKey: "strict-1", cwd },
      { has: () => false, mark: () => true },
    ), { deny: false });
  } finally {
    if (previousHome === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previousHome;
    if (previousMode === undefined) delete process.env.ROCKY_GATE_MODE;
    else process.env.ROCKY_GATE_MODE = previousMode;
    rmSync(home, { recursive: true, force: true });
  }
});

test("human override env allows everything and audits", async () => {
  const home = mkdtempSync(join(tmpdir(), "rocky-gate-override-"));
  const previousHome = process.env.ROCKY_HOME;
  const previousOverride = process.env.ROCKY_GATE_OVERRIDE;
  process.env.ROCKY_HOME = home;
  process.env.ROCKY_GATE_OVERRIDE = "1";
  try {
    const { gateEvent } = await import("../agent/gate.js");
    const stdin = JSON.stringify({ session_id: "ovr-1", tool_name: "Edit", tool_input: { file_path: "/work/repo/src/any.ts" }, cwd: "/work/repo" });
    assert.equal(gateEvent("claude-code", stdin).stdout, "{}");
  } finally {
    if (previousHome === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previousHome;
    if (previousOverride === undefined) delete process.env.ROCKY_GATE_OVERRIDE;
    else process.env.ROCKY_GATE_OVERRIDE = previousOverride;
    rmSync(home, { recursive: true, force: true });
  }
});

