import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { attempts } from "../commands/attempts.js";
import { run } from "../commands/run.js";
import { watch } from "../commands/watch.js";
import type { ExecResult } from "../core/exec.js";
import {
  commandIdentity,
  FINGERPRINT_ALGORITHM_VERSION,
  fingerprint,
  signatureLines,
} from "../core/fingerprint.js";
import {
  boundCommand,
  pendingPath,
  resolveFixOnSuccess,
  touchPending,
} from "../core/memory.js";
import { createMemoryQueries, LINK_WINDOW_MS } from "../core/memory-query.js";
import {
  loadMemoryChecked,
  MEMORY_FORMAT_VERSION,
  skippedLineAllowance,
  tailReadable,
  windowCovered,
  type FailureRecord,
  type FixRecord,
  type MemoryCoverage,
} from "../core/memory-read.js";
import { withRecordCap } from "./memory-cap-fixture.js";

const NOW = 1_700_000_000_000;
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

const rockyHomeContexts = new WeakSet<TestContext>();

function tempHome(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "rocky-stray-lines-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function withRockyHome(t: TestContext, home: string): void {
  const captureOriginal = !rockyHomeContexts.has(t);
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  if (captureOriginal) {
    rockyHomeContexts.add(t);
    t.after(() => {
      if (previous === undefined) delete process.env.ROCKY_HOME;
      else process.env.ROCKY_HOME = previous;
    });
  }
}

function reliableFailureRecord(
  id: string,
  cmd: string,
  cwd: string,
  ts: number,
  stderr = "false",
): FailureRecord {
  const storedCmd = boundCommand(cmd);
  const identity = commandIdentity(storedCmd);
  assert.equal(identity.reliable, true, `expected reliable command identity for ${cmd}`);
  return {
    kind: "failure",
    id,
    ts,
    cwd,
    cmd: storedCmd,
    exitCode: 1,
    fingerprint: fingerprint(stderr, storedCmd, 1),
    fingerprintV: FINGERPRINT_ALGORITHM_VERSION,
    signature: signatureLines(stderr),
    excerpt: stderr,
    commandIdentity: identity.value,
    identityV: identity.version,
    identityReliable: identity.reliable,
    platform: process.platform,
  };
}

function fillerFailureLines(count: number, cwd: string, ts: number): string[] {
  const template = reliableFailureRecord("filler-template", "cargo check", cwd, ts, "check failed");
  return Array.from({ length: count }, (_, index) => JSON.stringify({
    ...template,
    id: `filler-${index}`,
  }));
}

async function captureOutput(
  fn: () => Promise<number>,
): Promise<{ code: number; stderr: string; stdout: string }> {
  const origStderr = process.stderr.write;
  const origStdout = process.stdout.write;
  let stderr = "";
  let stdout = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    return { code: await fn(), stderr, stdout };
  } finally {
    process.stderr.write = origStderr;
    process.stdout.write = origStdout;
  }
}

test("allowance is one per thousand, at least one", () => {
  assert.equal(skippedLineAllowance(0), 1);
  assert.equal(skippedLineAllowance(1999), 1);
  assert.equal(skippedLineAllowance(2000), 2);
  assert.equal(skippedLineAllowance(10_000), 10);
  assert.equal(skippedLineAllowance(10_999), 10);
});

test("tail with tolerated skipped lines is readable and linkable", () => {
  const coverage: MemoryCoverage = {
    version: MEMORY_FORMAT_VERSION,
    window: "tail",
    reason: "record-cap",
    truncated: 1,
    complete: false,
    scanned: 10_001,
    skipped: 2,
    bytesScanned: 100_000,
    bytesTotal: 200_000,
    startOffset: 100_000,
    oldestTs: NOW - 9 * 60 * 60 * 1000,
  };
  assert.equal(tailReadable(coverage), true);
  assert.equal(windowCovered(coverage, NOW, LINK_WINDOW_MS), true);
});

test("tail at exact skipped-line allowance is readable and linkable", () => {
  const coverage: MemoryCoverage = {
    version: MEMORY_FORMAT_VERSION,
    window: "tail",
    reason: "record-cap",
    truncated: 1,
    complete: false,
    scanned: 10_001,
    skipped: 10,
    bytesScanned: 100_000,
    bytesTotal: 200_000,
    startOffset: 100_000,
    oldestTs: NOW - 9 * 60 * 60 * 1000,
  };
  assert.equal(tailReadable(coverage), true);
  assert.equal(windowCovered(coverage, NOW, LINK_WINDOW_MS), true);
});

test("allowance exceeded stays closed", () => {
  const coverage: MemoryCoverage = {
    version: MEMORY_FORMAT_VERSION,
    window: "tail",
    reason: "record-cap",
    truncated: 1,
    complete: false,
    scanned: 10_001,
    skipped: 11,
    bytesScanned: 100_000,
    bytesTotal: 200_000,
    startOffset: 100_000,
    oldestTs: NOW - 9 * 60 * 60 * 1000,
  };
  assert.equal(tailReadable(coverage), false);
  assert.equal(windowCovered(coverage, NOW, LINK_WINDOW_MS), false);
});

test("read race stays closed", () => {
  const coverage: MemoryCoverage = {
    version: MEMORY_FORMAT_VERSION,
    complete: false,
    reason: "read-race",
    skipped: 0,
    scanned: 0,
    truncated: 1,
    bytesScanned: 0,
    bytesTotal: 0,
  };
  assert.equal(tailReadable(coverage), false);
  assert.equal(windowCovered(coverage, NOW, LINK_WINDOW_MS), false);
});

test("full read with one skipped line is readable", () => {
  const oneSkipped: MemoryCoverage = {
    version: MEMORY_FORMAT_VERSION,
    complete: false,
    skipped: 1,
    scanned: 5,
    truncated: 0,
    bytesScanned: 100,
    bytesTotal: 100,
  };
  assert.equal(tailReadable(oneSkipped), true);
  assert.equal(windowCovered(oneSkipped, NOW, LINK_WINDOW_MS), true);

  const twoSkipped: MemoryCoverage = {
    ...oneSkipped,
    skipped: 2,
  };
  assert.equal(tailReadable(twoSkipped), false);
  assert.equal(windowCovered(twoSkipped, NOW, LINK_WINDOW_MS), false);
});

test("unexplained incomplete coverage with zero skipped stays closed", () => {
  const unexplained: MemoryCoverage = {
    version: MEMORY_FORMAT_VERSION,
    complete: false,
    skipped: 0,
    truncated: 0,
    scanned: 5,
    bytesScanned: 100,
    bytesTotal: 100,
  };
  assert.equal(tailReadable(unexplained), false);
  assert.equal(windowCovered(unexplained, NOW, LINK_WINDOW_MS), false);
});

test("unlock with a corrupt line in the tail", (t) => {
  withRecordCap(t, 10_000);
  const home = tempHome(t);
  withRockyHome(t, home);
  const targetCwd = join(home, "repo");
  const otherCwd = join(home, "other");
  const targetFailure = reliableFailureRecord(
    "target-failure",
    "npm test",
    targetCwd,
    NOW - 60 * 60 * 1000,
    "TypeError: token undefined",
  );
  const strayHookLine = JSON.stringify({
    kind: "failure",
    id: "stray-hook-1",
    ts: NOW - 30 * 60 * 1000,
    cwd: "=",
    cmd: "pwsh",
    exitCode: null,
    fingerprint: "0".repeat(16),
    signature: ["pwsh"],
    excerpt: "exit NaN",
    origin: "hook",
  });
  const lines = [
    ...fillerFailureLines(10_048, otherCwd, NOW - THREE_DAYS_MS),
    JSON.stringify(targetFailure),
    strayHookLine,
  ];
  writeFileSync(join(home, "memory.jsonl"), `${lines.join("\n")}\n`, "utf8");
  assert.equal(loadMemoryChecked().coverage.skipped, 1);
  touchPending();
  assert.equal(existsSync(pendingPath()), true);

  const result = resolveFixOnSuccess("npm test", targetCwd, { now: NOW });
  assert.equal(result.confirmedResolved, 1);
  assert.equal(result.possibleAssociated, 0);
  assert.equal(result.pausedReason, undefined);

  const lastLine = readFileSync(join(home, "memory.jsonl"), "utf8").trimEnd().split("\n").at(-1);
  assert.ok(lastLine !== undefined);
  const lastRecord = JSON.parse(lastLine) as FixRecord;
  assert.equal(lastRecord.kind, "fix");
  assert.equal(lastRecord.failureIds.includes(targetFailure.id), true);
  assert.equal(existsSync(pendingPath()), false);
});

test("unlock with a corrupt line in a full read", (t) => {
  const home = tempHome(t);
  withRockyHome(t, home);
  const targetCwd = join(home, "repo");
  const targetFailure = reliableFailureRecord(
    "target-full-failure",
    "npm test",
    targetCwd,
    NOW - 60 * 60 * 1000,
    "TypeError: token undefined",
  );
  const strayHookLine = JSON.stringify({
    kind: "failure",
    id: "stray-hook-full-1",
    ts: NOW - 30 * 60 * 1000,
    cwd: "=",
    cmd: "pwsh",
    exitCode: null,
    fingerprint: "0".repeat(16),
    signature: ["pwsh"],
    excerpt: "exit NaN",
    origin: "hook",
  });
  const lines = [
    JSON.stringify(targetFailure),
    strayHookLine,
  ];
  writeFileSync(join(home, "memory.jsonl"), `${lines.join("\n")}\n`, "utf8");
  const before = loadMemoryChecked();
  assert.equal(before.coverage.window, undefined);
  assert.equal(before.coverage.skipped, 1);
  touchPending();
  assert.equal(existsSync(pendingPath()), true);

  const result = resolveFixOnSuccess("npm test", targetCwd, { now: NOW });
  assert.equal(result.confirmedResolved, 1);
  assert.equal(result.possibleAssociated, 0);
  assert.equal(result.pausedReason, undefined);

  const memoryLines = readFileSync(join(home, "memory.jsonl"), "utf8").trimEnd().split("\n");
  const fixes = memoryLines
    .map((line) => {
      try {
        return JSON.parse(line) as { kind?: string };
      } catch {
        return undefined;
      }
    })
    .filter((record): record is FixRecord => record?.kind === "fix");
  assert.equal(fixes.length, 1);
  assert.equal(fixes[0]!.failureIds.includes(targetFailure.id), true);
  assert.equal(existsSync(pendingPath()), false);
});

test("full read with skipped line scopes copy", async (t) => {
  const home = tempHome(t);
  withRockyHome(t, home);
  const now = Date.now();
  const cmd = "npm test";
  const stderrLine = "TypeError: stray line copy check";
  const priorFailure = reliableFailureRecord(
    "prior-subcap",
    cmd,
    process.cwd(),
    now - 60 * 60 * 1000,
    stderrLine,
  );
  const strayHookLine = JSON.stringify({
    kind: "failure",
    id: "stray-subcap",
    ts: now - 30 * 60 * 1000,
    cwd: "=",
    cmd: "pwsh",
    exitCode: null,
    fingerprint: "0".repeat(16),
    signature: ["pwsh"],
    excerpt: "exit NaN",
    origin: "hook",
  });
  const fixture = `${JSON.stringify(priorFailure)}\n${strayHookLine}\n`;
  writeFileSync(join(home, "memory.jsonl"), fixture, "utf8");

  const failExec: ExecResult = {
    started: true,
    code: 1,
    stderr: stderrLine,
    tail: [stderrLine],
    durationMs: 5,
  };
  const { stderr } = await captureOutput(() => run(cmd, async () => failExec));
  assert.match(stderr, /Same error as before, first recorded .+ in the records read\./);
  assert.match(stderr, /rocky: No fix in the records read\./);
  assert.ok(stderr.includes("1 line could not be used."), stderr);
  assert.doesNotMatch(stderr, /earlier records were not read/);
  assert.doesNotMatch(stderr, /Only the newest/);
  assert.doesNotMatch(stderr, /No fix recorded yet\./);
  assert.doesNotMatch(stderr, /Memory coverage is incomplete/);

  writeFileSync(join(home, "memory.jsonl"), fixture, "utf8");
  const novelExec: ExecResult = {
    started: true,
    code: 1,
    stderr: "ReferenceError: never seen before",
    tail: ["ReferenceError: never seen before"],
    durationMs: 5,
  };
  const { stderr: noMatchStderr } = await captureOutput(() => run("npm run lint", async () => novelExec));
  assert.match(noMatchStderr, /New error recorded \(exit code 1\)\. No match in the records read\./);
  assert.ok(noMatchStderr.includes("1 line could not be used."), noMatchStderr);
  assert.doesNotMatch(noMatchStderr, /earlier records were not read/);
  assert.doesNotMatch(noMatchStderr, /Only the newest/);
  assert.doesNotMatch(noMatchStderr, /Memory coverage is incomplete/);

  writeFileSync(join(home, "memory.jsonl"), fixture, "utf8");
  const { stderr: watchStderr } = await captureOutput(() =>
    watch([cmd], { notify: () => {}, runProcess: async () => failExec }),
  );
  assert.match(watchStderr, /Same error as before, first recorded .+ in the records read\./);
  assert.match(watchStderr, /rocky: No fix in the records read\./);
  assert.ok(watchStderr.includes("1 line could not be used."), watchStderr);
  assert.doesNotMatch(watchStderr, /earlier records were not read/);
  assert.doesNotMatch(watchStderr, /Only the newest/);
  assert.doesNotMatch(watchStderr, /Memory coverage is incomplete/);
});

test("attempts still discloses skipped lines", async (t) => {
  withRecordCap(t, 50);
  const home = tempHome(t);
  withRockyHome(t, home);
  const targetCwd = join(home, "repo");
  const otherCwd = join(home, "other");
  mkdirSync(targetCwd, { recursive: true });
  const stderrLine = "TypeError: token undefined";
  const f1 = reliableFailureRecord("att-f1", "npm test", targetCwd, NOW - 2 * 60 * 60 * 1000, stderrLine);
  const f2 = reliableFailureRecord("att-f2", "npm test", targetCwd, NOW - 60 * 60 * 1000, stderrLine);
  const strayHookLine = JSON.stringify({
    kind: "failure",
    id: "stray-attempts",
    ts: NOW - 30 * 60 * 1000,
    cwd: "=",
    cmd: "pwsh",
    exitCode: null,
    fingerprint: "0".repeat(16),
    signature: ["pwsh"],
    excerpt: "exit NaN",
    origin: "hook",
  });
  const lines = [
    ...fillerFailureLines(60, otherCwd, NOW - THREE_DAYS_MS),
    JSON.stringify(f1),
    JSON.stringify(f2),
    strayHookLine,
  ];
  writeFileSync(join(home, "memory.jsonl"), `${lines.join("\n")}\n`, "utf8");

  const out = await captureOutput(() =>
    attempts([], { memory: createMemoryQueries(), now: NOW, cwd: targetCwd }),
  );
  assert.equal(out.code, 0);
  assert.equal(out.stdout, "");
  assert.ok(out.stderr.includes("1 line could not be used."), out.stderr);
});
