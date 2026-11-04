import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { commandFingerprint } from "../core/fingerprint.js";
import { cmdExeHint, run, speakFailureMemory } from "../commands/run.js";
import type { ExecResult } from "../core/exec.js";
import { phraseKeys, validateRockyPhrase } from "../ui/phrases.js";

const packageRoot = process.cwd();
const cli = join(packageRoot, "dist", "index.js");

function fakeExecResult(started: boolean, code: number): ExecResult {
  return { started, code, stderr: "spawn ENOENT", tail: ["spawn ENOENT"], durationMs: 5 };
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
  assert.match(output, /possible only|maybe not fix/);
  assert.doesNotMatch(output, /strong\./);
  assert.match(output, new RegExp(fixCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(commandFingerprint(cmd, 1).length > 0, true);
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
  assert.doesNotMatch(output, /last time, you fix with:|future\.js|future-only/);
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
  assert.match(output, /no confirmed fix\. but after error, you run this:/);
  assert.match(output, /npm run unrelated-beta/);
  assert.match(output, /maybe fix, maybe not\. check, question/);
  assert.doesNotMatch(output, /no fix in memory yet/);
});

test("run speech keeps the old no-fix text unchanged, byte for byte, when no association exists", () => {
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
  assert.ok(output.includes("no fix in memory yet. you fix, I remember. this is good trade."));
  assert.doesNotMatch(output, /no confirmed fix\. but after error, you run this:/);
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
  assert.match(output, /last time, same command work again after\. I not hear what change\./);
  assert.match(output, /same command, under 1 minute later\. strong\./);
  assert.doesNotMatch(output, /something between|just now later/);
  assert.doesNotMatch(output, /no confirmed fix\. but after error, you run this:/);
  assert.doesNotMatch(output, /should-not-appear/);
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
  assert.match(output, /but this comes from other place\./);
  assert.match(output, new RegExp(associationCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(output, /maybe fix, maybe not\. check, question/);
  assert.doesNotMatch(output, /strong\./);
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
  assert.match(output, /last time, same command work again after\. I not hear what change\./);
  assert.match(output, /different program, under 1 minute later\. maybe not fix\. check, question/);
  assert.doesNotMatch(output, /strong\./);
  assert.doesNotMatch(output, /same program,/);
});

test("run speech grades a same-program link with the gap it heard, never 'just now'", () => {
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
  assert.match(underAMinute, /same program, under 1 minute later\. maybe not fix\. check, question/);
  assert.doesNotMatch(underAMinute, /just now later|strong\./);
  assert.match(speak(2 * 60_000), /same program, 2 minutes later\. maybe not fix\. check, question/);
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
  assert.match(output, /last time, you run:/);
  assert.match(output, new RegExp(seededCmd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(output, /possible fix only, question/);
  assert.match(output, /try, question/);
});

test("unrelated successful npm task is not suggested as confirmed fix", (t) => {
  const home = mkdtempSync(join(tmpdir(), "rocky-causal-fix-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, ROCKY_HOME: home };
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
  assert.equal(success.stderr.includes("[Rocky]"), false, success.stderr);
  const second = spawnSync(process.execPath, [cli, "run", "npm run broken-alpha"], { cwd: project, env, encoding: "utf8" });
  assert.equal(second.status, 67);
  assert.doesNotMatch(second.stderr, /last time, you fix with:/);
  // v0.5.2 Fix 1: this same-cwd, same-base association is exactly the
  // legitimate weak candidate spec T1 describes ("user sees `no fix in
  // memory yet` although memory holds a candidate"). The original assertion
  // here (`doesNotMatch(second.stderr, /unrelated-beta/)`) encoded that
  // pre-fix bug — hiding a candidate memory actually holds — rather than a
  // real requirement, so it is replaced with the intended weak-candidate
  // display instead of being preserved unchanged.
  assert.match(second.stderr, /no confirmed fix\. but after error, you run this:/);
  assert.match(second.stderr, /unrelated-beta/);
  assert.match(second.stderr, /maybe fix, maybe not\. check, question/);
  assert.doesNotMatch(second.stderr, /no fix in memory yet/);

  const lines = readFileSync(join(home, "memory.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.some((record) => record.kind === "fix"), false);
  const association = lines.find((record) => record.kind === "association");
  assert.deepEqual(association.candidateFailureIds.length, 1);
  assert.equal(existsSync(join(home, "pending")), true, "possible association must not clear pending");

  const stats = spawnSync(process.execPath, [cli, "stats"], { cwd: project, env, encoding: "utf8" });
  assert.equal(stats.status, 0);
  assert.match(stats.stderr, /0 fix events/);
});

test("a confirmed link run says what Rocky heard and never claims a fix", (t) => {
  const home = mkdtempSync(join(tmpdir(), "rocky-link-voice-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, ROCKY_HOME: home };
  const project = join(home, "synthetic-project");
  mkdirSync(project);

  // The README 60-second test, minus the shell setup: one failing run, the
  // missing file appears, the same command runs again in the same directory.
  const first = spawnSync(process.execPath, [cli, "run", "node hello.js"], { cwd: project, env, encoding: "utf8" });
  assert.notEqual(first.status, 0);
  assert.equal(first.stderr.includes("link them"), false, "a failing run links nothing");
  writeFileSync(join(project, "hello.js"), "console.log(1)\n", "utf8");
  const second = spawnSync(process.execPath, [cli, "run", "node hello.js"], { cwd: project, env, encoding: "utf8" });
  assert.equal(second.status, 0);

  assert.match(second.stderr, /command works now\. same command fail before\. I link them\./);
  assert.match(second.stderr, /I not hear what change\. good good good\./);
  assert.doesNotMatch(second.stderr, /\bfixed\b|you fix it|I remember (the )?fix/i);
  assert.doesNotMatch(second.stderr, /something between/);
});

// `shell: true` is cmd.exe on win32. It rejects a word it cannot run in two lines on
// stderr, and the first one carries the pattern Rocky matches.
const CMD_EXE_REJECTION = "'FOO' is not recognized as an internal or external command,\r\noperable program or batch file.";
const CMD_EXE_HINT = "cmd.exe parsed this command. bash or powershell words not heard there.";

test("cmdExeHint names cmd.exe when it rejected a command on the default Windows shell", () => {
  const hint = cmdExeHint("'FOO' is not recognized as an internal or external command,", "win32", true);
  assert.equal(hint, CMD_EXE_HINT);
  assert.deepEqual(validateRockyPhrase(hint!), []);
  assert.ok(phraseKeys.includes("cmd-exe-parsed"), "registered, so the catalog lint covers it");
  assert.equal(cmdExeHint(CMD_EXE_REJECTION, "win32", true), CMD_EXE_HINT, "the full two-line message matches too");
});

test("cmdExeHint stays silent off Windows, off the default shell, in another locale, and without a rejection", () => {
  const rejection = "'FOO' is not recognized as an internal or external command,";
  assert.equal(cmdExeHint(rejection, "linux", true), undefined);
  assert.equal(cmdExeHint(rejection, "darwin", true), undefined);
  assert.equal(cmdExeHint(rejection, "win32", false), undefined);
  // A localized cmd.exe says something else. Rocky matches the English text only, so he is
  // silent rather than guessing, and he never claims what he did not hear.
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
    assert.ok(stderr.indexOf("new error. bad.") < stderr.indexOf(CMD_EXE_HINT), "memory speaks first, then the shell is named");
  }
  // Disclosure only: the failure is recorded as it always was, never skipped or tagged.
  const records = readFileSync(join(home, "memory.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line) as { kind: string; cmd?: string; exitCode?: number });
  assert.equal(records.length, 1);
  assert.deepEqual([records[0]?.kind, records[0]?.cmd, records[0]?.exitCode], ["failure", "FOO", 1]);
});
