import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { hookFail } from "../commands/hook.js";
import { run } from "../commands/run.js";
import { watch } from "../commands/watch.js";
import { cwdHash, type ExposureRow } from "../core/attempt-note-state.js";
import { commandFingerprint, commandIdentity, fingerprint, FINGERPRINT_ALGORITHM_VERSION } from "../core/fingerprint.js";
import { quoteShellPath } from "../core/shell-quote.js";
import { flushHookSpeech } from "../ui/rocky.js";
import { validateOutputLine } from "../ui/phrases.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(packageRoot, "dist", "index.js");
const PROCESS_TIMEOUT_MS = 30_000;

function makeSandbox(t: TestContext, prefix: string): { root: string; home: string; cwd: string } {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "rocky-home");
  const cwd = join(root, "work");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { root, home, cwd };
}

function failingNodeCmd(cwd: string, stderrLine: string, exitCode: number, stdoutLine?: string): string {
  const scriptPath = join(cwd, "fail-fixture.mjs");
  const lines: string[] = [];
  if (stdoutLine !== undefined) {
    lines.push(`process.stdout.write(${JSON.stringify(`${stdoutLine}\n`)});`);
  }
  lines.push(`process.stderr.write(${JSON.stringify(`${stderrLine}\n`)});`);
  lines.push(`process.exit(${exitCode});`);
  writeFileSync(scriptPath, `${lines.join("\n")}\n`, "utf8");
  return `${quoteShellPath(process.execPath, process.platform)} ${quoteShellPath(scriptPath, process.platform)}`;
}

function seedRunFailure(home: string, cwd: string, cmd: string, stderrLine: string, exitCode: number): string {
  const fp = fingerprint(`${stderrLine}\n`, cmd, exitCode);
  const identity = commandIdentity(cmd);
  const rec = {
    kind: "failure",
    id: "seed-fail-1",
    ts: Date.now() - 60_000,
    cwd,
    cmd,
    exitCode,
    fingerprint: fp,
    fingerprintV: FINGERPRINT_ALGORITHM_VERSION,
    signature: [stderrLine.toLowerCase()],
    excerpt: stderrLine,
    origin: "run",
    commandIdentity: identity.value,
    identityV: identity.version,
    identityReliable: identity.reliable,
    platform: process.platform,
  };
  writeFileSync(join(home, "memory.jsonl"), `${JSON.stringify(rec)}\n`, "utf8");
  return fp;
}

function baseChildEnv(home: string, overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ROCKY_HOME: home,
  };
  delete env.ROCKY_AGENT_SESSION;
  delete env.ROCKY_TEST_SEAMS;
  delete env.ROCKY_ATTEMPT_ARM;
  delete env.ROCKY_ATTEMPT_ADVISORY;
  delete env.CLAUDECODE;
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function runCliProcess(cwd: string, env: NodeJS.ProcessEnv, cmd: string) {
  return spawnSync(process.execPath, [cli, "run", cmd], {
    cwd,
    env,
    encoding: "utf8",
    timeout: PROCESS_TIMEOUT_MS,
    windowsHide: true,
  });
}

function readExposureRows(home: string): ExposureRow[] {
  const logFile = join(home, "advisories.jsonl");
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ExposureRow);
}

function readMemoryIds(home: string): string[] {
  return readFileSync(join(home, "memory.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => (JSON.parse(line) as { id: string }).id);
}

function assertRockyLinesClean(output: string): void {
  const rockyLines = output.split(/\r?\n/).filter((line) => line.startsWith("rocky: "));
  assert.ok(rockyLines.length > 0, `expected rocky lines in: ${output}`);
  for (const line of rockyLines) {
    assert.equal(line.startsWith("rocky: rocky: "), false, `double rocky prefix: ${line}`);
    assert.deepEqual(validateOutputLine(line.slice("rocky: ".length)), [], line);
  }
}

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const restore = (): void => {
    for (const [key, prev] of saved.entries()) {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  };
  try {
    const value = fn();
    if (value instanceof Promise) {
      return value.finally(restore) as T;
    }
    restore();
    return value;
  } catch (error) {
    restore();
    throw error;
  }
}

function captureTty<T>(fn: () => T): { result: T; tty: string } {
  const scratch = mkdtempSync(join(tmpdir(), "rocky-lane1-tty-"));
  const speechFile = join(scratch, "speech.txt");
  return withEnv({ ROCKY_HOOK_SPEECH_FILE: speechFile }, () => {
    try {
      const result = fn();
      flushHookSpeech();
      const tty = existsSync(speechFile) ? readFileSync(speechFile, "utf8") : "";
      return { result, tty };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}

async function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; stderr: string }> {
  const original = process.stderr.write;
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = await fn();
    return { result, stderr };
  } finally {
    process.stderr.write = original;
  }
}

test('run prints the note after "Same error as before" in arm shown, once per session', (t) => {
  const { home, cwd } = makeSandbox(t, "rocky-lane1-shown-");
  const marker = "TypeError: lane1 shown sentinel";
  const cmd = failingNodeCmd(cwd, marker, 7);
  const fp = seedRunFailure(home, cwd, cmd, marker, 7);
  const env = baseChildEnv(home, {
    ROCKY_TEST_SEAMS: "1",
    ROCKY_ATTEMPT_ARM: "shown",
    ROCKY_AGENT_SESSION: "s1",
  });

  const first = runCliProcess(cwd, env, cmd);
  assert.equal(first.status, 7, first.stderr);
  assertRockyLinesClean(first.stderr);

  const oldIdx = first.stderr.indexOf("rocky: Same error as before");
  const noteLine = first.stderr
    .split(/\r?\n/)
    .find((line) => line.startsWith("rocky: Same error recorded "));
  assert.ok(oldIdx >= 0, `expected old line in: ${first.stderr}`);
  assert.ok(noteLine !== undefined, `expected note line in: ${first.stderr}`);
  const noteIdx = first.stderr.indexOf(noteLine);
  assert.ok(noteIdx > oldIdx, `expected note after old line in: ${first.stderr}`);
  assert.ok(
    noteLine.endsWith(`Rocky records order, not cause. More: rocky attempts ${fp}`),
    `unexpected note footer: ${noteLine}`,
  );

  const second = runCliProcess(cwd, env, cmd);
  assert.equal(second.status, 7, second.stderr);
  assert.ok(second.stderr.includes("rocky: Same error as before"), second.stderr);
  assert.equal(second.stderr.includes("Same error recorded"), false, second.stderr);
  assert.equal(second.stderr.includes("Rocky records order, not cause."), false, second.stderr);

  const ids = readMemoryIds(home);
  assert.equal(ids.length, 3);
  const rows = readExposureRows(home);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.v, 1);
  assert.equal(rows[0]!.lane, "run");
  assert.equal(rows[0]!.kind, "note");
  assert.equal(rows[0]!.arm, "shown");
  assert.equal(rows[0]!.session, "s1");
  assert.equal(rows[0]!.delivered, true);
  assert.equal(rows[0]!.bytes, Buffer.byteLength(noteLine, "utf8"));
  assert.equal(rows[0]!.anchorFailureId, ids[1]);
  assert.equal(rows[0]!.cwdHash, cwdHash(cwd));
  assert.ok(rows[0]!.key !== null && rows[0]!.key.length > 0);
  assert.ok(rows[0]!.latencyMs >= 0);

  assert.equal(rows[1]!.lane, "run");
  assert.equal(rows[1]!.kind, "note");
  assert.equal(rows[1]!.arm, "shown");
  assert.equal(rows[1]!.session, "s1");
  assert.equal(rows[1]!.delivered, false);
  assert.ok(rows[1]!.bytes > 0, "bytes must reflect computed note even when suppressed by dedup");
  assert.equal(rows[1]!.anchorFailureId, ids[2]);
  assert.equal(rows[1]!.key, rows[0]!.key);
});

test("run in arm held prints the old line and no note, and logs delivered:false", (t) => {
  const { home, cwd } = makeSandbox(t, "rocky-lane1-held-");
  const marker = "TypeError: lane1 held sentinel";
  const cmd = failingNodeCmd(cwd, marker, 3);
  seedRunFailure(home, cwd, cmd, marker, 3);
  const env = baseChildEnv(home, {
    ROCKY_TEST_SEAMS: "1",
    ROCKY_ATTEMPT_ARM: "held",
    ROCKY_AGENT_SESSION: "s1",
  });

  const res = runCliProcess(cwd, env, cmd);
  assert.equal(res.status, 3, res.stderr);
  assert.ok(res.stderr.includes("rocky: Same error as before"), res.stderr);
  assert.equal(res.stderr.includes("Same error recorded"), false, res.stderr);
  assert.equal(existsSync(join(home, "gate-state")), false, "held arm must not claim a dedup slot");

  const ids = readMemoryIds(home);
  const rows = readExposureRows(home);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.lane, "run");
  assert.equal(rows[0]!.kind, "note");
  assert.equal(rows[0]!.arm, "held");
  assert.equal(rows[0]!.session, "s1");
  assert.equal(rows[0]!.delivered, false);
  assert.ok(rows[0]!.bytes > 0, "held arm must record computed note bytes");
  assert.equal(rows[0]!.anchorFailureId, ids[1]);
});

test('run with no session and CLAUDECODE=1 is unassigned: no note, one exposure row arm "unassigned"', (t) => {
  const { home, cwd } = makeSandbox(t, "rocky-lane1-unassigned-");
  const marker = "TypeError: lane1 unassigned sentinel";
  const cmd = failingNodeCmd(cwd, marker, 4);
  seedRunFailure(home, cwd, cmd, marker, 4);
  const env = baseChildEnv(home, { CLAUDECODE: "1" });

  const res = runCliProcess(cwd, env, cmd);
  assert.equal(res.status, 4, res.stderr);
  assert.ok(res.stderr.includes("rocky: Same error as before"), res.stderr);
  assert.equal(res.stderr.includes("Same error recorded"), false, res.stderr);
  assert.equal(existsSync(join(home, "gate-state")), false, "unassigned arm must not claim a dedup slot");

  const ids = readMemoryIds(home);
  const rows = readExposureRows(home);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.arm, "unassigned");
  assert.equal(rows[0]!.session, null);
  assert.equal(rows[0]!.delivered, false);
  assert.ok(rows[0]!.bytes > 0);
  assert.equal(rows[0]!.anchorFailureId, ids[1]);
});

test('run with no session in a human terminal shows the note, with arm "human"', (t) => {
  const { home, cwd } = makeSandbox(t, "rocky-lane1-human-");
  const marker = "TypeError: lane1 human sentinel";
  const cmd = failingNodeCmd(cwd, marker, 5);
  const fp = seedRunFailure(home, cwd, cmd, marker, 5);
  const env = baseChildEnv(home);

  const res = runCliProcess(cwd, env, cmd);
  assert.equal(res.status, 5, res.stderr);
  assertRockyLinesClean(res.stderr);
  assert.ok(res.stderr.includes("rocky: Same error as before"), res.stderr);
  assert.ok(res.stderr.includes("rocky: Same error recorded 1 time before in this directory"), res.stderr);
  assert.ok(res.stderr.includes(`More: rocky attempts ${fp}`), res.stderr);

  const ids = readMemoryIds(home);
  const rows = readExposureRows(home);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.arm, "human");
  assert.equal(rows[0]!.session, null);
  assert.equal(rows[0]!.delivered, true);
  assert.ok(rows[0]!.bytes > 0);
  assert.equal(rows[0]!.anchorFailureId, ids[1]);
});

test("ROCKY_ATTEMPT_ADVISORY=off prints no note and writes no exposure row", (t) => {
  const { home, cwd } = makeSandbox(t, "rocky-lane1-off-");
  const marker = "TypeError: lane1 off sentinel";
  const cmd = failingNodeCmd(cwd, marker, 6);
  seedRunFailure(home, cwd, cmd, marker, 6);
  const env = baseChildEnv(home, {
    ROCKY_ATTEMPT_ADVISORY: "off",
    ROCKY_TEST_SEAMS: "1",
    ROCKY_ATTEMPT_ARM: "shown",
    ROCKY_AGENT_SESSION: "s1",
  });

  const res = runCliProcess(cwd, env, cmd);
  assert.equal(res.status, 6, res.stderr);
  assert.ok(res.stderr.includes("rocky: Same error as before"), res.stderr);
  assert.equal(res.stderr.includes("Same error recorded"), false, res.stderr);
  assert.equal(existsSync(join(home, "advisories.jsonl")), false);
  assert.equal(existsSync(join(home, "gate-state")), false);
});

test("run exit code and wrapped output are unchanged when gate-state is unwritable", (t) => {
  const { home, cwd } = makeSandbox(t, "rocky-lane1-unwritable-");
  const marker = "TypeError: lane1 unwritable sentinel";
  const cmd = failingNodeCmd(cwd, marker, 9, "WRAPPED_STDOUT_OK");
  seedRunFailure(home, cwd, cmd, marker, 9);
  // Block both gate-state directory creation and advisories.jsonl appends.
  writeFileSync(join(home, "gate-state"), "not-a-directory", "utf8");
  mkdirSync(join(home, "advisories.jsonl"), { recursive: true });

  const env = baseChildEnv(home, {
    ROCKY_TEST_SEAMS: "1",
    ROCKY_ATTEMPT_ARM: "shown",
    ROCKY_AGENT_SESSION: "s1",
  });

  const res = runCliProcess(cwd, env, cmd);
  assert.equal(res.status, 9, res.stderr);
  assert.equal(res.stdout, "WRAPPED_STDOUT_OK\n");
  assert.ok(res.stderr.includes(marker), res.stderr);
  assert.ok(res.stderr.includes("rocky: Same error recorded 1 time before in this directory"), res.stderr);
});

test("_hookfail speaks the note through the tty path", (t) => {
  const { home, cwd } = makeSandbox(t, "rocky-lane1-hookfail-");
  const cmd = "hookfail-note-cmd";
  const fp = commandFingerprint(cmd, 1);
  const identity = commandIdentity(cmd);
  const seeded = {
    kind: "failure",
    id: "hook-seed-1",
    ts: Date.now() - 60_000,
    cwd,
    cmd,
    exitCode: 1,
    fingerprint: fp,
    fingerprintV: FINGERPRINT_ALGORITHM_VERSION,
    signature: [cmd],
    excerpt: "exit 1",
    origin: "hook",
    commandIdentity: identity.value,
    identityV: identity.version,
    identityReliable: identity.reliable,
    platform: process.platform,
  };
  writeFileSync(join(home, "memory.jsonl"), `${JSON.stringify(seeded)}\n`, "utf8");

  withEnv(
    {
      ROCKY_HOME: home,
      ROCKY_AGENT_SESSION: undefined,
      ROCKY_TEST_SEAMS: undefined,
      ROCKY_ATTEMPT_ARM: undefined,
      ROCKY_ATTEMPT_ADVISORY: undefined,
      CLAUDECODE: undefined,
    },
    () => {
      const first = captureTty(() => hookFail(cmd, 1, cwd));
      assert.equal(first.result, 0);
      assertRockyLinesClean(first.tty);
      const hintIdx = first.tty.indexOf("rocky: Same error again.");
      const noteLine = first.tty
        .split(/\r?\n/)
        .find((line) => line.startsWith("rocky: Same error recorded "));
      assert.ok(hintIdx >= 0, `expected hook hint in: ${first.tty}`);
      assert.ok(noteLine !== undefined, `expected note line in: ${first.tty}`);
      assert.ok(first.tty.indexOf(noteLine) > hintIdx, `expected note after hint in: ${first.tty}`);
      assert.ok(noteLine.endsWith(`Rocky records order, not cause. More: rocky attempts ${fp}`), noteLine);

      // Second immediate hook failure in a human terminal is suppressed by the 30-minute cooldown.
      const second = captureTty(() => hookFail(cmd, 1, cwd));
      assert.equal(second.result, 0);
      assert.ok(second.tty.includes("rocky: Same error again."), second.tty);
      assert.equal(second.tty.includes("Same error recorded"), false, second.tty);

      const ids = readMemoryIds(home);
      const rows = readExposureRows(home);
      assert.equal(rows.length, 2);
      assert.equal(rows[0]!.lane, "hookfail");
      assert.equal(rows[0]!.arm, "human");
      assert.equal(rows[0]!.session, null);
      assert.equal(rows[0]!.delivered, true);
      assert.equal(rows[0]!.bytes, Buffer.byteLength(noteLine, "utf8"));
      assert.equal(rows[0]!.anchorFailureId, ids[1]);
      assert.equal(rows[0]!.cwdHash, cwdHash(cwd));

      assert.equal(rows[1]!.lane, "hookfail");
      assert.equal(rows[1]!.arm, "human");
      assert.equal(rows[1]!.session, null);
      assert.equal(rows[1]!.delivered, false);
      assert.ok(rows[1]!.bytes > 0);
      assert.equal(rows[1]!.anchorFailureId, ids[2]);
    },
  );
});

test("watch prints the note on a repeated failure", async (t) => {
  const { home, cwd: scriptDir } = makeSandbox(t, "rocky-lane1-watch-");
  const cwd = process.cwd();
  const marker = "TypeError: lane1 watch sentinel";
  const cmd = failingNodeCmd(scriptDir, marker, 1);
  const fp = seedRunFailure(home, cwd, cmd, marker, 1);

  await withEnv(
    {
      ROCKY_HOME: home,
      ROCKY_TEST_SEAMS: "1",
      ROCKY_ATTEMPT_ARM: "shown",
      ROCKY_AGENT_SESSION: "watch-s1",
      ROCKY_ATTEMPT_ADVISORY: undefined,
      CLAUDECODE: undefined,
    },
    async () => {
      const { result, stderr } = await captureStderr(() => watch([cmd], { notify: () => {} }));
      assert.equal(result, 1);
      assertRockyLinesClean(stderr);

      const oldIdx = stderr.indexOf("rocky: Same error as before");
      const noteLine = stderr
        .split(/\r?\n/)
        .find((line) => line.startsWith("rocky: Same error recorded "));
      assert.ok(oldIdx >= 0, `expected old line in: ${stderr}`);
      assert.ok(noteLine !== undefined, `expected note line in: ${stderr}`);
      assert.ok(stderr.indexOf(noteLine) > oldIdx, `expected note after old line in: ${stderr}`);
      assert.ok(noteLine.endsWith(`Rocky records order, not cause. More: rocky attempts ${fp}`), noteLine);

      const ids = readMemoryIds(home);
      const rows = readExposureRows(home);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.lane, "watch");
      assert.equal(rows[0]!.kind, "note");
      assert.equal(rows[0]!.arm, "shown");
      assert.equal(rows[0]!.session, "watch-s1");
      assert.equal(rows[0]!.delivered, true);
      assert.equal(rows[0]!.bytes, Buffer.byteLength(noteLine, "utf8"));
      assert.equal(rows[0]!.anchorFailureId, ids[1]);
      assert.equal(rows[0]!.cwdHash, cwdHash(cwd));
    },
  );
});

test("_hookfail with no speech destination logs delivered:false", (t) => {
  const { home, cwd } = makeSandbox(t, "rocky-lane1-hookfail-notty-");
  const cmd = "hookfail-notty-cmd";
  const fp = commandFingerprint(cmd, 1);
  const identity = commandIdentity(cmd);
  const seeded = {
    kind: "failure",
    id: "hook-notty-seed-1",
    ts: Date.now() - 60_000,
    cwd,
    cmd,
    exitCode: 1,
    fingerprint: fp,
    fingerprintV: FINGERPRINT_ALGORITHM_VERSION,
    signature: [cmd],
    excerpt: "exit 1",
    origin: "hook",
    commandIdentity: identity.value,
    identityV: identity.version,
    identityReliable: identity.reliable,
    platform: process.platform,
  };
  writeFileSync(join(home, "memory.jsonl"), `${JSON.stringify(seeded)}\n`, "utf8");

  withEnv(
    {
      ROCKY_HOME: home,
      ROCKY_HOOK_SPEECH_FILE: undefined,
      ROCKY_AGENT_SESSION: undefined,
      ROCKY_TEST_SEAMS: undefined,
      ROCKY_ATTEMPT_ARM: undefined,
      ROCKY_ATTEMPT_ADVISORY: undefined,
      CLAUDECODE: undefined,
    },
    () => {
      const code = hookFail(cmd, 1, cwd);
      assert.equal(code, 0);

      const ids = readMemoryIds(home);
      const rows = readExposureRows(home);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.lane, "hookfail");
      assert.equal(rows[0]!.kind, "note");
      assert.equal(rows[0]!.arm, "human");
      assert.equal(rows[0]!.session, null);
      assert.equal(rows[0]!.delivered, false);
      assert.ok(rows[0]!.bytes > 0);
      assert.equal(rows[0]!.anchorFailureId, ids[1]);
      assert.equal(rows[0]!.cwdHash, cwdHash(cwd));
    },
  );
});

test("run logs delivered:false when printing the note throws", async (t) => {
  const { home } = makeSandbox(t, "rocky-lane1-run-say-throws-");
  const cwd = process.cwd();
  const marker = "TypeError: lane1 say throws sentinel";
  const cmd = "synthetic-say-throws-cmd";
  seedRunFailure(home, cwd, cmd, marker, 7);

  await withEnv(
    {
      ROCKY_HOME: home,
      ROCKY_TEST_SEAMS: "1",
      ROCKY_ATTEMPT_ARM: "shown",
      ROCKY_AGENT_SESSION: "say-throw-s1",
      ROCKY_ATTEMPT_ADVISORY: undefined,
      CLAUDECODE: undefined,
    },
    async () => {
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: string | Uint8Array) => {
        if (String(chunk).includes("Same error recorded")) {
          throw new Error("simulated stderr failure");
        }
        return true;
      }) as typeof process.stderr.write;

      let code: number;
      try {
        code = await run(cmd, async () => ({
          started: true,
          code: 7,
          stderr: `${marker}\n`,
          tail: [marker],
          durationMs: 5,
        }));
      } finally {
        process.stderr.write = originalWrite;
      }

      assert.equal(code, 7);
      const ids = readMemoryIds(home);
      const rows = readExposureRows(home);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.lane, "run");
      assert.equal(rows[0]!.kind, "note");
      assert.equal(rows[0]!.arm, "shown");
      assert.equal(rows[0]!.session, "say-throw-s1");
      assert.equal(rows[0]!.delivered, false);
      assert.ok(rows[0]!.bytes > 0);
      assert.equal(rows[0]!.anchorFailureId, ids[1]);
    },
  );
});

test("quiet watch logs eligible failure with delivered:false and leaves the session slot unclaimed", async (t) => {
  const { home, cwd: scriptDir } = makeSandbox(t, "rocky-lane1-quiet-watch-");
  const cwd = process.cwd();
  const marker = "TypeError: lane1 quiet watch sentinel";
  const cmd = failingNodeCmd(scriptDir, marker, 1);
  const fp = seedRunFailure(home, cwd, cmd, marker, 1);
  const session = "quiet-watch-s1";

  await withEnv(
    {
      ROCKY_HOME: home,
      ROCKY_TEST_SEAMS: "1",
      ROCKY_ATTEMPT_ARM: "shown",
      ROCKY_AGENT_SESSION: session,
      ROCKY_ATTEMPT_ADVISORY: undefined,
      CLAUDECODE: undefined,
    },
    async () => {
      const quietRun = await captureStderr(() =>
        watch(["--quiet", cmd], {
          notify: () => {
            throw new Error("quiet watch must not notify");
          },
        }),
      );
      assert.equal(quietRun.result, 1);
      assert.doesNotMatch(quietRun.stderr, /^rocky: /m);
      assert.equal(quietRun.stderr.includes("Same error recorded"), false, quietRun.stderr);
      assert.equal(quietRun.stderr.includes("Rocky records order, not cause."), false, quietRun.stderr);
      assert.match(quietRun.stderr, /exit: 1/);
      assert.equal(existsSync(join(home, "gate-state")), false, "quiet watch must not claim the dedup slot");

      const idsAfterWatch = readMemoryIds(home);
      const rowsAfterWatch = readExposureRows(home);
      assert.equal(rowsAfterWatch.length, 1);
      assert.equal(rowsAfterWatch[0]!.lane, "watch");
      assert.equal(rowsAfterWatch[0]!.kind, "note");
      assert.equal(rowsAfterWatch[0]!.arm, "shown");
      assert.equal(rowsAfterWatch[0]!.session, session);
      assert.equal(rowsAfterWatch[0]!.delivered, false);
      assert.ok(rowsAfterWatch[0]!.bytes > 0);
      assert.equal(rowsAfterWatch[0]!.anchorFailureId, idsAfterWatch[1]);
      assert.equal(rowsAfterWatch[0]!.cwdHash, cwdHash(cwd));
    },
  );

  const runEnv = baseChildEnv(home, {
    ROCKY_TEST_SEAMS: "1",
    ROCKY_ATTEMPT_ARM: "shown",
    ROCKY_AGENT_SESSION: session,
  });
  const laterRun = runCliProcess(cwd, runEnv, cmd);
  assert.equal(laterRun.status, 1, laterRun.stderr);
  assertRockyLinesClean(laterRun.stderr);
  const noteLine = laterRun.stderr
    .split(/\r?\n/)
    .find((line) => line.startsWith("rocky: Same error recorded "));
  assert.ok(noteLine !== undefined, `expected note on later non-quiet run, got: ${laterRun.stderr}`);
  assert.ok(noteLine.endsWith(`Rocky records order, not cause. More: rocky attempts ${fp}`), noteLine);

  const idsAfterRun = readMemoryIds(home);
  const rowsAfterRun = readExposureRows(home);
  assert.equal(rowsAfterRun.length, 2);
  assert.equal(rowsAfterRun[1]!.lane, "run");
  assert.equal(rowsAfterRun[1]!.kind, "note");
  assert.equal(rowsAfterRun[1]!.arm, "shown");
  assert.equal(rowsAfterRun[1]!.session, session);
  assert.equal(rowsAfterRun[1]!.delivered, true);
  assert.equal(rowsAfterRun[1]!.bytes, Buffer.byteLength(noteLine, "utf8"));
  assert.equal(rowsAfterRun[1]!.anchorFailureId, idsAfterRun[2]);
  assert.equal(rowsAfterRun[1]!.key, rowsAfterRun[0]!.key);
});
