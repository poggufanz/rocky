import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { commandFingerprint } from "../core/fingerprint.js";
import { validateRockyPhrase } from "../ui/phrases.js";
import { detailTty, flushHookSpeech, sayTty } from "../ui/rocky.js";

const home = mkdtempSync(join(tmpdir(), "rocky-hook-"));
process.env.ROCKY_HOME = home;

const memory = await import("../core/memory.js");
const { hookFail, hookSuccess } = await import("../commands/hook.js");

/**
 * Hook handlers speak over the console device (they run detached, stderr
 * discarded): `/dev/tty` on POSIX, `\\.\CON` on native Windows (see
 * `ui/rocky.ts`'s `ttyDevicePath` — native Windows Node has no `/dev/tty`,
 * so `sayTty`/`detailTty` target `\\.\CON` there instead; this interception
 * must match whichever one the implementation actually targets on this
 * platform, or every assertion below silently sees an empty `tty` string
 * instead of a real interception failure). Intercept `fs.writeFileSync` for
 * that one path and pass every other path through untouched — same
 * technique file-transaction.test.ts and hook-block.test.ts already use to
 * observe writes a module under test makes through a plain named
 * `import { writeFileSync } from "node:fs"`.
 *
 * The bare reserved name `CON` was tried first and rejected: task-4-report.md
 * records that `writeFileSync("CON", ...)` empirically creates an ordinary
 * file literally named `CON` in the process's cwd, both with a console
 * attached and fully detached/console-less (matching how hook handlers
 * actually run) — Node's long-path handling defeats Win32's classic
 * reserved-name interception for a bare relative path. `\\.\CON`, the
 * explicit Win32 device-namespace form, was proven never to do that.
 */
const TTY_DEVICE_PATH = process.platform === "win32" ? "\\\\.\\CON" : "/dev/tty";

function captureTty<T>(fn: () => T): { result: T; tty: string } {
  const original = fs.writeFileSync;
  let tty = "";
  fs.writeFileSync = ((
    file: fs.PathOrFileDescriptor,
    data: unknown,
    options?: fs.WriteFileOptions,
  ) => {
    if (file === TTY_DEVICE_PATH) {
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

/**
 * Real (uninstrumented) `sayTty`/`detailTty`, run in a genuinely console-less
 * child process — `stdio: "ignore"` plus `windowsHide: true` reproduces the
 * no-window, no-console shape this codebase already uses for its other
 * detached spawns (see `core/notify.ts`), and is the same shape task-4-report
 * used to empirically settle the `CON` question. This is the test the task-4
 * brief required: proof that no stray file named `CON` appears when no
 * console is attached, using the actual shipped `ttyDevicePath()` value, not
 * a hardcoded guess of it.
 */
test(
  "sayTty/detailTty never leave a stray CON file behind when no console is attached",
  { skip: process.platform !== "win32" && "CON-device fallback only exists on native Windows; POSIX targets /dev/tty" },
  async () => {
    const scratch = mkdtempSync(join(tmpdir(), "rocky-con-stray-"));
    try {
      const testModuleRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
      const rockyUiModuleUrl = pathToFileURL(join(testModuleRoot, "ui", "rocky.js")).href;
      const worker = [
        "const [modulePath] = process.argv.slice(1);",
        "const ui = await import(modulePath);",
        "ui.sayTty('probe say');",
        "ui.detailTty('probe detail');",
      ].join("\n");
      const child = spawn(process.execPath, ["--input-type=module", "--eval", worker, rockyUiModuleUrl], {
        cwd: scratch,
        stdio: "ignore",
        windowsHide: true,
      });
      const exitCode: number | null = await new Promise((resolve, reject) => {
        child.on("exit", resolve);
        child.on("error", reject);
      });
      assert.equal(exitCode, 0, "the console-less child must exit cleanly on its own");
      assert.equal(
        existsSync(join(scratch, "CON")),
        false,
        "sayTty/detailTty must never create an ordinary file literally named CON",
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);

// --- F2 (task-a-brief): ROCKY_HOOK_SPEECH_FILE buffer/publish path --------
//
// Only rocky-hook.ps1's own spawn ever sets this env var (see the extensive
// comments in __rockySpawnDetached and prompt) -- these tests drive
// sayTty/detailTty/flushHookSpeech directly, the same functions hookFail and
// hookSuccess already call, so they need no PowerShell process at all. The
// real-host round-trip (a real detached child publishing, a real `prompt`
// reading it back) is covered separately in hook-powershell.test.ts, where a
// pipe-based harness can at least observe filesystem state even though it
// cannot observe console rendering.

test("sayTty/detailTty buffer instead of writing the console when ROCKY_HOOK_SPEECH_FILE is set", () => {
  const scratch = mkdtempSync(join(tmpdir(), "rocky-hook-speech-"));
  const speechFile = join(scratch, "speech", "one.txt");
  const saved = process.env.ROCKY_HOOK_SPEECH_FILE;
  process.env.ROCKY_HOOK_SPEECH_FILE = speechFile;
  try {
    const { tty } = captureTty(() => {
      sayTty("this error again. deep memory need stderr. run with: rocky run 'x', question");
      detailTty("place: somewhere");
      return undefined;
    });
    assert.equal(tty, "", "buffered speech must never reach the console device directly");
    assert.equal(existsSync(speechFile), false, "nothing is published until flushHookSpeech runs");

    flushHookSpeech();

    assert.equal(existsSync(speechFile), true, "flushHookSpeech must publish the buffered lines");
    const published = readFileSync(speechFile, "utf8");
    assert.match(published, /^\[Rocky\] this error again\./);
    assert.match(published, /\n {4}place: somewhere\n$/);
    const leftoverTemp = fs.readdirSync(dirname(speechFile)).filter((name) => name.includes(".tmp"));
    assert.deepEqual(leftoverTemp, [], "the temp file must be renamed away, never left behind");
  } finally {
    if (saved === undefined) delete process.env.ROCKY_HOOK_SPEECH_FILE;
    else process.env.ROCKY_HOOK_SPEECH_FILE = saved;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("flushHookSpeech is a no-op when nothing was buffered -- no empty file, no directory created", () => {
  const scratch = mkdtempSync(join(tmpdir(), "rocky-hook-speech-empty-"));
  const speechFile = join(scratch, "speech", "never-created.txt");
  const saved = process.env.ROCKY_HOOK_SPEECH_FILE;
  process.env.ROCKY_HOOK_SPEECH_FILE = speechFile;
  try {
    flushHookSpeech();
    assert.equal(existsSync(dirname(speechFile)), false, "no directory is created for a message that was never said");
    assert.equal(existsSync(speechFile), false);
  } finally {
    if (saved === undefined) delete process.env.ROCKY_HOOK_SPEECH_FILE;
    else process.env.ROCKY_HOOK_SPEECH_FILE = saved;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a line spoken while ROCKY_HOOK_SPEECH_FILE was unset never resurfaces in a later flush", () => {
  const saved = process.env.ROCKY_HOOK_SPEECH_FILE;
  delete process.env.ROCKY_HOOK_SPEECH_FILE;
  try {
    // Unset: sayTty writes straight to the tty device (captured here, not
    // buffered) -- the exact unbuffered path every other test in this file
    // above already exercises.
    const { tty } = captureTty(() => sayTty("should go straight to tty, not buffer"));
    assert.match(tty, /should go straight to tty, not buffer/, "unset env var: sayTty must still write the console device directly");

    const scratch = mkdtempSync(join(tmpdir(), "rocky-hook-speech-noleak-"));
    const speechFile = join(scratch, "speech", "should-stay-absent.txt");
    process.env.ROCKY_HOOK_SPEECH_FILE = speechFile;
    try {
      flushHookSpeech();
      assert.equal(existsSync(speechFile), false, "a line spoken before the env var was ever set must not resurface in a later flush");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  } finally {
    if (saved === undefined) delete process.env.ROCKY_HOOK_SPEECH_FILE;
    else process.env.ROCKY_HOOK_SPEECH_FILE = saved;
  }
});

test("hookFail's speech survives end to end through the buffer/publish path exactly like the direct-write path", () => {
  const scratch = mkdtempSync(join(tmpdir(), "rocky-hook-speech-e2e-"));
  const speechFile = join(scratch, "speech", "hookfail.txt");
  const isolatedHome = mkdtempSync(join(tmpdir(), "rocky-hook-speech-home-"));
  const savedHome = process.env.ROCKY_HOME;
  const savedSpeech = process.env.ROCKY_HOOK_SPEECH_FILE;
  process.env.ROCKY_HOME = isolatedHome;
  process.env.ROCKY_HOOK_SPEECH_FILE = speechFile;
  try {
    const speechCwd = mkdtempSync(join(tmpdir(), "rocky-hook-speech-cwd-"));
    const { result } = captureTty(() => {
      hookFail("speech-roundtrip-cmd", 1, speechCwd); // first occurrence: silent by design
      return hookFail("speech-roundtrip-cmd", 1, speechCwd); // second: sayTty fires
    });
    assert.equal(result, 0);
    flushHookSpeech();
    assert.equal(existsSync(speechFile), true, "hookFail's second-occurrence speech must have been buffered and published");
    assert.match(readFileSync(speechFile, "utf8"), /this error again/);
  } finally {
    if (savedHome === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = savedHome;
    if (savedSpeech === undefined) delete process.env.ROCKY_HOOK_SPEECH_FILE;
    else process.env.ROCKY_HOOK_SPEECH_FILE = savedSpeech;
    rmSync(scratch, { recursive: true, force: true });
  }
});
