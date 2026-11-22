import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { loadMemoryChecked } from "../core/memory-read.js";
import { resolveRockyPaths } from "../core/state-paths.js";
import { TOOL_RESULT_STDIN_CAP_BYTES } from "../core/tool-result.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const entry = join(packageRoot, "dist", "index.js");
const PROCESS_TIMEOUT_MS = 30_000;

interface Sandbox {
  root: string;
  rockyHome: string;
  workDir: string;
}

function makeSandbox(t: TestContext): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "rocky-tool-result-"));
  const rockyHome = join(root, "rocky-home");
  const workDir = join(root, "work");
  mkdirSync(rockyHome, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, rockyHome, workDir };
}

function spawnHook(
  args: readonly string[],
  stdin: string,
  rockyHome: string,
  cwd: string = packageRoot,
  timeout: number = PROCESS_TIMEOUT_MS,
): SpawnSyncReturns<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, ROCKY_HOME: rockyHome };
  delete env.ROCKY_TEST_SEAMS;
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [entry, ...args], {
    cwd,
    env,
    input: stdin,
    encoding: "utf8",
    timeout,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
}

function failurePayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: "PostToolUseFailure",
    tool_name: "Bash",
    tool_input: { command: "npm test" },
    error: "Exit code 1\nError: Cannot find module 'express'\n",
    session_id: "s1",
    tool_use_id: "toolu_fail_1",
    ...overrides,
  });
}

function passPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "npm test" },
    tool_response: { stdout: "all green\n", stderr: "", interrupted: false },
    session_id: "s1",
    tool_use_id: "toolu_pass_1",
    ...overrides,
  });
}

test("process: failure payload writes one agent failure and prints {}", (t) => {
  const { rockyHome, workDir } = makeSandbox(t);
  const paths = resolveRockyPaths({ ROCKY_HOME: rockyHome });

  const result = spawnHook(
    ["hook", "tool-result", "claude-code"],
    failurePayload({ cwd: workDir }),
    rockyHome,
    workDir,
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "{}");
  assert.equal(result.stderr, "");

  const loaded = loadMemoryChecked(paths.memory);
  assert.equal(loaded.complete, true);
  assert.equal(loaded.records.length, 1);
  const record = loaded.records[0];
  assert.equal(record?.kind, "failure");
  assert.equal(record.origin, "agent");
  assert.equal(record.cmd, "npm test");
  assert.equal(record.cwd, workDir);
  assert.equal(record.exitCode, 1);
  assert.equal(record.agent?.vendor, "claude-code");
  assert.equal(record.agent?.session, "s1");
  assert.equal(record.agent?.toolUseId, "toolu_fail_1");
  assert.equal(existsSync(paths.pending), true);
});

test("process: wrapped command writes nothing", (t) => {
  const { rockyHome, workDir } = makeSandbox(t);
  const paths = resolveRockyPaths({ ROCKY_HOME: rockyHome });

  const result = spawnHook(
    ["hook", "tool-result", "claude-code"],
    failurePayload({ cwd: workDir, tool_input: { command: 'rocky run "npm test"' } }),
    rockyHome,
    workDir,
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "{}");
  assert.equal(existsSync(paths.memory), false);
  assert.equal(existsSync(paths.pending), false);
});

test("process: undecidable command writes nothing", (t) => {
  const { rockyHome, workDir } = makeSandbox(t);
  const paths = resolveRockyPaths({ ROCKY_HOME: rockyHome });

  const result = spawnHook(
    ["hook", "tool-result", "claude-code"],
    failurePayload({ cwd: workDir, tool_input: { command: 'echo start && rocky run "npm test"' } }),
    rockyHome,
    workDir,
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "{}");
  assert.equal(existsSync(paths.memory), false);
  assert.equal(existsSync(paths.pending), false);
});

test("process: interrupt, background, and no-exit-header write nothing", (t) => {
  const cases: ReadonlyArray<{ name: string; build: (cwd: string) => string }> = [
    {
      name: "interrupt",
      build: (cwd) => failurePayload({ cwd, is_interrupt: true }),
    },
    {
      name: "background",
      build: (cwd) => failurePayload({ cwd, tool_input: { command: "npm test", run_in_background: true } }),
    },
    {
      name: "no-exit-header",
      build: (cwd) => failurePayload({ cwd, error: "Command timed out after 120000ms" }),
    },
  ];

  for (const entryCase of cases) {
    const { rockyHome, workDir } = makeSandbox(t);
    const paths = resolveRockyPaths({ ROCKY_HOME: rockyHome });

    const result = spawnHook(
      ["hook", "tool-result", "claude-code"],
      entryCase.build(workDir),
      rockyHome,
      workDir,
    );

    assert.equal(result.status, 0, `${entryCase.name}: ${result.stderr}`);
    assert.equal(result.stdout, "{}", entryCase.name);
    assert.equal(existsSync(paths.memory), false, `${entryCase.name}: memory must stay absent`);
    assert.equal(existsSync(paths.pending), false, `${entryCase.name}: pending must stay absent`);
  }
});

test("process: pass payload without pending returns {} and writes nothing", (t) => {
  const { rockyHome, workDir } = makeSandbox(t);
  const paths = resolveRockyPaths({ ROCKY_HOME: rockyHome });

  const failResult = spawnHook(
    ["hook", "tool-result", "claude-code"],
    failurePayload({ cwd: workDir }),
    rockyHome,
    workDir,
  );
  assert.equal(failResult.status, 0, failResult.stderr);
  assert.equal(failResult.stdout, "{}");
  assert.equal(existsSync(paths.memory), true);
  assert.equal(existsSync(paths.pending), true);

  rmSync(paths.pending, { force: true });
  assert.equal(existsSync(paths.pending), false);
  const beforeBytes = statSync(paths.memory).size;
  const beforeContent = readFileSync(paths.memory);

  const passResult = spawnHook(
    ["hook", "tool-result", "claude-code"],
    passPayload({ cwd: workDir }),
    rockyHome,
    workDir,
  );

  assert.equal(passResult.status, 0, passResult.stderr);
  assert.equal(passResult.stdout, "{}");
  assert.equal(statSync(paths.memory).size, beforeBytes);
  assert.deepEqual(readFileSync(paths.memory), beforeContent);
  assert.equal(existsSync(paths.pending), false);
});

test("process: pass payload links the earlier agent failure", (t) => {
  const { rockyHome, workDir } = makeSandbox(t);
  const paths = resolveRockyPaths({ ROCKY_HOME: rockyHome });

  const failResult = spawnHook(
    ["hook", "tool-result", "claude-code"],
    failurePayload({ cwd: workDir }),
    rockyHome,
    workDir,
  );
  assert.equal(failResult.status, 0, failResult.stderr);
  assert.equal(failResult.stdout, "{}");

  const passResult = spawnHook(
    ["hook", "tool-result", "claude-code"],
    passPayload({ cwd: workDir }),
    rockyHome,
    workDir,
  );
  assert.equal(passResult.status, 0, passResult.stderr);
  assert.equal(passResult.stdout, "{}");

  const loaded = loadMemoryChecked(paths.memory);
  assert.equal(loaded.complete, true);
  const failures = loaded.records.filter((record) => record.kind === "failure");
  const fixes = loaded.records.filter((record) => record.kind === "fix");
  assert.equal(failures.length, 1);
  assert.equal(fixes.length, 1);
  const failure = failures[0]!;
  const fix = fixes[0]!;
  assert.deepEqual(fix.failureIds, [failure.id]);
  assert.equal(fix.agent?.vendor, "claude-code");
  assert.equal(fix.agent?.session, "s1");
  assert.equal(failure.resolvedBy, fix.id);
});

test("process: pass from another session does not link", (t) => {
  const { rockyHome, workDir } = makeSandbox(t);
  const paths = resolveRockyPaths({ ROCKY_HOME: rockyHome });

  const failResult = spawnHook(
    ["hook", "tool-result", "claude-code"],
    failurePayload({ cwd: workDir, session_id: "s1" }),
    rockyHome,
    workDir,
  );
  assert.equal(failResult.status, 0, failResult.stderr);
  assert.equal(failResult.stdout, "{}");

  const passResult = spawnHook(
    ["hook", "tool-result", "claude-code"],
    passPayload({ cwd: workDir, session_id: "s2" }),
    rockyHome,
    workDir,
  );
  assert.equal(passResult.status, 0, passResult.stderr);
  assert.equal(passResult.stdout, "{}");

  const loaded = loadMemoryChecked(paths.memory);
  assert.equal(loaded.complete, true);
  const failures = loaded.records.filter((record) => record.kind === "failure");
  const fixes = loaded.records.filter((record) => record.kind === "fix");
  assert.equal(failures.length, 1);
  assert.equal(fixes.length, 0);
  assert.equal(failures[0]?.resolvedBy, undefined);
});

test("process: malformed JSON, oversized stdin (1 MiB + 1), and unknown event print {} and exit 0", (t) => {
  const { rockyHome, workDir } = makeSandbox(t);
  const paths = resolveRockyPaths({ ROCKY_HOME: rockyHome });

  const base = failurePayload({ cwd: workDir });
  const oversized = base + " ".repeat(TOOL_RESULT_STDIN_CAP_BYTES - Buffer.byteLength(base, "utf8") + 1);
  assert.equal(Buffer.byteLength(oversized, "utf8"), TOOL_RESULT_STDIN_CAP_BYTES + 1);

  const cases: ReadonlyArray<{ name: string; stdin: string }> = [
    { name: "malformed JSON", stdin: "{not valid json" },
    { name: "oversized stdin", stdin: oversized },
    { name: "unknown event", stdin: failurePayload({ cwd: workDir, hook_event_name: "UnknownEvent" }) },
  ];

  for (const entryCase of cases) {
    const result = spawnHook(
      ["hook", "tool-result", "claude-code"],
      entryCase.stdin,
      rockyHome,
      workDir,
    );

    assert.equal(result.status, 0, `${entryCase.name}: ${result.stderr}`);
    assert.equal(result.stdout, "{}", entryCase.name);
    assert.equal(existsSync(paths.memory), false, `${entryCase.name}: memory must stay absent`);
  }
});

test("process: busy lock prints {} and exits 0 within 4 s", (t) => {
  const { rockyHome, workDir } = makeSandbox(t);
  const paths = resolveRockyPaths({ ROCKY_HOME: rockyHome });
  const lockPath = `${paths.memory}.triple.lock`;
  writeFileSync(lockPath, "", { mode: 0o600 });

  const started = performance.now();
  const result = spawnHook(
    ["hook", "tool-result", "claude-code"],
    failurePayload({ cwd: workDir }),
    rockyHome,
    workDir,
  );
  const elapsed = performance.now() - started;

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "{}");
  assert.ok(elapsed < 4_000, `expected exit within 4000ms, got ${elapsed.toFixed(1)}ms`);
  assert.equal(existsSync(paths.memory), false);
  assert.equal(existsSync(paths.pending), false);
});

test("process: rejects unknown vendor and extra args with exit 2", (t) => {
  const { rockyHome, workDir } = makeSandbox(t);

  for (const args of [
    ["hook", "tool-result", "codex"],
    ["hook", "tool-result"],
    ["hook", "tool-result", "claude-code", "x"],
  ] as const) {
    const result = spawnHook(args, "", rockyHome, workDir);
    assert.equal(result.status, 2, `${args.join(" ")}: ${result.stderr}`);
    assert.match(result.stderr, /usage: rocky hook /);
  }
});
