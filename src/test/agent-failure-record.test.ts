import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test, type TestContext } from "node:test";
import { fingerprint, signatureLines } from "../core/fingerprint.js";
import {
  HOOK_DUPLICATE_WINDOW_MS,
  recordAgentFailure,
  recordHookFailure,
  resolveFixOnSuccess,
} from "../core/memory.js";
import { loadMemoryChecked, type AgentStamp } from "../core/memory-read.js";
import { resolveRockyPaths, type RockyPaths } from "../core/state-paths.js";

function freshPaths(t: TestContext): RockyPaths {
  const home = mkdtempSync(join(tmpdir(), "rocky-agent-failure-"));
  const original = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  t.after(() => {
    if (original === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = original;
    rmSync(home, { recursive: true, force: true });
  });
  return resolveRockyPaths({ ROCKY_HOME: home });
}

const SAMPLE_AGENT: AgentStamp = {
  vendor: "claude-code",
  session: "s1",
  toolUseId: "toolu_1",
};

const SAMPLE_BODY = "> app@1.0.0 test\nError: Cannot find module 'express'\n";

test("recordAgentFailure writes an agent-origin failure fingerprinted from the body", (t) => {
  const paths = freshPaths(t);
  const cwd = paths.home;
  const result = recordAgentFailure(
    { cmd: "npm test", exitCode: 1, body: SAMPLE_BODY, cwd, agent: SAMPLE_AGENT },
    { lockWaitMs: 1_000 },
  );

  assert.equal(result.status, "written");
  assert.equal(result.record.origin, "agent");
  assert.deepEqual(result.record.agent, SAMPLE_AGENT);
  assert.equal(result.record.fingerprint, fingerprint(SAMPLE_BODY, "npm test", 1));
  assert.deepEqual(result.record.signature, signatureLines(SAMPLE_BODY));
  assert.equal(existsSync(paths.pending), true);

  const loaded = loadMemoryChecked(paths.memory);
  assert.equal(loaded.complete, true);
  assert.equal(loaded.coverage.complete, true);
  assert.equal(loaded.records.length, 1);
  assert.deepEqual(loaded.records[0], result.record);
});

test("recordAgentFailure skips when the shell hook recorded the same command in the same cwd within 5 s", (t) => {
  const paths = freshPaths(t);
  const cwd = paths.home;
  assert.equal(HOOK_DUPLICATE_WINDOW_MS, 5_000);
  const hook = recordHookFailure("npm test", 1, cwd);
  const now = hook.ts + 4_000;

  const result = recordAgentFailure(
    { cmd: "npm test", exitCode: 1, body: SAMPLE_BODY, cwd, agent: SAMPLE_AGENT },
    { lockWaitMs: 1_000, now },
  );

  assert.deepEqual(result, { status: "skipped", reason: "hook-duplicate" });
  const failures = loadMemoryChecked(paths.memory, now).records.filter((r) => r.kind === "failure");
  assert.equal(failures.length, 1);
});

test("recordAgentFailure still writes when the hook failure is 6 s old, in another cwd, or has another identity", async (t) => {
  await t.test("hook failure is 6 s old", (st) => {
    const paths = freshPaths(st);
    const cwd = paths.home;
    const hook = recordHookFailure("npm test", 1, cwd);
    const now = hook.ts + 6_000;

    const result = recordAgentFailure(
      { cmd: "npm test", exitCode: 1, body: SAMPLE_BODY, cwd, agent: SAMPLE_AGENT },
      { lockWaitMs: 1_000, now },
    );

    assert.equal(result.status, "written");
    const failures = loadMemoryChecked(paths.memory, now).records.filter((r) => r.kind === "failure");
    assert.equal(failures.length, 2);
  });

  await t.test("hook failure is in another cwd", (st) => {
    const paths = freshPaths(st);
    const cwd = paths.home;
    const otherCwd = join(paths.home, "other");
    const hook = recordHookFailure("npm test", 1, otherCwd);
    const now = hook.ts + 1_000;

    const result = recordAgentFailure(
      { cmd: "npm test", exitCode: 1, body: SAMPLE_BODY, cwd, agent: SAMPLE_AGENT },
      { lockWaitMs: 1_000, now },
    );

    assert.equal(result.status, "written");
    const failures = loadMemoryChecked(paths.memory, now).records.filter((r) => r.kind === "failure");
    assert.equal(failures.length, 2);
  });

  await t.test("hook failure has another identity", (st) => {
    const paths = freshPaths(st);
    const cwd = paths.home;
    const hook = recordHookFailure("npm run build", 1, cwd);
    const now = hook.ts + 1_000;

    const result = recordAgentFailure(
      { cmd: "npm test", exitCode: 1, body: SAMPLE_BODY, cwd, agent: SAMPLE_AGENT },
      { lockWaitMs: 1_000, now },
    );

    assert.equal(result.status, "written");
    const failures = loadMemoryChecked(paths.memory, now).records.filter((r) => r.kind === "failure");
    assert.equal(failures.length, 2);
  });
});

test("recordAgentFailure gives up after lockWaitMs on a fresh foreign lock", (t) => {
  const paths = freshPaths(t);
  const lock = `${paths.memory}.triple.lock`;
  writeFileSync(lock, "", { mode: 0o600 });

  const started = performance.now();
  assert.throws(
    () => recordAgentFailure(
      { cmd: "npm test", exitCode: 1, body: SAMPLE_BODY, cwd: paths.home, agent: SAMPLE_AGENT },
      { lockWaitMs: 1_000 },
    ),
    /triple lock is busy/u,
  );
  const elapsed = performance.now() - started;

  assert.ok(elapsed >= 900, `expected elapsed >= 900ms, got ${elapsed.toFixed(1)}ms`);
  assert.ok(elapsed < 3_000, `expected elapsed < 3000ms, got ${elapsed.toFixed(1)}ms`);
  assert.equal(existsSync(paths.memory), false);
});

test("resolveFixOnSuccess honours lockWaitMs", (t) => {
  const paths = freshPaths(t);
  const lock = `${paths.memory}.triple.lock`;
  writeFileSync(lock, "", { mode: 0o600 });

  const started = performance.now();
  assert.throws(
    () => resolveFixOnSuccess("npm test", paths.home, { lockWaitMs: 1_000 }),
    /triple lock is busy/u,
  );
  const elapsed = performance.now() - started;

  assert.ok(elapsed >= 900, `expected elapsed >= 900ms, got ${elapsed.toFixed(1)}ms`);
  assert.ok(elapsed < 3_000, `expected elapsed < 3000ms, got ${elapsed.toFixed(1)}ms`);
});

async function waitForFile(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  if (!existsSync(path)) throw new Error(`missing marker ${path}`);
}

test("recordAgentFailure enforces an absolute deadline despite lock ownership turnover", { timeout: 20_000 }, async (t) => {
  const paths = freshPaths(t);
  const lockPath = `${paths.memory}.triple.lock`;
  const readyPath = join(paths.home, "turnover.ready");
  const stopPath = join(paths.home, "turnover.stop");
  const countPath = join(paths.home, "turnover.count");

  const workerScript = [
    "import { randomBytes } from 'node:crypto';",
    "import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';",
    "const [lockPath, readyPath, stopPath, countPath] = process.argv.slice(1);",
    "const signal = new Int32Array(new SharedArrayBuffer(4));",
    "const deadline = Date.now() + 3_500;",
    "const swap = (seq) => {",
    "  const tmp = `${lockPath}.next.${seq}`;",
    "  const payload = JSON.stringify({ pid: process.pid, token: randomBytes(16).toString('hex') });",
    "  writeFileSync(tmp, payload, { mode: 0o600 });",
    "  try { renameSync(tmp, lockPath); return true; }",
    "  catch { try { rmSync(tmp, { force: true }); } catch {} return false; }",
    "};",
    "let seq = 0;",
    "let swaps = 0;",
    "while (!swap(seq++) && Date.now() < deadline) Atomics.wait(signal, 0, 0, 10);",
    "writeFileSync(readyPath, 'ready');",
    "while (!existsSync(stopPath) && Date.now() < deadline) {",
    "  Atomics.wait(signal, 0, 0, 50);",
    "  if (swap(seq++)) swaps++;",
    "}",
    "writeFileSync(countPath, String(swaps));",
  ].join("\n");

  const child = spawn(process.execPath, [
    "--input-type=module", "--eval", workerScript, lockPath, readyPath, stopPath, countPath,
  ], { stdio: ["ignore", "ignore", "ignore"] });
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  t.after(async () => {
    try { writeFileSync(stopPath, "stop"); } catch { /* best effort */ }
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });

  await waitForFile(readyPath);

  let elapsed = 0;
  try {
    const started = performance.now();
    assert.throws(
      () => recordAgentFailure(
        { cmd: "npm test", exitCode: 1, body: SAMPLE_BODY, cwd: paths.home, agent: SAMPLE_AGENT },
        { lockWaitMs: 600 },
      ),
      /triple lock is busy/u,
    );
    elapsed = performance.now() - started;
  } finally {
    writeFileSync(stopPath, "stop");
    await exited;
  }

  const swaps = Number(readFileSync(countPath, "utf8").trim());
  assert.ok(swaps >= 2, `expected >= 2 lock ownership turnovers, got ${swaps}`);
  assert.ok(elapsed >= 500, `expected elapsed >= 500ms, got ${elapsed.toFixed(1)}ms`);
  assert.ok(elapsed < 2_000, `expected elapsed < 2000ms despite turnover, got ${elapsed.toFixed(1)}ms`);
  assert.equal(existsSync(paths.memory), false);
});

test("recordAgentFailure refuses full memory and leaves memory and pending untouched", (t) => {
  const paths = freshPaths(t);
  const originalSeams = process.env.ROCKY_TEST_SEAMS;
  const originalCap = process.env.ROCKY_TEST_MAX_MEMORY_RECORDS;
  process.env.ROCKY_TEST_SEAMS = "1";
  process.env.ROCKY_TEST_MAX_MEMORY_RECORDS = "2";
  t.after(() => {
    if (originalSeams === undefined) delete process.env.ROCKY_TEST_SEAMS;
    else process.env.ROCKY_TEST_SEAMS = originalSeams;
    if (originalCap === undefined) delete process.env.ROCKY_TEST_MAX_MEMORY_RECORDS;
    else process.env.ROCKY_TEST_MAX_MEMORY_RECORDS = originalCap;
  });

  const seeded = [
    JSON.stringify({ kind: "note", id: "n1", ts: 1_000, cwd: paths.home, cmd: "npm test", file: "a.ts", line: 1, subject: "s1", answer: "a1" }),
    JSON.stringify({ kind: "note", id: "n2", ts: 2_000, cwd: paths.home, cmd: "npm test", file: "a.ts", line: 2, subject: "s2", answer: "a2" }),
  ].join("\n") + "\n";
  writeFileSync(paths.memory, seeded, { mode: 0o600 });

  assert.throws(
    () => recordAgentFailure(
      { cmd: "npm test", exitCode: 1, body: SAMPLE_BODY, cwd: paths.home, agent: SAMPLE_AGENT },
      { lockWaitMs: 1_000, now: 3_000 },
    ),
    /exceeds bounded memory envelope/u,
  );
  assert.equal(readFileSync(paths.memory, "utf8"), seeded);
  assert.equal(existsSync(paths.pending), false);
});

test("recordAgentFailure refuses incomplete memory coverage and leaves memory and pending untouched", (t) => {
  const paths = freshPaths(t);
  const seeded = "{corrupt-jsonl-line\n";
  writeFileSync(paths.memory, seeded, { mode: 0o600 });

  assert.throws(
    () => recordAgentFailure(
      { cmd: "npm test", exitCode: 1, body: SAMPLE_BODY, cwd: paths.home, agent: SAMPLE_AGENT },
      { lockWaitMs: 1_000, now: 3_000 },
    ),
    /requires complete memory coverage/u,
  );
  assert.equal(readFileSync(paths.memory, "utf8"), seeded);
  assert.equal(existsSync(paths.pending), false);
});
