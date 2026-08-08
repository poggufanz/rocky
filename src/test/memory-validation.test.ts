import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
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

test("loader accepts a fix's links array and drops a fix with a malformed link", () => {
  const root = mkdtempSync(join(tmpdir(), "rocky-links-"));
  const file = join(root, "memory.jsonl");
  const goodFix = {
    kind: "fix", id: "x1", ts: 2, cwd: "/work", cmd: "true", failureIds: ["f1"],
    links: [{ id: "f1", basis: "signature" }],
  };
  const badFix = {
    kind: "fix", id: "x2", ts: 3, cwd: "/work", cmd: "true", failureIds: ["f1"],
    links: [{ id: "f1", basis: "maybe" }],
  };
  writeFileSync(file, [JSON.stringify(goodFix), JSON.stringify(badFix)].join("\n") + "\n");
  const records = loadMemory(file);
  assert.deepEqual(records.map((r) => r.id), ["x1"]);
  assert.equal(records[0].kind === "fix" ? records[0].links?.[0]?.basis : undefined, "signature");
});

test("state paths resolve ROCKY_HOME on every call", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "rocky-state-paths-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const first = resolveRockyPaths({ ROCKY_HOME: "one" }, cwd, cwd);
  const second = resolveRockyPaths({ ROCKY_HOME: "two" }, cwd, cwd);
  assert.equal(first.home, join(cwd, "one"));
  assert.equal(second.home, join(cwd, "two"));
  assert.equal(isAbsolute(first.home), true);
  assert.equal(isAbsolute(second.home), true);
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

test("a watch-origin failure record round-trips", () => {
  const root = mkdtempSync(join(tmpdir(), "rocky-origin-watch-"));
  const file = join(root, "memory.jsonl");
  const record = {
    kind: "failure", id: "f-watch", ts: 1, cwd: "/w", cmd: "x", exitCode: 1,
    fingerprint: "fp", signature: ["x"], excerpt: "x", origin: "watch",
  };
  writeFileSync(file, JSON.stringify(record) + "\n");
  const records = loadMemory(file);
  assert.equal(records.length, 1);
  assert.equal(records[0].kind === "failure" ? records[0].origin : undefined, "watch");
});

test("an unrecognized string origin no longer discards the record; it reads as run", () => {
  const root = mkdtempSync(join(tmpdir(), "rocky-origin-unknown-"));
  const file = join(root, "memory.jsonl");
  const record = {
    kind: "failure", id: "f-unknown", ts: 1, cwd: "/w", cmd: "x", exitCode: 1,
    fingerprint: "fp", signature: ["x"], excerpt: "x", origin: "quantum",
  };
  writeFileSync(file, JSON.stringify(record) + "\n");
  const records = loadMemory(file);
  assert.equal(records.length, 1);
  assert.equal(records[0].kind === "failure" ? records[0].origin : undefined, "run");
});

test("a non-string origin no longer discards the record; it reads as run", () => {
  const root = mkdtempSync(join(tmpdir(), "rocky-origin-nonstring-"));
  const file = join(root, "memory.jsonl");
  const record = {
    kind: "failure", id: "f-nonstring", ts: 1, cwd: "/w", cmd: "x", exitCode: 1,
    fingerprint: "fp", signature: ["x"], excerpt: "x", origin: 7,
  };
  writeFileSync(file, JSON.stringify(record) + "\n");
  const records = loadMemory(file);
  assert.equal(records.length, 1);
  assert.equal(records[0].kind === "failure" ? records[0].origin : undefined, "run");
});

test("a failure record with no origin still parses with origin undefined", () => {
  const root = mkdtempSync(join(tmpdir(), "rocky-origin-absent-"));
  const file = join(root, "memory.jsonl");
  const record = {
    kind: "failure", id: "f-absent", ts: 1, cwd: "/w", cmd: "x", exitCode: 1,
    fingerprint: "fp", signature: ["x"], excerpt: "x",
  };
  writeFileSync(file, JSON.stringify(record) + "\n");
  const records = loadMemory(file);
  assert.equal(records.length, 1);
  assert.equal(records[0].kind === "failure" ? records[0].origin : undefined, undefined);
});

test("watchDir is <home>/watch and respects ROCKY_HOME", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "rocky-watchdir-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const paths = resolveRockyPaths({ ROCKY_HOME: "somehome" }, cwd, cwd);
  assert.equal(paths.watchDir, join(cwd, "somehome", "watch"));
});
