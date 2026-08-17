import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandFingerprint } from "../core/fingerprint.js";
import { validateRockyPhrase } from "../ui/phrases.js";

const home = mkdtempSync(join(tmpdir(), "rocky-hook-"));
process.env.ROCKY_HOME = home;

const memory = await import("../core/memory.js");
const { hookFail, hookSuccess } = await import("../commands/hook.js");

/**
 * Hook handlers speak over /dev/tty (they run detached, stderr discarded).
 * Intercept `fs.writeFileSync` for that one path and pass every other path
 * through untouched — same technique file-transaction.test.ts and
 * hook-block.test.ts already use to observe writes a module under test makes
 * through a plain named `import { writeFileSync } from "node:fs"`.
 */
function captureTty<T>(fn: () => T): { result: T; tty: string } {
  const original = fs.writeFileSync;
  let tty = "";
  fs.writeFileSync = ((
    file: fs.PathOrFileDescriptor,
    data: unknown,
    options?: fs.WriteFileOptions,
  ) => {
    if (file === "/dev/tty") {
      tty += String(data);
      return;
    }
    return original(file, data as never, options);
  }) as typeof fs.writeFileSync;
  syncBuiltinESMExports();
  try {
    return { result: fn(), tty };
  } finally {
    fs.writeFileSync = original;
    syncBuiltinESMExports();
  }
}

const cwd = mkdtempSync(join(tmpdir(), "rocky-cwd-"));

test("hookFail records nothing and says nothing for cancel exits", () => {
  const cancelHome = mkdtempSync(join(tmpdir(), "rocky-hook-cancel-"));
  process.env.ROCKY_HOME = cancelHome;
  try {
    for (const code of [130, 143]) {
      const { result, tty } = captureTty(() => hookFail("kimi --resume", code, "/tmp/somewhere"));
      assert.equal(result, 0);
      assert.equal(tty, "");
    }
    assert.equal(existsSync(join(cancelHome, "memory.jsonl")), false);
  } finally {
    process.env.ROCKY_HOME = home;
  }
});

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

/**
 * Isolated ROCKY_HOME per test below: the shared `home`/`cwd` above already
 * carries fix records other tests count exactly, so seeding a fix from a
 * different directory there would corrupt those assertions. hookFail reads
 * ROCKY_HOME fresh on every call (`resolveRockyPaths` defaults to
 * `process.env`), so swapping it around one call is enough isolation.
 */
function seedElsewhereFix(failCwd: string, fixCwd: string, cmd: string, exitCode: number): void {
  const isolatedHome = mkdtempSync(join(tmpdir(), "rocky-hook-elsewhere-"));
  const fp = commandFingerprint(cmd, exitCode);
  const failure = {
    kind: "failure", id: "seed-failure", ts: Date.now() - 1000, cwd: failCwd, cmd,
    exitCode, fingerprint: fp, fingerprintV: 2, signature: [cmd], excerpt: `exit ${exitCode}`, origin: "hook",
  };
  const fix = {
    kind: "fix", id: "seed-fix", ts: Date.now(), cwd: fixCwd, cmd,
    failureIds: ["seed-failure"],
  };
  writeFileSync(
    join(isolatedHome, "memory.jsonl"),
    `${JSON.stringify(failure)}\n${JSON.stringify(fix)}\n`,
    "utf8",
  );
  process.env.ROCKY_HOME = isolatedHome;
}

test("hookFail admits when the remembered fix's cwd differs from the cwd argument", () => {
  const failCwd = mkdtempSync(join(tmpdir(), "rocky-elsewhere-fail-"));
  const fixCwd = mkdtempSync(join(tmpdir(), "rocky-elsewhere-fix-"));
  seedElsewhereFix(failCwd, fixCwd, "elsewhere-test-cmd", 1);
  try {
    const { result, tty } = captureTty(() => hookFail("elsewhere-test-cmd", 1, failCwd));
    assert.equal(result, 0);
    assert.match(tty, /last time, you fix with:/);
    assert.match(tty, /but fix comes from other place\./);
    assert.match(tty, new RegExp(`place: ${fixCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.doesNotMatch(tty, /strong\.|confirmed/);
  } finally {
    process.env.ROCKY_HOME = home;
  }
});

test("hookFail compares elsewhere against linked failure cwd, not invocation cwd", () => {
  const failCwd = mkdtempSync(join(tmpdir(), "rocky-linked-failure-source-"));
  const fixCwd = mkdtempSync(join(tmpdir(), "rocky-linked-fix-current-"));
  seedElsewhereFix(failCwd, fixCwd, "linked-cwd-test-cmd", 1);
  try {
    const { result, tty } = captureTty(() => hookFail("linked-cwd-test-cmd", 1, fixCwd));
    assert.equal(result, 0);
    assert.match(tty, /but fix comes from other place\./);
    assert.match(tty, new RegExp(`place: ${fixCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(tty, /possible only/);
    assert.doesNotMatch(tty, /strong\.|confirmed/);
  } finally {
    process.env.ROCKY_HOME = home;
  }
});

test("hookFail says nothing extra when the remembered fix's cwd matches the cwd argument", () => {
  const sameCwd = mkdtempSync(join(tmpdir(), "rocky-samecwd-"));
  seedElsewhereFix(sameCwd, sameCwd, "samecwd-test-cmd", 1);
  try {
    const { result, tty } = captureTty(() => hookFail("samecwd-test-cmd", 1, sameCwd));
    assert.equal(result, 0);
    assert.doesNotMatch(tty, /other place/);
    assert.doesNotMatch(tty, /place:/);
    // sanity: the base fix line still speaks, proving the comparison — not
    // the whole fix branch — is what's being suppressed here.
    assert.match(tty, /last time, you fix with:/);
  } finally {
    process.env.ROCKY_HOME = home;
  }
});

test("the elsewhere-admission line follows Rocky's voice rules", () => {
  assert.deepEqual(validateRockyPhrase("but fix comes from other place."), []);
});
