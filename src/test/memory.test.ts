import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as memory from "../core/memory.js";

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
  memory.recordFix("npm run build", failures.map((failure) => ({ failure, basis: "program" as const })));
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
    basis: "signature" as const,
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
