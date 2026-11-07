import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { commandFingerprint } from "../core/fingerprint.js";
import { phrase, validateOutputLine } from "../ui/phrases.js";
import { detailTty, flushHookSpeech, sayTty } from "../ui/rocky.js";

const home = mkdtempSync(join(tmpdir(), "rocky-hook-"));
process.env.ROCKY_HOME = home;

const memory = await import("../core/memory.js");
const { hookFail, hookSuccess } = await import("../commands/hook.js");

/**
 * Every rocky-authored line in captured hook speech: the prefixed lines, minus
 * the prefix. Indented detail lines carry recorded data (a command, a path)
 * that may say anything, so they are never judged against the output rules.
 */
function spokenLines(tty: string): string[] {
  return tty
    .split("\n")
    .filter((line) => line.startsWith("rocky: "))
    .map((line) => line.slice("rocky: ".length));
}

function assertPlainSpeech(tty: string): void {
  const lines = spokenLines(tty);
  assert.ok(lines.length > 0, `expected at least one spoken line in ${JSON.stringify(tty)}`);
  for (const line of lines) assert.deepEqual(validateOutputLine(line), [], line);
  for (const line of tty.split("\n").filter((entry) => entry.length > 0)) {
    assert.ok(line.startsWith("rocky: ") || line.startsWith("    "), `unprefixed speech line: ${JSON.stringify(line)}`);
  }
}

function captureTty<T>(fn: () => T): { result: T; tty: string } {
  const scratch = mkdtempSync(join(tmpdir(), "rocky-capture-speech-"));
  const speechFile = join(scratch, "speech.txt");
  const previous = process.env.ROCKY_HOOK_SPEECH_FILE;
  process.env.ROCKY_HOOK_SPEECH_FILE = speechFile;
  try {
    const result = fn();
    flushHookSpeech();
    const tty = existsSync(speechFile) ? readFileSync(speechFile, "utf8") : "";
    return { result, tty };
  } finally {
    if (previous === undefined) delete process.env.ROCKY_HOOK_SPEECH_FILE;
    else process.env.ROCKY_HOOK_SPEECH_FILE = previous;
    rmSync(scratch, { recursive: true, force: true });
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

const LINK_LINE = `rocky: ${phrase("fix-linked")}\n`;
const RECURRENCE_SAME_LINE = `rocky: ${phrase("fix-recurrence-same")}\n`;

test("hookSuccess states what was recorded, then names the command the late line is about", () => {
  process.env.ROCKY_HOME = mkdtempSync(join(tmpdir(), "rocky-hook-link-voice-"));
  const linkCwd = mkdtempSync(join(tmpdir(), "rocky-hook-link-voice-cwd-"));
  try {
    assert.equal(hookFail("node hello.js", 1, linkCwd), 0);
    const { result, tty } = captureTty(() => hookSuccess("node hello.js", linkCwd));
    assert.equal(result, 0);
    assert.equal(tty, `${LINK_LINE}    command: node hello.js\n`);
    assert.doesNotMatch(tty, /\bfixed\b|you fixed it|remember(s|ed)? the fix|something between/i);
    assertPlainSpeech(tty);
  } finally {
    process.env.ROCKY_HOME = home;
  }
});

test("hookSuccess names the linked command through boundCommand, never the raw argument", () => {
  const isolatedHome = mkdtempSync(join(tmpdir(), "rocky-hook-link-bound-"));
  const linkCwd = mkdtempSync(join(tmpdir(), "rocky-hook-link-bound-cwd-"));
  // Built at runtime so no token-shaped literal sits in this source file.
  const token = `ghp_${"A1b2".repeat(9)}`;
  const cmd = `node deploy.js --token ${token}`;
  // This stored failure still holds the raw command, as an imported or
  // hand-written record can, so it links on that text. Only the printed line
  // can keep the secret off the terminal.
  const failure = {
    kind: "failure", id: "link-bound-failure", ts: Date.now() - 1000, cwd: linkCwd, cmd,
    exitCode: 1, fingerprint: commandFingerprint(cmd, 1), fingerprintV: 2, signature: [cmd], excerpt: "exit 1", origin: "hook",
  };
  writeFileSync(join(isolatedHome, "memory.jsonl"), `${JSON.stringify(failure)}\n`, "utf8");
  process.env.ROCKY_HOME = isolatedHome;
  try {
    const { result, tty } = captureTty(() => hookSuccess(cmd, linkCwd));
    assert.equal(result, 0);
    assert.equal(tty, `${LINK_LINE}    command: node deploy.js --token [redacted github token]\n`);
    assert.equal(tty.includes(token), false, "the raw secret must never reach the terminal");
  } finally {
    process.env.ROCKY_HOME = home;
  }
});

test("hookSuccess says nothing, not even the command, when no failure links", () => {
  process.env.ROCKY_HOME = mkdtempSync(join(tmpdir(), "rocky-hook-link-silent-"));
  try {
    const { result, tty } = captureTty(() => hookSuccess("node nothing-failed-before.js", cwd));
    assert.equal(result, 0);
    assert.equal(tty, "");
  } finally {
    process.env.ROCKY_HOME = home;
  }
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

const { isTypoSymptom } = await import("../commands/hook.js");

test("exit 127 is a typo symptom on every host", () => {
  assert.equal(isTypoSymptom("gti status", 127), true);
  assert.equal(isTypoSymptom("npm run build", 127), true);
});

test("a PATH-invisible command failing is not a typo symptom", () => {
  // Cmdlets, shell functions, and aliases never appear on PATH. Guessing
  // from PATH classified `Get-Item` as a typo and silenced a real hint;
  // the exit code is the only signal that actually knows.
  assert.equal(isTypoSymptom("Get-Item ./x -ErrorAction SilentlyContinue", 1), false);
  assert.equal(isTypoSymptom("ll /nonexistent", 1), false);
  assert.equal(isTypoSymptom("if false; then :; fi", 1), false);
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
    assert.ok(tty.includes(RECURRENCE_SAME_LINE), tty);
    assert.match(tty, /But that fix comes from a different directory\./);
    assert.match(tty, new RegExp(`place: ${fixCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.doesNotMatch(tty, /strong\.|confirmed/);
    assertPlainSpeech(tty);
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
    assert.match(tty, /But that fix comes from a different directory\./);
    assert.match(tty, new RegExp(`place: ${fixCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(tty, /Possible only\. Check before acting\./);
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
    assert.doesNotMatch(tty, /different directory/);
    assert.doesNotMatch(tty, /place:/);
    // sanity: the base fix line still speaks, proving the comparison — not
    // the whole fix branch — is what's being suppressed here.
    assert.ok(tty.includes(RECURRENCE_SAME_LINE), tty);
  } finally {
    process.env.ROCKY_HOME = home;
  }
});

/**
 * One Windows directory, two spellings: the Git Bash hook reports the
 * MSYS-converted `C:/...` where `rocky run` and the PowerShell hook report
 * `C:\...`. Equality widens for exactly that on win32 and nowhere else, so
 * the POSIX twin below proves a differing spelling never links there.
 */
const GIT_BASH_ONLY = { skip: process.platform !== "win32" && "the Git Bash spelling only exists on native Windows" };

test("a Git Bash hook failure and a rocky run success in the same directory link", GIT_BASH_ONLY, () => {
  process.env.ROCKY_HOME = mkdtempSync(join(tmpdir(), "rocky-hook-spelling-"));
  try {
    assert.equal(hookFail("node fail.js", 1, process.cwd().replaceAll("\\", "/")), 0);
    const result = memory.resolveFixOnSuccess("node fail.js", process.cwd());
    assert.equal(result.confirmedResolved, 1);
  } finally {
    process.env.ROCKY_HOME = home;
  }
});

test("hookSuccess says the command passes now when the failure was recorded under the Git Bash spelling", GIT_BASH_ONLY, () => {
  process.env.ROCKY_HOME = mkdtempSync(join(tmpdir(), "rocky-hook-spelling-works-"));
  try {
    hookFail("node fail.js", 1, process.cwd().replaceAll("\\", "/"));
    const { result, tty } = captureTty(() => hookSuccess("node fail.js", process.cwd()));
    assert.equal(result, 0);
    assert.ok(tty.includes(LINK_LINE), tty);
  } finally {
    process.env.ROCKY_HOME = home;
  }
});

test("hookFail does not call a same-directory fix 'a different directory' because it was recorded under another spelling", () => {
  const gitBash = "C:/Users/x/p";
  const native = "C:\\Users\\x\\p";
  seedElsewhereFix(gitBash, native, "spelling-test-cmd", 1);
  try {
    const { result, tty } = captureTty(() => hookFail("spelling-test-cmd", 1, gitBash));
    assert.equal(result, 0);
    // sanity: the base fix line speaks either way, so only the elsewhere
    // admission can differ between win32 (same directory) and POSIX (two).
    assert.ok(tty.includes(RECURRENCE_SAME_LINE), tty);
    assert.equal(/different directory/.test(tty), process.platform !== "win32");
  } finally {
    process.env.ROCKY_HOME = home;
  }
});

test(
  "on POSIX a differing spelling of the working directory stays a different directory and never links",
  { skip: process.platform === "win32" && "win32 widens this spelling on purpose; the twin test above covers it" },
  () => {
    process.env.ROCKY_HOME = mkdtempSync(join(tmpdir(), "rocky-hook-spelling-posix-"));
    try {
      assert.equal(hookFail("node fail.js", 1, `${process.cwd()}/`), 0);
      const result = memory.resolveFixOnSuccess("node fail.js", process.cwd());
      assert.equal(result.confirmedResolved, 0);
    } finally {
      process.env.ROCKY_HOME = home;
    }
  },
);

/**
 * The recurrence match in `hookFail` is a coarse, masked fingerprint on
 * `cmd` alone (no stderr reaches a detached hook handler) — `normalizeLine`
 * masks a plain non-semantic number to `#`, so "cat file123.txt" and
 * "cat file456.txt" (same exit code) fingerprint-collide while their
 * `commandIdentity` values stay genuinely distinct (different literal
 * filename token). This is the reachable case task 17b's reachability
 * check was asked to confirm: a confirmed `FixRecord` found through this
 * match can carry a `cmd` whose identity differs from the currently
 * failing command, so `hookFail` must not present it as "you fix with:".
 */
test("hookFail admits a fingerprint-matched fix may be a different command, not the fix", () => {
  const isolatedHome = mkdtempSync(join(tmpdir(), "rocky-diffcmd-"));
  const diffCwd = mkdtempSync(join(tmpdir(), "rocky-diffcmd-cwd-"));
  const seededCmd = "cat file123.txt";
  const currentCmd = "cat file456.txt";
  const seededFingerprint = commandFingerprint(seededCmd, 1);
  const failure = {
    kind: "failure", id: "diff-cmd-failure", ts: Date.now() - 1000, cwd: diffCwd,
    cmd: seededCmd, exitCode: 1, fingerprint: seededFingerprint, fingerprintV: 2,
    signature: [seededCmd], excerpt: "exit 1", origin: "hook",
    resolvedBy: "diff-cmd-fix",
  };
  const fix = {
    kind: "fix", id: "diff-cmd-fix", ts: Date.now(), cwd: diffCwd,
    cmd: seededCmd, failureIds: ["diff-cmd-failure"],
  };
  writeFileSync(
    join(isolatedHome, "memory.jsonl"),
    `${JSON.stringify(failure)}\n${JSON.stringify(fix)}\n`,
    "utf8",
  );
  process.env.ROCKY_HOME = isolatedHome;
  try {
    // Sanity: the two commands really do collide at the coarse fingerprint
    // Rocky's hook path uses (proves the test exercises the intended gap
    // instead of a same-command match by coincidence).
    assert.equal(commandFingerprint(currentCmd, 1), seededFingerprint);

    const { result, tty } = captureTty(() => hookFail(currentCmd, 1, diffCwd));
    assert.equal(result, 0);
    assert.doesNotMatch(tty, /you fix with/);
    assert.match(tty, /Last time, you ran:/);
    assert.match(tty, new RegExp(seededCmd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(tty, /Possible fix only\./);
    assert.match(tty, /Try that command\?/);
    assertPlainSpeech(tty);
  } finally {
    process.env.ROCKY_HOME = home;
  }
});

test("the elsewhere-admission lines follow the output rules", () => {
  assert.deepEqual(validateOutputLine("But that fix comes from a different directory."), []);
  assert.deepEqual(validateOutputLine("Possible only. Check before acting."), []);
});

test("hookFail speaks the full-record hint with the quoted command last, and plainly", () => {
  const isolatedHome = mkdtempSync(join(tmpdir(), "rocky-hook-hint-"));
  const hintCwd = mkdtempSync(join(tmpdir(), "rocky-hook-hint-cwd-"));
  process.env.ROCKY_HOME = isolatedHome;
  try {
    const failure = {
      kind: "failure", id: "hint-failure", ts: Date.now() - 1000, cwd: hintCwd, cmd: "hint-test-cmd",
      exitCode: 1, fingerprint: commandFingerprint("hint-test-cmd", 1), fingerprintV: 2,
      signature: ["hint-test-cmd"], excerpt: "exit 1", origin: "hook",
    };
    writeFileSync(join(isolatedHome, "memory.jsonl"), `${JSON.stringify(failure)}\n`, "utf8");
    const { result, tty } = captureTty(() => hookFail("hint-test-cmd", 1, hintCwd));
    assert.equal(result, 0);
    assert.equal(
      tty,
      "rocky: Same error again. The hook captures only the command, not stderr. To capture stderr too, run: rocky run 'hint-test-cmd'\n",
    );
    assertPlainSpeech(tty);
  } finally {
    process.env.ROCKY_HOME = home;
  }
});

test("hookFail says when memory cannot be read or written, plainly, and still exits 0", () => {
  const brokenHome = mkdtempSync(join(tmpdir(), "rocky-hook-broken-memory-"));
  const brokenCwd = mkdtempSync(join(tmpdir(), "rocky-hook-broken-memory-cwd-"));
  // A directory where the memory file belongs: it opens as neither a readable
  // nor a writable file, on every platform. The bounded reader reports that as
  // incomplete coverage instead of throwing.
  mkdirSync(join(brokenHome, "memory.jsonl"));
  process.env.ROCKY_HOME = brokenHome;
  try {
    const { result, tty } = captureTty(() => hookFail("broken-memory-cmd", 1, brokenCwd));
    assert.equal(result, 0);
    assert.match(tty, /^rocky: Memory coverage is incomplete, so no prior fix is claimed\. Check the details below\.$/m);
    assert.match(tty, /^rocky: The memory file could not be written\. This event was not recorded\.$/m);
    assert.match(tty, /^ {4}memory: .*memory\.jsonl$/m);
    assertPlainSpeech(tty);
  } finally {
    process.env.ROCKY_HOME = home;
  }
});

test("the memory-open failure line, which only a defensive catch can reach, follows the output rules", () => {
  // `loadMemoryChecked` folds every read failure into incomplete coverage, so
  // no real file state throws into `readMemory`'s catch. The sentence is pinned
  // from the shipped source instead of left unchecked.
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "commands", "hook.ts"), "utf8");
  const line = /sayTty\("(The memory file could not be opened[^"]*)"\)/.exec(source)?.[1];
  assert.equal(line, "The memory file could not be opened, so nothing is recalled.");
  assert.deepEqual(validateOutputLine(line!), []);
});

const RUNNING_AS_ROOT = { skip: process.getuid?.() === 0 && "root bypasses file mode; a read-only memory file cannot be exercised" };

test("hookFail says when only the write fails, naming the memory file", RUNNING_AS_ROOT, () => {
  const readOnlyHome = mkdtempSync(join(tmpdir(), "rocky-hook-readonly-memory-"));
  const readOnlyCwd = mkdtempSync(join(tmpdir(), "rocky-hook-readonly-memory-cwd-"));
  const memoryPath = join(readOnlyHome, "memory.jsonl");
  writeFileSync(memoryPath, "", "utf8");
  chmodSync(memoryPath, 0o444);
  process.env.ROCKY_HOME = readOnlyHome;
  try {
    const { result, tty } = captureTty(() => hookFail("readonly-memory-cmd", 1, readOnlyCwd));
    assert.equal(result, 0);
    assert.equal(
      tty,
      `rocky: The memory file could not be written. This event was not recorded.\n    memory: ${memoryPath}\n`,
    );
    assertPlainSpeech(tty);
  } finally {
    process.env.ROCKY_HOME = home;
    chmodSync(memoryPath, 0o644);
  }
});

test("hookFail discloses incomplete memory coverage without claiming a prior fix", () => {
  const partialHome = mkdtempSync(join(tmpdir(), "rocky-hook-partial-memory-"));
  const partialCwd = mkdtempSync(join(tmpdir(), "rocky-hook-partial-memory-cwd-"));
  // One unparseable line makes the bounded reader skip a record, which is
  // exactly the incomplete coverage the hook must disclose.
  writeFileSync(join(partialHome, "memory.jsonl"), "this line is not json\n", "utf8");
  process.env.ROCKY_HOME = partialHome;
  try {
    const { result, tty } = captureTty(() => hookFail("partial-memory-cmd", 1, partialCwd));
    assert.equal(result, 0);
    assert.match(tty, /^rocky: Memory coverage is incomplete, so no prior fix is claimed\. Check the details below\.$/m);
    assert.match(tty, /^ {4}\S/m, "a detail line follows the notice");
    assert.doesNotMatch(tty, /Same error|Last time, you ran/);
    assertPlainSpeech(tty);
  } finally {
    process.env.ROCKY_HOME = home;
  }
});

test("hookSuccess says when the fix link cannot be written, plainly, and still exits 0", RUNNING_AS_ROOT, () => {
  const readOnlyHome = mkdtempSync(join(tmpdir(), "rocky-hook-readonly-success-"));
  const readOnlyCwd = mkdtempSync(join(tmpdir(), "rocky-hook-readonly-success-cwd-"));
  const memoryPath = join(readOnlyHome, "memory.jsonl");
  process.env.ROCKY_HOME = readOnlyHome;
  try {
    // A recorded failure plus the pending flag it sets: the next pass has a
    // fix to link, and the write that would record the link is the one that fails.
    assert.equal(hookFail("readonly-success-cmd", 1, readOnlyCwd), 0);
    chmodSync(memoryPath, 0o444);
    const { result, tty } = captureTty(() => hookSuccess("readonly-success-cmd", readOnlyCwd));
    assert.equal(result, 0);
    assert.equal(
      tty,
      `rocky: The memory file could not be written. This event was not recorded.\n    memory: ${memoryPath}\n`,
    );
    assertPlainSpeech(tty);
  } finally {
    process.env.ROCKY_HOME = home;
    chmodSync(memoryPath, 0o644);
  }
});

/**
 * Real (uninstrumented) `sayTty`/`detailTty`, run in a genuinely console-less
 * child process — `stdio: "ignore"` plus `windowsHide: true` reproduces the
 * no-window, no-console shape this codebase already uses for its other
 * detached spawns (see `core/notify.ts`), and is the same shape used to
 * empirically settle the `CON` question. This test proves that no stray file
 * named `CON` appears when no console is attached, using the actual shipped
 * `ttyDevicePath()` value, not a hardcoded guess of it.
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

// --- ROCKY_HOOK_SPEECH_FILE buffer/publish path --------
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
    sayTty("Same error again. The hook captures only the command, not stderr. To capture stderr too, run: rocky run 'x'");
    detailTty("place: somewhere");
    assert.equal(existsSync(speechFile), false, "nothing is published until flushHookSpeech runs");

    flushHookSpeech();

    assert.equal(existsSync(speechFile), true, "flushHookSpeech must publish the buffered lines");
    const published = readFileSync(speechFile, "utf8");
    assert.match(published, /^rocky: Same error again\./);
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
    sayTty("should not buffer");
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
  const speechBin = mkdtempSync(join(tmpdir(), "rocky-hook-speech-bin-"));
  const exe = process.platform === "win32" ? "speech-roundtrip-cmd.cmd" : "speech-roundtrip-cmd";
  writeFileSync(join(speechBin, exe), "");
  if (process.platform !== "win32") chmodSync(join(speechBin, exe), 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = speechBin;
  try {
    const speechCwd = mkdtempSync(join(tmpdir(), "rocky-hook-speech-cwd-"));
    hookFail("speech-roundtrip-cmd", 1, speechCwd); // first occurrence: silent by design
    const result = hookFail("speech-roundtrip-cmd", 1, speechCwd); // second: sayTty fires
    assert.equal(result, 0);
    flushHookSpeech();
    assert.equal(existsSync(speechFile), true, "hookFail's second-occurrence speech must have been buffered and published");
    assert.match(readFileSync(speechFile, "utf8"), /Same error again/);
  } finally {
    if (savedHome === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = savedHome;
    if (savedSpeech === undefined) delete process.env.ROCKY_HOOK_SPEECH_FILE;
    else process.env.ROCKY_HOOK_SPEECH_FILE = savedSpeech;
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    rmSync(speechBin, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

const { ROCKY_HOOK_PROTOCOL_VERSION } = await import("../commands/hook.js");

test("both hook assets carry the protocol version the code expects", () => {
  const shellDir = join(dirname(fileURLToPath(import.meta.url)), "../shell");
  for (const asset of ["rocky-hook.bash", "rocky-hook.ps1"]) {
    const source = readFileSync(join(shellDir, asset), "utf8");
    const found = /ROCKY_HOOK_VERSION="([^"]+)"/.exec(source)?.[1];
    assert.equal(found, ROCKY_HOOK_PROTOCOL_VERSION, asset);
  }
});

const { hookStaleLine } = await import("../commands/hook.js");

test("a matching hook version produces no stale line", () => {
  assert.equal(hookStaleLine(ROCKY_HOOK_PROTOCOL_VERSION), undefined);
});

test("a differing hook version names the reinstall command", () => {
  const line = hookStaleLine("0.3.0");
  assert.ok(line !== undefined);
  assert.match(line, /rocky hook install/);
  assert.deepEqual(validateOutputLine(line), []);
});

test("a missing or unreadable hook version produces no stale line", () => {
  // "missing" and "unknown" are already reported by the version line itself;
  // a second line about reinstalling would be noise on top of noise.
  assert.equal(hookStaleLine("missing"), undefined);
  assert.equal(hookStaleLine("unknown"), undefined);
});
