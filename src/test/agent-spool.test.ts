import { strict as assert } from "node:assert";
import test from "node:test";
import {
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
