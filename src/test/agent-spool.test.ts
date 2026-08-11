import { strict as assert } from "node:assert";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import test from "node:test";
import {
  existsSync,
  mkdtempSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRockyPaths } from "../core/state-paths.js";
import {
  acquireLock,
  appendEvent,
  listOrphanBatches,
  MAX_BATCH_BYTES,
  readBatch,
  removeBatch,
} from "../agent/spool.js";
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

test("state paths include exact transient spool, labels, and agent log paths", (t) => {
  const paths = freshPaths(t);
  assert.equal(paths.spoolDir, join(paths.home, "spool"));
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
    "import { existsSync, writeFileSync } from 'node:fs';",
    "import { syncBuiltinESMExports } from 'node:module';",
    "import { join } from 'node:path';",
    "import { pathToFileURL } from 'node:url';",
    "const [modulePath, home, readyPath, startPath, key, text, gateDirectory, releasePath] = process.argv.slice(1);",
    "const originalWrite = fs.writeSync.bind(fs);",
    "const originalWriteFile = fs.writeFileSync.bind(fs);",
    "fs.writeSync = (fd, ...args) => { const markerPath = join(gateDirectory, `${process.pid}.gate`); if (!existsSync(markerPath)) { originalWriteFile(markerPath, 'gate'); const signal = new Int32Array(new SharedArrayBuffer(4)); while (!existsSync(releasePath)) Atomics.wait(signal, 0, 0, 1); } return originalWrite(fd, ...args); };",
    "syncBuiltinESMExports();",
    "const { appendEvent } = await import(pathToFileURL(modulePath).href);",
    "writeFileSync(readyPath, 'ready');",
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
    "import { existsSync, writeFileSync } from 'node:fs';",
    "import { syncBuiltinESMExports } from 'node:module';",
    "import { join } from 'node:path';",
    "import { pathToFileURL } from 'node:url';",
    "const [modulePath, home, key, readyPath, attemptPath, writeDirectory, unlinkDirectory, allowPath, gateUnlink] = process.argv.slice(1);",
    "const originalWrite = fs.writeSync.bind(fs);",
    "const originalWriteFile = fs.writeFileSync.bind(fs);",
    "const originalUnlink = fs.unlinkSync.bind(fs);",
    "fs.writeSync = (fd, ...args) => { const marker = join(writeDirectory, `${process.pid}.write`); if (!existsSync(marker)) originalWriteFile(marker, 'write'); return originalWrite(fd, ...args); };",
    "if (gateUnlink === 'yes') fs.unlinkSync = (path, ...args) => { if (String(path).endsWith(`${key}.append.lock`)) { const marker = join(unlinkDirectory, `${process.pid}.unlink`); originalWriteFile(marker, 'unlink'); const signal = new Int32Array(new SharedArrayBuffer(4)); while (!existsSync(allowPath)) Atomics.wait(signal, 0, 0, 1); } return originalUnlink(path, ...args); };",
    "syncBuiltinESMExports();",
    "const { appendEvent } = await import(pathToFileURL(modulePath).href);",
    "writeFileSync(readyPath, 'ready');",
    "if (attemptPath !== '-') writeFileSync(attemptPath, 'attempt');",
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
  writeFileSync(stalePath, "old");
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
  assert.equal(readBatch("writer", paths).length, 0);
  assert.equal(existsSync(lock), true);

  writeFileSync(lock, privateLockMetadata(process.pid, "b".repeat(32)));
  appendEvent("writer", intent("fresh lock blocks"), paths);
  assert.equal(existsSync(lock), true);
  removeBatch("writer", paths);
  assert.equal(existsSync(lock), true);
});

test("removeBatch deletes regular batch and lock files", (t) => {
  const paths = freshPaths(t);
  appendEvent("k3", intent("a"), paths);
  assert.equal(acquireLock("k3", paths), true);
  removeBatch("k3", paths);
  assert.equal(readBatch("k3", paths).length, 0);
  assert.equal(acquireLock("k3", paths), true);
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
  writeFileSync(staleLock, "old");
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
