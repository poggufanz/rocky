import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "rocky-mem-"));
process.env.ROCKY_HOME = home;

// dynamic import AFTER env is set, so ROCKY_DIR points at the temp dir
const memory = await import("../core/memory.js");

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
