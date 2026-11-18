import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

// The gate runs as its own process on every Edit and Write an agent attempts, so what
// matters is what that process prints and returns, not what `gateEvent` returns in-process.
// The built entry is the one an installed hook calls.
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const entry = join(packageRoot, "dist", "index.js");
// Hang guard only, not part of any assertion: Node startup alone can take seconds on a loaded runner.
const PROCESS_TIMEOUT_MS = 30_000;

/** Advisory switches cleared per test, so a developer's own shell cannot change a verdict here. */
const GATE_SWITCHES = [
  "ROCKY_CYCLE_ADVISORY", "ROCKY_CLARITY_ADVISORY",
  "NODE_OPTIONS", "NODE_TEST_CONTEXT",
] as const;

interface GateSandbox {
  work: string;
  env: NodeJS.ProcessEnv;
}

/** A throwaway home and working directory for one test; nothing here reaches the real memory. */
function gateSandbox(t: TestContext): GateSandbox {
  const root = mkdtempSync(join(tmpdir(), "rocky-gate-process-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const rockyHome = join(root, "rocky-home");
  const work = join(root, "work");
  for (const directory of [home, rockyHome, work]) mkdirSync(directory, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, ROCKY_HOME: rockyHome };
  for (const name of GATE_SWITCHES) delete env[name];
  return { work, env };
}

function runGateEvent(sandbox: GateSandbox, stdin: string): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [entry, "hook", "gate-event", "claude-code"], {
    cwd: sandbox.work,
    env: sandbox.env,
    input: stdin,
    encoding: "utf8",
    timeout: PROCESS_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
}

test("hook gate-event prints {} for a first edit with no stated reason, and exits 0", (t) => {
  const sandbox = gateSandbox(t);
  const file = join(sandbox.work, "app.ts");
  const payload = JSON.stringify({
    session_id: "gate-process-first",
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_input: { file_path: file },
    cwd: sandbox.work,
  });

  const result = runGateEvent(sandbox, payload);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "{}");
});

test("hook gate-event prints advisory additionalContext without permissionDecision, and exits 0", (t) => {
  const sandbox = gateSandbox(t);
  const file = join(sandbox.work, "app.ts");
  const payload = JSON.stringify({
    session_id: "gate-process-advisory",
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_input: { file_path: file },
    cwd: sandbox.work,
    rationale: "it is broken, this thing does that stuff with those things and it fails",
  });

  const result = runGateEvent(sandbox, payload);

  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout) as {
    hookSpecificOutput?: Record<string, unknown>;
  };
  assert.equal(decision.hookSpecificOutput?.hookEventName, "PreToolUse");
  assert.equal("permissionDecision" in (decision.hookSpecificOutput ?? {}), false);
  assert.match(String(decision.hookSpecificOutput?.additionalContext ?? ""), /^rocky: Prompt is vague/);
});

test("hook gate-event allows with {} and exits 0 on garbage or empty stdin", (t) => {
  const sandbox = gateSandbox(t);
  for (const [label, stdin] of [["garbage", "this is not json {"], ["empty", ""]] as const) {
    const result = runGateEvent(sandbox, stdin);
    assert.equal(result.status, 0, `${label}: ${result.stderr}`);
    assert.equal(result.stdout, "{}", label);
  }
});
