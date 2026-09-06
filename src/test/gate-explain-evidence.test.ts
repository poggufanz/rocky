import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { explainCheck, type GateInput, type GateState } from "../agent/gate.js";
import { recordExplain } from "../core/memory.js";

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

test("explain and rationale keys do not collide", async () => {
  withSandboxHome(async () => {
    const { rationaleCheck } = await import("../agent/gate.js");
    const { recordRationale } = await import("../core/memory.js");
    const cwd = "C:\\work\\repo";
    recordRationale({
      cwd, agent: "generic", rationale_fidelity: "summary", source: "notify",
      text: "rationale only, no explain", files: ["src\\solo.ts"], ts: Date.now() - 60_000,
    });
    assert.equal(rationaleCheck.evaluate(gateInput(cwd, "src\\solo.ts"), memState()).deny, false);
    assert.equal(explainCheck.evaluate(gateInput(cwd, "src\\solo.ts"), memState()).deny, true);
  });
});
