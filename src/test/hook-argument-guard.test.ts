import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookFail, hookSuccess } from "../commands/hook.js";
import { guardPendingPath, recordFailure, recordHookFailure, recordWatchFailure } from "../core/memory.js";
import { parseMemoryRecord } from "../core/memory-read.js";

const GUARD_PENDING_ENTRY = "1799000000\tcancelled\trm\\s+-rf\t/repo\trm -rf /tmp/x\n";

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
    const guardPending = guardPendingPath(home);
    writeFileSync(guardPending, GUARD_PENDING_ENTRY, "utf8");
    for (const exitCode of [Number.NaN, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(hookFail("npm test", exitCode, absDir), 0);
      assert.equal(existsSync(memoryPath), false, `expected no memory.jsonl for exitCode=${String(exitCode)}`);
      assert.equal(existsSync(pendingPath), false, `expected no pending for exitCode=${String(exitCode)}`);
      assert.equal(
        readFileSync(guardPending, "utf8"),
        GUARD_PENDING_ENTRY,
        `expected guard.pending byte-identical for exitCode=${String(exitCode)}`,
      );
    }
  });
});

test("hookFail drops a relative or junk cwd", (t) => {
  withTempRockyHome(t, (home) => {
    const memoryPath = join(home, "memory.jsonl");
    const pendingPath = join(home, "pending");
    const guardPending = guardPendingPath(home);
    writeFileSync(guardPending, GUARD_PENDING_ENTRY, "utf8");
    for (const cwd of ["=", "", "relative/dir"]) {
      assert.equal(hookFail("npm test", 1, cwd), 0);
      assert.equal(existsSync(memoryPath), false, `expected no memory.jsonl for cwd=${JSON.stringify(cwd)}`);
      assert.equal(existsSync(pendingPath), false, `expected no pending for cwd=${JSON.stringify(cwd)}`);
      assert.equal(
        readFileSync(guardPending, "utf8"),
        GUARD_PENDING_ENTRY,
        `expected guard.pending byte-identical for cwd=${JSON.stringify(cwd)}`,
      );
    }
  });
});

test("hookSuccess drops a junk cwd", (t) => {
  withTempRockyHome(t, (home, absDir) => {
    assert.equal(hookFail("npm test", 1, absDir), 0);
    const memoryPath = join(home, "memory.jsonl");
    const pendingPath = join(home, "pending");
    const guardPending = guardPendingPath(home);
    writeFileSync(guardPending, GUARD_PENDING_ENTRY, "utf8");
    const beforeMemory = readFileSync(memoryPath, "utf8");
    assert.equal(existsSync(pendingPath), true);

    for (const cwd of ["=", "", "relative/dir"]) {
      assert.equal(hookSuccess("npm test", cwd), 0);
      assert.equal(readFileSync(memoryPath, "utf8"), beforeMemory, `expected memory unchanged for cwd=${JSON.stringify(cwd)}`);
      assert.equal(existsSync(pendingPath), true, `expected pending retained for cwd=${JSON.stringify(cwd)}`);
      assert.equal(
        readFileSync(guardPending, "utf8"),
        GUARD_PENDING_ENTRY,
        `expected guard.pending byte-identical for cwd=${JSON.stringify(cwd)}`,
      );
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

test("hookFail accepts PowerShell FileSystem UNC cwd on win32 and drops relative FileSystem cwd", { skip: process.platform !== "win32" }, (t) => {
  withTempRockyHome(t, (home) => {
    const relCwd = "Microsoft.PowerShell.Core\\FileSystem::relative";
    const memoryPath = join(home, "memory.jsonl");
    const pendingPath = join(home, "pending");
    assert.equal(hookFail("npm test", 1, relCwd), 0);
    assert.equal(existsSync(memoryPath), false);
    assert.equal(existsSync(pendingPath), false);

    const uncCwd = "Microsoft.PowerShell.Core\\FileSystem::\\\\server\\share\\repo";
    assert.equal(hookFail("npm test", 1, uncCwd), 0);
    assert.equal(existsSync(memoryPath), true);
    const lines = readFileSync(memoryPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const parsed = parseMemoryRecord(JSON.parse(lines[0]!));
    assert.ok(parsed !== undefined, "expected parseMemoryRecord to accept recorded UNC failure");
    assert.equal(parsed.kind, "failure");
    assert.equal(parsed.cwd, uncCwd);
  });
});

test("hookFail accepts PowerShell drive locations on win32 while still dropping '='", { skip: process.platform !== "win32" }, (t) => {
  for (const driveCwd of ["Temp:\\", "Work:\\repo"]) {
    withTempRockyHome(t, (home) => {
      const memoryPath = join(home, "memory.jsonl");
      assert.equal(hookFail("npm test", 1, driveCwd), 0);
      assert.equal(existsSync(memoryPath), true);
      const lines = readFileSync(memoryPath, "utf8").trim().split("\n");
      assert.equal(lines.length, 1);
      const parsed = parseMemoryRecord(JSON.parse(lines[0]!));
      assert.ok(parsed !== undefined, `expected parseMemoryRecord to accept recorded failure for ${driveCwd}`);
      assert.equal(parsed.kind, "failure");
      assert.equal(parsed.cwd, driveCwd);
    });
  }

  for (const junkCwd of ["=", "http://x", "file:///C:/x"]) {
    withTempRockyHome(t, (home) => {
      const memoryPath = join(home, "memory.jsonl");
      const pendingPath = join(home, "pending");
      assert.equal(hookFail("npm test", 1, junkCwd), 0);
      assert.equal(existsSync(memoryPath), false, `expected no memory.jsonl for cwd=${junkCwd}`);
      assert.equal(existsSync(pendingPath), false);
    });
  }
});

test("failure writers refuse NaN and non-safe integers", (t) => {
  withTempRockyHome(t, (home, absDir) => {
    const memoryPath = join(home, "memory.jsonl");
    for (const exitCode of [Number.NaN, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => recordHookFailure("x", exitCode, absDir), {
        name: "RangeError",
        message: "exitCode must be a safe integer",
      });
      assert.throws(() => recordFailure("x", exitCode, "boom"), {
        name: "RangeError",
        message: "exitCode must be a safe integer",
      });
      assert.throws(() => recordWatchFailure("x", exitCode, "boom", absDir), {
        name: "RangeError",
        message: "exitCode must be a safe integer",
      });
    }
    assert.equal(existsSync(memoryPath), false);
  });
});
