import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  countCycleClusters,
  cycleClusterLine,
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
import { CliUsageError } from "../commands/cli-args.js";
import { parseStatsArgs, stats } from "../commands/stats.js";
import { resolveRockyPaths } from "../core/state-paths.js";
import { validateOutputLine } from "../ui/phrases.js";

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

async function captureOutput(fn: () => Promise<number>): Promise<{ result: number; stdout: string; stderr: string }> {
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
    return { result: await fn(), stdout, stderr };
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

test("rendered card and nudge line are plain statements that pass the output rules", () => {
  const line = cycleNudgeLine(true);
  assert.ok(line !== undefined);
  assert.doesNotMatch(line, /\?/);
  assert.equal(
    line,
    "Same failure with the same wording again. Add new information before retrying. "
      + "Try rocky recall, rocky teach <file>, or rocky why --diff.",
  );
  assert.deepEqual(validateOutputLine(line), [], line);
  const card = renderCycleCard(3, 2);
  for (const cardLine of card) {
    assert.doesNotMatch(cardLine, /\?/);
    assert.deepEqual(validateOutputLine(cardLine), [], cardLine);
  }
  assert.ok(card.includes("Recorded 3 times this session."));
  assert.ok(card.includes(cycleClusterLine(2)));
  assert.equal(cycleClusterLine(2), "2 failures repeated this session. Count only, no cause named.");
  assert.ok(!renderCycleCard(3, 1).some((entry) => entry.includes("Count only")));
});

const invalidStatsArgs = [
  ["--json"],
  ["--cycles", "--attempts"],
  ["--attempts", "--attempts"],
  ["--bogus"],
  ["--cycles", "--json"],
  ["--cycles", "--cycles"],
  ["--attempts", "--json", "--json"],
];

test("parseStatsArgs accepts summary, cycles, and attempt study modes", () => {
  assert.deepEqual(parseStatsArgs([]), { mode: "summary" });
  assert.deepEqual(parseStatsArgs(["--cycles"]), { mode: "cycles" });
  assert.deepEqual(parseStatsArgs(["--attempts"]), { mode: "attempts", json: false });
  for (const argv of [["--attempts", "--json"], ["--json", "--attempts"]]) {
    assert.deepEqual(parseStatsArgs(argv), { mode: "attempts", json: true });
  }
});

test("parseStatsArgs rejects invalid flag combinations", () => {
  for (const argv of invalidStatsArgs) {
    assert.throws(() => parseStatsArgs(argv), CliUsageError, argv.join(" "));
  }
});

function seedCycleMemory(t: import("node:test").TestContext): void {
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
}

test("stats --cycles lists top fingerprints with counts from memory", async (t) => {
  withEnv(t, "ROCKY_VERBOSE", undefined);
  seedCycleMemory(t);
  const { result, stderr } = await captureOutput(() => stats(["--cycles"]));
  assert.equal(result, 0);
  assert.match(stderr, new RegExp(`${FP_A} x3`));
  assert.match(stderr, new RegExp(`${FP_B} x1`));
  assert.match(stderr, /2 distinct errors recorded\. Top 2 listed\./);
  assert.match(stderr, /1 distinct error seen 3 or more times\. Counts only; no cause is named\./);
  // A whole read has no coverage to disclose, so default output carries no counter line.
  assert.doesNotMatch(stderr, /memory coverage/);
  assert.doesNotMatch(stderr, /\?/);
});

test("stats --cycles prints the raw memory counters under ROCKY_VERBOSE", async (t) => {
  withEnv(t, "ROCKY_VERBOSE", "1");
  seedCycleMemory(t);
  const { result, stderr } = await captureOutput(() => stats(["--cycles"]));
  assert.equal(result, 0);
  assert.match(stderr, /memory coverage: version 1, scanned 4, skipped 0, truncated 0, complete true/);
});

test("stats --cycles is honest when memory holds no failure", async (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rocky-stats-cycles-empty-")));
  withRockyHome(t, home);
  const { result, stderr } = await captureOutput(() => stats(["--cycles"]));
  assert.equal(result, 0);
  assert.match(stderr, /No failures recorded yet\. Nothing repeats\./);
});

test("stats returns a usage error for invalid flag combinations", async (t) => {
  withRockyHome(t, realpathSync(mkdtempSync(join(tmpdir(), "rocky-stats-cycles-usage-"))));
  for (const argv of invalidStatsArgs) {
    const { result, stdout, stderr } = await captureOutput(() => stats(argv));
    assert.equal(result, 2, argv.join(" "));
    assert.equal(stdout, "");
    assert.ok(stderr.includes("usage: rocky stats [--cycles | --attempts [--json]]"));
  }
});
