import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  countCycleClusters,
  cycleNudgeLine,
  CYCLE_NUDGE,
  FAILURE_CYCLE_COUNT,
  FAILURE_CYCLE_MAX_KEYS,
  FAILURE_CYCLE_SIMILARITY,
  hashRationale,
  hasNewContentTokens,
  isSameWordsRepeat,
  loadCycleState,
  observeFailureCycle,
  rationaleTokens,
  renderCycleCard,
  saveCycleState,
  type CycleEntry,
} from "../core/failure-cycle.js";
import { fingerprint, similarity, tokens } from "../core/fingerprint.js";
import { parseStatsArgs, stats } from "../commands/stats.js";
import { resolveRockyPaths } from "../core/state-paths.js";

const FP_A = "aaaaaaaaaaaaaaaa";
const FP_B = "bbbbbbbbbbbbbbbb";
const R1 = "fix timeout in auth retry helper";
const R1_NEAR = "fix timeout auth retry helper";
const LONG_BASE = "fix timeout auth retry helper backoff limit counter queue worker pool schedule";
const R_LONG_NEW = `${LONG_BASE} extra`;

function withRockyHome(t: import("node:test").TestContext, home: string): void {
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
  });
}

function withEnv(t: import("node:test").TestContext, name: string, value: string | undefined): void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

function captureOutput<T>(fn: () => T): { result: T; stdout: string; stderr: string } {
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  let stdout = "";
  let stderr = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: fn(), stdout, stderr };
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

test("three same-fingerprint near-identical rationales trigger the cycle", () => {
  const state = new Map<string, CycleEntry>();
  assert.deepEqual(observeFailureCycle(state, FP_A, R1), { count: 1, cycle: false });
  assert.deepEqual(observeFailureCycle(state, FP_A, R1), { count: 2, cycle: false });
  const third = observeFailureCycle(state, FP_A, R1_NEAR);
  assert.equal(third.count, 3);
  assert.equal(third.cycle, true);
  // Near-identical holds by the shared rule: high similarity, nothing new.
  assert.ok(similarity(rationaleTokens(R1), rationaleTokens(R1_NEAR)) > FAILURE_CYCLE_SIMILARITY);
  assert.equal(hasNewContentTokens(rationaleTokens(R1), rationaleTokens(R1_NEAR)), false);
  assert.equal(countCycleClusters(state), 1);
});

test("a different fingerprint never triggers, even interleaved", () => {
  const state = new Map<string, CycleEntry>();
  observeFailureCycle(state, FP_A, R1);
  observeFailureCycle(state, FP_B, R1);
  assert.deepEqual(observeFailureCycle(state, FP_A, R1), { count: 2, cycle: false });
  assert.deepEqual(observeFailureCycle(state, FP_B, R1), { count: 2, cycle: false });
  assert.equal(countCycleClusters(state), 0);
});

test("a paraphrase with new tokens stays silent even past the count", () => {
  const state = new Map<string, CycleEntry>();
  observeFailureCycle(state, FP_A, LONG_BASE);
  observeFailureCycle(state, FP_A, LONG_BASE);
  // One added word keeps similarity above the bar but the token set grows.
  assert.ok(similarity(rationaleTokens(LONG_BASE), rationaleTokens(R_LONG_NEW)) > FAILURE_CYCLE_SIMILARITY);
  assert.equal(hasNewContentTokens(rationaleTokens(LONG_BASE), rationaleTokens(R_LONG_NEW)), true);
  const third = observeFailureCycle(state, FP_A, R_LONG_NEW);
  assert.equal(third.count, 3);
  assert.equal(third.cycle, false);
});

test("empty rationale and empty fingerprint never trigger", () => {
  const state = new Map<string, CycleEntry>();
  observeFailureCycle(state, FP_A, "");
  observeFailureCycle(state, FP_A, "");
  assert.deepEqual(observeFailureCycle(state, FP_A, ""), { count: 3, cycle: false });
  assert.deepEqual(observeFailureCycle(state, "", R1), { count: 0, cycle: false });
  assert.equal(isSameWordsRepeat(new Set(), new Set()), false);
});

test("corrupt state reads as empty and every entry point fails open", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rocky-cycle-corrupt-")));
  const file = join(home, "s1.cycles.json");
  writeFileSync(file, "garbage{not json\n", "utf8");
  assert.deepEqual([...loadCycleState(file).entries()], []);
  assert.deepEqual([...loadCycleState(join(home, "missing.json")).entries()], []);
  assert.equal(saveCycleState("", new Map()), false);
  assert.deepEqual(observeFailureCycle(new Map(), undefined, undefined), { count: 0, cycle: false });
  assert.equal(hashRationale(undefined), hashRationale(""));
  assert.equal(cycleNudgeLine(false), undefined);
  assert.deepEqual(renderCycleCard(0, 0)[0], CYCLE_NUDGE);
});

test("state round-trips atomically, bounds keys, and honors the session timeout", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rocky-cycle-state-")));
  const file = join(home, "s1.cycles.json");
  const state = new Map<string, CycleEntry>();
  observeFailureCycle(state, FP_A, R1);
  assert.equal(saveCycleState(file, state), true);
  const reloaded = loadCycleState(file);
  assert.equal(reloaded.get(FP_A)?.count, 1);
  assert.deepEqual(reloaded.get(FP_A)?.lastTokens, [...rationaleTokens(R1)]);
  // Third observation after reload still detects the loop: persistence keeps it.
  observeFailureCycle(reloaded, FP_A, R1);
  const third = observeFailureCycle(reloaded, FP_A, R1_NEAR);
  assert.equal(third.cycle, true);

  const big = new Map<string, CycleEntry>();
  for (let i = 0; i < FAILURE_CYCLE_MAX_KEYS + 5; i += 1) {
    observeFailureCycle(big, `fp-${i}`, R1);
  }
  assert.ok(big.size <= FAILURE_CYCLE_MAX_KEYS);
  assert.equal(saveCycleState(file, big), true);
  assert.ok(loadCycleState(file).size <= FAILURE_CYCLE_MAX_KEYS);

  const stale = loadCycleState(file, Date.now() + 31 * 60 * 1000);
  assert.equal(stale.size, 0, "a session older than 30 minutes reads fresh");
});

test("reuses fingerprint() tokens() similarity() from the core", () => {
  const fp = fingerprint("Error: connect refused\n", "npm test", 1);
  assert.match(fp, /^[0-9a-f]{16}$/);
  const state = new Map<string, CycleEntry>();
  observeFailureCycle(state, fp, R1);
  observeFailureCycle(state, fp, R1);
  assert.equal(observeFailureCycle(state, fp, R1).cycle, true);
  assert.deepEqual(rationaleTokens(R1), tokens(R1.slice(0, 8 * 1024)));
});

test("rendered card and nudge line never contain a question mark", () => {
  const line = cycleNudgeLine(true);
  assert.ok(line !== undefined);
  assert.doesNotMatch(line, /\?/);
  assert.match(line, /, question/);
  assert.match(line, /rocky recall/);
  assert.match(line, /rocky teach <file>/);
  assert.match(line, /rocky why --diff/);
  for (const cardLine of renderCycleCard(3, 2)) assert.doesNotMatch(cardLine, /\?/);
  const card = renderCycleCard(3, 2);
  assert.ok(card.some((entry) => entry.includes("count only, no cause named")));
  assert.ok(!renderCycleCard(3, 1).some((entry) => entry.includes("count only")));
});

function gatePayload(session: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: session,
    tool_name: "Edit",
    tool_input: { file_path: "/work/repo/src/q.ts" },
    cwd: "/work/repo",
    ...extra,
  });
}

function gatePayloadForFile(session: string, file: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: session,
    tool_name: "Edit",
    tool_input: { file_path: file },
    cwd: "/work/repo",
    ...extra,
  });
}

test("gate cycle check is advisory: third loop appends the nudge, never denies alone", async (t) => {
  withRockyHome(t, realpathSync(mkdtempSync(join(tmpdir(), "rocky-cycle-gate-"))));
  withEnv(t, "ROCKY_RATIONALE_GATE", undefined);
  withEnv(t, "ROCKY_CYCLE_ADVISORY", undefined);
  withEnv(t, "ROCKY_CLARITY_ADVISORY", "off");
  const { gateEvent, failureCycleCheck } = await import("../agent/gate.js");
  assert.equal(failureCycleCheck.id, "failure-cycle");

  const payload = { rationale: R1, fingerprint: FP_A };
  // A fresh file per event: the rationale gate denies once per file, while
  // the cycle count accumulates per session + fingerprint across the three.
  gateEvent("claude-code", gatePayloadForFile("loop", "/work/repo/src/a.ts", payload));
  gateEvent("claude-code", gatePayloadForFile("loop", "/work/repo/src/b.ts", payload));
  const third = gateEvent("claude-code", gatePayloadForFile("loop", "/work/repo/src/c.ts", payload));
  assert.equal(third.exitCode, 0);
  const reason = JSON.parse(third.stdout).hookSpecificOutput.permissionDecisionReason as string;
  assert.match(reason, /same trouble, same words\. add new info, question/);
  assert.match(reason, /rocky recall/);
  assert.doesNotMatch(reason, /\?/);
});

test("gate cycle check derives the fingerprint from stderr via fingerprint()", async (t) => {
  withRockyHome(t, realpathSync(mkdtempSync(join(tmpdir(), "rocky-cycle-gate-stderr-"))));
  withEnv(t, "ROCKY_CLARITY_ADVISORY", "off");
  const { gateEvent } = await import("../agent/gate.js");
  const payload = { rationale: R1, stderr: "Error: connect refused\n", cmd: "npm test", exitCode: 1 };
  gateEvent("claude-code", gatePayloadForFile("derived", "/work/repo/src/a.ts", payload));
  gateEvent("claude-code", gatePayloadForFile("derived", "/work/repo/src/b.ts", payload));
  const third = gateEvent("claude-code", gatePayloadForFile("derived", "/work/repo/src/c.ts", payload));
  assert.match(
    JSON.parse(third.stdout).hookSpecificOutput.permissionDecisionReason as string,
    /same trouble, same words/,
  );
});

test("gate cycle advisory never denies and honors opt-out plus corrupt state", async (t) => {
  withRockyHome(t, realpathSync(mkdtempSync(join(tmpdir(), "rocky-cycle-gate-allow-"))));
  withEnv(t, "ROCKY_RATIONALE_GATE", "off");
  const { gateEvent } = await import("../agent/gate.js");
  const payload = { rationale: R1, fingerprint: FP_A };
  for (let i = 0; i < 5; i += 1) {
    const result = gateEvent("claude-code", gatePayload("free", payload));
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "{}", "the cycle check allows on its own");
  }

  withEnv(t, "ROCKY_RATIONALE_GATE", undefined);
  withEnv(t, "ROCKY_CYCLE_ADVISORY", "off");
  const silent = gateEvent("claude-code", gatePayload("optout", payload));
  assert.equal(JSON.parse(silent.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.doesNotMatch(
    JSON.parse(silent.stdout).hookSpecificOutput.permissionDecisionReason as string,
    /same trouble/,
  );

  withEnv(t, "ROCKY_CYCLE_ADVISORY", undefined);
  const home = process.env.ROCKY_HOME ?? "";
  mkdirSync(join(home, "gate-state"), { recursive: true });
  writeFileSync(join(home, "gate-state", "broken.cycles.json"), "garbage\n", "utf8");
  const corrupt = gateEvent("claude-code", gatePayload("broken", payload));
  assert.equal(corrupt.exitCode, 0);
  assert.doesNotMatch(
    JSON.parse(corrupt.stdout).hookSpecificOutput.permissionDecisionReason as string,
    /same trouble/,
  );
});

test("parseStatsArgs takes only --cycles", () => {
  assert.equal(parseStatsArgs([]), false);
  assert.equal(parseStatsArgs(["--cycles"]), true);
  assert.throws(() => parseStatsArgs(["--bogus"]), /unexpected argument/);
  assert.throws(() => parseStatsArgs(["--cycles", "--cycles"]), /unexpected argument/);
});

test("stats --cycles lists top fingerprints with counts from memory", async (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rocky-stats-cycles-")));
  withRockyHome(t, home);
  const now = Date.now();
  const failure = (id: string, fp: string) => ({
    kind: "failure", id, ts: now - 1000, cwd: "/repo", cmd: "npm test",
    exitCode: 1, fingerprint: fp, signature: ["err"], excerpt: "err",
  });
  writeFileSync(
    resolveRockyPaths().memory,
    [failure("f1", FP_A), failure("f2", FP_A), failure("f3", FP_A), failure("f4", FP_B)]
      .map((record) => `${JSON.stringify(record)}\n`).join(""),
    "utf8",
  );
  const { result, stderr } = captureOutput(() => stats(["--cycles"]));
  assert.equal(result, 0);
  assert.match(stderr, new RegExp(`${FP_A} x3`));
  assert.match(stderr, new RegExp(`${FP_B} x1`));
  assert.match(stderr, /count only, no cause named/);
  assert.match(stderr, /memory coverage:/);
  assert.doesNotMatch(stderr, /\?/);
});

test("stats --cycles is honest when memory holds no failure", async (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rocky-stats-cycles-empty-")));
  withRockyHome(t, home);
  const { result, stderr } = captureOutput(() => stats(["--cycles"]));
  assert.equal(result, 0);
  assert.match(stderr, /no failure heard yet\. nothing cycles\./);
});

test("stats still rejects unknown flags", async (t) => {
  withRockyHome(t, realpathSync(mkdtempSync(join(tmpdir(), "rocky-stats-cycles-usage-"))));
  const { result } = captureOutput(() => stats(["--bogus"]));
  assert.equal(result, 2);
});
