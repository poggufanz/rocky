import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cwdHash, type ExposureRow } from "../core/attempt-note-state.js";
import { commandIdentity, fingerprint, FINGERPRINT_ALGORITHM_VERSION, signatureLines } from "../core/fingerprint.js";
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
  extraEnv: Record<string, string | undefined> = {},
): SpawnSyncReturns<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, ROCKY_HOME: rockyHome };
  delete env.ROCKY_TEST_SEAMS;
  delete env.ROCKY_ATTEMPT_ARM;
  delete env.ROCKY_ATTEMPT_ADVISORY;
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
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

function readExposureRows(rockyHome: string): ExposureRow[] {
  const logPath = join(rockyHome, "advisories.jsonl");
  if (!existsSync(logPath)) return [];
  const text = readFileSync(logPath, "utf8").trim();
  if (text.length === 0) return [];
  return text.split("\n").map((line) => JSON.parse(line) as ExposureRow);
}

function seedAgentFailures(
  memoryPath: string,
  cwd: string,
  cmd: string,
  body: string,
  count: number,
  options: { exitCode?: number; session?: string; origin?: "agent" | "hook" } = {},
): string {
  const exitCode = options.exitCode ?? 1;
  const session = options.session ?? "seed-session";
  const origin = options.origin ?? "agent";
  const fp = fingerprint(body, cmd, exitCode);
  const identity = commandIdentity(cmd);
  const now = Date.now();
  const lines: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const rec = {
      kind: "failure",
      id: `seed-fail-${i + 1}`,
      ts: now - (count - i) * 60_000,
      cwd,
      cmd,
      exitCode,
      fingerprint: fp,
      fingerprintV: FINGERPRINT_ALGORITHM_VERSION,
      signature: signatureLines(body),
      excerpt: body.trim(),
      origin,
      ...(origin === "agent" ? { agent: { vendor: "claude-code", session } } : {}),
      commandIdentity: identity.value,
      identityV: identity.version,
      identityReliable: identity.reliable,
      platform: process.platform,
    };
    lines.push(JSON.stringify(rec));
  }
  writeFileSync(memoryPath, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  return fp;
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
    assert.deepEqual(readExposureRows(rockyHome), [], `${entryCase.name}: exposure log must stay empty`);
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

test("process: stdin read error after valid JSON prints {} and writes nothing", (t) => {
  const { root, rockyHome, workDir } = makeSandbox(t);
  const paths = resolveRockyPaths({ ROCKY_HOME: rockyHome });
  const payload = failurePayload({ cwd: workDir });
  const preloadPath = join(root, "failing-stdin.mjs");
  writeFileSync(
    preloadPath,
    [
      'import { Readable } from "node:stream";',
      'const payload = Buffer.from(process.env.ROCKY_TEST_STDIN_PAYLOAD ?? "", "utf8");',
      "let pushed = false;",
      "const failingStdin = new Readable({",
      "  read() {",
      "    if (!pushed) {",
      "      pushed = true;",
      "      this.push(payload);",
      "      return;",
      "    }",
      '    this.destroy(new Error("simulated stdin read error"));',
      "  },",
      "});",
      'Object.defineProperty(process, "stdin", { value: failingStdin, configurable: true });',
    ].join("\n"),
    "utf8",
  );

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ROCKY_HOME: rockyHome,
    ROCKY_TEST_STDIN_PAYLOAD: payload,
  };
  delete env.ROCKY_TEST_SEAMS;
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;

  const result = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(preloadPath).href, entry, "hook", "tool-result", "claude-code"],
    {
      cwd: workDir,
      env,
      encoding: "utf8",
      timeout: PROCESS_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "{}");
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

test("process: shown arm returns additionalContext once per session and key", (t) => {
  const { rockyHome, workDir } = makeSandbox(t);
  const paths = resolveRockyPaths({ ROCKY_HOME: rockyHome });
  const body = "Error: Cannot find module 'express'\n";
  const fp = seedAgentFailures(paths.memory, workDir, "npm test", body, 2);
  const env = { ROCKY_TEST_SEAMS: "1", ROCKY_ATTEMPT_ARM: "shown" };

  const first = spawnHook(
    ["hook", "tool-result", "claude-code"],
    failurePayload({ cwd: workDir, session_id: "s-shown", tool_use_id: "toolu_1" }),
    rockyHome,
    workDir,
    PROCESS_TIMEOUT_MS,
    env,
  );
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stderr, "");
  assert.ok(Buffer.byteLength(first.stdout, "utf8") < 2048);

  const parsedFirst = JSON.parse(first.stdout) as {
    hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
  };
  assert.equal(parsedFirst.hookSpecificOutput?.hookEventName, "PostToolUseFailure");
  const context = parsedFirst.hookSpecificOutput?.additionalContext ?? "";
  assert.ok(
    context.startsWith("rocky: Same error recorded 2 times before"),
    `unexpected additionalContext: ${context}`,
  );
  assert.ok(
    context.endsWith(`Rocky records order, not cause. More: rocky attempts ${fp}`),
    `missing footer in additionalContext: ${context}`,
  );

  const second = spawnHook(
    ["hook", "tool-result", "claude-code"],
    failurePayload({ cwd: workDir, session_id: "s-shown", tool_use_id: "toolu_2" }),
    rockyHome,
    workDir,
    PROCESS_TIMEOUT_MS,
    env,
  );
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stderr, "");
  assert.equal(second.stdout, "{}");

  const rows = readExposureRows(rockyHome);
  assert.equal(rows.length, 2);
  const loaded = loadMemoryChecked(paths.memory);
  const recordedIds = loaded.records.filter((r) => r.kind === "failure").map((r) => r.id);
  assert.equal(recordedIds.length, 4);

  const [row1, row2] = rows as [ExposureRow, ExposureRow];
  assert.equal(row1.v, 1);
  assert.equal(row1.lane, "tool-result");
  assert.equal(row1.kind, "note");
  assert.equal(row1.arm, "shown");
  assert.equal(row1.session, "s-shown");
  assert.equal(row1.cwdHash, cwdHash(workDir));
  assert.equal(row1.anchorFailureId, recordedIds[2]);
  assert.equal(row1.delivered, true);
  assert.equal(row1.bytes, Buffer.byteLength(context, "utf8"));
  assert.ok(row1.latencyMs >= 0);

  assert.equal(row2.v, 1);
  assert.equal(row2.lane, "tool-result");
  assert.equal(row2.kind, "note");
  assert.equal(row2.arm, "shown");
  assert.equal(row2.session, "s-shown");
  assert.equal(row2.key, row1.key);
  assert.equal(row2.cwdHash, cwdHash(workDir));
  assert.equal(row2.anchorFailureId, recordedIds[3]);
  assert.equal(row2.delivered, false);
  assert.ok(row2.bytes > 0);
  assert.ok(row2.latencyMs >= 0);
});

test("process: held arm prints {} and logs delivered:false", (t) => {
  const { rockyHome, workDir } = makeSandbox(t);
  const paths = resolveRockyPaths({ ROCKY_HOME: rockyHome });
  const body = "Error: Cannot find module 'express'\n";
  seedAgentFailures(paths.memory, workDir, "npm test", body, 2);
  const env = { ROCKY_TEST_SEAMS: "1", ROCKY_ATTEMPT_ARM: "held" };

  const result = spawnHook(
    ["hook", "tool-result", "claude-code"],
    failurePayload({ cwd: workDir, session_id: "s-held" }),
    rockyHome,
    workDir,
    PROCESS_TIMEOUT_MS,
    env,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "{}");

  const rows = readExposureRows(rockyHome);
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.lane, "tool-result");
  assert.equal(row.kind, "note");
  assert.equal(row.arm, "held");
  assert.equal(row.session, "s-held");
  assert.equal(row.cwdHash, cwdHash(workDir));
  assert.equal(row.delivered, false);
  assert.ok(row.bytes > 0);
  assert.equal(existsSync(join(rockyHome, "gate-state", "s-held.attempts.json")), false);
});

test("process: toggle off suppresses additionalContext and exposure rows including skips", (t) => {
  const { rockyHome, workDir } = makeSandbox(t);
  const paths = resolveRockyPaths({ ROCKY_HOME: rockyHome });
  const body = "Error: Cannot find module 'express'\n";
  seedAgentFailures(paths.memory, workDir, "npm test", body, 2);
  const env = { ROCKY_TEST_SEAMS: "1", ROCKY_ATTEMPT_ARM: "shown", ROCKY_ATTEMPT_ADVISORY: "off" };

  const failResult = spawnHook(
    ["hook", "tool-result", "claude-code"],
    failurePayload({ cwd: workDir, session_id: "s-off" }),
    rockyHome,
    workDir,
    PROCESS_TIMEOUT_MS,
    env,
  );
  assert.equal(failResult.status, 0, failResult.stderr);
  assert.equal(failResult.stdout, "{}");
  assert.equal(loadMemoryChecked(paths.memory).records.length, 3);
  assert.deepEqual(readExposureRows(rockyHome), []);

  const skipResult = spawnHook(
    ["hook", "tool-result", "claude-code"],
    failurePayload({ cwd: workDir, session_id: "s-off", tool_input: { command: 'rocky run "npm test"' } }),
    rockyHome,
    workDir,
    PROCESS_TIMEOUT_MS,
    env,
  );
  assert.equal(skipResult.status, 0, skipResult.stderr);
  assert.equal(skipResult.stdout, "{}");
  assert.deepEqual(readExposureRows(rockyHome), []);
});

test("process: skips log kind skip with reason", (t) => {
  const cases: ReadonlyArray<{
    name: string;
    expectedReason: string;
    setup?: (rockyHome: string, workDir: string) => void;
    payload: (workDir: string) => string;
  }> = [
    {
      name: "wrapped",
      expectedReason: "wrapped",
      payload: (cwd) => failurePayload({ cwd, session_id: "s-skip", tool_input: { command: 'rocky run "npm test"' } }),
    },
    {
      name: "undecidable",
      expectedReason: "undecidable",
      payload: (cwd) => failurePayload({ cwd, session_id: "s-skip", tool_input: { command: 'echo hi && rocky run "npm test"' } }),
    },
    {
      name: "interrupt",
      expectedReason: "interrupt",
      payload: (cwd) => failurePayload({ cwd, session_id: "s-skip", is_interrupt: true }),
    },
    {
      name: "background",
      expectedReason: "background",
      payload: (cwd) => failurePayload({ cwd, session_id: "s-skip", tool_input: { command: "npm test", run_in_background: true } }),
    },
    {
      name: "no-exit-header",
      expectedReason: "no-exit-header",
      payload: (cwd) => failurePayload({ cwd, session_id: "s-skip", error: "Command timed out after 120000ms" }),
    },
    {
      name: "hook-duplicate",
      expectedReason: "hook-duplicate",
      setup: (rockyHome, workDir) => {
        const paths = resolveRockyPaths({ ROCKY_HOME: rockyHome });
        const identity = commandIdentity("npm test");
        const rec = {
          kind: "failure",
          id: "hook-dup-1",
          ts: Date.now(),
          cwd: workDir,
          cmd: "npm test",
          exitCode: 1,
          fingerprint: "0123456789abcdef",
          fingerprintV: FINGERPRINT_ALGORITHM_VERSION,
          signature: ["error"],
          excerpt: "error",
          origin: "hook",
          commandIdentity: identity.value,
          identityV: identity.version,
          identityReliable: identity.reliable,
          platform: process.platform,
        };
        writeFileSync(paths.memory, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
      },
      payload: (cwd) => failurePayload({ cwd, session_id: "s-skip" }),
    },
    {
      name: "coverage",
      expectedReason: "coverage",
      setup: (rockyHome) => {
        const paths = resolveRockyPaths({ ROCKY_HOME: rockyHome });
        writeFileSync(paths.memory, "{corrupt-1\n{corrupt-2\n", { mode: 0o600 });
      },
      payload: (cwd) => failurePayload({ cwd, session_id: "s-skip" }),
    },
    {
      name: "lock_busy",
      expectedReason: "lock_busy",
      setup: (rockyHome) => {
        const paths = resolveRockyPaths({ ROCKY_HOME: rockyHome });
        writeFileSync(`${paths.memory}.triple.lock`, "", { mode: 0o600 });
      },
      payload: (cwd) => failurePayload({ cwd, session_id: "s-skip" }),
    },
  ];

  for (const entryCase of cases) {
    const { rockyHome, workDir } = makeSandbox(t);
    entryCase.setup?.(rockyHome, workDir);

    const result = spawnHook(
      ["hook", "tool-result", "claude-code"],
      entryCase.payload(workDir),
      rockyHome,
      workDir,
    );
    assert.equal(result.status, 0, `${entryCase.name}: ${result.stderr}`);
    assert.equal(result.stdout, "{}", entryCase.name);

    const rows = readExposureRows(rockyHome);
    assert.equal(rows.length, 1, `${entryCase.name}: expected 1 skip row`);
    const row = rows[0]!;
    assert.equal(row.v, 1, entryCase.name);
    assert.equal(row.lane, "tool-result", entryCase.name);
    assert.equal(row.kind, "skip", entryCase.name);
    assert.equal(row.reason, entryCase.expectedReason, entryCase.name);
    assert.equal(row.arm, null, entryCase.name);
    assert.equal(row.key, null, entryCase.name);
    assert.equal(row.anchorFailureId, null, entryCase.name);
    assert.equal(row.delivered, false, entryCase.name);
    assert.equal(row.bytes, 0, entryCase.name);
    assert.equal(row.session, "s-skip", entryCase.name);
    assert.equal(row.cwdHash, cwdHash(workDir), entryCase.name);
    assert.ok(row.latencyMs >= 0, entryCase.name);
  }
});

test("process: pass payloads never log exposure", (t) => {
  const { rockyHome, workDir } = makeSandbox(t);
  const paths = resolveRockyPaths({ ROCKY_HOME: rockyHome });
  seedAgentFailures(paths.memory, workDir, "npm test", "Error: Cannot find module 'express'\n", 1, { session: "s-pass" });
  writeFileSync(paths.pending, "", { mode: 0o600 });

  for (const payload of [
    passPayload({ cwd: workDir, session_id: "s-pass" }),
    passPayload({ cwd: workDir, session_id: "s-pass", tool_input: { command: 'rocky run "npm test"' } }),
    passPayload({ cwd: workDir, session_id: "s-pass", tool_response: { stdout: "", stderr: "", interrupted: true } }),
  ]) {
    const result = spawnHook(
      ["hook", "tool-result", "claude-code"],
      payload,
      rockyHome,
      workDir,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "{}");
  }

  assert.deepEqual(readExposureRows(rockyHome), []);
});

test("process: stdout is valid JSON under 2 KiB in every case", (t) => {
  const { rockyHome, workDir } = makeSandbox(t);
  const paths = resolveRockyPaths({ ROCKY_HOME: rockyHome });
  const body = "Error: Cannot find module 'express'\n";
  seedAgentFailures(paths.memory, workDir, "npm test", body, 10);

  const runs: ReadonlyArray<{ stdin: string; env?: Record<string, string | undefined> }> = [
    { stdin: failurePayload({ cwd: workDir, session_id: "s-size-1" }), env: { ROCKY_TEST_SEAMS: "1", ROCKY_ATTEMPT_ARM: "shown" } },
    { stdin: failurePayload({ cwd: workDir, session_id: "s-size-1" }), env: { ROCKY_TEST_SEAMS: "1", ROCKY_ATTEMPT_ARM: "shown" } },
    { stdin: failurePayload({ cwd: workDir, session_id: "s-size-2" }), env: { ROCKY_TEST_SEAMS: "1", ROCKY_ATTEMPT_ARM: "held" } },
    { stdin: failurePayload({ cwd: workDir, session_id: "s-size-3", is_interrupt: true }) },
    { stdin: passPayload({ cwd: workDir, session_id: "s-size-1" }) },
    { stdin: "{broken" },
  ];

  for (const runCase of runs) {
    const result = spawnHook(
      ["hook", "tool-result", "claude-code"],
      runCase.stdin,
      rockyHome,
      workDir,
      PROCESS_TIMEOUT_MS,
      runCase.env ?? {},
    );
    assert.equal(result.status, 0, result.stderr);
    assert.ok(Buffer.byteLength(result.stdout, "utf8") < 2048, `stdout exceeded 2 KiB: ${result.stdout.length}`);
    assert.doesNotThrow(() => JSON.parse(result.stdout));
  }
});
