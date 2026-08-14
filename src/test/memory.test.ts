import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as memory from "../core/memory.js";
import { resolveRockyPaths, type RockyPaths } from "../core/state-paths.js";

const home = mkdtempSync(join(tmpdir(), "rocky-mem-"));
const originalRockyHome = process.env.ROCKY_HOME;
process.env.ROCKY_HOME = home;

after(() => {
  if (originalRockyHome === undefined) delete process.env.ROCKY_HOME;
  else process.env.ROCKY_HOME = originalRockyHome;
});

test("recordHookFailure writes an origin:hook record and touches pending", () => {
  const rec = memory.recordHookFailure("npm run build", 1, "/some/dir");
  assert.equal(rec.origin, "hook");
  assert.equal(rec.cwd, "/some/dir");
  assert.equal(rec.excerpt, "exit 1");
  assert.ok(rec.signature.length > 0);
  const raw = readFileSync(join(home, "memory.jsonl"), "utf8");
  assert.ok(raw.includes('"origin":"hook"'));
  assert.ok(existsSync(memory.pendingPath()));
});

test("two hook failures of same command share a fingerprint", () => {
  const a = memory.recordHookFailure("npm run build", 1, "/some/dir");
  const b = memory.recordHookFailure("npm run build", 1, "/other/dir");
  assert.equal(a.fingerprint, b.fingerprint);
});

test("clearPendingIfResolved removes flag only when nothing unresolved", () => {
  // there ARE unresolved failures right now
  let records = memory.loadMemory();
  memory.clearPendingIfResolved(records);
  assert.ok(existsSync(memory.pendingPath()), "flag stays while unresolved");

  // resolve everything, then it clears
  const failures = records.filter(
    (r): r is import("../core/memory.js").FailureRecord => r.kind === "failure"
  );
  memory.recordFix("npm run build", failures.map((failure) => ({ failure, basis: "identity" as const, confidence: "confirmed" as const })));
  records = memory.loadMemory();
  assert.equal(memory.hasUnresolvedRecent(records), false);
  memory.clearPendingIfResolved(records);
  assert.ok(!existsSync(memory.pendingPath()), "flag cleared when resolved");
});

test("memoryPath resolves ROCKY_HOME each time", () => {
  const original = process.env.ROCKY_HOME;
  try {
    process.env.ROCKY_HOME = join(home, "one");
    const first = memory.memoryPath();
    process.env.ROCKY_HOME = join(home, "two");
    const second = memory.memoryPath();
    assert.notEqual(first, second);
    assert.equal(first, join(home, "one", "memory.jsonl"));
    assert.equal(second, join(home, "two", "memory.jsonl"));
  } finally {
    if (original === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = original;
  }
});

test("recordFix keeps its line readable instead of writing a record that is silently lost", () => {
  // 10 000 linked failures used to serialise to ~1.13 MB — past
  // MAX_MEMORY_LINE_BYTES, so loadMemory skipped it forever while Rocky still
  // said "I remember the fix" and stats reported "0 have fix".
  const links = Array.from({ length: 10_000 }, (_, i) => ({
    failure: {
      kind: "failure" as const, id: `failure-${i}`, ts: 1_700_000_000_000 + i, cwd: "/x",
      cmd: "true", exitCode: 1, fingerprint: "ff", signature: [] as string[], excerpt: "",
    },
    basis: "identity" as const,
    confidence: "confirmed" as const,
  }));

  const fix = memory.recordFix("true ok", links, "/x");

  assert.ok(fix.links !== undefined);
  assert.equal(fix.links.length, memory.MAX_FIX_LINKS);
  assert.equal(fix.failureIds.length, memory.MAX_FIX_LINKS);
  assert.ok(
    Buffer.byteLength(JSON.stringify(fix) + "\n", "utf8") <= memory.MAX_MEMORY_LINE_BYTES,
    "a fix record must fit inside the line length every reader enforces",
  );

  // it must actually survive the round trip it previously failed
  const stored = memory.loadMemory(join(home, "memory.jsonl"))
    .filter((record) => record.kind === "fix" && record.id === fix.id);
  assert.equal(stored.length, 1, "the fix record must still be readable after writing");
});

test("recordNote round-trips through the parser", () => {
  memory.recordNote({
    cwd: "/tmp/x",
    cmd: "abc..def",
    file: "src/a.ts",
    line: 3,
    subject: "eval(x)",
    answer: "it evaluates x",
  });

  const note = memory.loadMemory().find((record) => record.kind === "note");
  assert.ok(note);
  assert.equal(note.file, "src/a.ts");
  assert.equal(note.answer, "it evaluates x");
});

test("parseMemoryRecord rejects malformed notes and still skips unknown kinds", () => {
  assert.equal(
    memory.parseMemoryRecord({ kind: "note", id: "x", ts: 1, cwd: "/", cmd: "" }),
    undefined,
  );
  assert.equal(
    memory.parseMemoryRecord({ kind: "hologram", id: "x", ts: 1, cwd: "/", cmd: "" }),
    undefined,
  );
});

test("loadMemory skips unknown record kinds between known records", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "rocky-mem-forward-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "memory.jsonl");
  const failure = {
    kind: "failure",
    id: "known-1",
    ts: 1,
    cwd: "/w",
    cmd: "false",
    exitCode: 1,
    fingerprint: "f",
    signature: ["false"],
    excerpt: "failed",
  };
  const note = {
    kind: "note",
    id: "known-2",
    ts: 2,
    cwd: "/w",
    cmd: "note",
    file: "src/a.ts",
    line: 1,
    subject: "x",
    answer: "y",
  };
  writeFileSync(path, `${JSON.stringify(failure)}\n{"kind":"hologram","id":"unknown"}\n${JSON.stringify(note)}\n`, "utf8");
  const records = memory.loadMemory(path);
  assert.deepEqual(records.map((record) => record.id), ["known-1", "known-2"]);
});

function tripleInput() {
  return {
    ts: 7,
    cwd: "/w",
    agent: "codex" as const,
    intent: { text: "make test pass" },
    mechanism: { files: [], truncatedFiles: 0 },
  };
}

test("recordTriple creates a private 0600 memory file under umask 022", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "rocky-mem-private-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const resolved = freshMemoryPaths(directory);
  const previous = process.umask(0o022);
  try {
    memory.recordTriple(tripleInput(), resolved);
    if (process.platform !== "win32") assert.equal(statSync(resolved.memory).mode & 0o777, 0o600);
  } finally {
    process.umask(previous);
  }
});

test("recordTriple corrects an existing permissive regular memory file", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "rocky-mem-correct-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const resolved = freshMemoryPaths(directory);
  writeFileSync(resolved.memory, "", "utf8");
  if (process.platform !== "win32") chmodSync(resolved.memory, 0o644);
  const previous = process.umask(0o022);
  try {
    memory.recordTriple(tripleInput(), resolved);
    if (process.platform !== "win32") assert.equal(statSync(resolved.memory).mode & 0o777, 0o600);
    assert.equal(memory.loadMemory(resolved.memory).length, 1);
  } finally {
    process.umask(previous);
  }
});

test("recordTriple rejects a memory symlink without modifying its target", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "rocky-mem-symlink-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const resolved = freshMemoryPaths(directory);
  const target = join(directory, "target.jsonl");
  writeFileSync(target, "keep\n", "utf8");
  try {
    symlinkSync(target, resolved.memory);
  } catch {
    return;
  }
  assert.equal(lstatSync(resolved.memory).isSymbolicLink(), true);
  assert.throws(() => memory.recordTriple(tripleInput(), resolved));
  assert.equal(readFileSync(target, "utf8"), "keep\n");
  assert.equal(lstatSync(resolved.memory).isSymbolicLink(), true);
});

test("recordTriple rejects a non-regular memory destination", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "rocky-mem-nonregular-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const resolved = freshMemoryPaths(directory);
  mkdirSync(resolved.memory, { recursive: true });
  assert.throws(() => memory.recordTriple(tripleInput(), resolved));
  assert.equal(lstatSync(resolved.memory).isDirectory(), true);
});

test("recordTriple rejects a candidate line over the memory byte cap", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "rocky-mem-cap-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const resolved = freshMemoryPaths(directory);
  assert.throws(() => memory.recordTriple({
    ...tripleInput(),
    intent: { text: "x".repeat(memory.MAX_MEMORY_LINE_BYTES) },
  }, resolved));
  assert.equal(existsSync(resolved.memory), false);
});

function freshMemoryPaths(directory: string): RockyPaths {
  // Keep these tests independent of process.env.ROCKY_HOME.
  return resolveRockyPaths({ ROCKY_HOME: directory });
}
