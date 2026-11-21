import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookFail, hookSuccess } from "../commands/hook.js";
import { recordFailure, recordHookFailure, recordWatchFailure } from "../core/memory.js";
import { parseMemoryRecord } from "../core/memory-read.js";

function withTempRockyHome(t: TestContext, fn: (home: string, absDir: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "rocky-hook-guard-"));
  const home = join(root, "home");
  const absDir = join(root, "repo");
  mkdirSync(home, { recursive: true });
  mkdirSync(absDir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  try {
    fn(home, absDir);
  } finally {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
  }
}

test("hookFail drops a non-integer exit code", (t) => {
  withTempRockyHome(t, (home, absDir) => {
    const memoryPath = join(home, "memory.jsonl");
    const pendingPath = join(home, "pending");
    for (const exitCode of [Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
      assert.equal(hookFail("npm test", exitCode, absDir), 0);
      assert.equal(existsSync(memoryPath), false, `expected no memory.jsonl for exitCode=${String(exitCode)}`);
      assert.equal(existsSync(pendingPath), false, `expected no pending for exitCode=${String(exitCode)}`);
    }
  });
});

test("hookFail drops a relative or junk cwd", (t) => {
  withTempRockyHome(t, (home) => {
    const memoryPath = join(home, "memory.jsonl");
    const pendingPath = join(home, "pending");
    for (const cwd of ["=", "", "relative/dir"]) {
      assert.equal(hookFail("npm test", 1, cwd), 0);
      assert.equal(existsSync(memoryPath), false, `expected no memory.jsonl for cwd=${JSON.stringify(cwd)}`);
      assert.equal(existsSync(pendingPath), false, `expected no pending for cwd=${JSON.stringify(cwd)}`);
    }
  });
});

test("hookSuccess drops a junk cwd", (t) => {
  withTempRockyHome(t, (home, absDir) => {
    assert.equal(hookFail("npm test", 1, absDir), 0);
    const memoryPath = join(home, "memory.jsonl");
    const pendingPath = join(home, "pending");
    const beforeMemory = readFileSync(memoryPath, "utf8");
    assert.equal(existsSync(pendingPath), true);

    for (const cwd of ["=", "", "relative/dir"]) {
      assert.equal(hookSuccess("npm test", cwd), 0);
      assert.equal(readFileSync(memoryPath, "utf8"), beforeMemory, `expected memory unchanged for cwd=${JSON.stringify(cwd)}`);
      assert.equal(existsSync(pendingPath), true, `expected pending retained for cwd=${JSON.stringify(cwd)}`);
    }
  });
});

test("hookFail still records a valid failure", (t) => {
  withTempRockyHome(t, (home, absDir) => {
    assert.equal(hookFail("npm test", 1, absDir), 0);
    const memoryPath = join(home, "memory.jsonl");
    assert.equal(existsSync(memoryPath), true);
    const lines = readFileSync(memoryPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const parsed = parseMemoryRecord(JSON.parse(lines[0]!));
    assert.ok(parsed !== undefined, "expected parseMemoryRecord to accept recorded failure");
    assert.equal(parsed.kind, "failure");
    assert.equal(parsed.exitCode, 1);
    assert.equal(parsed.cwd, absDir);
    assert.equal(parsed.origin, "hook");
  });
});

test("failure writers refuse NaN", (t) => {
  withTempRockyHome(t, (home, absDir) => {
    const memoryPath = join(home, "memory.jsonl");
    assert.throws(() => recordHookFailure("x", Number.NaN, absDir), {
      name: "RangeError",
      message: "exitCode must be a safe integer",
    });
    assert.throws(() => recordFailure("x", Number.NaN, "boom"), {
      name: "RangeError",
      message: "exitCode must be a safe integer",
    });
    assert.throws(() => recordWatchFailure("x", Number.NaN, "boom", absDir), {
      name: "RangeError",
      message: "exitCode must be a safe integer",
    });
    assert.equal(existsSync(memoryPath), false);
  });
});
