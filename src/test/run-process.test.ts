import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { commandFingerprint } from "../core/fingerprint.js";
import { cmdExeHint, run, speakFailureMemory } from "../commands/run.js";
import type { ExecResult } from "../core/exec.js";
import { phraseKeys, validateOutputLine } from "../ui/phrases.js";

const packageRoot = process.cwd();
const cli = join(packageRoot, "dist", "index.js");

function fakeExecResult(started: boolean, code: number): ExecResult {
  return { started, code, stderr: "spawn ENOENT", tail: ["spawn ENOENT"], durationMs: 5 };
}

const STRONG_LINK = /Strong link/;
const SAME_COMMAND_PASSED = /Last time, the same command passed again afterward\. The change itself was not recorded\./;
const MAY_OR_MAY_NOT_BE_A_FIX = /It may or may not be a fix\. Check before acting\./;
const NO_CONFIRMED_FIX = /No confirmed fix\. After that error, you ran:/;

/** Every line rocky itself wrote (the `rocky: ` ones) must follow the output rules; detail lines are data. */
function assertRockyLinesArePlain(output: string): void {
  const lines = output.split(/\r?\n/).filter((line) => line.startsWith("rocky: "));
  assert.ok(lines.length > 0, `expected at least one rocky line in: ${output}`);
  for (const line of lines) assert.deepEqual(validateOutputLine(line.slice("rocky: ".length)), [], line);
}

test("run does not record a spawn-not-started result", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "rocky-run-not-started-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const original = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  try {
    const result = await run("synthetic-not-started", async () => fakeExecResult(false, 127));
    assert.equal(result, 127);
    assert.equal(existsSync(join(home, "memory.jsonl")), false);
  } finally {
    if (original === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = original;
  }
});

test("run records a started child that exits 127", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "rocky-run-started-127-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const original = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  try {
    const result = await run("synthetic-started-127", async () => fakeExecResult(true, 127));
    assert.equal(result, 127);
    const records = readFileSync(join(home, "memory.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as { kind: string; exitCode?: number });
    assert.equal(records.length, 1);
    assert.equal(records[0]?.kind, "failure");
    assert.equal(records[0]?.exitCode, 127);
  } finally {
    if (original === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = original;
  }
});

test("run speech discloses cross-directory fix as possible, never strong", () => {
  const failureCwd = join(tmpdir(), "rocky-run-failure");
  const fixCwd = join(tmpdir(), "rocky-run-fix");
  const cmd = "node stable-command.js";
  const failure = {
    kind: "failure" as const, id: "run-cross-failure", ts: Date.now() - 1_000, cwd: failureCwd, cmd,
    exitCode: 1, fingerprint: "run-cross-fingerprint", signature: ["failure"], excerpt: "failure",
    commandIdentity: JSON.stringify(["node", "stable-command.js"]), identityV: 1 as const,
    identityReliable: true, platform: process.platform,
  };
  const fix = {
    kind: "fix" as const, id: "run-cross-fix", ts: Date.now(), cwd: fixCwd, cmd,
    failureIds: [failure.id], links: [{ id: failure.id, basis: "identity" as const, confidence: "confirmed" as const }],
  };
  const original = process.stderr.write;
  let output = "";
  process.stderr.write = ((chunk: string | Uint8Array) => { output += String(chunk); return true; }) as typeof process.stderr.write;
  try {
    // Invocation happens where the fix was learned, but the linked failure
    // came from another cwd; source disclosure must follow the failure.
    speakFailureMemory([failure, fix], failure.fingerprint, cmd, 1, fixCwd);
  } finally {
    process.stderr.write = original;
  }
  assert.match(output, /place:/);
  assert.match(output, /But that fix comes from a different directory\./);
  assert.match(output, /Possible only\. Check before acting\./);
  assert.doesNotMatch(output, STRONG_LINK);
  assert.match(output, new RegExp(fixCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(commandFingerprint(cmd, 1).length > 0, true);
  assertRockyLinesArePlain(output);
});

test("run speech ignores a future failure at the captured clock", () => {
  const now = Date.now();
  const future = {
    kind: "failure" as const, id: "run-future-failure", ts: now + 60_000, cwd: "/work/future", cmd: "node future.js",
    exitCode: 1, fingerprint: "run-future-fingerprint", signature: ["future-only"], excerpt: "future-only",
  };
  const original = process.stderr.write;
  let output = "";
  process.stderr.write = ((chunk: string | Uint8Array) => { output += String(chunk); return true; }) as typeof process.stderr.write;
  try {
    speakFailureMemory([future], future.fingerprint, future.cmd, 1, future.cwd, now);
  } finally {
    process.stderr.write = original;
  }
  assert.doesNotMatch(output, /Last time, you ran:|Same error as before|future\.js|future-only/);
  assert.match(output, /New error recorded \(exit code 1\)\./);
  assertRockyLinesArePlain(output);
});

test("run speech shows the top weak association candidate instead of the old no-fix text", () => {
  const cwd = join(tmpdir(), "rocky-run-possible");
  const cmd = "npm run broken-alpha";
  const now = 1_800_000_000_000;
  const failure = {
    kind: "failure" as const, id: "run-possible-failure", ts: now - 2_000, cwd, cmd,
    exitCode: 67, fingerprint: "run-possible-fingerprint", signature: ["synthetic failure"], excerpt: "synthetic failure",
  };
  const association = {
    kind: "association" as const, id: "run-possible-association", ts: now - 1_000, cwd, cmd: "npm run unrelated-beta",
    candidateFailureIds: [failure.id], links: [{ id: failure.id, basis: "program" as const, confidence: "possible" as const }],
  };
  const original = process.stderr.write;
  let output = "";
  process.stderr.write = ((chunk: string | Uint8Array) => { output += String(chunk); return true; }) as typeof process.stderr.write;
  try {
    speakFailureMemory([failure, association], failure.fingerprint, cmd, 67, cwd, now);
  } finally {
    process.stderr.write = original;
  }
  assert.match(output, NO_CONFIRMED_FIX);
  assert.match(output, /npm run unrelated-beta/);
  assert.match(output, MAY_OR_MAY_NOT_BE_A_FIX);
  assert.doesNotMatch(output, /No fix recorded yet/);
  assertRockyLinesArePlain(output);
});

test("run speech keeps the plain no-fix line, byte for byte, when no association exists", () => {
  const cwd = join(tmpdir(), "rocky-run-no-possible");
  const cmd = "npm run broken-alpha";
  const now = 1_800_000_000_000;
  const failure = {
    kind: "failure" as const, id: "run-no-possible-failure", ts: now - 1_000, cwd, cmd,
    exitCode: 67, fingerprint: "run-no-possible-fingerprint", signature: ["synthetic failure"], excerpt: "synthetic failure",
  };
  const original = process.stderr.write;
  let output = "";
  process.stderr.write = ((chunk: string | Uint8Array) => { output += String(chunk); return true; }) as typeof process.stderr.write;
  try {
    speakFailureMemory([failure], failure.fingerprint, cmd, 67, cwd, now);
  } finally {
    process.stderr.write = original;
  }
  assert.ok(output.includes("No fix recorded yet."));
  assert.doesNotMatch(output, NO_CONFIRMED_FIX);
  assertRockyLinesArePlain(output);
});

test("run speech never overrides or duplicates a confirmed fix with an association", () => {
  const cwd = join(tmpdir(), "rocky-run-confirmed-and-possible");
  const cmd = "node stable-command.js";
  const now = 1_800_000_000_000;
  const failure = {
    kind: "failure" as const, id: "run-confirmed-failure", ts: now - 3_000, cwd, cmd,
    exitCode: 1, fingerprint: "run-confirmed-fingerprint", signature: ["failure"], excerpt: "failure",
    resolvedBy: "run-confirmed-fix",
  };
  const fix = {
    kind: "fix" as const, id: "run-confirmed-fix", ts: now - 1_000, cwd, cmd,
    failureIds: [failure.id], links: [{ id: failure.id, basis: "identity" as const, confidence: "confirmed" as const }],
  };
  const association = {
    kind: "association" as const, id: "run-confirmed-association", ts: now - 2_000, cwd, cmd: "npm run should-not-appear",
    candidateFailureIds: [failure.id], links: [{ id: failure.id, basis: "program" as const, confidence: "possible" as const }],
  };
  const original = process.stderr.write;
  let output = "";
  process.stderr.write = ((chunk: string | Uint8Array) => { output += String(chunk); return true; }) as typeof process.stderr.write;
  try {
    speakFailureMemory([failure, fix, association], failure.fingerprint, cmd, 1, cwd, now);
  } finally {
    process.stderr.write = original;
  }
  assert.match(output, SAME_COMMAND_PASSED);
  assert.match(output, /Same command, under 1 minute later\. Strong link\./);
  assert.doesNotMatch(output, /something between|just now later/);
  assert.doesNotMatch(output, NO_CONFIRMED_FIX);
  assert.doesNotMatch(output, /should-not-appear/);
  assertRockyLinesArePlain(output);
});

test("run speech marks a cross-cwd association candidate with a place line and stays weak", () => {
  const failureCwd = join(tmpdir(), "rocky-run-possible-elsewhere-failure");
  const associationCwd = join(tmpdir(), "rocky-run-possible-elsewhere-association");
  const cmd = "npm run broken-alpha";
  const now = 1_800_000_000_000;
  const failure = {
    kind: "failure" as const, id: "run-elsewhere-failure", ts: now - 2_000, cwd: failureCwd, cmd,
    exitCode: 67, fingerprint: "run-elsewhere-fingerprint", signature: ["synthetic failure"], excerpt: "synthetic failure",
  };
  const association = {
    kind: "association" as const, id: "run-elsewhere-association", ts: now - 1_000, cwd: associationCwd, cmd: "npm run unrelated-beta",
    candidateFailureIds: [failure.id], links: [{ id: failure.id, basis: "program" as const, confidence: "possible" as const }],
  };
  const original = process.stderr.write;
  let output = "";
  process.stderr.write = ((chunk: string | Uint8Array) => { output += String(chunk); return true; }) as typeof process.stderr.write;
  try {
    speakFailureMemory([failure, association], failure.fingerprint, cmd, 67, failureCwd, now);
  } finally {
    process.stderr.write = original;
  }
  assert.match(output, /But that command comes from a different directory\./);
  assert.match(output, new RegExp(associationCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(output, MAY_OR_MAY_NOT_BE_A_FIX);
  assert.doesNotMatch(output, STRONG_LINK);
  assertRockyLinesArePlain(output);
});

test("run speech grades an unrecognized FixRecord link basis as the weakest hedge, never silent", () => {
  const cwd = join(tmpdir(), "rocky-run-unrecognized-basis");
  const cmd = "node stable-command.js";
  const now = 1_800_000_000_000;
  const failure = {
    kind: "failure" as const, id: "run-unrecognized-failure", ts: now - 3_000, cwd, cmd,
    exitCode: 1, fingerprint: "run-unrecognized-fingerprint", signature: ["failure"], excerpt: "failure",
    resolvedBy: "run-unrecognized-fix",
  };
  const fix = {
    kind: "fix" as const, id: "run-unrecognized-fix", ts: now - 1_000, cwd, cmd,
    failureIds: [failure.id],
    links: [{ id: failure.id, basis: "future-basis-v2", confidence: "possible" as const }],
  };
  const original = process.stderr.write;
  let output = "";
  process.stderr.write = ((chunk: string | Uint8Array) => { output += String(chunk); return true; }) as typeof process.stderr.write;
  try {
    speakFailureMemory([failure, fix], failure.fingerprint, cmd, 1, cwd, now);
  } finally {
    process.stderr.write = original;
  }
  assert.match(output, SAME_COMMAND_PASSED);
  assert.match(output, /Different program, under 1 minute later\. May not be the fix\. Check before acting\./);
  assert.doesNotMatch(output, STRONG_LINK);
  assert.doesNotMatch(output, /Same program,/);
  assertRockyLinesArePlain(output);
});

test("run speech grades a same-program link with the gap it recorded, never 'just now'", () => {
  const cwd = join(tmpdir(), "rocky-run-same-program-gap");
  const cmd = "node stable-command.js";
  const now = 1_800_000_000_000;
  const failure = {
    kind: "failure" as const, id: "run-gap-failure", ts: now - 3 * 60_000, cwd, cmd,
    exitCode: 1, fingerprint: "run-gap-fingerprint", signature: ["failure"], excerpt: "failure",
    resolvedBy: "run-gap-fix",
  };
  const speak = (fixGapMs: number): string => {
    const fix = {
      kind: "fix" as const, id: "run-gap-fix", ts: failure.ts + fixGapMs, cwd, cmd,
      failureIds: [failure.id], links: [{ id: failure.id, basis: "program" as const, confidence: "possible" as const }],
    };
    const original = process.stderr.write;
    let output = "";
    process.stderr.write = ((chunk: string | Uint8Array) => { output += String(chunk); return true; }) as typeof process.stderr.write;
    try {
      speakFailureMemory([failure, fix], failure.fingerprint, cmd, 1, cwd, now);
    } finally {
      process.stderr.write = original;
    }
    return output;
  };

  const underAMinute = speak(40_000);
  assert.match(underAMinute, /Same program, under 1 minute later\. May not be the fix\. Check before acting\./);
  assert.doesNotMatch(underAMinute, /just now later|Strong link/);
  assert.match(speak(2 * 60_000), /Same program, 2 minutes later\. May not be the fix\. Check before acting\./);
  assertRockyLinesArePlain(underAMinute);
});

/**
 * `fingerprint()` hashes stderr signature lines alone once stderr has any
 * (`cmd` only enters the hash as a fallback for empty-signature failures)
 * — so this match is genuinely cmd-independent, wider than `hookFail`'s
 * masked-cmd fingerprint gap. Two unrelated commands sharing an error shape
 * fingerprint-collide here while their `commandIdentity` stays distinct,
 * so a confirmed fix found through this match can carry a `cmd` whose
 * identity differs from the currently failing command.
 */
test("run speech admits a stderr-matched fix may be a different command, not the fix", () => {
  const cwd = join(tmpdir(), "rocky-run-diffcmd");
  const now = 1_800_000_000_000;
  const seededCmd = "cargo build --release";
  const currentCmd = "npm test";
  const sharedFingerprint = "run-diffcmd-fingerprint";
  const failure = {
    kind: "failure" as const, id: "run-diffcmd-failure", ts: now - 3_000, cwd, cmd: seededCmd,
    exitCode: 1, fingerprint: sharedFingerprint, signature: ["failure"], excerpt: "failure",
    resolvedBy: "run-diffcmd-fix",
  };
  const fix = {
    kind: "fix" as const, id: "run-diffcmd-fix", ts: now - 1_000, cwd, cmd: seededCmd,
    failureIds: [failure.id], links: [{ id: failure.id, basis: "identity" as const, confidence: "confirmed" as const }],
  };
  const original = process.stderr.write;
  let output = "";
  process.stderr.write = ((chunk: string | Uint8Array) => { output += String(chunk); return true; }) as typeof process.stderr.write;
  try {
    speakFailureMemory([failure, fix], sharedFingerprint, currentCmd, 1, cwd, now);
  } finally {
    process.stderr.write = original;
  }
  assert.doesNotMatch(output, /you fix with/);
  assert.match(output, /Last time, you ran:/);
  assert.match(output, new RegExp(seededCmd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(output, /Possible fix only\./);
  assert.match(output, /Try that command\?/);
  assertRockyLinesArePlain(output);
});

test("unrelated successful npm task is not suggested as confirmed fix", (t) => {
  const home = mkdtempSync(join(tmpdir(), "rocky-causal-fix-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  // npm's update notice goes to stderr, which this test inspects line by line.
  const env = { ...process.env, ROCKY_HOME: home, NPM_CONFIG_UPDATE_NOTIFIER: "false" };
  const project = join(home, "synthetic-project");
  mkdirSync(project);
  writeFileSync(join(project, "package.json"), JSON.stringify({
    private: true,
    scripts: {
      "broken-alpha": "node -e \"process.stderr.write('synthetic causal failure\\\\n');process.exit(67)\"",
      "unrelated-beta": "node -e \"process.exit(0)\"",
    },
  }), "utf8");

  const first = spawnSync(process.execPath, [cli, "run", "npm run broken-alpha"], { cwd: project, env, encoding: "utf8" });
  assert.equal(first.status, 67);
  const success = spawnSync(process.execPath, [cli, "run", "npm run unrelated-beta"], { cwd: project, env, encoding: "utf8" });
  assert.equal(success.status, 0);
  // A same-program association is only possible, never resolution: the link
  // line is gated on a confirmed resolution, so a possible-only success stays silent.
  assert.doesNotMatch(success.stderr, /^rocky: /m, success.stderr);
  const second = spawnSync(process.execPath, [cli, "run", "npm run broken-alpha"], { cwd: project, env, encoding: "utf8" });
  assert.equal(second.status, 67);
  assert.doesNotMatch(second.stderr, /Last time, you ran:|last time, you fix with:/);
  // v0.5.2 Fix 1: this same-cwd, same-base association is exactly the
  // legitimate weak candidate spec T1 describes ("user sees `No fix recorded
  // yet` although memory holds a candidate"). The original assertion
  // here (`doesNotMatch(second.stderr, /unrelated-beta/)`) encoded that
  // pre-fix bug — hiding a candidate memory actually holds — rather than a
  // real requirement, so it is replaced with the intended weak-candidate
  // display instead of being preserved unchanged.
  assert.match(second.stderr, NO_CONFIRMED_FIX);
  assert.match(second.stderr, /unrelated-beta/);
  assert.match(second.stderr, MAY_OR_MAY_NOT_BE_A_FIX);
  assert.doesNotMatch(second.stderr, /No fix recorded yet/);

  const lines = readFileSync(join(home, "memory.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.some((record) => record.kind === "fix"), false);
  const association = lines.find((record) => record.kind === "association");
  assert.deepEqual(association.candidateFailureIds.length, 1);
  assert.equal(existsSync(join(home, "pending")), true, "possible association must not clear pending");

  const stats = spawnSync(process.execPath, [cli, "stats"], { cwd: project, env, encoding: "utf8" });
  assert.equal(stats.status, 0);
  assert.match(stats.stderr, /0 fix events/);
});

test("a confirmed link run says what rocky recorded and never claims a fix", (t) => {
  const home = mkdtempSync(join(tmpdir(), "rocky-link-voice-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, ROCKY_HOME: home };
  const project = join(home, "synthetic-project");
  mkdirSync(project);

  // The README 60-second test, minus the shell setup: one failing run, the
  // missing file appears, the same command runs again in the same directory.
  const first = spawnSync(process.execPath, [cli, "run", "node hello.js"], { cwd: project, env, encoding: "utf8" });
  assert.notEqual(first.status, 0);
  assert.equal(first.stderr.includes("linked to the earlier failure"), false, "a failing run links nothing");
  writeFileSync(join(project, "hello.js"), "console.log(1)\n", "utf8");
  const second = spawnSync(process.execPath, [cli, "run", "node hello.js"], { cwd: project, env, encoding: "utf8" });
  assert.equal(second.status, 0);

  assert.match(second.stderr, /Command passes now; linked to the earlier failure\./);
  assert.match(second.stderr, /The change itself was not recorded\./);
  assert.doesNotMatch(second.stderr, /\bfix(?:ed|es)?\b/i);
  assert.doesNotMatch(second.stderr, /something between/);
  assertRockyLinesArePlain(second.stderr);
});

// `shell: true` is cmd.exe on win32. It rejects a word it cannot run in two lines on
// stderr, and the first one carries the pattern rocky matches.
const CMD_EXE_REJECTION = "'FOO' is not recognized as an internal or external command,\r\noperable program or batch file.";
const CMD_EXE_HINT = "cmd.exe parsed this command; bash or PowerShell syntax does not apply there.";

test("cmdExeHint names cmd.exe when it rejected a command on the default Windows shell", () => {
  const hint = cmdExeHint("'FOO' is not recognized as an internal or external command,", "win32", true);
  assert.equal(hint, CMD_EXE_HINT);
  assert.deepEqual(validateOutputLine(hint!), []);
  assert.ok(phraseKeys.includes("cmd-exe-parsed"), "registered, so the catalog lint covers it");
  assert.equal(cmdExeHint(CMD_EXE_REJECTION, "win32", true), CMD_EXE_HINT, "the full two-line message matches too");
});

test("cmdExeHint stays silent off Windows, off the default shell, in another locale, and without a rejection", () => {
  const rejection = "'FOO' is not recognized as an internal or external command,";
  assert.equal(cmdExeHint(rejection, "linux", true), undefined);
  assert.equal(cmdExeHint(rejection, "darwin", true), undefined);
  assert.equal(cmdExeHint(rejection, "win32", false), undefined);
  // A localized cmd.exe says something else. rocky matches the English text only, so it stays
  // silent rather than guessing, and never claims what it did not record.
  assert.equal(cmdExeHint("'FOO' n'est pas reconnu en tant que commande interne", "win32", true), undefined);
  assert.equal(cmdExeHint("", "win32", true), undefined);
  assert.equal(cmdExeHint("Error: Cannot find module 'foo'", "win32", true), undefined);
});

async function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; stderr: string }> {
  const original = process.stderr.write;
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
  try {
    return { result: await fn(), stderr };
  } finally {
    process.stderr.write = original;
  }
}

test("run names cmd.exe once after what memory knows, on Windows only, and records the failure either way", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "rocky-run-cmd-exe-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const original = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  t.after(() => {
    if (original === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = original;
  });

  const rejected: ExecResult = {
    started: true, code: 1, stderr: CMD_EXE_REJECTION, tail: CMD_EXE_REJECTION.split("\r\n"), durationMs: 5,
  };
  const { result, stderr } = await captureStderr(() => run("FOO", async () => rejected));

  assert.equal(result, 1, "the wrapped exit code passes through");
  const onWindows = process.platform === "win32";
  assert.equal(stderr.split(CMD_EXE_HINT).length - 1, onWindows ? 1 : 0, stderr);
  if (onWindows) {
    assert.ok(stderr.indexOf("New error recorded") < stderr.indexOf(CMD_EXE_HINT), "memory speaks first, then the shell is named");
  }
  // Disclosure only: the failure is recorded as it always was, never skipped or tagged.
  const records = readFileSync(join(home, "memory.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line) as { kind: string; cmd?: string; exitCode?: number });
  assert.equal(records.length, 1);
  assert.deepEqual([records[0]?.kind, records[0]?.cmd, records[0]?.exitCode], ["failure", "FOO", 1]);
});
