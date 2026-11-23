import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  bootstrapCI,
  perTaskMeans,
  signFlipP,
  verdict,
} from "../analyze.mjs";
import { RUN_BOUNDARY_RULE, generateReport } from "../report.mjs";

const testDir = resolve(dirname(fileURLToPath(import.meta.url)));
const evalDir = resolve(testDir, "..");
const reportScript = join(evalDir, "report.mjs");

function makeRun(overrides) {
  return {
    taskId: "T01",
    arm: "none",
    block: 1,
    invalid: null,
    solved: true,
    repeatFailures: 0,
    turnsToPass: 3,
    numTurns: 4,
    wallMs: 1000,
    noteBytes: 0,
    noteDelivered: null,
    staleRepeat: null,
    leak: [],
    ...overrides,
  };
}

describe("signFlipP", () => {
  test("signFlipP all five positive is 2/32", () => {
    const res = signFlipP([1, 1, 1, 1, 1]);
    assert.deepEqual(res, { p: 0.0625, nEffective: 5 });
  });

  test("signFlipP enumerates exactly", () => {
    const a = signFlipP([2, -1, 3]);
    assert.deepEqual(a, { p: 0.5, nEffective: 3 });

    const b = signFlipP([0, 0, 4]);
    assert.deepEqual(b, { p: 1, nEffective: 1 });
  });

  test("signFlipP handles empty, all-zero, floating-point ties, and rejects >24 non-zero diffs", () => {
    assert.deepEqual(signFlipP([]), { p: 1, nEffective: 0 });
    assert.deepEqual(signFlipP([0, -0, 0]), { p: 1, nEffective: 0 });
    assert.deepEqual(signFlipP([-1, -1, -1, -1, -1, -1]), { p: 2 / 64, nEffective: 6 });

    // 0.1 + 0.2 + 0.3 - 0.4 = 0.2 mathematically; (+0.1 - 0.2 + 0.3) style ties must not miss by ULP.
    const fp = signFlipP([0.1, 0.2, -0.3]);
    assert.equal(fp.nEffective, 3);
    assert.equal(fp.p, 1);

    assert.throws(
      () => signFlipP(Array.from({ length: 25 }, () => 1)),
      /24/,
    );
    assert.throws(() => signFlipP([1, Number.NaN]), /finite/i);
  });
});

describe("bootstrapCI", () => {
  test("bootstrapCI is reproducible for a seed and brackets the mean", () => {
    const fixture = [
      [1, 2, 3, 4],
      [6, 7, 8, 9],
    ];
    const meanOfTaskMeans = (tasks) => {
      const taskMeans = tasks.map(
        (runs) => runs.reduce((acc, v) => acc + v, 0) / runs.length,
      );
      return taskMeans.reduce((acc, v) => acc + v, 0) / taskMeans.length;
    };
    const observedMean = meanOfTaskMeans(fixture);

    const ci1 = bootstrapCI(fixture, meanOfTaskMeans, {
      resamples: 2000,
      level: 0.9,
      seed: 20261123,
    });
    const ci2 = bootstrapCI(fixture, meanOfTaskMeans, {
      resamples: 2000,
      level: 0.9,
      seed: 20261123,
    });

    assert.deepEqual(ci1, ci2);
    assert.equal(ci1.length, 2);
    assert.ok(ci1[0] <= observedMean, `expected lo (${ci1[0]}) <= mean (${observedMean})`);
    assert.ok(observedMean <= ci1[1], `expected mean (${observedMean}) <= hi (${ci1[1]})`);
    assert.ok(ci1[0] < ci1[1], "expected non-degenerate interval for varying fixture");
  });

  test("bootstrapCI supports two-arm task objects and empty input", () => {
    const paired = [
      { first: [0, 0, 1], second: [2, 3, 2] },
      { first: [1, 1, 2], second: [4, 3, 4] },
    ];
    const diffStat = (tasks) => {
      let sum = 0;
      for (const t of tasks) {
        const m1 = t.first.reduce((a, b) => a + b, 0) / t.first.length;
        const m2 = t.second.reduce((a, b) => a + b, 0) / t.second.length;
        sum += m1 - m2;
      }
      return sum / tasks.length;
    };
    const obs = diffStat(paired);
    const [lo, hi] = bootstrapCI(paired, diffStat, { resamples: 2000, level: 0.9, seed: 7 });
    assert.ok(lo <= obs && obs <= hi);
    assert.deepEqual(bootstrapCI([], diffStat, { resamples: 100, level: 0.9, seed: 7 }), [null, null]);
  });
});

describe("perTaskMeans", () => {
  test("no_attempt runs are excluded from means but counted", () => {
    const runs = [
      makeRun({ taskId: "T01", arm: "after", block: 1, repeatFailures: 2 }),
      makeRun({ taskId: "T01", arm: "after", block: 2, repeatFailures: "no_attempt" }),
      makeRun({ taskId: "T01", arm: "after", block: 3, repeatFailures: 4 }),
      makeRun({ taskId: "T01", arm: "after", block: 4, invalid: "timeout", repeatFailures: 99 }),
      makeRun({ taskId: "T01", arm: "none", block: 1, repeatFailures: "no_attempt" }),
      makeRun({ taskId: "T01", arm: "none", block: 2, repeatFailures: "no_attempt" }),
    ];

    const means = perTaskMeans(runs, "repeatFailures");
    assert.ok(means instanceof Map);
    assert.equal(means.get("T01")?.get("after"), 3);
    assert.equal(means.get("T01")?.get("none"), undefined);

    const afterCounts = means.counts.get("T01")?.get("after");
    assert.equal(afterCounts.included, 2);
    assert.equal(afterCounts.noAttempt, 1);
    assert.equal(afterCounts.invalid, 1);
    assert.equal(afterCounts.total, 4);

    const noneCounts = means.counts.get("T01")?.get("none");
    assert.equal(noneCounts.included, 0);
    assert.equal(noneCounts.noAttempt, 2);
    assert.equal(noneCounts.invalid, 0);
    assert.equal(noneCounts.total, 2);
  });
});

describe("verdict", () => {
  test("veto fires on a 0.2 solved drop", () => {
    const buildBatch = (afterSolvedCount) => {
      const runs = [];
      for (let i = 0; i < 20; i += 1) {
        const taskId = i < 10 ? "C01" : "C02";
        runs.push(
          makeRun({
            taskId,
            arm: "none",
            block: (i % 10) + 1,
            solved: true,
            numTurns: 5,
          }),
        );
        runs.push(
          makeRun({
            taskId,
            arm: "after",
            block: (i % 10) + 1,
            solved: i < afterSolvedCount,
            numTurns: 5,
          }),
        );
      }
      return { runs, seed: 11, resamples: 200 };
    };

    const exactDrop = verdict(buildBatch(16)); // 1.0 - 0.8 = 0.2
    assert.equal(exactDrop.veto.vetoed, true);
    assert.ok(Math.abs(exactDrop.veto.solvedDrop - 0.2) < 1e-12);
    assert.equal(exactDrop.veto.medianTurnRise, 0);

    const belowDrop = verdict(buildBatch(17)); // 1.0 - 0.85 = 0.15
    assert.equal(belowDrop.veto.vetoed, false);
    assert.ok(Math.abs(belowDrop.veto.solvedDrop - 0.15) < 1e-12);
  });

  test("veto fires on a median turn rise of 3", () => {
    const runs = [
      // Control + stale pooled
      makeRun({ taskId: "C01", arm: "none", block: 1, solved: true, numTurns: 4 }),
      makeRun({ taskId: "C01", arm: "none", block: 2, solved: true, numTurns: 6 }),
      makeRun({ taskId: "S01", arm: "none", block: 1, solved: true, numTurns: 5, staleRepeat: false }),
      makeRun({ taskId: "C01", arm: "after", block: 1, solved: true, numTurns: 7 }),
      makeRun({ taskId: "C01", arm: "after", block: 2, solved: true, numTurns: 9 }),
      makeRun({ taskId: "S01", arm: "after", block: 1, solved: true, numTurns: 8, staleRepeat: false }),
    ];

    const res = verdict({ runs, seed: 11, resamples: 200 });
    assert.equal(res.veto.solvedDrop, 0);
    assert.equal(res.veto.medianTurnRise, 3);
    assert.equal(res.veto.vetoed, true);

    const okRuns = runs.map((r) => (r.arm === "after" ? { ...r, numTurns: r.numTurns - 1 } : r));
    const okRes = verdict({ runs: okRuns, seed: 11, resamples: 200 });
    assert.equal(okRes.veto.medianTurnRise, 2);
    assert.equal(okRes.veto.vetoed, false);
  });

  test("stale tasks report the staleRepeat rate per arm", () => {
    const runs = [
      makeRun({ taskId: "S01", arm: "after", block: 1, staleRepeat: true, repeatFailures: 0, numTurns: 5 }),
      makeRun({ taskId: "S02", arm: "after", block: 1, staleRepeat: false, repeatFailures: 0, numTurns: 5 }),
      makeRun({ taskId: "S01", arm: "none", block: 1, staleRepeat: false, repeatFailures: 5, numTurns: 5 }),
      makeRun({ taskId: "S02", arm: "none", block: 1, staleRepeat: false, repeatFailures: 5, numTurns: 5 }),
      makeRun({ taskId: "S01", arm: "before", block: 1, staleRepeat: true, repeatFailures: 2, numTurns: 5 }),
      // Invalid stale run must not affect staleRepeatRate.
      makeRun({ taskId: "S02", arm: "before", block: 1, invalid: "api_error", staleRepeat: false }),
    ];

    const res = verdict({ runs, seed: 11, resamples: 200 });
    assert.equal(res.staleRepeatRate.after, 0.5);
    assert.equal(res.staleRepeatRate.none, 0);
    assert.equal(res.staleRepeatRate.before, 1);

    // Descriptive only: feeds no claim (0 trap tasks) and does not veto on its own.
    assert.equal(res.claims.afterVsNone.n, 0);
    assert.equal(res.claims.afterVsNone.claimed, false);
    assert.equal(res.veto.vetoed, false);
  });

  test("batch invalid above 20% not_delivered", () => {
    const buildAfterTraps = (undelivered) => {
      const runs = [];
      for (let i = 0; i < 10; i += 1) {
        const taskId = `T${String(i + 1).padStart(2, "0")}`;
        runs.push(
          makeRun({
            taskId,
            arm: "after",
            block: 1,
            noteDelivered: i >= undelivered,
          }),
        );
      }
      return { runs, seed: 11, resamples: 200 };
    };

    const invalidBatch = verdict(buildAfterTraps(3)); // 3/10 = 0.3 > 0.2
    assert.equal(invalidBatch.notDeliveredRate, 0.3);
    assert.equal(invalidBatch.batchValid, false);

    const validBatch = verdict(buildAfterTraps(2)); // 2/10 = 0.2 <= 0.2
    assert.equal(validBatch.notDeliveredRate, 0.2);
    assert.equal(validBatch.batchValid, true);
  });

  test("claims require p <= 0.05, downward direction, and non-lower trap solved rate", () => {
    const trapIds = ["T01", "T02", "T03", "T04", "T05", "T06"];
    const runs = [];
    for (const taskId of trapIds) {
      for (let block = 1; block <= 2; block += 1) {
        runs.push(
          makeRun({ taskId, arm: "none", block, repeatFailures: 3, solved: true }),
          makeRun({ taskId, arm: "before", block, repeatFailures: 2, solved: true }),
          makeRun({ taskId, arm: "after", block, repeatFailures: 0, solved: true, noteDelivered: true }),
        );
      }
    }
    // Add a SMOKE run with wild values and leak: must never be analysed.
    runs.push(
      makeRun({
        taskId: "SMOKE",
        arm: "none",
        block: 1,
        repeatFailures: 999,
        solved: false,
        leak: ["none-arm-rocky"],
      }),
    );

    const res = verdict({ runs, seed: 20261123, resamples: 500 });
    assert.equal(res.batchValid, true);
    assert.equal(res.claims.afterVsNone.n, 6);
    assert.equal(res.claims.afterVsNone.p, 2 / 64);
    assert.equal(res.claims.afterVsNone.direction, "downward");
    assert.equal(res.claims.afterVsNone.solvedOk, true);
    assert.equal(res.claims.afterVsNone.claimed, true);
    assert.equal(res.claims.afterVsBefore.claimed, true);
    assert.equal(res.claims.beforeVsNone.claimed, true);

    // Lower trap solved rate blocks claim even when p <= 0.05 and downward.
    const lowSolvedRuns = runs.map((r) =>
      r.taskId === "T01" && r.arm === "after" ? { ...r, solved: false } : r,
    );
    const lowSolvedRes = verdict({ runs: lowSolvedRuns, seed: 20261123, resamples: 500 });
    assert.equal(lowSolvedRes.claims.afterVsNone.p, 2 / 64);
    assert.equal(lowSolvedRes.claims.afterVsNone.direction, "downward");
    assert.equal(lowSolvedRes.claims.afterVsNone.solvedOk, false);
    assert.equal(lowSolvedRes.claims.afterVsNone.claimed, false);

    // Upward direction (after has MORE repeats than none) is never claimed.
    const upwardRuns = runs.map((r) =>
      r.taskId !== "SMOKE" && r.arm === "after" ? { ...r, repeatFailures: 10 } : r,
    );
    const upwardRes = verdict({ runs: upwardRuns, seed: 20261123, resamples: 500 });
    assert.equal(upwardRes.claims.afterVsNone.direction, "upward");
    assert.equal(upwardRes.claims.afterVsNone.claimed, false);
  });

  test("leaks, token_leak invalid runs, and ownerCheck invalidate the batch", () => {
    const baseRuns = [
      makeRun({ taskId: "T01", arm: "none", block: 1 }),
      makeRun({ taskId: "T01", arm: "after", block: 1, noteDelivered: true }),
    ];

    assert.equal(verdict({ runs: baseRuns, resamples: 100 }).batchValid, true);

    const noneLeak = verdict({
      runs: [
        makeRun({ taskId: "T01", arm: "none", block: 1, leak: ["none-arm-rocky"] }),
        makeRun({ taskId: "T01", arm: "after", block: 1, noteDelivered: true }),
      ],
      resamples: 100,
    });
    assert.equal(noneLeak.batchValid, false);
    assert.equal(noneLeak.armValid.none, false);
    assert.equal(noneLeak.armValid.after, true);

    const tokenLeak = verdict({
      runs: [
        makeRun({ taskId: "T01", arm: "before", block: 1, invalid: "token_leak", leak: [] }),
        makeRun({ taskId: "T01", arm: "after", block: 1, noteDelivered: true }),
      ],
      resamples: 100,
    });
    assert.equal(tokenLeak.batchValid, false);
    assert.equal(tokenLeak.armValid.before, false);
    assert.equal(tokenLeak.excluded.before, 1);

    const ownerLeak = verdict({
      runs: baseRuns,
      ownerCheck: { leak: true, appendedUnderEvalRoot: 1, settingsChanged: [] },
      resamples: 100,
    });
    assert.equal(ownerLeak.batchValid, false);
    assert.equal(ownerLeak.armValid.none, false);
    assert.equal(ownerLeak.armValid.after, false);
  });
});

describe("report.mjs", () => {
  test("report CLI writes all required sections for a batch", () => {
    const dir = mkdtempSync(join(tmpdir(), "rocky-eval-report-"));
    try {
      const batchJson = {
        v: 1,
        startedAt: "2026-11-23T02:00:00.000Z",
        claudeVersion: "2.1.330 (Claude Code)",
        model: "claude-sonnet-5-5",
        claudeFlags: ["-p", "--max-turns", "30"],
        beforeRef: "31128bc",
        afterRef: "c44a1e2",
        beforeSha: "31128bc46ca7aa0bdf10c6d35e8fce353163c1d0",
        afterSha: "c44a1e2b1dc10ed28fd0c39143e0e5fcb6967845",
        evaluatorCommit: "0e4134e",
        taskSetSha256: "3bf31ff00c6337c38646b83112576e37e545a2298f6302ddcadd7d4cf0e2d62a",
        claudeMdSha256: { none: "aaa", before: "bbb", after: "ccc" },
        seed: 20261123,
        k: 1,
        concurrency: 2,
        arms: ["none", "before", "after"],
        taskIds: ["T01", "C01", "S01"],
        auth: "token",
      };
      const metricsJson = {
        "T01-none-b1": makeRun({ taskId: "T01", arm: "none", repeatFailures: 2, turnsToPass: 5, numTurns: 6, wallMs: 12000, noteBytes: 0 }),
        "T01-before-b1": makeRun({ taskId: "T01", arm: "before", repeatFailures: 1, turnsToPass: 4, numTurns: 5, wallMs: 11000, noteBytes: 90 }),
        "T01-after-b1": makeRun({ taskId: "T01", arm: "after", repeatFailures: 0, turnsToPass: 3, numTurns: 4, wallMs: 10000, noteBytes: 160, noteDelivered: true }),
        "C01-none-b1": makeRun({ taskId: "C01", arm: "none", repeatFailures: 0, turnsToPass: 3, numTurns: 4, wallMs: 8000, noteBytes: 0 }),
        "C01-after-b1": makeRun({ taskId: "C01", arm: "after", repeatFailures: 0, turnsToPass: 3, numTurns: 4, wallMs: 8500, noteBytes: 0, noteDelivered: false }),
        "S01-none-b1": makeRun({ taskId: "S01", arm: "none", repeatFailures: 1, turnsToPass: 4, numTurns: 5, wallMs: 9000, staleRepeat: false }),
        "S01-after-b1": makeRun({ taskId: "S01", arm: "after", repeatFailures: 1, turnsToPass: 4, numTurns: 5, wallMs: 9500, noteBytes: 150, noteDelivered: true, staleRepeat: true }),
        "T01-before-b2": makeRun({ taskId: "T01", arm: "before", block: 2, invalid: "api_error" }),
      };

      writeFileSync(join(dir, "batch.json"), `${JSON.stringify(batchJson, null, 2)}\n`, "utf8");
      writeFileSync(join(dir, "metrics.json"), `${JSON.stringify(metricsJson, null, 2)}\n`, "utf8");

      const dest = join(dir, "out", "report.md");
      const res = spawnSync(
        process.execPath,
        [reportScript, "--out", dir, "--label", "run1", "--dest", dest, "--resamples", "500"],
        { encoding: "utf8" },
      );
      assert.equal(res.status, 0, res.stderr);

      const md = readFileSync(dest, "utf8");
      assert.match(md, /## Provenance/);
      assert.match(md, /claude-sonnet-5-5/);
      assert.match(md, /## Excluded Runs/);
      assert.match(md, /## Leak Results/);
      assert.match(md, /## Positive Control/);
      assert.match(md, /note text in a tool result or a delivered note row in the run's advisories\.jsonl/);
      assert.match(md, /## Per-Task Metrics/);
      assert.match(md, /repeatFailures/);
      assert.match(md, /no_attempt/);
      assert.match(md, /turnsToPass/);
      assert.match(md, /wallMs/);
      assert.match(md, /noteBytes/);
      assert.match(md, /staleRepeat/);
      assert.match(md, /## Comparisons/);
      assert.match(md, /afterVsNone/);
      assert.match(md, /afterVsBefore/);
      assert.match(md, /beforeVsNone/);
      assert.match(md, /## Veto and Verdict/);
      assert.match(md, /## Run-Boundary Rule/);
      assert.ok(md.includes(RUN_BOUNDARY_RULE));

      // Sanity-check programmatic API matches CLI output structure.
      const built = generateReport(dir, { label: "run1", resamples: 500 });
      assert.equal(built.verdict.batchValid, true);
      assert.equal(built.verdict.excluded.before, 1);
      assert.equal(built.verdict.staleRepeatRate.after, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("report CLI handles smoke-only batch and exits 2 on missing required flags", () => {
    const dir = mkdtempSync(join(tmpdir(), "rocky-eval-report-smoke-"));
    try {
      writeFileSync(
        join(dir, "batch.json"),
        `${JSON.stringify({ v: 1, seed: 20261123, k: 1, taskIds: ["SMOKE"] }, null, 2)}\n`,
        "utf8",
      );
      writeFileSync(
        join(dir, "metrics.json"),
        `${JSON.stringify({
          "SMOKE-none-b1": makeRun({ taskId: "SMOKE", arm: "none" }),
          "SMOKE-after-b1": makeRun({ taskId: "SMOKE", arm: "after", noteDelivered: false }),
        }, null, 2)}\n`,
        "utf8",
      );
      const dest = join(dir, "report.md");
      const ok = spawnSync(
        process.execPath,
        [reportScript, "--out", dir, "--label", "smoke", "--dest", dest],
        { encoding: "utf8" },
      );
      assert.equal(ok.status, 0, ok.stderr);
      const md = readFileSync(dest, "utf8");
      assert.match(md, /2 SMOKE run\(s\) present in metrics\.json were omitted/);
      assert.match(md, /No control or stale runs present/);

      const bad = spawnSync(process.execPath, [reportScript, "--out", dir], { encoding: "utf8" });
      assert.equal(bad.status, 2);
      assert.match(bad.stderr, /--label/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
