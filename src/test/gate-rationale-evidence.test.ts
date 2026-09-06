import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateEvent, rationaleCheck, type GateInput, type GateState } from "../agent/gate.js";
import { recordRationale } from "../core/memory.js";
import { loadMemory } from "../core/memory-read.js";
import { resolveRockyPaths } from "../core/state-paths.js";
import { agentEvent } from "../commands/agent-hook.js";

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

/** Run `fn` with ROCKY_HOME pointed at a fresh sandbox; restore afterward. */
function withSandboxHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "rocky-gate-evidence-"));
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  try {
    return fn(home);
  } finally {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

test("recordRationale stores a bounded files list and the parser round-trips it", () => {
  withSandboxHome(() => {
    const paths = resolveRockyPaths();
    const many = Array.from({ length: 12 }, (_, i) => `src/file-${i}.ts`);
    recordRationale({
      cwd: "/w", agent: "generic", rationale_fidelity: "summary", source: "notify",
      text: "bounded files round trip", files: many, ts: 1_800_000_000_000,
    }, paths);
    const records = loadMemory(paths.memory, 1_800_000_000_001);
    const rationale = records.find((r) => r.kind === "rationale");
    assert.ok(rationale && rationale.kind === "rationale");
    assert.ok(Array.isArray(rationale.files), "files must survive the parse round trip");
    assert.equal(rationale.files.length, 8, "files list is capped at 8 entries");
    assert.equal(rationale.files[0], "src/file-0.ts");
  });
});

test("agent-event generic --files lands on the stored rationale record", async () => {
  const home = mkdtempSync(join(tmpdir(), "rocky-gate-evidence-async-"));
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  try {
    const paths = resolveRockyPaths();
    const code = await agentEvent("generic", {
      rationale: "notify files must persist",
      files: ["src/a.ts", "src/b.ts"],
      paths,
    } as never);
    assert.equal(code, 0);
    const records = loadMemory(paths.memory, Date.now());
    const rationale = records.find((r) => r.kind === "rationale");
    assert.ok(rationale && rationale.kind === "rationale");
    assert.deepEqual(rationale.files, ["src/a.ts", "src/b.ts"]);
  } finally {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("gate allows first sight when fresh file-linked rationale evidence exists", () => {
  withSandboxHome(() => {
    const paths = resolveRockyPaths();
    const cwd = "C:\\work\\repo";
    const now = Date.now();
    recordRationale({
      cwd, agent: "generic", rationale_fidelity: "summary", source: "notify",
      text: "about to refactor parser", files: ["src\\parser.ts"], ts: now - 60_000,
    }, paths);
    const decision = rationaleCheck.evaluate(gateInput(cwd, "src\\parser.ts"), memState());
    assert.deepEqual(decision, { deny: false }, "fresh file-linked evidence must satisfy the gate");
  });
});

test("gate still denies once when no file-linked evidence exists, then fails open", () => {
  withSandboxHome(() => {
    const cwd = "C:\\work\\repo";
    const state = memState();
    const first = rationaleCheck.evaluate(gateInput(cwd, "src\\lonely.ts"), state);
    assert.equal(first.deny, true, "no evidence: first sight denies once");
    const second = rationaleCheck.evaluate(gateInput(cwd, "src\\lonely.ts"), state);
    assert.deepEqual(second, { deny: false }, "second sight fails open");
  });
});

test("stale file-linked evidence outside the window does not satisfy the gate", () => {
  withSandboxHome(() => {
    const paths = resolveRockyPaths();
    const cwd = "C:\\work\\repo";
    const nineHoursAgo = Date.now() - 9 * 60 * 60 * 1000;
    recordRationale({
      cwd, agent: "generic", rationale_fidelity: "summary", source: "notify",
      text: "long ago", files: ["src\\old.ts"], ts: nineHoursAgo,
    }, paths);
    const decision = rationaleCheck.evaluate(gateInput(cwd, "src\\old.ts"), memState());
    assert.equal(decision.deny, true, "stale evidence must not open the gate");
  });
});

test("fifty gate evaluations over 5000 memory lines finish under 5 seconds", () => {
  withSandboxHome(() => {
    const paths = resolveRockyPaths();
    const cwd = "C:\\work\\repo";
    const now = Date.now();
    for (let i = 0; i < 5000; i++) {
      recordRationale({
        cwd, agent: "generic", rationale_fidelity: "summary", source: "notify",
        text: `bulk rationale ${i}`, files: [`src\\bulk-${i % 100}.ts`], ts: now - 1000,
      }, paths);
    }
    const started = Date.now();
    for (let i = 0; i < 50; i++) {
      rationaleCheck.evaluate(gateInput(cwd, "src\\bulk-7.ts"), memState());
    }
    assert.ok(Date.now() - started < 5000, "evidence lookup must use the index, not a full scan per call");
  });
});

test("deny decisions append one bounded audit line", async () => {
  const home = mkdtempSync(join(tmpdir(), "rocky-gate-audit-"));
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  try {
    const { gateEvent } = await import("../agent/gate.js");
    const stdin = JSON.stringify({ session_id: "audit-1", tool_name: "Edit", tool_input: { file_path: "/work/repo/src/audit-me.ts" }, cwd: "/work/repo" });
    const first = gateEvent("claude-code", stdin);
    assert.equal(JSON.parse(first.stdout).hookSpecificOutput.permissionDecision, "deny");
    const { readFileSync, existsSync } = await import("node:fs");
    const auditFile = join(home, "gate-state", "audit.jsonl");
    assert.equal(existsSync(auditFile), true);
    const lines = readFileSync(auditFile, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0] as string) as Record<string, unknown>;
    assert.equal(entry.session, "audit-1");
    assert.equal(entry.decision, "deny");
  } finally {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

