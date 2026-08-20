import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { commandFingerprint } from "../core/fingerprint.js";
import { run, speakFailureMemory } from "../commands/run.js";
import type { ExecResult } from "../core/exec.js";

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
  assert.match(output, /last time, something between fix it\. what, I not hear\. works again, I remember\./);
  assert.match(output, /same command,.*strong\./);
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
  assert.match(output, /last time, something between fix it\. what, I not hear\. works again, I remember\./);
  assert.match(output, /different program,.*maybe not fix\. check, question/);
  assert.doesNotMatch(output, /strong\./);
  assert.doesNotMatch(output, /same program,/);
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
