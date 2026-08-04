import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMemory } from "../core/memory.js";
import { resolveRockyPaths } from "../core/state-paths.js";

test("loader skips JSON-valid garbage and keeps valid legacy records", () => {
  const root = mkdtempSync(join(tmpdir(), "rocky-valid-"));
  const file = join(root, "memory.jsonl");
  const legacy = {
    kind: "failure", id: "f1", ts: 1, cwd: "/work", cmd: "false", exitCode: 1,
    fingerprint: "abc", signature: ["false"], excerpt: "exit 1",
  };
  const fix = { kind: "fix", id: "x1", ts: 2, cwd: "/work", cmd: "true", failureIds: ["f1"] };
  writeFileSync(file, ["null", "[]", "{}", JSON.stringify(legacy), JSON.stringify(fix)].join("\n") + "\n");
  const before = { bytes: readFileSync(file), mtime: statSync(file).mtimeMs };
  const records = loadMemory(file);
  assert.equal(records.length, 2);
  assert.equal(records[0].kind, "failure");
  assert.equal(records[0].kind === "failure" ? records[0].resolvedBy : undefined, "x1");
  assert.deepEqual(readFileSync(file), before.bytes);
  assert.equal(statSync(file).mtimeMs, before.mtime);
});

test("state paths resolve ROCKY_HOME on every call", () => {
  const first = resolveRockyPaths({ ROCKY_HOME: "one" }, "/users/me", "/work");
  const second = resolveRockyPaths({ ROCKY_HOME: "two" }, "/users/me", "/work");
  assert.equal(first.home, join("/work", "one"));
  assert.equal(second.home, join("/work", "two"));
  assert.notEqual(first.memory, second.memory);
});

test("loader drops a line larger than one MiB", () => {
  const root = mkdtempSync(join(tmpdir(), "rocky-large-"));
  const file = join(root, "memory.jsonl");
  writeFileSync(file, JSON.stringify({
    kind: "failure", id: "f", ts: 1, cwd: "/w", cmd: "x", exitCode: 1,
    fingerprint: "fp", signature: ["x"], excerpt: "x".repeat(1024 * 1024),
  }) + "\n");
  assert.deepEqual(loadMemory(file), []);
});
