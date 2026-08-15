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
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { commandIdentity } from "../core/fingerprint.js";
import * as memory from "../core/memory.js";
import type { AssociationRecord, FailureRecord, FixRecord, MemoryRecord, NoteRecord } from "../core/memory.js";
import { LINK_WINDOW_MS, queryStats } from "../core/memory-query.js";
import { hookSuccess } from "../commands/hook.js";
import { probeSymlink } from "./symlink-capability.js";

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

type WorkerOutcome = {
  code: number | null;
  signal: NodeJS.Signals | null;
  pid: number | null;
  stderr: string;
  spawnError: { name: string; message: string; code?: string } | null;
};

function completionWithStderr(child: ChildProcess): Promise<WorkerOutcome> {
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  let spawnError: WorkerOutcome["spawnError"] = null;
  child.once("error", (error) => {
    const candidate = error as NodeJS.ErrnoException;
    spawnError = {
      name: error.name,
      message: error.message,
      ...(typeof candidate.code === "string" ? { code: candidate.code } : {}),
    };
  });
  return new Promise<WorkerOutcome>((resolve) => {
    child.once("close", (code, signal) => resolve({
      code,
      signal,
      pid: child.pid ?? null,
      stderr,
      spawnError,
    }));
  });
}

function delayedMemoryReadPreload(path: string): void {
  writeFileSync(path, [
    "const fs = require('node:fs');",
    "const { syncBuiltinESMExports } = require('node:module');",
    "const originalOpen = fs.openSync.bind(fs);",
    "const originalRead = fs.readSync.bind(fs);",
    "const memoryFds = new Set();",
    "let delayed = false;",
    "fs.openSync = (path, ...args) => { const fd = originalOpen(path, ...args); if (String(path) === process.env.ROCKY_TEST_MEMORY) memoryFds.add(fd); return fd; };",
    "fs.readSync = (fd, ...args) => { if (!delayed && memoryFds.has(fd)) { delayed = true; if (process.env.ROCKY_TEST_READ_MARKER) fs.writeFileSync(process.env.ROCKY_TEST_READ_MARKER, 'fired'); const signal = new Int32Array(new SharedArrayBuffer(4)); Atomics.wait(signal, 0, 0, Number(process.env.ROCKY_TEST_READ_DELAY_MS || 15)); } return originalRead(fd, ...args); };",
    "syncBuiltinESMExports();",
  ].join("\n"), "utf8");
}

function mutationReloadFailurePreload(path: string): void {
  writeFileSync(path, [
    "const fs = require('node:fs');",
    "const { syncBuiltinESMExports } = require('node:module');",
    "const originalOpen = fs.openSync.bind(fs);",
    "const originalRead = fs.readSync.bind(fs);",
    "const originalLstat = fs.lstatSync.bind(fs);",
    "const memoryFds = new Set();",
    "let reads = 0;",
    "let lists = 0;",
    "fs.openSync = (path, ...args) => { const fd = originalOpen(path, ...args); if (String(path) === process.env.ROCKY_TEST_MEMORY) memoryFds.add(fd); return fd; };",
    "fs.readSync = (fd, ...args) => { if (process.env.ROCKY_TEST_RELOAD_MODE === 'read' && memoryFds.has(fd) && ++reads === 2) { if (process.env.ROCKY_TEST_READ_MARKER) fs.writeFileSync(process.env.ROCKY_TEST_READ_MARKER, 'fired'); throw new Error('injected mutation reload failure'); } return originalRead(fd, ...args); };",
    "fs.lstatSync = (path, ...args) => { const stats = originalLstat(path, ...args); if (process.env.ROCKY_TEST_RELOAD_MODE === 'identity' && String(path) === process.env.ROCKY_TEST_MEMORY && ++lists === 3) { if (process.env.ROCKY_TEST_LSTAT_MARKER) fs.writeFileSync(process.env.ROCKY_TEST_LSTAT_MARKER, 'fired'); const replacement = Object.create(Object.getPrototypeOf(stats)); Object.assign(replacement, stats, { ino: Number(stats.ino) + 1 }); return replacement; } return stats; };",
    "syncBuiltinESMExports();",
  ].join("\n"), "utf8");
}

function initialMemoryReadFailurePreload(path: string): void {
  writeFileSync(path, [
    "const fs = require('node:fs');",
    "const { syncBuiltinESMExports } = require('node:module');",
    "const originalOpen = fs.openSync.bind(fs);",
    "const originalRead = fs.readSync.bind(fs);",
    "const memoryFds = new Set();",
    "let reads = 0;",
    "fs.openSync = (path, ...args) => { const fd = originalOpen(path, ...args); if (String(path) === process.env.ROCKY_TEST_MEMORY) memoryFds.add(fd); return fd; };",
    "fs.readSync = (fd, ...args) => { if (memoryFds.has(fd) && ++reads === 1) { if (process.env.ROCKY_TEST_READ_MARKER) fs.writeFileSync(process.env.ROCKY_TEST_READ_MARKER, 'fired'); throw new Error('injected initial memory read failure'); } return originalRead(fd, ...args); };",
    "syncBuiltinESMExports();",
  ].join("\n"), "utf8");
}

function crashAfterLockRenamePreload(path: string): void {
  writeFileSync(path, [
    "const fs = require('node:fs');",
    "const { syncBuiltinESMExports } = require('node:module');",
    "const originalRename = fs.renameSync.bind(fs);",
    "fs.renameSync = (from, to, ...args) => {",
    "  const result = originalRename(from, to, ...args);",
    "  if (String(from) === process.env.ROCKY_TEST_CRASH_RENAME_FROM) process.exit(Number(process.env.ROCKY_TEST_CRASH_CODE || 73));",
    "  return result;",
    "};",
    "syncBuiltinESMExports();",
  ].join("\n"), "utf8");
}

function replacementBeforePrimaryRenamePreload(path: string): void {
  writeFileSync(path, [
    "const fs = require('node:fs');",
    "const { syncBuiltinESMExports } = require('node:module');",
    "const originalRename = fs.renameSync.bind(fs);",
    "let replaced = false;",
    "fs.renameSync = (from, to, ...args) => {",
    "  if (!replaced && String(from) === process.env.ROCKY_TEST_REPLACE_FROM) {",
    "    replaced = true;",
    "    originalRename(from, process.env.ROCKY_TEST_REPLACE_SAVE);",
    "    fs.writeFileSync(from, JSON.stringify({ pid: 2147483647, token: 'r'.repeat(32) }));",
    "  }",
    "  return originalRename(from, to, ...args);",
    "};",
    "syncBuiltinESMExports();",
  ].join("\n"), "utf8");
}

function tombstoneReplacementBeforeDeletePreload(path: string): void {
  writeFileSync(path, [
    "const fs = require('node:fs');",
    "const { syncBuiltinESMExports } = require('node:module');",
    "const originalOpen = fs.openSync.bind(fs);",
    "const originalRead = fs.readSync.bind(fs);",
    "const originalRename = fs.renameSync.bind(fs);",
    "const tombstoneFds = new Map();",
    "let reads = 0;",
    "fs.openSync = (path, ...args) => { const fd = originalOpen(path, ...args); if (String(path).includes('.reclaim.tombstone.')) tombstoneFds.set(fd, String(path)); return fd; };",
    "fs.readSync = (fd, ...args) => { const result = originalRead(fd, ...args); const tombstone = tombstoneFds.get(fd); if (tombstone && ++reads === 2) { originalRename(tombstone, process.env.ROCKY_TEST_TOMBSTONE_SAVE); fs.writeFileSync(tombstone, JSON.stringify({ pid: 2147483647, token: 'x'.repeat(32) })); } return result; };",
    "syncBuiltinESMExports();",
  ].join("\n"), "utf8");
}

function partialMetadataWritePreload(path: string): void {
  writeFileSync(path, [
    "const fs = require('node:fs');",
    "const { syncBuiltinESMExports } = require('node:module');",
    "const originalOpen = fs.openSync.bind(fs);",
    "const originalWrite = fs.writeSync.bind(fs);",
    "const paths = new Map();",
    "let failed = false;",
    "fs.openSync = (path, ...args) => { const fd = originalOpen(path, ...args); paths.set(fd, String(path)); return fd; };",
    "fs.writeSync = (fd, ...args) => { if (!failed && paths.get(fd) === process.env.ROCKY_TEST_PARTIAL_PATH) { failed = true; if (process.env.ROCKY_TEST_PARTIAL_MODE === 'throw') throw new Error('injected partial metadata write'); return 0; } return originalWrite(fd, ...args); };",
    "syncBuiltinESMExports();",
  ].join("\n"), "utf8");
}

async function concurrentSuccesses(t: TestContext, count: number): Promise<void> {
  const home = sandbox(t, `rocky-atomic-${count}-`);
  const ready = join(home, "ready");
  const start = join(home, "start");
  const preload = join(home, "delay-memory.cjs");
  const readMarker = join(home, "read-fired");
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
    ROCKY_TEST_READ_MARKER: readMarker,
    NODE_OPTIONS: `--require=${preload}`,
  };
  const children = Array.from({ length: count }, () => spawn(process.execPath, [
    "--input-type=module", "--eval", worker,
    memoryModuleUrl, runModuleUrl, home, cwd, cmd, ready, start,
  ], { env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true }));
  t.after(() => {
    for (const child of children) {
      try { child.kill(); } catch { /* already gone */ }
    }
  });
  const completions = children.map(completionWithStderr);

  await waitFor(() => readdirSync(ready).length === count, 45_000, `${count} success workers`);
  writeFileSync(start, "start", "utf8");
  const outcomes = await Promise.all(completions);
  const lock = join(home, "memory.jsonl.triple.lock");
  const lockState = existsSync(lock) ? readFileSync(lock, "utf8") : "absent";
  assert.deepEqual(
    outcomes.map(({ code }) => code),
    Array<number>(count).fill(0),
    `worker outcomes: ${JSON.stringify({ outcomes, lockState })}`,
  );
  assert.equal(existsSync(readMarker), true, "readSync delay seam must fire");

  const records = memory.loadMemory(join(home, "memory.jsonl"));
  const fixes = records.filter((record) => record.kind === "fix");
  const associations = records.filter((record) => record.kind === "association");
  const rememberedFailure = records.find((record): record is FailureRecord => record.kind === "failure");
  assert.equal(fixes.length, 1, `${count} successes must create one physical confirmed fix`);
  assert.equal(associations.length, 0);
  assert.equal(rememberedFailure?.resolvedBy, fixes[0]?.id);
  assert.deepEqual(queryStats(records), {
    failures: 1, fixEvents: 1, resolved: 1, unresolved: 0,
    confirmedFixes: 1, possibleFixes: 0, triples: 0, notes: 0, total: 2,
  });
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
    "const originalReadSync = fs.readSync.bind(fs);",
    "const originalWrite = fs.writeFileSync.bind(fs);",
    "const memoryFds = new Set();",
    "let opens = 0;",
    "fs.openSync = (path, ...args) => { const fd = originalOpen(path, ...args); if (String(path) === process.env.ROCKY_TEST_MEMORY) { memoryFds.add(fd); if (process.env.ROCKY_RACE_ROLE === 'success' && ++opens === 2) { originalWrite(process.env.ROCKY_SUCCESS_READ, 'open'); const signal = new Int32Array(new SharedArrayBuffer(4)); while (!fs.existsSync(process.env.ROCKY_ALLOW_SUCCESS)) Atomics.wait(signal, 0, 0, 5); } } return fd; };",
    "fs.readFileSync = (path, ...args) => originalRead(path, ...args);",
    "fs.readSync = (path, ...args) => originalReadSync(path, ...args);",
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

test("a no-link success never clears pending without a confirmed resolution", (t) => {
  const home = sandbox(t, "rocky-no-confirmed-pending-");
  const cwd = home;
  const now = 1_800_000_000_000;
  seed(home, [failure("expired-failure", "npm run build", cwd, now - LINK_WINDOW_MS - 1)]);
  const original = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  try {
    memory.clearPendingIfResolved([], LINK_WINDOW_MS, now);
    assert.equal(hookSuccess("npm run unrelated", cwd, { now }), 0);
  } finally {
    if (original === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = original;
  }
  assert.equal(existsSync(join(home, "pending")), true);
  assert.equal(memory.loadMemory(join(home, "memory.jsonl")).filter((record) => record.kind === "fix").length, 0);
});

test("future failures are not linked and cannot satisfy delayed resolution proof", (t) => {
  const now = 1_800_000_000_000;
  const home = sandbox(t, "rocky-future-failure-");
  const cwd = home;
  const cmd = "node future-command.js";
  const futureFailure = failure("future-failure", cmd, cwd, now + 1);
  seed(home, [futureFailure]);
  const originalHome = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  try {
    const result = memory.resolveFixOnSuccess(cmd, cwd, { now });
    assert.deepEqual(result, { confirmedResolved: 0, possibleAssociated: 0 });
  } finally {
    if (originalHome === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = originalHome;
  }
  assert.equal(existsSync(join(home, "pending")), true, "future unresolved failure retains pending");
  assert.equal(memory.loadMemory(join(home, "memory.jsonl")).filter((record) => record.kind === "fix").length, 0);

  const proofHome = sandbox(t, "rocky-future-proof-");
  const proofFailure = failure("future-proof-failure", cmd, proofHome, now + 1);
  const proofFix: FixRecord = {
    kind: "fix", id: "future-proof-fix", ts: now - 1_000, cwd: proofHome,
    cmd, failureIds: [proofFailure.id],
  };
  seed(proofHome, [proofFailure, proofFix]);
  const proofOriginalHome = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = proofHome;
  try {
    memory.resolveFixOnSuccess(cmd, proofHome, { now });
  } finally {
    if (proofOriginalHome === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = proofOriginalHome;
  }
  assert.equal(existsSync(join(proofHome, "pending")), true, "future failure cannot satisfy delayed recovery proof");

  const combinedHome = sandbox(t, "rocky-future-unrelated-reconcile-");
  const combinedCwd = combinedHome;
  const combinedFailure = failure("combined-future-failure", cmd, combinedCwd, now + 1);
  const combinedFutureFix: FixRecord = {
    kind: "fix", id: "combined-future-fix", ts: now + 2, cwd: combinedCwd,
    cmd, failureIds: [combinedFailure.id],
  };
  const unrelatedCmd = "node unrelated-valid-command.js";
  const unrelatedFailure = failure("combined-unrelated-failure", unrelatedCmd, combinedCwd, now - 1_000);
  const unrelatedFix: FixRecord = {
    kind: "fix", id: "combined-unrelated-fix", ts: now - 500, cwd: combinedCwd,
    cmd: unrelatedCmd, failureIds: [unrelatedFailure.id],
  };
  seed(combinedHome, [combinedFailure, combinedFutureFix, unrelatedFailure, unrelatedFix]);
  const combinedOriginalHome = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = combinedHome;
  try {
    memory.resolveFixOnSuccess(unrelatedCmd, combinedCwd, { now });
  } finally {
    if (combinedOriginalHome === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = combinedOriginalHome;
  }
  const combinedRecords = memory.loadMemory(join(combinedHome, "memory.jsonl"), now);
  assert.equal(combinedRecords.find((record): record is FailureRecord => record.kind === "failure" && record.id === combinedFailure.id)?.resolvedBy, undefined);
  assert.equal(combinedRecords.find((record): record is FailureRecord => record.kind === "failure" && record.id === unrelatedFailure.id)?.resolvedBy, unrelatedFix.id);
  assert.equal(existsSync(join(combinedHome, "pending")), false, "future records do not keep pending during reconciliation");
});

test("a same-identity FixRecord from another cwd cannot clear pending through delayed reconciliation", (t) => {
  const now = 1_800_000_000_000;
  const home = sandbox(t, "rocky-cross-cwd-resolution-");
  const cwdA = join(home, "project-a");
  const cwdB = join(home, "project-b");
  const cmd = "node stable-command.js";
  const oldFailure = failure("old-same-cwd-failure", cmd, cwdA, now - 2 * 60 * 60 * 1_000);
  const oldFix: FixRecord = {
    kind: "fix", id: "old-same-cwd-fix", ts: now - 2 * 60 * 60 * 1_000, cwd: cwdA,
    cmd, failureIds: [oldFailure.id],
  };
  const recentFailure = failure("recent-cross-cwd-failure", cmd, cwdA, now - 1_000);
  const crossCwdFix: FixRecord = {
    kind: "fix", id: "cross-cwd-fix", ts: now - 500, cwd: cwdB,
    cmd, failureIds: [recentFailure.id],
  };
  seed(home, [oldFailure, oldFix, recentFailure, crossCwdFix]);
  const originalHome = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  try {
    memory.clearPendingIfResolved([], LINK_WINDOW_MS, now);
  } finally {
    if (originalHome === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = originalHome;
  }
  const records = memory.loadMemory(join(home, "memory.jsonl"));
  assert.equal(records.find((record): record is FailureRecord => record.kind === "failure" && record.id === recentFailure.id)?.resolvedBy, undefined);
  assert.equal(existsSync(join(home, "pending")), true, "cross-cwd confirmation must retain pending");
});

test("a reload failure after fix append fails closed and preserves pending", { timeout: 20_000 }, (t) => {
  const home = sandbox(t, "rocky-reload-incomplete-");
  const cwd = home;
  const cmd = "node stable-command.js";
  seed(home, [failure("reload-resolved", cmd, cwd), failure("reload-remaining", "cargo build", cwd)]);
  const preload = join(home, "reload-failure.cjs");
  const readMarker = join(home, "reload-read-fired");
  mutationReloadFailurePreload(preload);
  const result = spawnSync(process.execPath, [cli, "_hooksuccess", cmd, cwd], {
    env: {
      ...process.env,
      ROCKY_HOME: home,
      ROCKY_TEST_MEMORY: join(home, "memory.jsonl"),
      ROCKY_TEST_RELOAD_MODE: "read",
      ROCKY_TEST_READ_MARKER: readMarker,
      NODE_OPTIONS: `--require=${preload}`,
    },
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(readMarker), true, "readSync reload seam must fire");
  const records = memory.loadMemory(join(home, "memory.jsonl"));
  assert.equal(records.filter((record) => record.kind === "fix").length, 1);
  assert.equal(records.find((record): record is FailureRecord =>
    record.kind === "failure" && record.id === "reload-remaining")?.resolvedBy, undefined);
  assert.equal(existsSync(join(home, "pending")), true);

  const identityHome = sandbox(t, "rocky-reload-identity-");
  seed(identityHome, [failure("identity-resolved", cmd, identityHome), failure("identity-remaining", "cargo build", identityHome)]);
  const identityResult = spawnSync(process.execPath, [cli, "_hooksuccess", cmd, identityHome], {
    env: {
      ...process.env,
      ROCKY_HOME: identityHome,
      ROCKY_TEST_MEMORY: join(identityHome, "memory.jsonl"),
      ROCKY_TEST_RELOAD_MODE: "identity",
      ROCKY_TEST_LSTAT_MARKER: join(identityHome, "lstat-fired"),
      NODE_OPTIONS: `--require=${preload}`,
    },
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  assert.equal(identityResult.status, 0, identityResult.stderr);
  assert.equal(existsSync(join(identityHome, "lstat-fired")), true, "lstat identity seam must fire");
  const identityRecords = memory.loadMemory(join(identityHome, "memory.jsonl"));
  assert.equal(identityRecords.filter((record) => record.kind === "fix").length, 1);
  assert.equal(existsSync(join(identityHome, "pending")), true);
});

test("a crash after durable FixRecord append is reconciled by the next success", { timeout: 20_000 }, (t) => {
  const home = sandbox(t, "rocky-fix-crash-recovery-");
  const cwd = home;
  const cmd = "node stable-command.js";
  seed(home, [failure("crashed-fix", cmd, cwd)]);
  const preload = join(home, "crash-after-fix.cjs");
  writeFileSync(preload, [
    "const fs = require('node:fs');",
    "const { syncBuiltinESMExports } = require('node:module');",
    "const originalWrite = fs.writeSync.bind(fs);",
    "fs.writeSync = (fd, buffer, ...args) => { const written = originalWrite(fd, buffer, ...args); if (String(buffer).includes('\\\"kind\\\":\\\"fix\\\"')) process.exit(73); return written; };",
    "syncBuiltinESMExports();",
  ].join("\n"), "utf8");
  const first = spawnSync(process.execPath, [cli, "_hooksuccess", cmd, cwd], {
    env: {
      ...process.env,
      ROCKY_HOME: home,
      NODE_OPTIONS: `--require=${preload}`,
    },
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  assert.equal(first.status, 73, first.stderr);
  assert.equal(memory.loadMemory(join(home, "memory.jsonl")).filter((record) => record.kind === "fix").length, 1);
  assert.equal(existsSync(join(home, "pending")), true);

  const second = spawnSync(process.execPath, [cli, "_hooksuccess", cmd, cwd], {
    env: { ...process.env, ROCKY_HOME: home },
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(memory.loadMemory(join(home, "memory.jsonl")).filter((record) => record.kind === "fix").length, 1);
  assert.equal(existsSync(join(home, "pending")), false);
});

test("a delayed exact success recovers crash resolution beyond the link window while weak evidence stays pending", { timeout: 30_000 }, (t) => {
  const oldNow = 1_800_000_000_000;
  const delays = [9 * 60 * 60 * 1_000, 90 * 24 * 60 * 60 * 1_000];
  for (const delay of delays) {
    const home = sandbox(t, `rocky-fix-crash-delayed-${delay}-`);
    const cwd = home;
    const cmd = "node stable-command.js";
    const preload = join(home, "crash-after-fix-old-clock.cjs");
    seed(home, [failure(`crashed-${delay}`, cmd, cwd, oldNow)]);
    writeFileSync(preload, [
      `Date.now = () => ${oldNow};`,
      "const fs = require('node:fs');",
      "const { syncBuiltinESMExports } = require('node:module');",
      "const originalWrite = fs.writeSync.bind(fs);",
      "fs.writeSync = (fd, buffer, ...args) => { const written = originalWrite(fd, buffer, ...args); if (String(buffer).includes('\\\"kind\\\":\\\"fix\\\"')) process.exit(73); return written; };",
      "syncBuiltinESMExports();",
    ].join("\n"), "utf8");
    const first = spawnSync(process.execPath, [cli, "_hooksuccess", cmd, cwd], {
      env: { ...process.env, ROCKY_HOME: home, NODE_OPTIONS: `--require=${preload}` },
      encoding: "utf8", timeout: 10_000, windowsHide: true,
    });
    assert.equal(first.status, 73, first.stderr);
    assert.equal(existsSync(join(home, "pending")), true);
    assert.equal(memory.loadMemory(join(home, "memory.jsonl")).filter((record) => record.kind === "fix").length, 1);

    const originalHome = process.env.ROCKY_HOME;
    process.env.ROCKY_HOME = home;
    try {
      const result = memory.resolveFixOnSuccess(cmd, cwd, { now: oldNow + delay });
      assert.deepEqual(result, { confirmedResolved: 0, possibleAssociated: 0 });
    } finally {
      if (originalHome === undefined) delete process.env.ROCKY_HOME;
      else process.env.ROCKY_HOME = originalHome;
    }
    assert.equal(existsSync(join(home, "pending")), false, `${delay} ms delayed recovery must reconcile pending`);
  }

  const weakHome = sandbox(t, "rocky-fix-crash-delayed-weak-");
  const weakCwd = weakHome;
  const weakCmd = "node weak-command.js";
  const weakFailure = failure("weak-delayed", weakCmd, weakCwd, oldNow);
  const weakAssociation: AssociationRecord = {
    kind: "association", id: "weak-association", ts: oldNow, cwd: weakCwd, cmd: weakCmd,
    candidateFailureIds: [weakFailure.id],
    links: [{ id: weakFailure.id, basis: "program", confidence: "possible" }],
  };
  seed(weakHome, [weakFailure, weakAssociation]);
  const weakOriginalHome = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = weakHome;
  try {
    memory.resolveFixOnSuccess(weakCmd, weakCwd, { now: oldNow + delays[0]! });
  } finally {
    if (weakOriginalHome === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = weakOriginalHome;
  }
  assert.equal(existsSync(join(weakHome, "pending")), true, "old weak association must not clear pending");

  const mismatchHome = sandbox(t, "rocky-fix-crash-delayed-mismatch-");
  const mismatchCwd = mismatchHome;
  const mismatchCmd = "node mismatch-command.js";
  const mismatchFailure = failure("mismatch-delayed", mismatchCmd, mismatchCwd, oldNow);
  const mismatchedFix: FixRecord = {
    kind: "fix", id: "mismatched-fix", ts: oldNow, cwd: mismatchCwd,
    cmd: "node other-command.js", failureIds: [mismatchFailure.id],
  };
  seed(mismatchHome, [mismatchFailure, mismatchedFix]);
  const mismatchOriginalHome = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = mismatchHome;
  try {
    memory.resolveFixOnSuccess(mismatchCmd, mismatchCwd, { now: oldNow + delays[1]! });
  } finally {
    if (mismatchOriginalHome === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = mismatchOriginalHome;
  }
  assert.equal(existsSync(join(mismatchHome, "pending")), true, "old unconfirmed FixRecord must not clear pending");

  const incompleteHome = sandbox(t, "rocky-fix-crash-delayed-incomplete-");
  const incompleteCwd = incompleteHome;
  const incompleteCmd = "node incomplete-command.js";
  const incompleteFailure = failure("incomplete-delayed", incompleteCmd, incompleteCwd, oldNow);
  const incompleteFix: FixRecord = {
    kind: "fix", id: "incomplete-fix", ts: oldNow, cwd: incompleteCwd,
    cmd: incompleteCmd, failureIds: [incompleteFailure.id],
  };
  seed(incompleteHome, [incompleteFailure, incompleteFix]);
  const incompletePreload = join(incompleteHome, "incomplete-read.cjs");
  const incompleteReadMarker = join(incompleteHome, "initial-read-fired");
  initialMemoryReadFailurePreload(incompletePreload);
  const incomplete = spawnSync(process.execPath, [cli, "_hooksuccess", incompleteCmd, incompleteCwd], {
    env: {
      ...process.env,
      ROCKY_HOME: incompleteHome,
      ROCKY_TEST_MEMORY: join(incompleteHome, "memory.jsonl"),
      ROCKY_TEST_READ_MARKER: incompleteReadMarker,
      NODE_OPTIONS: `--require=${incompletePreload}`,
    },
    encoding: "utf8", timeout: 10_000, windowsHide: true,
  });
  assert.equal(incomplete.status, 0, incomplete.stderr);
  assert.equal(existsSync(incompleteReadMarker), true, "initial readSync failure seam must fire");
  assert.equal(existsSync(join(incompleteHome, "pending")), true, "incomplete loader snapshot must retain pending");
});

function fixedClockPreload(path: string): void {
  writeFileSync(path, "Date.now = () => Number(process.env.ROCKY_FIXED_NOW);\n", "utf8");
}

test("run, watch, and hook use the same 8-hour boundary at minus/exact/plus 1 ms", { timeout: 30_000 }, (t) => {
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
    { label: "exact", delta: 0, linked: true },
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

test("guard and primary crash tombstones do not block the next acquisition", { timeout: 20_000 }, async (t) => {
  for (const mode of ["guard", "primary"] as const) {
    await t.test(`${mode} move`, async (st) => {
      const home = sandbox(st, `rocky-tombstone-crash-${mode}-`);
      const lock = join(home, "memory.jsonl.triple.lock");
      const guard = `${lock}.reclaim.guard`;
      const deadPid = 2_147_483_647;
      mkdirSync(home, { recursive: true });
      writeFileSync(lock, JSON.stringify({ pid: deadPid, token: "d".repeat(32) }), { mode: 0o600 });
      if (mode === "guard") writeFileSync(guard, JSON.stringify({ pid: deadPid, token: "c".repeat(32) }), { mode: 0o600 });
      const preload = join(home, "crash-after-rename.cjs");
      crashAfterLockRenamePreload(preload);
      const worker = [
        "const [modulePath, home] = process.argv.slice(1);",
        "process.env.ROCKY_HOME = home;",
        "const memory = await import(modulePath);",
        "memory.withMemoryTransaction(() => {});",
      ].join("\n");
      const crashed = spawn(process.execPath, ["--input-type=module", "--eval", worker, memoryModuleUrl, home], {
        env: {
          ...process.env,
          ROCKY_HOME: home,
          ROCKY_TEST_CRASH_RENAME_FROM: mode === "guard" ? guard : lock,
          NODE_OPTIONS: `--require=${preload}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stderr = "";
      crashed.stderr?.on("data", (chunk) => { stderr += String(chunk); });
      const crashCode = await completion(crashed);
      assert.equal(crashCode, 73, stderr);
      const tombstones = readdirSync(home).filter((name) => name.includes(".reclaim.tombstone."));
      assert.ok(tombstones.length >= 1, "crash leaves unique tombstone");
      assert.equal(existsSync(`${lock}.reclaim.guard.claim`), false);

      const original = process.env.ROCKY_HOME;
      process.env.ROCKY_HOME = home;
      try {
        memory.recordNote({ cwd: home, cmd: `after-${mode}-crash`, file: "crash.ts", line: 1, subject: "crash", answer: "recovered" });
      } finally {
        if (original === undefined) delete process.env.ROCKY_HOME;
        else process.env.ROCKY_HOME = original;
      }
      assert.equal(existsSync(lock), false, "canonical lock is released after recovery");
      assert.ok(readdirSync(home).some((name) => name.includes(".reclaim.tombstone.")), "tombstone remains housekeeping-only");
    });
  }
});

test("replacement moved by a reclaim rename is preserved in its tombstone", { timeout: 20_000 }, (t) => {
  const home = sandbox(t, "rocky-tombstone-replacement-");
  const lock = join(home, "memory.jsonl.triple.lock");
  const saved = join(home, "original-primary.lock");
  const preload = join(home, "replace-before-rename.cjs");
  const deadPid = 2_147_483_647;
  mkdirSync(home, { recursive: true });
  writeFileSync(lock, JSON.stringify({ pid: deadPid, token: "d".repeat(32) }), { mode: 0o600 });
  replacementBeforePrimaryRenamePreload(preload);
  const worker = [
    "const [modulePath, home] = process.argv.slice(1);",
    "process.env.ROCKY_HOME = home;",
    "const memory = await import(modulePath);",
    "memory.withMemoryTransaction((transaction) => transaction.append({ kind: 'note', id: 'replacement-note', ts: Date.now(), cwd: home, cmd: 'replacement', file: 'replacement.ts', line: 1, subject: 'replacement', answer: 'preserved' }));",
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", worker, memoryModuleUrl, home], {
    env: {
      ...process.env,
      ROCKY_HOME: home,
      ROCKY_TEST_REPLACE_FROM: lock,
      ROCKY_TEST_REPLACE_SAVE: saved,
      NODE_OPTIONS: `--require=${preload}`,
    },
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(saved), true, "original inode remains recoverable");
  const preserved = readdirSync(home)
    .filter((name) => name.includes(".reclaim.tombstone."))
    .map((name) => readFileSync(join(home, name), "utf8"))
    .find((contents) => contents.includes(`\"token\":\"${"r".repeat(32)}\"`));
  assert.ok(preserved, "replacement inode remains in preserved tombstone");
  assert.equal(existsSync(lock), false, "next acquisition still releases canonical lock");
});

test("replacement after final tombstone validation survives because no path unlink occurs", { timeout: 20_000 }, (t) => {
  const home = sandbox(t, "rocky-tombstone-predelete-");
  const lock = join(home, "memory.jsonl.triple.lock");
  const saved = join(home, "validated-tombstone.lock");
  const preload = join(home, "replace-before-delete.cjs");
  const deadPid = 2_147_483_647;
  mkdirSync(home, { recursive: true });
  writeFileSync(lock, JSON.stringify({ pid: deadPid, token: "d".repeat(32) }), { mode: 0o600 });
  tombstoneReplacementBeforeDeletePreload(preload);
  const worker = [
    "const [modulePath, home] = process.argv.slice(1);",
    "process.env.ROCKY_HOME = home;",
    "const memory = await import(modulePath);",
    "memory.withMemoryTransaction(() => {});",
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", worker, memoryModuleUrl, home], {
    env: {
      ...process.env,
      ROCKY_HOME: home,
      ROCKY_TEST_TOMBSTONE_SAVE: saved,
      NODE_OPTIONS: `--require=${preload}`,
    },
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(saved), true, "validated inode remains preserved separately");
  const replacement = readdirSync(home)
    .filter((name) => name.includes(".reclaim.tombstone."))
    .map((name) => readFileSync(join(home, name), "utf8"))
    .find((contents) => contents.includes(`\"token\":\"${"x".repeat(32)}\"`));
  assert.ok(replacement, "replacement at tombstone path survives");
  assert.equal(existsSync(lock), false, "canonical lock remains absent after recovery");
});

test("partial primary and guard metadata writes recover without lock timeout", { timeout: 30_000 }, (t) => {
  for (const target of ["primary", "guard"] as const) {
    for (const mode of ["zero", "throw"] as const) {
      const home = sandbox(t, `rocky-partial-${target}-${mode}-`);
      const lock = join(home, "memory.jsonl.triple.lock");
      const partialPath = target === "primary" ? lock : `${lock}.reclaim.guard`;
      const preload = join(home, "partial-write.cjs");
      mkdirSync(home, { recursive: true });
      if (target === "guard") {
        writeFileSync(lock, JSON.stringify({ pid: 2_147_483_647, token: "d".repeat(32) }), { mode: 0o600 });
      }
      partialMetadataWritePreload(preload);
      const worker = [
        "const [modulePath, home] = process.argv.slice(1);",
        "process.env.ROCKY_HOME = home;",
        "const memory = await import(modulePath);",
        "memory.withMemoryTransaction(() => {});",
      ].join("\n");
      const started = Date.now();
      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", worker, memoryModuleUrl, home], {
        env: {
          ...process.env,
          ROCKY_HOME: home,
          ROCKY_TEST_PARTIAL_PATH: partialPath,
          ROCKY_TEST_PARTIAL_MODE: mode,
          NODE_OPTIONS: `--require=${preload}`,
        },
        encoding: "utf8",
        timeout: 4_000,
        windowsHide: true,
      });
      assert.equal(result.status, 0, `${target}/${mode}: ${result.stderr}`);
      assert.ok(Date.now() - started < 2_000, `${target}/${mode} partial write must not wait for lock deadline`);
      assert.equal(existsSync(lock), false, `${target}/${mode} canonical lock is released`);
      assert.ok(readdirSync(home).some((name) => name.includes(".reclaim.tombstone.")), `${target}/${mode} leaves safe tombstone evidence`);
    }
  }
});

test("a dead orphan claim is pruned when the primary pathname is already absent", (t) => {
  const home = sandbox(t, "rocky-orphan-without-primary-");
  const lock = `${join(home, "memory.jsonl")}.triple.lock`;
  const deadPid = 2_147_483_647;
  mkdirSync(home, { recursive: true });
  writeFileSync(lock, JSON.stringify({ pid: deadPid, token: "b".repeat(32) }), { mode: 0o600 });
  const orphanClaim = `${lock}.reclaim.${deadPid}.${"a".repeat(32)}`;
  linkSync(lock, orphanClaim);
  unlinkSync(lock);
  const original = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  try {
    memory.recordNote({ cwd: home, cmd: "after-absent-primary", file: "e.ts", line: 1, subject: "e", answer: "e" });
    const emptyLock = `${lock}.empty-source`;
    const emptyClaim = `${lock}.reclaim.${deadPid}.${"c".repeat(32)}`;
    writeFileSync(emptyLock, "", { mode: 0o600 });
    linkSync(emptyLock, emptyClaim);
    unlinkSync(emptyLock);
    memory.recordNote({ cwd: home, cmd: "after-empty-absent-primary", file: "f.ts", line: 1, subject: "f", answer: "f" });
    assert.equal(existsSync(emptyClaim), false);
  } finally {
    if (original === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = original;
  }
  assert.equal(existsSync(orphanClaim), false);
});

test("an old orphan claim behind a stable nonclaim prefix cannot starve lock recovery", { timeout: 15_000 }, (t) => {
  const home = sandbox(t, "rocky-orphan-prefix-starvation-");
  const lock = `${join(home, "memory.jsonl")}.triple.lock`;
  const deadPid = 2_147_483_647;
  mkdirSync(home, { recursive: true });
  // These names intentionally precede the reclaim-shaped entry in normal
  // directory enumeration. They are stable, nonclaim files and must not be
  // deleted; correctness cannot depend on sweeping past all of them.
  for (let index = 0; index < 96; index++) {
    writeFileSync(join(home, `aaa-stable-prefix-${index.toString().padStart(3, "0")}`), "keep", { mode: 0o600 });
  }
  writeFileSync(lock, JSON.stringify({ pid: deadPid, token: "d".repeat(32) }), { mode: 0o600 });
  const orphanClaim = `${lock}.reclaim.${deadPid}.${"e".repeat(32)}`;
  linkSync(lock, orphanClaim);

  const originalHome = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  const started = Date.now();
  try {
    memory.recordNote({ cwd: home, cmd: "prefix-starvation", file: "prefix.ts", line: 1, subject: "prefix", answer: "recovered" });
  } finally {
    if (originalHome === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = originalHome;
  }
  assert.ok(Date.now() - started < 2_000, "orphan recovery must not wait for the full lock deadline");
  assert.equal(existsSync(lock), false, "dead primary lock is reclaimed");
  assert.equal(existsSync(orphanClaim), true, "old orphan claim may remain for bounded cleanup");
  assert.equal(readdirSync(home).filter((name) => name.startsWith("aaa-stable-prefix-")).length, 96);
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
  for (let index = 0; index < 96; index++) {
    writeFileSync(join(home, `aaa-reclaim-prefix-${index.toString().padStart(3, "0")}`), "keep", { mode: 0o600 });
  }
  writeFileSync(lock, JSON.stringify({ pid: 2_147_483_647, token: "d".repeat(32) }), { mode: 0o600 });
  linkSync(lock, `${lock}.reclaim.2147483647.${"e".repeat(32)}`);
  writeFileSync(`${lock}.reclaim.guard`, JSON.stringify({ pid: 2_147_483_647, token: "c".repeat(32) }), { mode: 0o600 });
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

  // Exercise the same tombstone reclaim protocol for a crashed reclaimer
  // that left an empty, old election guard rather than valid PID metadata.
  writeFileSync(lock, JSON.stringify({ pid: 2_147_483_647, token: "d".repeat(32) }), { mode: 0o600 });
  const staleGuard = `${lock}.reclaim.guard`;
  writeFileSync(staleGuard, "", { mode: 0o600 });
  const staleAt = new Date(Date.now() - 20 * 60 * 1_000);
  utimesSync(staleGuard, staleAt, staleAt);
  const originalHome = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  try {
    memory.recordNote({ cwd: home, cmd: "stale-guard", file: "stale.ts", line: 1, subject: "stale", answer: "recovered" });
  } finally {
    if (originalHome === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = originalHome;
  }
  assert.equal(existsSync(lock), false, "stale election guard recovery removes dead primary");
  assert.equal(existsSync(staleGuard), false, "stale election guard is removed through a tombstone");
});

test("reclaim-claim sweeping examines a bounded batch and preserves unsafe entries", (t) => {
  const home = sandbox(t, "rocky-lock-reclaim-bounded-");
  const lock = `${join(home, "memory.jsonl")}.triple.lock`;
  const deadPid = 2_147_483_647;
  const claimPrefix = `${lock}.reclaim.`;
  const claimNamePrefix = "memory.jsonl.triple.lock.reclaim.";
  const claimCount = 320;
  mkdirSync(home, { recursive: true });
  const liveClaim = `${claimPrefix}${process.pid}.${"c".repeat(32)}`;
  writeFileSync(liveClaim, "", { mode: 0o600 });
  const unknownName = `${claimPrefix}not-a-claim`;
  writeFileSync(unknownName, "unknown", { mode: 0o600 });
  const replacementTarget = join(home, "replacement-target");
  const replacementClaim = `${claimPrefix}${deadPid}.${"b".repeat(32)}`;
  writeFileSync(replacementTarget, "replacement", { mode: 0o600 });
  let replacementCreated = false;
  const symlinkCapability = probeSymlink();
  if (symlinkCapability.available) {
    symlinkSync(replacementTarget, replacementClaim);
    replacementCreated = true;
  } else {
    t.diagnostic(
      `symlink file unavailable: ${symlinkCapability.code}; owner: host filesystem capability`,
    );
  }
  for (let index = 0; index < claimCount; index++) {
    const token = index.toString(16).padStart(32, "0");
    writeFileSync(`${claimPrefix}${deadPid}.${token}`, "", { mode: 0o600 });
  }

  const originalHome = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  const started = Date.now();
  try {
    memory.recordNote({ cwd: home, cmd: "bounded-sweep", file: "bounded.ts", line: 1, subject: "bounded", answer: "bounded" });
  } finally {
    if (originalHome === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = originalHome;
  }
  const elapsed = Date.now() - started;
  const remainingDeadRegularClaims = readdirSync(home).filter((name) =>
    name.startsWith(claimNamePrefix) && /^\d+\.[a-f0-9]{32}$/u.test(name.slice(claimNamePrefix.length)) &&
    !name.endsWith("b".repeat(32))
  );
  assert.ok(claimCount > memory.RECLAIM_CLAIM_SCAN_MAX_ENTRIES * 2,
    "fixture must exceed two bounded sweep batches");
  assert.ok(remainingDeadRegularClaims.length >= claimCount - memory.RECLAIM_CLAIM_SCAN_MAX_ENTRIES,
    "sweep must leave residual claims after one fixed-size batch");
  assert.ok(elapsed < 2_000, `bounded sweep must complete promptly, got ${elapsed} ms`);
  assert.equal(existsSync(liveClaim), true, "live-owner claim is never removed");
  assert.equal(existsSync(unknownName), true, "unknown claim-shaped file is never removed");
  if (replacementCreated) assert.equal(existsSync(replacementClaim), true, "symlink/replacement claim is never removed");
  assert.equal(existsSync(lock), false, "released primary lock is not left behind");
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
