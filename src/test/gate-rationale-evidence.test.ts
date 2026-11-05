import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { explainCheck, gateEvent, rationaleCheck, type GateInput, type GateState } from "../agent/gate.js";
import { recordRationale } from "../core/memory.js";
import { loadMemory, loadMemoryChecked, MAX_SUPPORTED_MEMORY_RECORDS } from "../core/memory-read.js";
import { resolveRockyPaths } from "../core/state-paths.js";
import { agentEvent } from "../commands/agent-hook.js";
import { failureLines, failureLinesPastByteCap } from "./memory-cap-fixture.js";

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
    const lines: string[] = [];
    for (let i = 0; i < 5000; i++) {
      lines.push(JSON.stringify({
        kind: "rationale",
        id: `bulk-${i}`,
        ts: now - 1000,
        v: 1,
        cwd,
        agent: "generic",
        rationale_fidelity: "summary",
        source: "notify",
        excerpt: `bulk rationale ${i}`,
        files: [`src\\bulk-${i % 100}.ts`],
      }));
    }
    writeFileSync(paths.memory, lines.join("\n") + "\n", "utf8");
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

test("audit log rotates to audit.1.jsonl when exceeding byte limit", async () => {
  const home = mkdtempSync(join(tmpdir(), "rocky-gate-audit-rot-"));
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  try {
    const { gateEvent } = await import("../agent/gate.js");
    const { writeFileSync, mkdirSync, existsSync, readFileSync } = await import("node:fs");
    const auditDir = join(home, "gate-state");
    mkdirSync(auditDir, { recursive: true });
    const auditFile = join(auditDir, "audit.jsonl");
    const rotatedFile = join(auditDir, "audit.1.jsonl");
    // Write 65 KB to trigger rotation (> 64 * 1024)
    const largeData = "x".repeat(65 * 1024) + "\n";
    writeFileSync(auditFile, largeData, "utf8");

    const stdin = JSON.stringify({ session_id: "rot-1", tool_name: "Edit", tool_input: { file_path: "/work/repo/src/rot.ts" }, cwd: "/work/repo" });
    const res = gateEvent("claude-code", stdin);
    assert.equal(JSON.parse(res.stdout).hookSpecificOutput.permissionDecision, "deny");

    assert.equal(existsSync(rotatedFile), true, "rotated file audit.1.jsonl should exist");
    assert.equal(readFileSync(rotatedFile, "utf8"), largeData);
    assert.equal(existsSync(auditFile), true, "new audit.jsonl should exist");
    const newLines = readFileSync(auditFile, "utf8").trim().split("\n");
    assert.equal(newLines.length, 1);
  } finally {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("gate allows on first sight when memory is past the record cap and newer evidence may sit unread", () => {
  withSandboxHome(() => {
    writeFileSync(resolveRockyPaths().memory, failureLines(MAX_SUPPORTED_MEMORY_RECORDS + 1), "utf8");
    const cwd = "C:\\work\\repo";
    // Twice: the second pass answers from the cached evidence index and must say the same.
    for (let pass = 0; pass < 2; pass += 1) {
      assert.deepEqual(rationaleCheck.evaluate(gateInput(cwd, "src\\unheard.ts"), memState()), { deny: false }, `rationale pass ${pass}`);
      assert.deepEqual(explainCheck.evaluate(gateInput(cwd, "src\\unheard.ts"), memState()), { deny: false }, `explain pass ${pass}`);
    }
  });
});

test("gate allows on first sight when memory is past the file size cap and newer evidence may sit unread", () => {
  withSandboxHome(() => {
    const paths = resolveRockyPaths();
    writeFileSync(paths.memory, failureLinesPastByteCap(), "utf8");
    assert.equal(loadMemoryChecked(paths.memory).coverage.reason, "file-size-cap", "the fixture must stop at the byte cap, not the record cap");
    const cwd = "C:\\work\\repo";
    assert.deepEqual(rationaleCheck.evaluate(gateInput(cwd, "src\\unheard.ts"), memState()), { deny: false });
    assert.deepEqual(explainCheck.evaluate(gateInput(cwd, "src\\unheard.ts"), memState()), { deny: false });
  });
});

test("gate still denies once at exactly the record cap, where no line is unread", () => {
  withSandboxHome(() => {
    writeFileSync(resolveRockyPaths().memory, failureLines(MAX_SUPPORTED_MEMORY_RECORDS), "utf8");
    const cwd = "C:\\work\\repo";
    assert.equal(rationaleCheck.evaluate(gateInput(cwd, "src\\lonely.ts"), memState()).deny, true);
    assert.equal(explainCheck.evaluate(gateInput(cwd, "src\\lonely.ts"), memState()).deny, true);
  });
});

test("gate denies again once memory is back under the record cap", () => {
  withSandboxHome(() => {
    const paths = resolveRockyPaths();
    const cwd = "C:\\work\\repo";
    writeFileSync(paths.memory, failureLines(MAX_SUPPORTED_MEMORY_RECORDS + 1), "utf8");
    assert.deepEqual(rationaleCheck.evaluate(gateInput(cwd, "src\\lonely.ts"), memState()), { deny: false });
    writeFileSync(paths.memory, failureLines(3), "utf8");
    assert.equal(rationaleCheck.evaluate(gateInput(cwd, "src\\lonely.ts"), memState()).deny, true);
    assert.equal(explainCheck.evaluate(gateInput(cwd, "src\\lonely.ts"), memState()).deny, true);
  });
});

test("gate with no memory file denies once and does not throw", () => {
  withSandboxHome(() => {
    const cwd = "C:\\work\\repo";
    const rationaleState = memState();
    const explainState = memState();
    assert.equal(rationaleCheck.evaluate(gateInput(cwd, "src\\lonely.ts"), rationaleState).deny, true);
    assert.equal(explainCheck.evaluate(gateInput(cwd, "src\\lonely.ts"), explainState).deny, true);
    assert.deepEqual(rationaleCheck.evaluate(gateInput(cwd, "src\\lonely.ts"), rationaleState), { deny: false });
    assert.deepEqual(explainCheck.evaluate(gateInput(cwd, "src\\lonely.ts"), explainState), { deny: false });
  });
});

test("gate with unreadable memory denies once and does not throw", () => {
  withSandboxHome(() => {
    // A directory where the memory file belongs: it stats, but it cannot be read as memory.
    mkdirSync(resolveRockyPaths().memory);
    const cwd = "C:\\work\\repo";
    assert.doesNotThrow(() => rationaleCheck.evaluate(gateInput(cwd, "src\\lonely.ts"), memState()));
    assert.equal(rationaleCheck.evaluate(gateInput(cwd, "src\\lonely.ts"), memState()).deny, true);
    assert.equal(explainCheck.evaluate(gateInput(cwd, "src\\lonely.ts"), memState()).deny, true);
  });
});

test("gateEvent allows an edit, strict mode included, when memory is past the record cap", () => {
  withSandboxHome((home) => {
    writeFileSync(join(home, "memory.jsonl"), failureLines(MAX_SUPPORTED_MEMORY_RECORDS + 1), "utf8");
    const previousMode = process.env.ROCKY_GATE_MODE;
    try {
      for (const mode of [undefined, "strict"]) {
        if (mode === undefined) delete process.env.ROCKY_GATE_MODE;
        else process.env.ROCKY_GATE_MODE = mode;
        const label = mode ?? "nudge";
        // A session of its own per mode: a file already seen in a session passes without asking memory.
        const stdin = JSON.stringify({
          session_id: `cap-${label}`, tool_name: "Edit", tool_input: { file_path: "/work/repo/src/unheard.ts" }, cwd: "/work/repo",
        });
        assert.equal(gateEvent("claude-code", stdin).stdout, "{}", `mode ${label}`);
      }
    } finally {
      if (previousMode === undefined) delete process.env.ROCKY_GATE_MODE;
      else process.env.ROCKY_GATE_MODE = previousMode;
    }
    assert.equal(existsSync(join(home, "gate-state", "audit.jsonl")), false, "an allow leaves no deny audit line");
  });
});


