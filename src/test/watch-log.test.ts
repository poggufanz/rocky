import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneWatchLogs, watchLogName, writeWatchLog } from "../core/watch-log.js";

test("watchLogName is deterministic and differs by cmd, with no path/space characters", () => {
  const ts = Date.UTC(2026, 0, 15, 12, 34, 56, 789);
  const a = watchLogName(ts, "npm test");
  const b = watchLogName(ts, "npm test");
  const c = watchLogName(ts, "npm build");
  assert.equal(a, b);
  assert.notEqual(a, c);
  for (const name of [a, c]) {
    assert.ok(!name.includes("/"));
    assert.ok(!name.includes("\\"));
    assert.ok(!name.includes(":"));
    assert.ok(!name.includes(" "));
  }
});

test("writeWatchLog creates the directory, writes the lines, and sets mode 0600", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rocky-watch-log-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "watch");

  const name = watchLogName(Date.now(), "npm test");
  const path = writeWatchLog(dir, name, ["line one", "line two"]);

  assert.ok(path);
  assert.ok(existsSync(path));
  assert.equal(readdirSync(dir).length, 1);

  const content = readFileSync(path, "utf8");
  assert.equal(content, "line one\nline two\n");

  if (process.platform !== "win32") {
    const mode = statSync(path).mode & 0o777;
    assert.equal(mode, 0o600);
  }
});

test("writing the 21st log leaves exactly 20 files, the 20 newest by name", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rocky-watch-log-retain-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "watch");

  const baseTs = Date.UTC(2026, 0, 1, 0, 0, 0, 0);
  const names: string[] = [];
  for (let i = 0; i < 21; i++) {
    const ts = baseTs + i * 1000; // 1s apart: strictly increasing ISO names
    const name = watchLogName(ts, `cmd-${i}`);
    names.push(name);
    writeWatchLog(dir, name, [`entry ${i}`]);
  }

  const remaining = readdirSync(dir).sort();
  assert.equal(remaining.length, 20);
  assert.deepEqual(remaining, names.slice(1).sort());
});

test("writeWatchLog into an uncreatable directory returns undefined and does not throw", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rocky-watch-log-blocked-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const blocker = join(root, "blocker");
  writeFileSync(blocker, "not a directory");
  const dir = join(blocker, "watch"); // parent path component is a file

  const result = writeWatchLog(dir, "whatever.log", ["line"]);
  assert.equal(result, undefined);
});

test("pruneWatchLogs on a nonexistent directory does not throw", () => {
  assert.doesNotThrow(() => pruneWatchLogs(join(tmpdir(), "rocky-watch-log-does-not-exist-xyz")));
});
