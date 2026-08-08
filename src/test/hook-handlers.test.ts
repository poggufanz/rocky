import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "rocky-hook-"));
process.env.ROCKY_HOME = home;

const memory = await import("../core/memory.js");
const { hookFail, hookSuccess } = await import("../commands/hook.js");

const cwd = mkdtempSync(join(tmpdir(), "rocky-cwd-"));

test("hookFail records origin:hook failure and sets pending", () => {
  const code = hookFail("npm run build", 1, cwd);
  assert.equal(code, 0);
  const raw = readFileSync(join(home, "memory.jsonl"), "utf8");
  assert.ok(raw.includes('"origin":"hook"'));
  assert.ok(existsSync(memory.pendingPath()));
});

test("hookSuccess links fix to recent same-base failure in same cwd and clears pending", () => {
  const code = hookSuccess("npm run build", cwd);
  assert.equal(code, 0);
  const records = memory.loadMemory();
  const fixes = records.filter((r) => r.kind === "fix");
  assert.equal(fixes.length, 1);
  assert.equal(fixes[0].cwd, cwd);
  assert.ok(!existsSync(memory.pendingPath()), "pending cleared once resolved");
});

test("hookSuccess with nothing to link records no fix", () => {
  const beforeCount = memory.loadMemory().filter((r) => r.kind === "fix").length;
  hookSuccess("totally different-program", cwd);
  const afterCount = memory.loadMemory().filter((r) => r.kind === "fix").length;
  assert.equal(afterCount, beforeCount);
});

test("hookSuccess does not change process cwd", () => {
  memory.recordHookFailure("another program", 1, cwd);
  const before = process.cwd();
  hookSuccess("another program", cwd);
  assert.equal(process.cwd(), before);

  const fixes = memory.loadMemory().filter((record) => record.kind === "fix");
  assert.equal(fixes.at(-1)?.cwd, cwd);
});

const { deepMemoryHint } = await import("../commands/hook.js");

test("deep memory hint quotes the command so it can be pasted safely", () => {
  assert.equal(deepMemoryHint("npm run build"), "rocky run 'npm run build'");
  assert.equal(deepMemoryHint('git commit -m "wip"'), `rocky run 'git commit -m "wip"'`);
  assert.equal(deepMemoryHint("echo it's"), `rocky run 'echo it'\\''s'`);
});

test("no deep memory hint when the command is already a rocky run", () => {
  assert.equal(deepMemoryHint('rocky run "kimi resume"'), undefined);
  assert.equal(deepMemoryHint("  rocky   run npm test"), undefined);
});
