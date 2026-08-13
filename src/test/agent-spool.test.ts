import { strict as assert } from "node:assert";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import test from "node:test";
import {
  existsSync,
  linkSync,
  mkdtempSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRockyPaths } from "../core/state-paths.js";
import {
  acquireAnnotationLease,
  acquireLock,
  appendEvent,
  claimBatch,
  listOrphanBatches,
  MAX_BATCH_BYTES,
  readBatch,
  readClaim,
  readClaimResult,
  releaseAnnotationLease,
  removeClaim,
  removeBatch,
} from "../agent/spool.js";
import { annotateCommand } from "../agent/annotate.js";
import { loadMemory } from "../core/memory.js";
import type { IntentEvent } from "../agent/schema.js";

type CleanupContext = { after(callback: () => void): void };

function freshPaths(t: CleanupContext) {
  const home = mkdtempSync(join(tmpdir(), "rocky-spool-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return resolveRockyPaths({ ROCKY_HOME: home });
}

const intent = (text: string): IntentEvent => ({
  v: 1,
  agent: "claude-code",
  kind: "intent",
  ts: 1,
  text,
});

function oldTime(now = Date.now()): Date {
  return new Date(now - 11 * 60 * 1000);
}

function privateLockMetadata(pid: number, token = "a".repeat(32)): string {
  return JSON.stringify({ pid, token });
}

async function waitForPath(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  if (!existsSync(path)) throw new Error(`expected marker: ${path}`);
}

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", "process.exit(0)"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pid = child.pid;
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => resolve());
  });
  if (!pid) throw new Error("test child did not expose a pid");
  return pid;
}

async function waitForReady(directory: string, count: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (readdirSync(directory).length < count) {
    if (Date.now() >= deadline) throw new Error("concurrent spool workers did not become ready");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForGate(directory: string, count: number, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (readdirSync(directory).length < count && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  return readdirSync(directory).length;
}

function waitForWorker(child: ChildProcessWithoutNullStreams): Promise<{ code: number | null; stderr: string }> {
  const stderr: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr: Buffer.concat(stderr).toString("utf8") }));
  });
}

test("state paths include exact transient spool, digest hint, labels, and agent log paths", (t) => {
  const paths = freshPaths(t);
  assert.equal(paths.spoolDir, join(paths.home, "spool"));
  assert.equal(paths.digestHint, join(paths.home, "digest-hint"));
  assert.equal(paths.labels, join(paths.home, "labels"));
  assert.equal(paths.agentLog, join(paths.home, "agent-hook.log"));
});

test("appendEvent then readBatch round-trips and skips garbage lines", (t) => {
  const paths = freshPaths(t);
  appendEvent("k1", intent("naikin dikit"), paths);
  writeFileSync(
    join(paths.spoolDir, "k1.jsonl"),
    JSON.stringify(intent("ok")) + "\n" + "{broken\n",
    { flag: "a" },
  );
  const events = readBatch("k1", paths);
  assert.equal(events.length, 2);
  assert.equal(events[0]?.kind, "intent");
  assert.equal(events[1]?.kind, "intent");
});

test("appendEvent rejects a UTF-8 candidate that would cross MAX_BATCH_BYTES", (t) => {
  const paths = freshPaths(t);
  const event = intent("🚀".repeat(2_048));
  const line = `${JSON.stringify(event)}\n`;
  const lineBytes = Buffer.byteLength(line, "utf8");
  assert.ok(lineBytes > 1);
  const existingBytes = MAX_BATCH_BYTES - lineBytes + 1;
  mkdirSync(paths.spoolDir, { recursive: true });
  writeFileSync(join(paths.spoolDir, "utf8.jsonl"), Buffer.alloc(existingBytes, 0x20));

  appendEvent("utf8", event, paths);

  assert.equal(statSync(join(paths.spoolDir, "utf8.jsonl")).size, existingBytes);
});

test("appendEvent never grows a batch beyond the byte cap", (t) => {
  const paths = freshPaths(t);
  const big = intent("z".repeat(1_900));
  for (let i = 0; i < 400; i += 1) appendEvent("k2", big, paths);
  assert.ok(statSync(join(paths.spoolDir, "k2.jsonl")).size <= MAX_BATCH_BYTES);
});

test("concurrent processes cannot overshoot the per-batch byte cap", { timeout: 15_000 }, async (t) => {
  const paths = freshPaths(t);
  const key = "race";
  const event = intent("q".repeat(1_900));
  const line = `${JSON.stringify(event)}\n`;
  const lineBytes = Buffer.byteLength(line, "utf8");
  mkdirSync(paths.spoolDir, { recursive: true });
  writeFileSync(join(paths.spoolDir, `${key}.jsonl`), Buffer.alloc(MAX_BATCH_BYTES - lineBytes, 0x20));

  const workerCount = 24;
  const readyDirectory = join(paths.home, "ready");
  const gateDirectory = join(paths.home, "gate");
  const startPath = join(paths.home, "start");
  const releasePath = join(paths.home, "release");
  mkdirSync(readyDirectory);
  mkdirSync(gateDirectory);
  const spoolModule = join(dirname(fileURLToPath(import.meta.url)), "..", "agent", "spool.js");
  const workerScript = [
    "import fs from 'node:fs';",
    "import { existsSync } from 'node:fs';",
    "import { syncBuiltinESMExports } from 'node:module';",
    "import { join } from 'node:path';",
    "import { pathToFileURL } from 'node:url';",
    "const [modulePath, home, readyPath, startPath, key, text, gateDirectory, releasePath] = process.argv.slice(1);",
    "const originalWrite = fs.writeSync.bind(fs);",
    "const originalOpen = fs.openSync.bind(fs);",
    "const originalClose = fs.closeSync.bind(fs);",
    "const writeControlFile = (path, text) => { const fd = originalOpen(path, 'w'); try { originalWrite(fd, text); } finally { originalClose(fd); } };",
    "fs.writeSync = (fd, ...args) => { const markerPath = join(gateDirectory, `${process.pid}.gate`); if (!existsSync(markerPath)) { writeControlFile(markerPath, 'gate'); const signal = new Int32Array(new SharedArrayBuffer(4)); while (!existsSync(releasePath)) Atomics.wait(signal, 0, 0, 1); } return originalWrite(fd, ...args); };",
    "syncBuiltinESMExports();",
    "const { appendEvent } = await import(pathToFileURL(modulePath).href);",
    "writeControlFile(readyPath, 'ready');",
    "const signal = new Int32Array(new SharedArrayBuffer(4));",
    "while (!existsSync(startPath)) Atomics.wait(signal, 0, 0, 1);",
    "const paths = { spoolDir: join(home, 'spool') };",
    "const event = { v: 1, agent: 'claude-code', kind: 'intent', ts: 1, text };",
    "for (let i = 0; i < 4; i += 1) appendEvent(key, event, paths);",
  ].join("\n");
  const children: ChildProcessWithoutNullStreams[] = [];
  const completions: Promise<{ code: number | null; stderr: string }>[] = [];
  try {
    for (let i = 0; i < workerCount; i += 1) {
      const child = spawn(process.execPath, [
        "--input-type=module",
        "--eval",
        workerScript,
        spoolModule,
        paths.home,
        join(readyDirectory, `${i}.ready`),
        startPath,
        key,
        event.text,
        gateDirectory,
        releasePath,
      ], { stdio: ["pipe", "pipe", "pipe"] });
      children.push(child);
      completions.push(waitForWorker(child));
    }
    await waitForReady(readyDirectory, workerCount);
    writeFileSync(startPath, "go\n");
    const gateCount = await waitForGate(gateDirectory, 2, 2_000);
    assert.equal(gateCount, 1);
    writeFileSync(releasePath, "release\n");
    const results = await Promise.all(completions);
    for (const result of results) {
      assert.equal(result.code, 0, result.stderr);
    }
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  }

  assert.equal(existsSync(startPath), true);
  const finalSize = statSync(join(paths.spoolDir, `${key}.jsonl`)).size;
  assert.ok(finalSize <= MAX_BATCH_BYTES);
});

test("failed private lock creation removes its owned artifact before the next append", { timeout: 10_000 }, async (t) => {
  const paths = freshPaths(t);
  const key = "recover";
  const spoolModule = join(dirname(fileURLToPath(import.meta.url)), "..", "agent", "spool.js");
  const workerScript = [
    "import fs from 'node:fs';",
    "import { syncBuiltinESMExports } from 'node:module';",
    "import { join } from 'node:path';",
    "import { pathToFileURL } from 'node:url';",
    "const [modulePath, home] = process.argv.slice(1);",
    "const originalWrite = fs.writeSync.bind(fs);",
    "let failed = false;",
    "fs.writeSync = (fd, ...args) => { if (!failed) { failed = true; return 0; } return originalWrite(fd, ...args); };",
    "syncBuiltinESMExports();",
    "const { appendEvent } = await import(pathToFileURL(modulePath).href);",
    "appendEvent('recover', { v: 1, agent: 'claude-code', kind: 'intent', ts: 1, text: 'short write' }, { spoolDir: join(home, 'spool') });",
  ].join("\n");
  const child = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    workerScript,
    spoolModule,
    paths.home,
  ], { stdio: ["pipe", "pipe", "pipe"] });
  const result = await waitForWorker(child);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(existsSync(join(paths.spoolDir, `${key}.append.lock`)), false);

  appendEvent(key, intent("next append is not suppressed"), paths);
  assert.equal(readBatch(key, paths).length, 1);
});

test("stale private locks with live owners are preserved", (t) => {
  const paths = freshPaths(t);
  mkdirSync(paths.spoolDir, { recursive: true });
  const stale = oldTime();
  const privatePath = join(paths.spoolDir, "live.append.lock");
  writeFileSync(privatePath, privateLockMetadata(process.pid, "b".repeat(32)));
  utimesSync(privatePath, stale, stale);
  appendEvent("live", intent("live private owner"), paths);
  assert.equal(existsSync(privatePath), true);
  assert.equal(readBatch("live", paths).length, 0);
});

test("active writer release cannot race a stale-owner replacement", { timeout: 15_000 }, async (t) => {
  const paths = freshPaths(t);
  const key = "replace";
  const readyA = join(paths.home, "ready-a");
  const readyB = join(paths.home, "ready-b");
  const attemptB = join(paths.home, "attempt-b");
  const allowUnlink = join(paths.home, "allow-unlink");
  const writeDirectory = join(paths.home, "write-gates");
  const unlinkDirectory = join(paths.home, "unlink-gates");
  mkdirSync(writeDirectory);
  mkdirSync(unlinkDirectory);
  const spoolModule = join(dirname(fileURLToPath(import.meta.url)), "..", "agent", "spool.js");
  const workerScript = [
    "import fs from 'node:fs';",
    "import { existsSync } from 'node:fs';",
    "import { syncBuiltinESMExports } from 'node:module';",
    "import { join } from 'node:path';",
    "import { pathToFileURL } from 'node:url';",
    "const [modulePath, home, key, readyPath, attemptPath, writeDirectory, unlinkDirectory, allowPath, gateUnlink] = process.argv.slice(1);",
    "const originalWrite = fs.writeSync.bind(fs);",
    "const originalOpen = fs.openSync.bind(fs);",
    "const originalClose = fs.closeSync.bind(fs);",
    "const writeControlFile = (path, text) => { const fd = originalOpen(path, 'w'); try { originalWrite(fd, text); } finally { originalClose(fd); } };",
    "const originalUnlink = fs.unlinkSync.bind(fs);",
    "fs.writeSync = (fd, ...args) => { const marker = join(writeDirectory, `${process.pid}.write`); if (!existsSync(marker)) writeControlFile(marker, 'write'); return originalWrite(fd, ...args); };",
    "if (gateUnlink === 'yes') fs.unlinkSync = (path, ...args) => { if (String(path).endsWith(`${key}.append.lock`)) { const marker = join(unlinkDirectory, `${process.pid}.unlink`); writeControlFile(marker, 'unlink'); const signal = new Int32Array(new SharedArrayBuffer(4)); while (!existsSync(allowPath)) Atomics.wait(signal, 0, 0, 1); } return originalUnlink(path, ...args); };",
    "syncBuiltinESMExports();",
    "const { appendEvent } = await import(pathToFileURL(modulePath).href);",
    "writeControlFile(readyPath, 'ready');",
    "if (attemptPath !== '-') writeControlFile(attemptPath, 'attempt');",
    "appendEvent(key, { v: 1, agent: 'claude-code', kind: 'intent', ts: 1, text: 'replacement race' }, { spoolDir: join(home, 'spool') });",
  ].join("\n");
  const childA = spawn(process.execPath, [
    "--input-type=module", "--eval", workerScript, spoolModule, paths.home, key,
    readyA, "-", writeDirectory, unlinkDirectory, allowUnlink, "yes",
  ], { stdio: ["pipe", "pipe", "pipe"] });
  const childACompletion = waitForWorker(childA);
  let childB: ChildProcessWithoutNullStreams | undefined;
  try {
    await waitForPath(join(unlinkDirectory, `${childA.pid}.unlink`));
    const privatePath = join(paths.spoolDir, `${key}.append.lock`);
    const stale = oldTime();
    utimesSync(privatePath, stale, stale);
    childB = spawn(process.execPath, [
      "--input-type=module", "--eval", workerScript, spoolModule, paths.home, key,
      readyB, attemptB, writeDirectory, unlinkDirectory, allowUnlink, "no",
    ], { stdio: ["pipe", "pipe", "pipe"] });
    const childBCompletion = waitForWorker(childB);
    await waitForPath(readyB);
    await waitForPath(attemptB);
    const writeGateCount = await waitForGate(writeDirectory, 2, 2_000);
    assert.equal(writeGateCount, 1);
    writeFileSync(allowUnlink, "release");
    const [resultA, resultB] = await Promise.all([childACompletion, childBCompletion]);
    assert.equal(resultA.code, 0, resultA.stderr);
    assert.equal(resultB.code, 0, resultB.stderr);
  } finally {
    if (childA.exitCode === null && childA.signalCode === null) childA.kill();
    if (childB && childB.exitCode === null && childB.signalCode === null) childB.kill();
  }
  assert.equal(existsSync(join(paths.spoolDir, `${key}.append.lock`)), false);
});

test("filesystem boundaries reject empty, traversal, control, and oversized keys", (t) => {
  const paths = freshPaths(t);
  const escaped = join(paths.home, "escape.jsonl");
  writeFileSync(escaped, "keep\n");
  const invalidKeys = [
    "",
    ".",
    "..",
    "../escape",
    "nested/name",
    "nested\\name",
    "line\nbreak",
    "x".repeat(121),
  ];

  for (const key of invalidKeys) {
    appendEvent(key, intent(key || "empty"), paths);
    assert.deepEqual(readBatch(key, paths), [], `read should reject ${JSON.stringify(key)}`);
    assert.equal(acquireLock(key, paths), false, `lock should reject ${JSON.stringify(key)}`);
    removeBatch(key, paths);
  }

  assert.equal(readFileSync(escaped, "utf8"), "keep\n");
  assert.deepEqual(readdirSync(paths.home).sort(), ["escape.jsonl"]);
});

test("readBatch rejects oversized files without reading unbounded data", (t) => {
  const paths = freshPaths(t);
  mkdirSync(paths.spoolDir, { recursive: true });
  writeFileSync(join(paths.spoolDir, "large.jsonl"), Buffer.alloc(MAX_BATCH_BYTES + 1, 0x61));
  assert.deepEqual(readBatch("large", paths), []);
});

test("acquireLock reclaims one stale regular lock but excludes fresh locks", (t) => {
  const paths = freshPaths(t);
  appendEvent("stale", intent("a"), paths);
  const stalePath = join(paths.spoolDir, "stale.lock");
  writeFileSync(stalePath, "");
  const stale = oldTime();
  utimesSync(stalePath, stale, stale);
  assert.equal(acquireLock("stale", paths), true);
  assert.equal(acquireLock("stale", paths), false);

  appendEvent("fresh", intent("b"), paths);
  assert.equal(acquireLock("fresh", paths), true);
  assert.equal(acquireLock("fresh", paths), false);
});

test("private stale state remains fail-safe and removeBatch preserves ownership", async (t) => {
  const paths = freshPaths(t);
  const lock = join(paths.spoolDir, "writer.append.lock");
  mkdirSync(paths.spoolDir, { recursive: true });
  writeFileSync(lock, privateLockMetadata(await exitedPid(), "a".repeat(32)));
  const stale = oldTime();
  utimesSync(lock, stale, stale);
  appendEvent("writer", intent("stale lock drops safely"), paths);
  assert.equal(readBatch("writer", paths).length, 1);
  assert.equal(existsSync(lock), false);

  writeFileSync(lock, privateLockMetadata(process.pid, "b".repeat(32)));
  appendEvent("writer", intent("fresh lock blocks"), paths);
  assert.equal(existsSync(lock), true);
  removeBatch("writer", paths);
  assert.equal(existsSync(lock), true);
});

test("stale owner-bearing append lock with a dead owner is recovered", { timeout: 10_000 }, async (t) => {
  const paths = freshPaths(t);
  const key = "dead-writer";
  mkdirSync(paths.spoolDir, { recursive: true });
  const lock = join(paths.spoolDir, `${key}.append.lock`);
  writeFileSync(lock, privateLockMetadata(await exitedPid(), "d".repeat(32)), { mode: 0o600 });
  const stale = oldTime();
  utimesSync(lock, stale, stale);

  appendEvent(key, intent("recover dead writer"), paths);

  assert.equal(readBatch(key, paths).length, 1);
  assert.equal(existsSync(lock), false);
});

test("stale zero-byte append lock left before metadata is recovered", (t) => {
  const paths = freshPaths(t);
  const key = "empty-writer";
  mkdirSync(paths.spoolDir, { recursive: true });
  const lock = join(paths.spoolDir, `${key}.append.lock`);
  writeFileSync(lock, "", { mode: 0o600 });
  const stale = oldTime();
  utimesSync(lock, stale, stale);

  appendEvent(key, intent("recover empty writer"), paths);

  assert.equal(readBatch(key, paths).length, 1);
  assert.equal(existsSync(lock), false);
});

test("stale zero-byte append lock recovers with unsafe filesystem identity", { timeout: 10_000 }, async (t) => {
  const paths = freshPaths(t);
  const key = "unsafe-empty-writer";
  const resultPath = join(paths.home, "result.json");
  const spoolModule = join(dirname(fileURLToPath(import.meta.url)), "..", "agent", "spool.js");
  const workerScript = [
    "import fs from 'node:fs';",
    "import { syncBuiltinESMExports } from 'node:module';",
    "import { join } from 'node:path';",
    "import { pathToFileURL } from 'node:url';",
    "const [modulePath, home, resultPath, key] = process.argv.slice(1);",
    "const unsafeIno = Number.MAX_SAFE_INTEGER + 2;",
    "const patchIdentity = (stats) => { stats.ino = unsafeIno; return stats; };",
    "const originalFstat = fs.fstatSync.bind(fs);",
    "const originalLstat = fs.lstatSync.bind(fs);",
    "fs.fstatSync = (...args) => patchIdentity(originalFstat(...args));",
    "fs.lstatSync = (...args) => patchIdentity(originalLstat(...args));",
    "syncBuiltinESMExports();",
    "const { appendEvent, readBatch } = await import(pathToFileURL(modulePath).href);",
    "const paths = { spoolDir: join(home, 'spool') };",
    "const lock = join(paths.spoolDir, `${key}.append.lock`);",
    "fs.mkdirSync(paths.spoolDir, { recursive: true });",
    "fs.writeFileSync(lock, '');",
    "const stale = new Date(Date.now() - 11 * 60 * 1000);",
    "fs.utimesSync(lock, stale, stale);",
    "appendEvent(key, { v: 1, agent: 'claude-code', kind: 'intent', ts: 1, text: 'unsafe stale recovery' }, paths);",
    "fs.writeFileSync(resultPath, JSON.stringify({ events: readBatch(key, paths).length, lockExists: fs.existsSync(lock) }));",
  ].join("\n");
  const child = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    workerScript,
    spoolModule,
    paths.home,
    resultPath,
    key,
  ], { stdio: ["pipe", "pipe", "pipe"] });
  const result = await waitForWorker(child);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(resultPath, "utf8")), { events: 1, lockExists: false });
});

test("fresh or malformed append locks remain fail-closed", (t) => {
  const paths = freshPaths(t);
  const freshKey = "fresh-empty-writer";
  const freshLock = join(paths.spoolDir, `${freshKey}.append.lock`);
  mkdirSync(paths.spoolDir, { recursive: true });
  writeFileSync(freshLock, "", { mode: 0o600 });
  appendEvent(freshKey, intent("do not race fresh empty writer"), paths);
  assert.equal(readBatch(freshKey, paths).length, 0);
  assert.equal(existsSync(freshLock), true);

  const malformedKey = "malformed-writer";
  const malformedLock = join(paths.spoolDir, `${malformedKey}.append.lock`);
  writeFileSync(malformedLock, "unknown-owner", { mode: 0o600 });
  const stale = oldTime();
  utimesSync(malformedLock, stale, stale);
  appendEvent(malformedKey, intent("do not race malformed writer"), paths);
  assert.equal(readBatch(malformedKey, paths).length, 0);
  assert.equal(readFileSync(malformedLock, "utf8"), "unknown-owner");
});

test("non-empty stale annotation lease is malformed and fails closed", (t) => {
  const paths = freshPaths(t);
  const key = "malformed-lease";
  appendEvent(key, intent("retain malformed lease"), paths);
  const lock = join(paths.spoolDir, `${key}.lock`);
  writeFileSync(lock, "not-owner-metadata", { mode: 0o600 });
  const stale = oldTime();
  utimesSync(lock, stale, stale);

  assert.equal(acquireLock(key, paths), false);
  assert.equal(readFileSync(lock, "utf8"), "not-owner-metadata");
});

test("successful annotation lease acquisition closes its lock descriptor", (t) => {
  if (process.platform !== "linux" || !existsSync("/proc/self/fd")) {
    t.skip("Linux proc descriptors are unavailable");
    return;
  }
  const paths = freshPaths(t);
  const key = "lease-fd";
  const lock = join(paths.spoolDir, `${key}.lock`);
  const openTargets = (): string[] => readdirSync("/proc/self/fd").flatMap((fd) => {
    try {
      return [readlinkSync(join("/proc/self/fd", fd))];
    } catch {
      return [];
    }
  }).filter((target) => target === lock || target === `${lock} (deleted)`);

  const lease = acquireAnnotationLease(key, paths);
  assert.ok(lease);
  try {
    assert.deepEqual(openTargets(), []);
  } finally {
    releaseAnnotationLease(lease, paths);
  }
});

test("cleanup cannot unlink a replacement annotation lease", (t) => {
  const paths = freshPaths(t);
  const key = "replacement-lease";
  appendEvent(key, intent("lease replacement"), paths);
  assert.equal(acquireLock(key, paths), true);
  const lock = join(paths.spoolDir, `${key}.lock`);
  unlinkSync(lock);
  writeFileSync(lock, "replacement-owner", { mode: 0o600 });

  removeBatch(key, paths);

  assert.equal(existsSync(lock), true);
  assert.equal(readFileSync(lock, "utf8"), "replacement-owner");
});

test("a stale annotation lease with a live owner is preserved", { timeout: 15_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "rocky-live-lease-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const paths = resolveRockyPaths({ ROCKY_HOME: home });
  const key = "live-lease";
  appendEvent(key, intent("live lease"), paths);
  appendEvent(key, { v: 1, agent: "claude-code", kind: "mechanism", ts: 2, tool: "Edit", path: "a.ts", excerpt: "test: pass" }, paths);

  const lock = join(paths.spoolDir, `${key}.lock`);
  const marker = join(home, "lease-ready");
  const release = join(home, "lease-release");
  const worker = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    [
      "import { existsSync, writeFileSync } from 'node:fs';",
      "const [lockPath, markerPath, releasePath] = process.argv.slice(1);",
      "writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'c'.repeat(32) }), { mode: 0o600 });",
      "writeFileSync(markerPath, 'ready');",
      "const signal = new Int32Array(new SharedArrayBuffer(4));",
      "while (!existsSync(releasePath)) Atomics.wait(signal, 0, 0, 10);",
    ].join("\n"),
    lock,
    marker,
    release,
  ], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => {
    if (worker.exitCode === null && worker.signalCode === null) worker.kill();
  });
  await waitForPath(marker);
  const stale = oldTime();
  utimesSync(lock, stale, stale);

  const original = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  try {
    await annotateCommand(key);
    assert.equal(loadMemory(paths.memory).filter((record) => record.kind === "triple").length, 0);
    assert.equal(readBatch(key, paths).length, 2);
    assert.match(readFileSync(lock, "utf8"), /"pid"/u);

    writeFileSync(release, "release");
    await new Promise<void>((resolve, reject) => {
      worker.once("error", reject);
      worker.once("close", () => resolve());
    });
    await annotateCommand(key);
    assert.equal(loadMemory(paths.memory).filter((record) => record.kind === "triple").length, 1);
    assert.equal(readBatch(key, paths).length, 0);
  } finally {
    if (original === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = original;
  }
});

test("claim cleanup cannot unlink a replacement claim", (t) => {
  const paths = freshPaths(t);
  const key = "replacement-claim";
  appendEvent(key, intent("claim replacement"), paths);
  const claim = claimBatch(key, paths);
  assert.ok(claim);
  renameSync(claim.path, `${claim.path}.old`);
  writeFileSync(claim.path, "replacement claim", { mode: 0o600 });

  assert.equal(removeClaim(claim, paths), false);
  assert.equal(existsSync(claim.path), true);
  assert.equal(readFileSync(claim.path, "utf8"), "replacement claim");
});

test("claim recovery removes only the same live inode left by a link-before-unlink crash", (t) => {
  const paths = freshPaths(t);
  const key = "claim-recovery";
  appendEvent(key, intent("recover claim"), paths);
  const live = join(paths.spoolDir, `${key}.jsonl`);
  const claimPath = join(paths.spoolDir, `${key}.claim.${"e".repeat(32)}.jsonl`);
  try {
    linkSync(live, claimPath);
  } catch {
    t.skip("hard links are unavailable");
    return;
  }

  const claim = claimBatch(key, paths);
  assert.ok(claim);
  assert.equal(claim.path, claimPath);
  assert.equal(existsSync(live), false);
  assert.equal(readBatch(key, paths).length, 1);
});

test("claimBatch after-lock recovery fails closed when live unlink leaves the same inode", { timeout: 15_000 }, async (t) => {
  const paths = freshPaths(t);
  const key = "after-lock-claim";
  appendEvent(key, intent("after lock claim"), paths);
  const live = join(paths.spoolDir, `${key}.jsonl`);
  const claimPath = join(paths.spoolDir, `${key}.claim.${"a".repeat(32)}.jsonl`);
  const resultPath = join(paths.home, "after-lock-result.json");
  const modulePath = join(dirname(fileURLToPath(import.meta.url)), "..", "agent", "spool.js");
  const workerScript = [
    "import fs from 'node:fs';",
    "import { syncBuiltinESMExports } from 'node:module';",
    "import { join } from 'node:path';",
    "import { pathToFileURL } from 'node:url';",
    "const [modulePath, home, key, live, claimPath, resultPath] = process.argv.slice(1);",
    "const originalReadDir = fs.readdirSync.bind(fs);",
    "const originalLink = fs.linkSync.bind(fs);",
    "const originalUnlink = fs.unlinkSync.bind(fs);",
    "let reads = 0;",
    "fs.readdirSync = (path, ...args) => { reads += 1; if (reads === 2) originalLink(live, claimPath); return originalReadDir(path, ...args); };",
    "fs.unlinkSync = (path, ...args) => { if (String(path) === live) throw new Error('blocked same-inode unlink'); return originalUnlink(path, ...args); };",
    "syncBuiltinESMExports();",
    "const { claimBatch } = await import(pathToFileURL(modulePath).href);",
    "const claim = claimBatch(key, { spoolDir: join(home, 'spool') });",
    "fs.writeFileSync(resultPath, JSON.stringify({ path: claim?.path ?? null }), { mode: 0o600 });",
  ].join("\n");
  const child = spawn(process.execPath, [
    "--input-type=module", "--eval", workerScript, modulePath, paths.home, key, live, claimPath, resultPath,
  ], { stdio: ["pipe", "pipe", "pipe"] });
  const result = await waitForWorker(child);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(resultPath, "utf8")), { path: null });
  assert.equal(existsSync(live), true);
  assert.equal(existsSync(claimPath), true);
});

test("claim finalization fails closed when live unlink remains blocked", { timeout: 15_000 }, async (t) => {
  const paths = freshPaths(t);
  const freshKey = "blocked-fresh";
  const existingKey = "blocked-existing";
  appendEvent(freshKey, intent("blocked fresh claim"), paths);
  appendEvent(existingKey, intent("blocked existing claim"), paths);
  const existingLive = join(paths.spoolDir, `${existingKey}.jsonl`);
  const existingClaim = join(paths.spoolDir, `${existingKey}.claim.${"f".repeat(32)}.jsonl`);
  try {
    linkSync(existingLive, existingClaim);
  } catch {
    t.skip("hard links are unavailable");
    return;
  }
  const modulePath = join(dirname(fileURLToPath(import.meta.url)), "..", "agent", "spool.js");
  const resultPath = join(paths.home, "blocked-result.json");
  const workerScript = [
    "import fs from 'node:fs';",
    "import { syncBuiltinESMExports } from 'node:module';",
    "import { join } from 'node:path';",
    "import { pathToFileURL } from 'node:url';",
    "const [modulePath, home, freshKey, existingKey, resultPath] = process.argv.slice(1);",
    "const originalUnlink = fs.unlinkSync.bind(fs);",
    "fs.unlinkSync = (path, ...args) => { if (String(path).endsWith(`${freshKey}.jsonl`) || String(path).endsWith(`${existingKey}.jsonl`)) throw new Error('blocked live unlink'); return originalUnlink(path, ...args); };",
    "syncBuiltinESMExports();",
    "const { claimBatch } = await import(pathToFileURL(modulePath).href);",
    "const paths = { spoolDir: join(home, 'spool') };",
    "const fresh = claimBatch(freshKey, paths);",
    "const existing = claimBatch(existingKey, paths);",
    "fs.writeFileSync(resultPath, JSON.stringify({ fresh: fresh?.path ?? null, existing: existing?.path ?? null }), { mode: 0o600 });",
  ].join("\n");
  const child = spawn(process.execPath, [
    "--input-type=module", "--eval", workerScript, modulePath, paths.home, freshKey, existingKey, resultPath,
  ], { stdio: ["pipe", "pipe", "pipe"] });
  const result = await waitForWorker(child);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(resultPath, "utf8")), { fresh: null, existing: null });
  assert.equal(existsSync(join(paths.spoolDir, `${freshKey}.jsonl`)), true);
  assert.equal(existsSync(existingLive), true);
  assert.equal(readdirSync(paths.spoolDir).filter((name) => name.startsWith(`${freshKey}.claim.`)).length, 1);
  assert.equal(existsSync(existingClaim), true);
});

test("appendEvent detaches a post-claim same-inode live path before appending", (t) => {
  const paths = freshPaths(t);
  const key = "append-after-claim";
  appendEvent(key, intent("before crash"), paths);
  const live = join(paths.spoolDir, `${key}.jsonl`);
  const claimPath = join(paths.spoolDir, `${key}.claim.${"b".repeat(32)}.jsonl`);
  try {
    linkSync(live, claimPath);
  } catch {
    t.skip("hard links are unavailable");
    return;
  }
  const claim = { key, id: "b".repeat(32), path: claimPath, stats: lstatSync(claimPath) };
  appendEvent(key, { v: 1, agent: "claude-code", kind: "mechanism", ts: 2, tool: "Edit", path: "after.ts", excerpt: "test: pass" }, paths);

  assert.equal(readClaim(claim, paths).some((event) => event.kind === "mechanism"), false);
  assert.deepEqual(readBatch(key, paths).map((event) => event.kind === "mechanism" ? event.path : event.kind), ["after.ts"]);
});

test("readClaimResult distinguishes a successful empty claim", (t) => {
  const paths = freshPaths(t);
  const key = "empty-claim";
  mkdirSync(paths.spoolDir, { recursive: true });
  writeFileSync(join(paths.spoolDir, `${key}.jsonl`), "", { mode: 0o600 });
  const claim = claimBatch(key, paths);
  assert.ok(claim);

  assert.deepEqual(readClaimResult(claim, paths), { ok: true, events: [] });
  assert.deepEqual(readClaim(claim, paths), []);

  const malformedKey = "malformed-claim";
  writeFileSync(join(paths.spoolDir, `${malformedKey}.jsonl`), "not-json\n", { mode: 0o600 });
  const malformedClaim = claimBatch(malformedKey, paths);
  assert.ok(malformedClaim);
  assert.deepEqual(readClaimResult(malformedClaim, paths), { ok: true, events: [] });
});

test("forged claim paths outside spool are rejected without deleting their inode", (t) => {
  const paths = freshPaths(t);
  const key = "forged-claim";
  appendEvent(key, intent("reject forged claim"), paths);
  const claim = claimBatch(key, paths);
  assert.ok(claim);
  const outside = join(paths.home, "forged.claim.jsonl");
  try {
    linkSync(claim.path, outside);
  } catch {
    t.skip("hard links are unavailable");
    return;
  }
  const original = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = paths.home;
  try {
    const forged = { ...claim, path: outside };
    assert.deepEqual(readClaim(forged), []);
    assert.equal(removeClaim(forged, paths), false);
    assert.equal(existsSync(outside), true);
  } finally {
    if (original === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = original;
  }
});

test("removeBatch deletes regular batch and lock files", (t) => {
  const paths = freshPaths(t);
  appendEvent("k3", intent("a"), paths);
  assert.equal(acquireLock("k3", paths), true);
  removeBatch("k3", paths);
  assert.equal(readBatch("k3", paths).length, 0);
  assert.equal(acquireLock("k3", paths), true);
});

test("removeBatch releases locks when filesystem identity exceeds safe integer range", { timeout: 10_000 }, async (t) => {
  const paths = freshPaths(t);
  const key = "unsafe-identity";
  const resultPath = join(paths.home, "result.json");
  const spoolModule = join(dirname(fileURLToPath(import.meta.url)), "..", "agent", "spool.js");
  const workerScript = [
    "import fs from 'node:fs';",
    "import { syncBuiltinESMExports } from 'node:module';",
    "import { join } from 'node:path';",
    "import { pathToFileURL } from 'node:url';",
    "const [modulePath, home, resultPath, key] = process.argv.slice(1);",
    "const unsafeIno = Number.MAX_SAFE_INTEGER + 2;",
    "const patchIdentity = (stats) => { stats.ino = unsafeIno; return stats; };",
    "const originalFstat = fs.fstatSync.bind(fs);",
    "const originalLstat = fs.lstatSync.bind(fs);",
    "fs.fstatSync = (...args) => patchIdentity(originalFstat(...args));",
    "fs.lstatSync = (...args) => patchIdentity(originalLstat(...args));",
    "syncBuiltinESMExports();",
    "const { acquireLock, appendEvent, removeBatch } = await import(pathToFileURL(modulePath).href);",
    "const paths = { spoolDir: join(home, 'spool') };",
    "appendEvent(key, { v: 1, agent: 'claude-code', kind: 'intent', ts: 1, text: 'unsafe identity' }, paths);",
    "const first = acquireLock(key, paths);",
    "removeBatch(key, paths);",
    "const second = acquireLock(key, paths);",
    "fs.writeFileSync(resultPath, JSON.stringify({ first, second }));",
  ].join("\n");
  const child = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    workerScript,
    spoolModule,
    paths.home,
    resultPath,
    key,
  ], { stdio: ["pipe", "pipe", "pipe"] });
  const result = await waitForWorker(child);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(resultPath, "utf8")), { first: true, second: true });
});

test("listOrphanBatches returns sorted stale batches with absent or stale regular locks", (t) => {
  const paths = freshPaths(t);
  appendEvent("old", intent("a"), paths);
  appendEvent("stale-lock", intent("b"), paths);
  appendEvent("fresh-lock", intent("c"), paths);
  appendEvent("fresh", intent("d"), paths);
  const now = Date.now();
  const stale = oldTime(now);
  for (const key of ["old", "stale-lock"]) {
    utimesSync(join(paths.spoolDir, `${key}.jsonl`), stale, stale);
  }
  const staleLock = join(paths.spoolDir, "stale-lock.lock");
  writeFileSync(staleLock, "");
  utimesSync(staleLock, stale, stale);
  assert.equal(acquireLock("fresh-lock", paths), true);

  assert.deepEqual(listOrphanBatches(now, paths), ["old", "stale-lock"]);
});

test("append, read, lock, and orphan listing reject symlink and non-regular files", (t) => {
  const paths = freshPaths(t);
  mkdirSync(paths.spoolDir, { recursive: true });
  const targetBatch = join(paths.home, "target.jsonl");
  writeFileSync(targetBatch, JSON.stringify(intent("target")) + "\n");
  const symlinkBatch = join(paths.spoolDir, "link.jsonl");
  try {
    symlinkSync(targetBatch, symlinkBatch);
  } catch {
    t.skip("symlink creation unsupported on this platform");
    return;
  }
  const beforeTarget = readFileSync(targetBatch, "utf8");
  appendEvent("link", intent("must not follow"), paths);
  assert.deepEqual(readBatch("link", paths), []);
  assert.equal(readFileSync(targetBatch, "utf8"), beforeTarget);
  assert.deepEqual(listOrphanBatches(Date.now() + 12 * 60 * 1000, paths), []);

  const targetLock = join(paths.home, "target.lock");
  writeFileSync(targetLock, "target");
  const symlinkLock = join(paths.spoolDir, "link.lock");
  symlinkSync(targetLock, symlinkLock);
  assert.equal(acquireLock("link", paths), false);
  assert.equal(readFileSync(targetLock, "utf8"), "target");

  mkdirSync(join(paths.spoolDir, "directory.jsonl"));
  mkdirSync(join(paths.spoolDir, "directory.lock"));
  appendEvent("directory", intent("must not write directory"), paths);
  assert.deepEqual(readBatch("directory", paths), []);
  assert.equal(acquireLock("directory", paths), false);
  assert.deepEqual(listOrphanBatches(Date.now() + 12 * 60 * 1000, paths), []);
});

test("new spool directory and batch file use private modes where portable", (t) => {
  const paths = freshPaths(t);
  appendEvent("modes", intent("private"), paths);
  if (process.platform !== "win32") {
    assert.equal(statSync(paths.spoolDir).mode & 0o777, 0o700);
    assert.equal(statSync(join(paths.spoolDir, "modes.jsonl")).mode & 0o777, 0o600);
  }
});

test("filesystem errors fail safely at every exported spool boundary", (t) => {
  const paths = freshPaths(t);
  const spoolFile = join(paths.home, "not-a-directory");
  writeFileSync(spoolFile, "file");
  const broken = { ...paths, spoolDir: spoolFile };
  assert.doesNotThrow(() => appendEvent("k", intent("x"), broken));
  assert.deepEqual(readBatch("k", broken), []);
  assert.doesNotThrow(() => removeBatch("k", broken));
  assert.equal(acquireLock("k", broken), false);
  assert.deepEqual(listOrphanBatches(Date.now(), broken), []);
});

test("valid batch keys remain filename-safe and bounded", (t) => {
  const paths = freshPaths(t);
  const key = "A_0-" + "x".repeat(116);
  appendEvent(key, intent("valid"), paths);
  assert.equal(readBatch(key, paths).length, 1);
  assert.equal(lstatSync(join(paths.spoolDir, `${key}.jsonl`)).isFile(), true);
  assert.ok(key.length <= 120);
  assert.equal(dirname(join(paths.spoolDir, `${key}.jsonl`)), paths.spoolDir);
});
