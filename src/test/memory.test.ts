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
  memory.recordFix("npm run build", failures);
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
