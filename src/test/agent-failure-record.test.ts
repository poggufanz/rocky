import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test, type TestContext } from "node:test";
import { fingerprint, signatureLines } from "../core/fingerprint.js";
import {
  boundCommand,
  HOOK_DUPLICATE_WINDOW_MS,
  MAX_COMMAND_BYTES,
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

const noopObserve = (): undefined => undefined;

test("recordAgentFailure writes an agent-origin failure fingerprinted from the body", (t) => {
  const paths = freshPaths(t);
  const cwd = paths.home;
  const result = recordAgentFailure(
    { cmd: "npm test", exitCode: 1, body: SAMPLE_BODY, cwd, agent: SAMPLE_AGENT },
    { lockWaitMs: 1_000, observe: noopObserve },
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

test("recordAgentFailure runs observe on the snapshot before append", (t) => {
  const paths = freshPaths(t);
  const cwd = paths.home;
  const first = recordAgentFailure(
    { cmd: "npm test", exitCode: 1, body: SAMPLE_BODY, cwd, agent: SAMPLE_AGENT },
    { lockWaitMs: 1_000, now: 1_000_000, observe: noopObserve },
  );
  assert.equal(first.status, "written");

  let observedIds: string[] = [];
  let observedComplete = false;
  let observedFingerprint = "";
  const second = recordAgentFailure(
    { cmd: "npm test", exitCode: 1, body: SAMPLE_BODY, cwd, agent: SAMPLE_AGENT },
    {
      lockWaitMs: 1_000,
      now: 1_010_000,
      observe: ({ records, coverage, fingerprint: snapshotFp }) => {
        observedIds = records.map((r) => r.id);
        observedComplete = coverage.complete;
        observedFingerprint = snapshotFp;
        return { priorCount: records.length, firstId: records[0]?.id };
      },
    },
  );

  assert.equal(second.status, "written");
  assert.equal(observedComplete, true);
  assert.equal(observedFingerprint, second.record.fingerprint);
  assert.deepEqual(observedIds, [first.record.id]);
  assert.equal(observedIds.includes(second.record.id), false);
  assert.deepEqual(second.observed, { priorCount: 1, firstId: first.record.id });

  const loaded = loadMemoryChecked(paths.memory, 1_010_000);
  assert.equal(loaded.records.length, 2);
  assert.deepEqual(loaded.records.map((r) => r.id), [first.record.id, second.record.id]);
});

test("recordAgentFailure passes the bounded-command writer fingerprint to observe", (t) => {
  const paths = freshPaths(t);
  const cwd = paths.home;
  const longCmd = `npm test -- ${"x".repeat(MAX_COMMAND_BYTES + 200)}`;
  const boundedCmd = boundCommand(longCmd);
  assert.notEqual(boundedCmd, longCmd);
  assert.notEqual(fingerprint("", boundedCmd, 1), fingerprint("", longCmd, 1));

  let observedFingerprint = "";
  const result = recordAgentFailure(
    { cmd: longCmd, exitCode: 1, body: "", cwd, agent: SAMPLE_AGENT },
    {
      lockWaitMs: 1_000,
      now: 1_020_000,
      observe: ({ fingerprint: snapshotFp }) => {
        observedFingerprint = snapshotFp;
        return snapshotFp;
      },
    },
  );

  assert.equal(result.status, "written");
  assert.equal(result.record.cmd, boundedCmd);
  assert.equal(result.record.fingerprint, fingerprint("", boundedCmd, 1));
  assert.equal(observedFingerprint, result.record.fingerprint);
  assert.equal(result.observed, result.record.fingerprint);
});

test("recordAgentFailure skips when the shell hook recorded the same command in the same cwd within 5 s", (t) => {
  const paths = freshPaths(t);
  const cwd = paths.home;
  assert.equal(HOOK_DUPLICATE_WINDOW_MS, 5_000);
  const hook = recordHookFailure("npm test", 1, cwd);
  const now = hook.ts + 4_000;

  let observeCalled = false;
  const result = recordAgentFailure(
    { cmd: "npm test", exitCode: 1, body: SAMPLE_BODY, cwd, agent: SAMPLE_AGENT },
    {
      lockWaitMs: 1_000,
      now,
      observe: () => {
        observeCalled = true;
        return "unexpected";
      },
    },
  );

  assert.deepEqual(result, { status: "skipped", reason: "hook-duplicate" });
  assert.equal(observeCalled, false);
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
      { lockWaitMs: 1_000, now, observe: noopObserve },
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
      { lockWaitMs: 1_000, now, observe: noopObserve },
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
      { lockWaitMs: 1_000, now, observe: noopObserve },
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
      { lockWaitMs: 1_000, observe: noopObserve },
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
        { lockWaitMs: 600, observe: noopObserve },
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

test("recordAgentFailure writes in tail-mode memory and still dedupes a hook failure inside the window", (t) => {
  const paths = freshPaths(t);
  const cwd = paths.home;
  const originalSeams = process.env.ROCKY_TEST_SEAMS;
  const originalCap = process.env.ROCKY_TEST_MAX_MEMORY_RECORDS;
  process.env.ROCKY_TEST_SEAMS = "1";
  process.env.ROCKY_TEST_MAX_MEMORY_RECORDS = "4";
  t.after(() => {
    if (originalSeams === undefined) delete process.env.ROCKY_TEST_SEAMS;
    else process.env.ROCKY_TEST_SEAMS = originalSeams;
    if (originalCap === undefined) delete process.env.ROCKY_TEST_MAX_MEMORY_RECORDS;
    else process.env.ROCKY_TEST_MAX_MEMORY_RECORDS = originalCap;
  });

  const now = 2_000_000;
  const makeFailure = (id: string, ts: number, cmd: string, origin?: "hook") => ({
    kind: "failure",
    id,
    ts,
    cwd,
    cmd,
    exitCode: 1,
    fingerprint: "0123456789abcdef",
    fingerprintV: 2,
    signature: ["error"],
    excerpt: "error",
    ...(origin === undefined ? {} : { origin }),
  });
  const seeded = [
    JSON.stringify(makeFailure("f-trimmed", 100_000, "npm run lint")),
    JSON.stringify(makeFailure("f-old-1", 1_000_000, "npm run lint")),
    JSON.stringify(makeFailure("f-old-2", 1_100_000, "npm run lint")),
    JSON.stringify(makeFailure("f-hook", now - 2_000, "npm run build", "hook")),
    JSON.stringify({ kind: "note", id: "n1", ts: now - 1_000, cwd, cmd: "npm test", file: "a.ts", line: 1, subject: "s1", answer: "a1" }),
  ].join("\n") + "\n";
  writeFileSync(paths.memory, seeded, { mode: 0o600 });

  const before = loadMemoryChecked(paths.memory, now);
  assert.equal(before.coverage.window, "tail");
  assert.equal(before.coverage.reason, "record-cap");

  const written = recordAgentFailure(
    { cmd: "npm test", exitCode: 1, body: SAMPLE_BODY, cwd, agent: SAMPLE_AGENT },
    { lockWaitMs: 1_000, now, observe: noopObserve },
  );
  assert.equal(written.status, "written");
  assert.equal(existsSync(paths.pending), true);
  const afterWriteContent = readFileSync(paths.memory, "utf8");
  assert.equal(afterWriteContent.trimEnd().split("\n").length, 6);

  const dup = recordAgentFailure(
    { cmd: "npm run build", exitCode: 1, body: SAMPLE_BODY, cwd, agent: SAMPLE_AGENT },
    { lockWaitMs: 1_000, now, observe: noopObserve },
  );
  assert.deepEqual(dup, { status: "skipped", reason: "hook-duplicate" });
  assert.equal(readFileSync(paths.memory, "utf8"), afterWriteContent);
});

test("recordAgentFailure still writes when one corrupt line is within the skipped-line allowance", (t) => {
  const paths = freshPaths(t);
  const seeded = "{corrupt-jsonl-line\n";
  writeFileSync(paths.memory, seeded, { mode: 0o600 });

  const result = recordAgentFailure(
    { cmd: "npm test", exitCode: 1, body: SAMPLE_BODY, cwd: paths.home, agent: SAMPLE_AGENT },
    { lockWaitMs: 1_000, now: 3_000, observe: noopObserve },
  );
  assert.equal(result.status, "written");
  assert.equal(existsSync(paths.pending), true);
  const loaded = loadMemoryChecked(paths.memory, 3_000);
  assert.equal(loaded.coverage.skipped, 1);
  assert.equal(loaded.records.length, 1);
  assert.deepEqual(loaded.records[0], result.record);
});

test("recordAgentFailure writes nothing and leaves pending untouched above the skipped-line allowance or on an uncovered window", async (t) => {
  await t.test("skipped lines above allowance", (st) => {
    const paths = freshPaths(st);
    const seeded = "{corrupt-jsonl-1\n{corrupt-jsonl-2\n";
    writeFileSync(paths.memory, seeded, { mode: 0o600 });

    let observeCalled = false;
    const result = recordAgentFailure(
      { cmd: "npm test", exitCode: 1, body: SAMPLE_BODY, cwd: paths.home, agent: SAMPLE_AGENT },
      {
        lockWaitMs: 1_000,
        now: 3_000,
        observe: () => {
          observeCalled = true;
          return undefined;
        },
      },
    );
    assert.deepEqual(result, { status: "skipped", reason: "coverage" });
    assert.equal(observeCalled, false);
    assert.equal(readFileSync(paths.memory, "utf8"), seeded);
    assert.equal(existsSync(paths.pending), false);
  });

  await t.test("uncovered tail window", (st) => {
    const paths = freshPaths(st);
    const cwd = paths.home;
    const originalSeams = process.env.ROCKY_TEST_SEAMS;
    const originalCap = process.env.ROCKY_TEST_MAX_MEMORY_RECORDS;
    process.env.ROCKY_TEST_SEAMS = "1";
    process.env.ROCKY_TEST_MAX_MEMORY_RECORDS = "2";
    st.after(() => {
      if (originalSeams === undefined) delete process.env.ROCKY_TEST_SEAMS;
      else process.env.ROCKY_TEST_SEAMS = originalSeams;
      if (originalCap === undefined) delete process.env.ROCKY_TEST_MAX_MEMORY_RECORDS;
      else process.env.ROCKY_TEST_MAX_MEMORY_RECORDS = originalCap;
    });

    const now = 2_000_000;
    const makeFailure = (id: string, ts: number) => ({
      kind: "failure",
      id,
      ts,
      cwd,
      cmd: "npm run lint",
      exitCode: 1,
      fingerprint: "0123456789abcdef",
      fingerprintV: 2,
      signature: ["error"],
      excerpt: "error",
    });
    const seeded = [
      JSON.stringify(makeFailure("f1", now - 3_000)),
      JSON.stringify(makeFailure("f2", now - 2_000)),
      JSON.stringify(makeFailure("f3", now - 1_000)),
    ].join("\n") + "\n";
    writeFileSync(paths.memory, seeded, { mode: 0o600 });

    const result = recordAgentFailure(
      { cmd: "npm test", exitCode: 1, body: SAMPLE_BODY, cwd, agent: SAMPLE_AGENT },
      { lockWaitMs: 1_000, now, observe: noopObserve },
    );
    assert.deepEqual(result, { status: "skipped", reason: "coverage" });
    assert.equal(readFileSync(paths.memory, "utf8"), seeded);
    assert.equal(existsSync(paths.pending), false);
  });
});

test("recordAgentFailure refuses a free lock when lockWaitMs is zero", (t) => {
  const paths = freshPaths(t);

  assert.throws(
    () => recordAgentFailure(
      { cmd: "npm test", exitCode: 1, body: SAMPLE_BODY, cwd: paths.home, agent: SAMPLE_AGENT },
      { lockWaitMs: 0, observe: noopObserve },
    ),
    /triple lock is busy/u,
  );
  assert.equal(existsSync(paths.memory), false);
  assert.equal(existsSync(paths.pending), false);
});

test("recordAgentFailure checks the absolute deadline before the first lock acquisition", (t) => {
  const paths = freshPaths(t);
  let calls = 0;
  const monotonicNow = (): number => {
    calls += 1;
    return calls === 1 ? 1_000 : 1_100;
  };

  assert.throws(
    () => recordAgentFailure(
      { cmd: "npm test", exitCode: 1, body: SAMPLE_BODY, cwd: paths.home, agent: SAMPLE_AGENT },
      { lockWaitMs: 50, monotonicNow, observe: noopObserve },
    ),
    /triple lock is busy/u,
  );
  assert.equal(existsSync(paths.memory), false);
  assert.equal(existsSync(paths.pending), false);
});
