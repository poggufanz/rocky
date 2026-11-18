import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, realpathSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";

const FP_A = "aaaaaaaaaaaaaaaa";
const R1 = "fix timeout in auth retry helper";
const VAGUE = "it is broken, this thing does that stuff with those things and it fails";

function preToolUse(file: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ session_id: "s1", tool_name: "Edit", tool_input: { file_path: file }, cwd: "/work/repo", ...extra });
}

function gatePayload(session: string, file: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ session_id: session, tool_name: "Edit", tool_input: { file_path: file }, cwd: "/work/repo", ...extra });
}

function withRockyHome(t: import("node:test").TestContext, home: string): void {
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
  });
}

function withEnv(t: import("node:test").TestContext, name: string, value: string | undefined): void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

test("gate never denies a first edit with no recorded reason", async (t) => {
  withRockyHome(t, realpathSync(mkdtempSync(join(tmpdir(), "rocky-gate-"))));
  const { gateEvent } = await import("../agent/gate.js");
  const result = gateEvent("claude-code", preToolUse("/work/repo/src/a.ts"));
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "{}");
});

test("gate ignores retired strict and off switches", async (t) => {
  for (const retired of ["ROCKY_GATE_MODE", "ROCKY_RATIONALE_GATE", "ROCKY_GATE_OVERRIDE", "ROCKY_CLARITY_ADVISORY"]) {
    withEnv(t, retired, undefined);
  }
  const { gateEvent } = await import("../agent/gate.js");

  withRockyHome(t, realpathSync(mkdtempSync(join(tmpdir(), "rocky-gate-retired-base-"))));
  const baseline = gateEvent("claude-code", gatePayload("baseline", "/work/repo/src/a.ts", { rationale: VAGUE }));
  assert.equal(baseline.exitCode, 0);
  const baselineParsed = JSON.parse(baseline.stdout) as { hookSpecificOutput: Record<string, unknown> };
  assert.equal("permissionDecision" in baselineParsed.hookSpecificOutput, false);
  const baselineContext = baselineParsed.hookSpecificOutput.additionalContext as string;
  assert.match(baselineContext, /^rocky: .*Prompt is vague \(\d+\/100\)\./);

  for (const [name, value] of [
    ["ROCKY_GATE_MODE", "strict"],
    ["ROCKY_RATIONALE_GATE", "off"],
    ["ROCKY_GATE_OVERRIDE", "1"],
  ] as const) {
    withRockyHome(t, realpathSync(mkdtempSync(join(tmpdir(), "rocky-gate-retired-"))));
    process.env[name] = value;
    try {
      const sid = `retired-${name}`;
      for (let i = 0; i < 2; i += 1) {
        const result = gateEvent("claude-code", gatePayload(sid, "/work/repo/src/a.ts"));
        assert.equal(result.exitCode, 0, `${name}=${value} pass ${i}`);
        assert.equal(result.stdout, "{}", `${name}=${value} pass ${i}`);
        assert.equal(result.stdout.includes("permissionDecision"), false, `${name}=${value} pass ${i}`);
      }

      const positive = gateEvent("claude-code", gatePayload(sid, "/work/repo/src/a.ts", { rationale: VAGUE }));
      assert.equal(positive.exitCode, 0, `${name}=${value} positive control`);
      const parsed = JSON.parse(positive.stdout) as { hookSpecificOutput: Record<string, unknown> };
      assert.equal("permissionDecision" in parsed.hookSpecificOutput, false, `${name}=${value} positive control`);
      assert.equal(parsed.hookSpecificOutput.additionalContext, baselineContext, `${name}=${value} positive control`);
    } finally {
      delete process.env[name];
    }
  }
});

test("cycle nudge reaches the agent as additionalContext on the third loop", async (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rocky-gate-cycle-")));
  withRockyHome(t, home);
  withEnv(t, "ROCKY_CYCLE_ADVISORY", undefined);
  withEnv(t, "ROCKY_CLARITY_ADVISORY", "off");
  const { gateEvent } = await import("../agent/gate.js");

  const extra = { rationale: R1, fingerprint: FP_A };
  const first = gateEvent("claude-code", gatePayload("loop", "/work/repo/src/a.ts", extra));
  const second = gateEvent("claude-code", gatePayload("loop", "/work/repo/src/b.ts", extra));
  assert.equal(first.stdout, "{}");
  assert.equal(second.stdout, "{}");

  const third = gateEvent("claude-code", gatePayload("loop", "/work/repo/src/c.ts", extra));
  assert.equal(third.exitCode, 0);
  const parsed = JSON.parse(third.stdout) as { hookSpecificOutput: Record<string, unknown> };
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal("permissionDecision" in parsed.hookSpecificOutput, false);
  const context = parsed.hookSpecificOutput.additionalContext as string;
  assert.match(context, /^rocky: .*Same failure with the same wording again\. Add new information before retrying\./);
  assert.match(context, /rocky recall/);
  assert.doesNotMatch(context, /\?/);
  assert.equal(existsSync(join(home, "gate-state", "loop.cycles.json")), true);
});

test("cycle nudge derives the fingerprint from stderr via fingerprint()", async (t) => {
  withRockyHome(t, realpathSync(mkdtempSync(join(tmpdir(), "rocky-gate-cycle-stderr-"))));
  withEnv(t, "ROCKY_CYCLE_ADVISORY", undefined);
  withEnv(t, "ROCKY_CLARITY_ADVISORY", "off");
  const { gateEvent } = await import("../agent/gate.js");

  const extra = { rationale: R1, stderr: "Error: connect refused\n", cmd: "npm test", exitCode: 1 };
  assert.equal(gateEvent("claude-code", gatePayload("derived", "/work/repo/src/a.ts", extra)).stdout, "{}");
  assert.equal(gateEvent("claude-code", gatePayload("derived", "/work/repo/src/b.ts", extra)).stdout, "{}");
  const third = gateEvent("claude-code", gatePayload("derived", "/work/repo/src/c.ts", extra));
  assert.equal(third.exitCode, 0);
  const parsed = JSON.parse(third.stdout) as { hookSpecificOutput: Record<string, unknown> };
  assert.equal("permissionDecision" in parsed.hookSpecificOutput, false);
  assert.match(parsed.hookSpecificOutput.additionalContext as string, /Same failure with the same wording again/);
});

test("cycle nudge honors ROCKY_CYCLE_ADVISORY=off and fails open on corrupt cycle state", async (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rocky-gate-cycle-optout-")));
  withRockyHome(t, home);
  withEnv(t, "ROCKY_CLARITY_ADVISORY", "off");
  withEnv(t, "ROCKY_CYCLE_ADVISORY", "off");
  const { gateEvent } = await import("../agent/gate.js");
  const extra = { rationale: R1, fingerprint: FP_A };

  for (let i = 0; i < 4; i += 1) {
    const silent = gateEvent("claude-code", gatePayload("optout", `/work/repo/src/${i}.ts`, extra));
    assert.equal(silent.exitCode, 0);
    assert.equal(silent.stdout, "{}");
  }

  delete process.env.ROCKY_CYCLE_ADVISORY;
  mkdirSync(join(home, "gate-state"), { recursive: true });
  writeFileSync(join(home, "gate-state", "broken.cycles.json"), "garbage\n", "utf8");
  const corrupt = gateEvent("claude-code", gatePayload("broken", "/work/repo/src/q.ts", extra));
  assert.equal(corrupt.exitCode, 0);
  assert.equal(corrupt.stdout, "{}");
});

test("cycle nudge stays silent when saving cycle state fails", async (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rocky-gate-cycle-save-fail-")));
  withRockyHome(t, home);
  withEnv(t, "ROCKY_CYCLE_ADVISORY", undefined);
  withEnv(t, "ROCKY_CLARITY_ADVISORY", "off");
  const { gateEvent } = await import("../agent/gate.js");

  const extra = { rationale: R1, fingerprint: FP_A };
  assert.equal(gateEvent("claude-code", gatePayload("savefail", "/work/repo/src/a.ts", extra)).stdout, "{}");
  assert.equal(gateEvent("claude-code", gatePayload("savefail", "/work/repo/src/b.ts", extra)).stdout, "{}");

  const stateFile = join(home, "gate-state", "savefail.cycles.json");
  assert.equal(existsSync(stateFile), true);
  // Make the atomic temp-file target a directory so writeFileSync fails portably on Windows and POSIX.
  mkdirSync(`${stateFile}.${process.pid}.tmp`);

  const third = gateEvent("claude-code", gatePayload("savefail", "/work/repo/src/c.ts", extra));
  assert.equal(third.exitCode, 0);
  assert.equal(third.stdout, "{}");
});

test("clarity nudge arrives as additionalContext and honors its opt-out", async (t) => {
  withRockyHome(t, realpathSync(mkdtempSync(join(tmpdir(), "rocky-gate-clarity-"))));
  withEnv(t, "ROCKY_CLARITY_ADVISORY", undefined);
  const { gateEvent } = await import("../agent/gate.js");

  const nudged = gateEvent("claude-code", gatePayload("s1", "/work/repo/src/q.ts", { rationale: VAGUE }));
  assert.equal(nudged.exitCode, 0);
  const parsed = JSON.parse(nudged.stdout) as { hookSpecificOutput: Record<string, unknown> };
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal("permissionDecision" in parsed.hookSpecificOutput, false);
  assert.match(parsed.hookSpecificOutput.additionalContext as string, /^rocky: .*Prompt is vague \(\d+\/100\)\./);

  withEnv(t, "ROCKY_CLARITY_ADVISORY", "off");
  const silent = gateEvent("claude-code", gatePayload("s2", "/work/repo/src/q.ts", { rationale: VAGUE }));
  assert.equal(silent.exitCode, 0);
  assert.equal(silent.stdout, "{}");
});

test("clarity nudge fails open on corrupt rationale", async (t) => {
  withRockyHome(t, realpathSync(mkdtempSync(join(tmpdir(), "rocky-gate-clarity-corrupt-"))));
  withEnv(t, "ROCKY_CLARITY_ADVISORY", undefined);
  const { gateEvent } = await import("../agent/gate.js");
  const corrupt = gateEvent("claude-code", gatePayload("s9", "/b.ts", { rationale: 42 }));
  assert.equal(corrupt.exitCode, 0);
  assert.equal(corrupt.stdout, "{}");
});

test("corrupt stdin and corrupt state fail open", async (t) => {
  withRockyHome(t, realpathSync(mkdtempSync(join(tmpdir(), "rocky-gate3-"))));
  const { gateEvent } = await import("../agent/gate.js");
  assert.equal(gateEvent("claude-code", "NOT JSON").stdout, "{}");
  const stateDir = join(process.env.ROCKY_HOME!, "gate-state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "s1.cycles.json"), "garbage\n");
  const afterCorrupt = gateEvent("claude-code", preToolUse("/b.ts"));
  assert.equal(afterCorrupt.exitCode, 0);
  assert.equal(afterCorrupt.stdout, "{}");
});

test("missing session_id fails open without touching gate-state", async (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rocky-gate4-")));
  withRockyHome(t, home);
  const { gateEvent } = await import("../agent/gate.js");
  const noSession = JSON.stringify({ tool_name: "Edit", tool_input: { file_path: "/c.ts" }, cwd: "/work/repo" });
  assert.equal(gateEvent("claude-code", noSession).stdout, "{}");
  assert.equal(existsSync(join(home, "gate-state")), false, "no state file for a request with no session_id");
});

test("path-traversal session_id is sanitized: state lands inside gate-state, nothing escapes", async (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rocky-gate4b-")));
  withRockyHome(t, home);
  withEnv(t, "ROCKY_CYCLE_ADVISORY", undefined);
  const { gateEvent } = await import("../agent/gate.js");
  const traversal = JSON.stringify({
    session_id: "../../../evil",
    tool_name: "Edit",
    tool_input: { file_path: "/c.ts" },
    cwd: "/work/repo",
    rationale: R1,
    fingerprint: FP_A,
  });
  const result = gateEvent("claude-code", traversal);
  assert.equal(result.exitCode, 0);

  // The property that matters: the traversal payload must not be able to
  // place a file anywhere outside gate-state/. A naive `join(gateStateDir,
  // session_id + ".cycles.json")` with this exact payload would resolve two
  // directory levels above `home` (the literal "../../../" cancels the
  // "gate-state" segment plus climbs two more) — assert that never exists,
  // and that whatever gateEvent did write landed inside gate-state/.
  const escapedGuess = join(dirname(dirname(home)), "evil.cycles.json");
  assert.equal(existsSync(escapedGuess), false, "no file at the naive-join escape location");

  const gateStateDir = join(home, "gate-state");
  assert.equal(existsSync(gateStateDir), true, "gate-state directory was created");
  const entries = readdirSync(gateStateDir);
  assert.ok(entries.length > 0, "a state file was written for the sanitized session id");
  const realGateStateDir = realpathSync(gateStateDir);
  for (const entry of entries) {
    const realEntry = realpathSync(join(gateStateDir, entry));
    assert.ok(
      realEntry === realGateStateDir || realEntry.startsWith(realGateStateDir + sep),
      `state entry "${entry}" resolves inside gate-state/`,
    );
  }
});

test("unknown vendor allows without enforcement or touching gate-state", async (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rocky-gate4c-")));
  withRockyHome(t, home);
  const { gateEvent } = await import("../agent/gate.js");
  const result = gateEvent("some-bogus-vendor", preToolUse("/work/repo/src/q.ts", { rationale: VAGUE }));
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "{}", "unrecognized vendor never runs gate checks");
  assert.equal(existsSync(join(home, "gate-state")), false, "unknown vendor never touches gate-state");
});

test("non-gated tool and missing file_path allow", async (t) => {
  withRockyHome(t, realpathSync(mkdtempSync(join(tmpdir(), "rocky-gate5-"))));
  const { gateEvent } = await import("../agent/gate.js");
  const bash = JSON.stringify({ session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" }, cwd: "/work/repo", rationale: VAGUE });
  assert.equal(gateEvent("claude-code", bash).stdout, "{}");
  const noPath = JSON.stringify({ session_id: "s1", tool_name: "Edit", tool_input: {}, cwd: "/work/repo", rationale: VAGUE });
  assert.equal(gateEvent("claude-code", noPath).stdout, "{}");
});

test("MultiEdit and tool_input.path pass the advisory filter without denying", async (t) => {
  withRockyHome(t, realpathSync(mkdtempSync(join(tmpdir(), "rocky-gate6-"))));
  withEnv(t, "ROCKY_CLARITY_ADVISORY", undefined);
  const { gateEvent } = await import("../agent/gate.js");
  const multi = JSON.stringify({
    session_id: "s1",
    tool_name: "MultiEdit",
    tool_input: { file_path: "/work/repo/src/m.ts", edits: [{ old_string: "a", new_string: "b" }] },
    cwd: "/work/repo",
    rationale: VAGUE,
  });
  const multiRes = gateEvent("claude-code", multi);
  assert.equal(multiRes.exitCode, 0);
  const multiParsed = JSON.parse(multiRes.stdout) as { hookSpecificOutput: Record<string, unknown> };
  assert.equal("permissionDecision" in multiParsed.hookSpecificOutput, false);
  assert.match(multiParsed.hookSpecificOutput.additionalContext as string, /^rocky: .*Prompt is vague/);

  const pathFallback = JSON.stringify({
    session_id: "s-path",
    tool_name: "Edit",
    tool_input: { path: "src/fallback.ts" },
    cwd: "/work/repo",
    rationale: VAGUE,
  });
  const res = gateEvent("claude-code", pathFallback);
  assert.equal(res.exitCode, 0);
  const parsed = JSON.parse(res.stdout) as { hookSpecificOutput: Record<string, unknown> };
  assert.equal("permissionDecision" in parsed.hookSpecificOutput, false);
  assert.match(parsed.hookSpecificOutput.additionalContext as string, /^rocky: .*Prompt is vague/);
});
