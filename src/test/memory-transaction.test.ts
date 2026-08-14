import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { commandIdentity } from "../core/fingerprint.js";
import * as memory from "../core/memory.js";
import type { FailureRecord, MemoryRecord, NoteRecord } from "../core/memory.js";
import { LINK_WINDOW_MS, queryStats } from "../core/memory-query.js";
import { hookSuccess } from "../commands/hook.js";

const packageRoot = process.cwd();
const cli = join(packageRoot, "dist", "index.js");
const testModuleRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const memoryModule = join(testModuleRoot, "core", "memory.js");
const runModule = join(testModuleRoot, "commands", "run.js");
const memoryModuleUrl = pathToFileURL(memoryModule).href;
const runModuleUrl = pathToFileURL(runModule).href;

function sandbox(t: TestContext, prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function shellArg(value: string): string {
  if (process.platform === "win32") return `"${value.replace(/"/gu, '""')}"`;
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function failure(id: string, cmd: string, cwd: string, ts = Date.now() - 1_000): FailureRecord {
  const identity = commandIdentity(cmd);
  assert.equal(identity.reliable, true, `test command must have reliable identity: ${cmd}`);
  return {
    kind: "failure",
    id,
    ts,
    cwd,
    cmd,
    exitCode: 1,
    fingerprint: `fingerprint-${id}`,
    signature: [cmd],
    excerpt: "synthetic failure",
    commandIdentity: identity.value,
    identityV: 1,
    identityReliable: true,
    platform: process.platform,
  };
}

function seed(home: string, records: readonly MemoryRecord[], pending = true): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "memory.jsonl"), records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
  if (pending) writeFileSync(join(home, "pending"), "", "utf8");
}

async function waitFor(check: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function completion(child: ChildProcess): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? -1));
  });
}

function delayedMemoryReadPreload(path: string): void {
  writeFileSync(path, [
    "const fs = require('node:fs');",
    "const { syncBuiltinESMExports } = require('node:module');",
    "const originalOpen = fs.openSync.bind(fs);",
    "const originalRead = fs.readFileSync.bind(fs);",
    "const memoryFds = new Set();",
    "fs.openSync = (path, ...args) => { const fd = originalOpen(path, ...args); if (String(path) === process.env.ROCKY_TEST_MEMORY) memoryFds.add(fd); return fd; };",
    "fs.readFileSync = (path, ...args) => { const value = originalRead(path, ...args); if (typeof path === 'number' && memoryFds.has(path)) { const signal = new Int32Array(new SharedArrayBuffer(4)); Atomics.wait(signal, 0, 0, Number(process.env.ROCKY_TEST_READ_DELAY_MS || 15)); } return value; };",
    "syncBuiltinESMExports();",
  ].join("\n"), "utf8");
}

async function concurrentSuccesses(t: TestContext, count: number): Promise<void> {
  const home = sandbox(t, `rocky-atomic-${count}-`);
  const ready = join(home, "ready");
  const start = join(home, "start");
  const preload = join(home, "delay-memory.cjs");
  mkdirSync(ready);
  delayedMemoryReadPreload(preload);

  const cwd = home;
  const cmd = "node stable-command.js";
  seed(home, [failure("shared-failure", cmd, cwd)]);

  const worker = [
    "import { existsSync, writeFileSync } from 'node:fs';",
    "const [memoryModule, runModule, home, cwd, cmd, ready, start] = process.argv.slice(1);",
    "process.env.ROCKY_HOME = home;",
    "const memory = await import(memoryModule);",
    "const run = await import(runModule);",
    "writeFileSync(`${ready}/${process.pid}`, 'ready');",
    "const signal = new Int32Array(new SharedArrayBuffer(4));",
    "while (!existsSync(start)) Atomics.wait(signal, 0, 0, 5);",
    "if (typeof memory.resolveFixOnSuccess === 'function') memory.resolveFixOnSuccess(cmd, cwd);",
    "else run.linkFixOnSuccess(memory.loadMemory(), cmd, cwd, true);",
  ].join("\n");
  const env = {
    ...process.env,
    ROCKY_HOME: home,
    ROCKY_TEST_MEMORY: join(home, "memory.jsonl"),
    ROCKY_TEST_READ_DELAY_MS: "5",
    NODE_OPTIONS: `--require=${preload}`,
  };
  const children = Array.from({ length: count }, () => spawn(process.execPath, [
    "--input-type=module", "--eval", worker,
    memoryModuleUrl, runModuleUrl, home, cwd, cmd, ready, start,
  ], { env, stdio: "ignore", windowsHide: true }));
  t.after(() => {
    for (const child of children) {
      try { child.kill(); } catch { /* already gone */ }
    }
  });
  const completions = children.map(completion);

  await waitFor(() => readdirSync(ready).length === count, 45_000, `${count} success workers`);
  writeFileSync(start, "start", "utf8");
  assert.deepEqual(await Promise.all(completions), Array<number>(count).fill(0));

  const records = memory.loadMemory(join(home, "memory.jsonl"));
  const fixes = records.filter((record) => record.kind === "fix");
  const associations = records.filter((record) => record.kind === "association");
  const rememberedFailure = records.find((record): record is FailureRecord => record.kind === "failure");
  assert.equal(fixes.length, 1, `${count} successes must create one physical confirmed fix`);
  assert.equal(associations.length, 0);
  assert.equal(rememberedFailure?.resolvedBy, fixes[0]?.id);
  assert.deepEqual(queryStats(records), { failures: 1, fixEvents: 1, resolved: 1, unresolved: 0 });
  assert.equal(existsSync(join(home, "pending")), false);
  assert.equal(existsSync(`${join(home, "memory.jsonl")}.triple.lock`), false);
}

test("16, 50, and 100 concurrent confirmed successes make one logical resolution", { timeout: 180_000 }, async (t) => {
  for (const count of [16, 50, 100]) {
    await t.test(`${count} successes`, { timeout: 60_000 }, async (st) => concurrentSuccesses(st, count));
  }
});

test("a concurrent new failure cannot be lost by pending clear", { timeout: 30_000 }, async (t) => {
  const home = sandbox(t, "rocky-pending-race-");
  const cwd = home;
  const successCmd = "node resolved.js";
  const newFailureCmd = "cargo new-failure";
  seed(home, [failure("old-failure", successCmd, cwd)]);
  const successRead = join(home, "success-read");
  const allowSuccess = join(home, "allow-success");
  const failurePending = join(home, "failure-pending");
  const preload = join(home, "pending-race.cjs");
  writeFileSync(preload, [
    "const fs = require('node:fs');",
    "const { syncBuiltinESMExports } = require('node:module');",
    "const originalOpen = fs.openSync.bind(fs);",
    "const originalRead = fs.readFileSync.bind(fs);",
    "const originalWrite = fs.writeFileSync.bind(fs);",
    "const memoryFds = new Set();",
    "let reads = 0;",
    "fs.openSync = (path, ...args) => { const fd = originalOpen(path, ...args); if (String(path) === process.env.ROCKY_TEST_MEMORY) memoryFds.add(fd); return fd; };",
    "fs.readFileSync = (path, ...args) => { const value = originalRead(path, ...args); if (process.env.ROCKY_RACE_ROLE === 'success' && typeof path === 'number' && memoryFds.has(path) && ++reads === 2) { originalWrite(process.env.ROCKY_SUCCESS_READ, 'read'); const signal = new Int32Array(new SharedArrayBuffer(4)); while (!fs.existsSync(process.env.ROCKY_ALLOW_SUCCESS)) Atomics.wait(signal, 0, 0, 5); } return value; };",
    "fs.writeFileSync = (path, ...args) => { const value = originalWrite(path, ...args); if (process.env.ROCKY_RACE_ROLE === 'failure' && String(path) === process.env.ROCKY_TEST_PENDING) originalWrite(process.env.ROCKY_FAILURE_PENDING, 'pending'); return value; };",
    "syncBuiltinESMExports();",
  ].join("\n"), "utf8");
  const common = {
    ...process.env,
    ROCKY_HOME: home,
    ROCKY_TEST_MEMORY: join(home, "memory.jsonl"),
    ROCKY_TEST_PENDING: join(home, "pending"),
    ROCKY_SUCCESS_READ: successRead,
    ROCKY_ALLOW_SUCCESS: allowSuccess,
    ROCKY_FAILURE_PENDING: failurePending,
    NODE_OPTIONS: `--require=${preload}`,
  };
  const success = spawn(process.execPath, [cli, "_hooksuccess", successCmd, cwd], {
    env: { ...common, ROCKY_RACE_ROLE: "success" }, stdio: "ignore", windowsHide: true,
  });
  t.after(() => { try { success.kill(); } catch { /* already gone */ } });
  const successDone = completion(success);
  await waitFor(() => existsSync(successRead), 10_000, "success transaction second read");

  const nextFailure = spawn(process.execPath, [cli, "_hookfail", newFailureCmd, "1", cwd], {
    env: { ...common, ROCKY_RACE_ROLE: "failure" }, stdio: "ignore", windowsHide: true,
  });
  t.after(() => { try { nextFailure.kill(); } catch { /* already gone */ } });
  const failureDone = completion(nextFailure);
  await Promise.race([
    waitFor(() => existsSync(failurePending), 2_000, "concurrent failure pending write").catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
  writeFileSync(allowSuccess, "allow", "utf8");

  assert.equal(await successDone, 0);
  assert.equal(await failureDone, 0);
  const records = memory.loadMemory(join(home, "memory.jsonl"));
  const oldFailure = records.find((record): record is FailureRecord => record.kind === "failure" && record.id === "old-failure");
  const latestFailure = records.find((record): record is FailureRecord => record.kind === "failure" && record.cmd === newFailureCmd);
  assert.ok(oldFailure?.resolvedBy);
  assert.equal(latestFailure?.resolvedBy, undefined);
  assert.equal(existsSync(join(home, "pending")), true);
});

test("partial confirmed resolution keeps pending for another recent failure", (t) => {
  const home = sandbox(t, "rocky-partial-pending-");
  const cwd = home;
  const resolvedCmd = "npm run build";
  const remainingCmd = "npm run lint";
  seed(home, [
    failure("build-failure", resolvedCmd, cwd),
    failure("lint-failure", remainingCmd, cwd),
  ]);
  const original = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  try {
    assert.equal(hookSuccess(resolvedCmd, cwd), 0);
  } finally {
    if (original === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = original;
  }
  const records = memory.loadMemory(join(home, "memory.jsonl"));
  const failures = records.filter((record): record is FailureRecord => record.kind === "failure");
  assert.ok(failures.find((record) => record.id === "build-failure")?.resolvedBy);
  assert.equal(failures.find((record) => record.id === "lint-failure")?.resolvedBy, undefined);
  assert.equal(records.filter((record) => record.kind === "fix").length, 1);
  assert.equal(records.filter((record) => record.kind === "association").length, 1);
  assert.equal(existsSync(join(home, "pending")), true);
});

test("weak-only candidate records association but never clears pending", (t) => {
  const home = sandbox(t, "rocky-weak-pending-");
  const cwd = home;
  const failedCmd = "npm run broken-alpha";
  const successCmd = "npm run unrelated-beta";
  seed(home, [failure("weak-failure", failedCmd, cwd)]);
  const original = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  try {
    assert.equal(hookSuccess(successCmd, cwd), 0);
  } finally {
    if (original === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = original;
  }
  const records = memory.loadMemory(join(home, "memory.jsonl"));
  const rememberedFailure = records.find((record): record is FailureRecord => record.kind === "failure");
  assert.equal(records.filter((record) => record.kind === "fix").length, 0);
  assert.equal(records.filter((record) => record.kind === "association").length, 1);
  assert.equal(rememberedFailure?.resolvedBy, undefined);
  assert.equal(existsSync(join(home, "pending")), true);
});

function fixedClockPreload(path: string): void {
  writeFileSync(path, "Date.now = () => Number(process.env.ROCKY_FIXED_NOW);\n", "utf8");
}

test("run, watch, and hook use the same 8-hour boundary at minus/plus 1 ms", { timeout: 30_000 }, (t) => {
  const root = sandbox(t, "rocky-window-boundary-");
  const preload = join(root, "fixed-clock.cjs");
  const fixture = join(root, "success.cjs");
  fixedClockPreload(preload);
  writeFileSync(fixture, "process.exit(0);\n", "utf8");
  const cmd = `${shellArg(process.execPath)} ${shellArg(fixture)}`;
  const now = 1_800_000_000_000;
  const surfaces = ["run", "watch", "hook"] as const;
  const boundaries = [
    { label: "inside", delta: 1, linked: true },
    { label: "outside", delta: -1, linked: false },
  ] as const;

  for (const surface of surfaces) {
    for (const boundary of boundaries) {
      const home = join(root, `${surface}-${boundary.label}`);
      const cwd = root;
      seed(home, [failure(`${surface}-${boundary.label}`, cmd, cwd, now - LINK_WINDOW_MS + boundary.delta)]);
      const env = {
        ...process.env,
        ROCKY_HOME: home,
        ROCKY_FIXED_NOW: String(now),
        NODE_OPTIONS: `--require=${preload}`,
      };
      const args = surface === "run"
        ? [cli, "run", cmd]
        : surface === "watch"
          ? [cli, "watch", "--quiet", cmd]
          : [cli, "_hooksuccess", cmd, cwd];
      const result = spawnSync(process.execPath, args, { cwd, env, encoding: "utf8", timeout: 10_000, windowsHide: true });
      assert.equal(result.status, 0, `${surface}/${boundary.label}: ${result.stderr}`);
      const records = memory.loadMemory(join(home, "memory.jsonl"));
      assert.equal(records.filter((record) => record.kind === "fix").length, boundary.linked ? 1 : 0, `${surface}/${boundary.label}`);
      assert.equal(existsSync(join(home, "pending")), !boundary.linked, `${surface}/${boundary.label} pending`);
    }
  }
});

test("an explicit selected-window override remains transactional", (t) => {
  const home = sandbox(t, "rocky-window-override-");
  const cwd = home;
  const cmd = "npm run build";
  const now = 1_800_000_000_000;
  seed(home, [failure("nine-hours-old", cmd, cwd, now - 9 * 60 * 60 * 1_000)]);
  const original = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  try {
    const result = memory.resolveFixOnSuccess(cmd, cwd, { now, windowMs: 10 * 60 * 60 * 1_000 });
    assert.equal(result.confirmedResolved, 1);
  } finally {
    if (original === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = original;
  }
  assert.equal(memory.loadMemory(join(home, "memory.jsonl")).filter((record) => record.kind === "fix").length, 1);
  assert.equal(existsSync(join(home, "pending")), false);
});

test("48 small and 12 real 128 KiB concurrent appends are parseable and lossless", { timeout: 90_000 }, async (t) => {
  const home = sandbox(t, "rocky-append-integrity-");
  const ready = join(home, "ready");
  const start = join(home, "start");
  mkdirSync(ready);
  const workers = [
    ...Array.from({ length: 48 }, (_, index) => ({ id: `small-${index}`, size: 32 })),
    ...Array.from({ length: 12 }, (_, index) => ({ id: `large-${index}`, size: 128 * 1024 })),
  ];
  const script = [
    "import { existsSync, writeFileSync } from 'node:fs';",
    "const [modulePath, home, id, sizeText, ready, start] = process.argv.slice(1);",
    "process.env.ROCKY_HOME = home;",
    "const { recordNote } = await import(modulePath);",
    "writeFileSync(`${ready}/${process.pid}`, 'ready');",
    "const signal = new Int32Array(new SharedArrayBuffer(4));",
    "while (!existsSync(start)) Atomics.wait(signal, 0, 0, 5);",
    "const size = Number(sizeText);",
    "const answer = `${id}:` + 'x'.repeat(size) + `:${id}`;",
    "recordNote({ cwd: home, cmd: id, file: `${id}.ts`, line: 1, subject: id, answer });",
  ].join("\n");
  const children = workers.map((worker) => spawn(process.execPath, [
    "--input-type=module", "--eval", script,
    memoryModuleUrl, home, worker.id, String(worker.size), ready, start,
  ], { stdio: "ignore", windowsHide: true }));
  t.after(() => {
    for (const child of children) {
      try { child.kill(); } catch { /* already gone */ }
    }
  });
  const completions = children.map(completion);
  await waitFor(() => readdirSync(ready).length === workers.length, 45_000, "append workers");
  writeFileSync(start, "start", "utf8");
  assert.deepEqual(await Promise.all(completions), Array<number>(workers.length).fill(0));

  const rawLines = readFileSync(join(home, "memory.jsonl"), "utf8").trim().split("\n");
  assert.equal(rawLines.length, workers.length);
  for (const line of rawLines) assert.doesNotThrow(() => JSON.parse(line));
  const notes = memory.loadMemory(join(home, "memory.jsonl")).filter((record): record is NoteRecord => record.kind === "note");
  assert.equal(notes.length, workers.length);
  const byCmd = new Map(notes.map((note) => [note.cmd, note]));
  for (const worker of workers) {
    const answer = byCmd.get(worker.id)?.answer;
    assert.equal(answer, `${worker.id}:` + "x".repeat(worker.size) + `:${worker.id}`);
  }
});

test("dead owner and stale empty, torn, or orphan-claim locks recover promptly", { timeout: 20_000 }, async (t) => {
  const home = sandbox(t, "rocky-lock-recovery-");
  const ready = join(home, "crash-ready");
  const worker = [
    "import { writeFileSync } from 'node:fs';",
    "const [modulePath, home, ready] = process.argv.slice(1);",
    "process.env.ROCKY_HOME = home;",
    "const memory = await import(modulePath);",
    "if (typeof memory.withMemoryTransaction !== 'function') process.exit(64);",
    "memory.withMemoryTransaction(() => { writeFileSync(ready, 'ready'); process.exit(73); });",
  ].join("\n");
  const crashed = spawn(process.execPath, ["--input-type=module", "--eval", worker, memoryModuleUrl, home, ready], {
    stdio: "ignore", windowsHide: true,
  });
  assert.equal(await completion(crashed), 73);
  assert.equal(existsSync(ready), true);
  const lock = `${join(home, "memory.jsonl")}.triple.lock`;
  assert.equal(existsSync(lock), true);

  const original = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  try {
    const started = Date.now();
    memory.recordNote({ cwd: home, cmd: "after-crash", file: "a.ts", line: 1, subject: "a", answer: "a" });
    assert.ok(Date.now() - started < 2_000, "dead owner recovery stays prompt");
    assert.equal(existsSync(lock), false);

    writeFileSync(lock, "", { mode: 0o600 });
    const stale = new Date(Date.now() - 11 * 60 * 1_000);
    utimesSync(lock, stale, stale);
    memory.recordNote({ cwd: home, cmd: "after-empty", file: "b.ts", line: 1, subject: "b", answer: "b" });
    assert.equal(existsSync(lock), false);

    writeFileSync(lock, '{"pid":', { mode: 0o600 });
    utimesSync(lock, stale, stale);
    const tornStarted = Date.now();
    memory.recordNote({ cwd: home, cmd: "after-torn", file: "c.ts", line: 1, subject: "c", answer: "c" });
    assert.ok(Date.now() - tornStarted < 2_000, "stale torn-lock recovery stays prompt");
    assert.equal(existsSync(lock), false);

    const deadPid = 2_147_483_647;
    writeFileSync(lock, JSON.stringify({ pid: deadPid, token: "e".repeat(32) }), { mode: 0o600 });
    const orphanClaim = `${lock}.reclaim.${deadPid}.${"f".repeat(32)}`;
    linkSync(lock, orphanClaim);
    memory.recordNote({ cwd: home, cmd: "after-orphan", file: "d.ts", line: 1, subject: "d", answer: "d" });
    assert.equal(existsSync(lock), false);
    assert.equal(existsSync(orphanClaim), false);
  } finally {
    if (original === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = original;
  }
  assert.equal(memory.loadMemory(join(home, "memory.jsonl")).filter((record) => record.kind === "note").length, 4);
});

test("competing dead-owner reclaimers never overlap transactions", { timeout: 30_000 }, async (t) => {
  const home = sandbox(t, "rocky-lock-reclaim-race-");
  const lock = `${join(home, "memory.jsonl")}.triple.lock`;
  const preload = join(home, "delay-unlink.cjs");
  const ready = join(home, "ready");
  const start = join(home, "start");
  const active = join(home, "active");
  const violation = join(home, "overlap");
  mkdirSync(ready, { recursive: true });
  mkdirSync(active, { recursive: true });
  writeFileSync(lock, JSON.stringify({ pid: 2_147_483_647, token: "d".repeat(32) }), { mode: 0o600 });
  writeFileSync(preload, [
    "const fs = require('node:fs');",
    "const { syncBuiltinESMExports } = require('node:module');",
    "const original = fs.unlinkSync.bind(fs);",
    "fs.unlinkSync = (path) => {",
    "  if (String(path) === process.env.ROCKY_TEST_LOCK) {",
    "    const signal = new Int32Array(new SharedArrayBuffer(4));",
    "    Atomics.wait(signal, 0, 0, 100);",
    "  }",
    "  return original(path);",
    "};",
    "syncBuiltinESMExports();",
  ].join("\n"), "utf8");
  const worker = [
    "import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';",
    "const [modulePath, home, ready, start, active, violation] = process.argv.slice(1);",
    "process.env.ROCKY_HOME = home;",
    "const { withMemoryTransaction } = await import(modulePath);",
    "writeFileSync(`${ready}/${process.pid}`, 'ready');",
    "const signal = new Int32Array(new SharedArrayBuffer(4));",
    "while (!existsSync(start)) Atomics.wait(signal, 0, 0, 5);",
    "withMemoryTransaction(() => {",
    "  const marker = `${active}/${process.pid}`;",
    "  writeFileSync(marker, 'active');",
    "  if (readdirSync(active).length > 1) writeFileSync(violation, 'overlap');",
    "  Atomics.wait(signal, 0, 0, 120);",
    "  rmSync(marker, { force: true });",
    "});",
  ].join("\n");
  const env = { ...process.env, ROCKY_HOME: home, ROCKY_TEST_LOCK: lock, NODE_OPTIONS: `--require=${preload}` };
  const children = Array.from({ length: 12 }, () => spawn(process.execPath, [
    "--input-type=module", "--eval", worker, memoryModuleUrl, home, ready, start, active, violation,
  ], { env, stdio: "ignore", windowsHide: true }));
  t.after(() => {
    for (const child of children) {
      try { child.kill(); } catch { /* already gone */ }
    }
  });
  const completions = children.map(completion);
  await waitFor(() => readdirSync(ready).length === children.length, 15_000, "reclaim workers");
  writeFileSync(start, "start", "utf8");
  assert.deepEqual(await Promise.all(completions), Array<number>(children.length).fill(0));
  assert.equal(existsSync(violation), false, "memory transactions must never overlap during recovery");
  assert.equal(existsSync(lock), false);
});

test("live owner lock is bounded bookkeeping and preserves child success", { timeout: 12_000 }, (t) => {
  const home = sandbox(t, "rocky-live-lock-");
  const fixture = join(home, "success.cjs");
  const lock = `${join(home, "memory.jsonl")}.triple.lock`;
  mkdirSync(home, { recursive: true });
  writeFileSync(fixture, "process.exit(0);\n", "utf8");
  writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "a".repeat(32) }), { mode: 0o600 });
  const cmd = `${shellArg(process.execPath)} ${shellArg(fixture)}`;
  const started = Date.now();
  const result = spawnSync(process.execPath, [cli, "run", cmd], {
    env: { ...process.env, ROCKY_HOME: home }, encoding: "utf8", timeout: 9_000, windowsHide: true,
  });
  const elapsed = Date.now() - started;
  assert.equal(result.status, 0, result.stderr);
  assert.ok(elapsed >= 4_000 && elapsed < 8_000, `memory lock wait must stay bounded, got ${elapsed} ms`);
  assert.equal(existsSync(lock), true, "live owner's lock is never stolen");
  assert.match(result.stderr, /I cannot write memory\. this one I forget\./u);
});

test("hook bookkeeping also returns zero when a live owner keeps the lock", (t) => {
  const home = sandbox(t, "rocky-hook-live-lock-");
  const cwd = home;
  const cmd = "npm run build";
  seed(home, [failure("hook-live", cmd, cwd)]);
  const lock = `${join(home, "memory.jsonl")}.triple.lock`;
  writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "b".repeat(32) }), { mode: 0o600 });
  const originalHome = process.env.ROCKY_HOME;
  const originalNow = Date.now;
  const base = originalNow();
  let first = true;
  process.env.ROCKY_HOME = home;
  Date.now = () => first ? (first = false, base) : base + 6_000;
  try {
    assert.equal(hookSuccess(cmd, cwd), 0);
  } finally {
    Date.now = originalNow;
    if (originalHome === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = originalHome;
  }
  assert.equal(existsSync(lock), true);
  assert.equal(memory.loadMemory(join(home, "memory.jsonl")).filter((record) => record.kind === "fix").length, 0);
  assert.equal(existsSync(join(home, "pending")), true);
});
