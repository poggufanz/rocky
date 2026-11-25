import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { stats } from "../commands/stats.js";
import { exposureKeyHash, type ExposureRow } from "../core/attempt-note-state.js";
import { STUDY_START_FILE } from "../core/attempt-study.js";
import { commandIdentity } from "../core/fingerprint.js";
import { createMemoryQueries } from "../core/memory-query.js";
import type { FailureRecord } from "../core/memory-read.js";

const START = Date.UTC(2026, 10, 24);
const NOW = Date.UTC(2026, 10, 25);
const CWD = "/work/app";
const FINGERPRINT = "3f2a9c1e44d0b7a1";

function freshHome(t: TestContext): string {
  const home = mkdtempSync(join(tmpdir(), "rocky-stats-attempts-"));
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });
  return home;
}

async function captureOutput(run: () => Promise<number>): Promise<{
  code: number; stdout: string; stderr: string;
}> {
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  let stdout = "";
  let stderr = "";
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    // Keep node:test's binary report frames on the real stdout channel.
    if (typeof chunk !== "string") {
      return (originalStdout as (...args: unknown[]) => boolean).call(process.stdout, chunk, ...rest);
    }
    stdout += chunk;
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { code: await run(), stdout, stderr };
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

function fileSnapshot(home: string): Map<string, { mtimeMs: number; size: number }> {
  const files = new Map<string, { mtimeMs: number; size: number }>();
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else {
        const { mtimeMs, size } = statSync(path);
        files.set(path, { mtimeMs, size });
      }
    }
  };
  visit(home);
  return files;
}

test("stats --attempts reports an empty, unstarted study without creating state", async (t) => {
  const home = freshHome(t);

  const out = await captureOutput(() => stats(["--attempts"]));

  assert.equal(out.code, 0);
  assert.equal(out.stdout, "");
  assert.match(out.stderr, /^rocky: Attempt study not started\./);
  assert.match(out.stderr, /shown: 0 episodes/);
  assert.deepEqual(readdirSync(home), []);
});

test("stats --attempts reports a running study without outcomes or filesystem writes", async (t) => {
  const home = freshHome(t);
  const cmd = "npm test";
  const identity = commandIdentity(cmd, { platform: "linux" });
  const failure: FailureRecord = {
    kind: "failure", id: "a1", ts: START + 1_000, cwd: CWD, cmd, exitCode: 1,
    fingerprint: FINGERPRINT, fingerprintV: 2, signature: ["Error: test failed"],
    excerpt: "Error: test failed", origin: "run",
    commandIdentity: identity.value, identityV: 1, identityReliable: identity.reliable, platform: "linux",
  };
  const exposure: ExposureRow = {
    v: 1, ts: START + 1_001, session: "s1", lane: "run", kind: "note",
    arm: "shown", key: exposureKeyHash(`output:${FINGERPRINT}:${CWD}`), cwdHash: FINGERPRINT,
    anchorFailureId: failure.id, latencyMs: 10, delivered: true, bytes: 100,
  };
  writeFileSync(join(home, "memory.jsonl"), `${JSON.stringify(failure)}\n`);
  writeFileSync(join(home, "advisories.jsonl"), `${JSON.stringify(exposure)}\n`);
  writeFileSync(join(home, STUDY_START_FILE), `${new Date(START).toISOString()}\n`);
  mkdirSync(join(home, "desk"));
  writeFileSync(join(home, "desk", "tool-text-off"), "");
  const before = fileSnapshot(home);

  const out = await captureOutput(() => stats(["--attempts", "--json"], { now: NOW }));

  assert.equal(out.code, 0);
  assert.equal(out.stderr, "");
  assert.match(out.stdout, /^[^\r\n]+\n$/u);
  const report = JSON.parse(out.stdout);
  assert.equal(report.phase, "running");
  assert.equal(report.primaryUnits, 1, out.stdout);
  assert.equal(report.arms.shown.episodes, 1);
  assert.doesNotMatch(out.stdout, /"(?:primary|secondary|sameFailure|repeatFileSet|expectations|verdict|passed)":/u);

  const textOut = await captureOutput(() => stats(["--attempts"], { now: NOW }));
  assert.equal(textOut.code, 0);
  assert.match(textOut.stderr, /shown: 1 episodes/);
  assert.deepEqual(fileSnapshot(home), before);
  assert.equal(existsSync(join(home, "gate-state")), false);
  assert.equal(existsSync(join(home, "derived")), false);
});

test("stats --attempts exits 1 when the exposure log is unreadable", async (t) => {
  const home = freshHome(t);
  mkdirSync(join(home, "advisories.jsonl"));

  const out = await captureOutput(() => stats(["--attempts", "--json"]));

  assert.deepEqual(out, { code: 1, stdout: "", stderr: "rocky: Exposure log cannot be read.\n" });
});

test("stats --attempts exits 1 for a memory read race or unavailable snapshot", async (t) => {
  const home = freshHome(t);
  const unavailable = await captureOutput(() =>
    stats(["--attempts", "--json"], { memory: createMemoryQueries(() => []) }),
  );
  mkdirSync(join(home, "memory.jsonl"));
  const readRace = await captureOutput(() => stats(["--attempts"]));

  const expected = { code: 1, stdout: "", stderr: "rocky: Memory cannot be read.\n" };
  assert.deepEqual(readRace, expected);
  assert.deepEqual(unavailable, expected);
});
