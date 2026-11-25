import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ADVISORY_LOG_MAX_BYTES, exposureKeyHash, type ExposureRow } from "../core/attempt-note-state.js";
import {
  anchorIds, buildAttemptStudy, readExposureLog, readStudyStart, renderAttemptStudyText,
  type AttemptStudyInput, type AttemptStudyReport,
} from "../core/attempt-study.js";
import { clusterBootstrapDiff, mde, newcombeDiff, Z90 } from "../core/attempt-study-math.js";
import type { Attempt, ProblemEntry } from "../core/attempts.js";
import type { FailureRecord, FixRecord, MemoryRecord } from "../core/memory-read.js";
import { causalWordViolations } from "./causal-words.js";

const DAY = 86_400_000;
const START = Date.UTC(2026, 11, 1);
const DEADLINE = START + 120 * DAY;
const FINGERPRINT = "1234567890abcdef";
const KEY = "output:1234567890abcdef:fedcba0987654321";
const CMD = "npm test";
const CWD = "/work/repo";
const start = { state: "set", ts: START } as const;

function tempHome(t: TestContext): string {
  const home = mkdtempSync(join(tmpdir(), "rocky-attempt-study-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function note(overrides: Partial<ExposureRow> = {}): ExposureRow {
  return {
    v: 1, ts: START + 100, session: "s1", lane: "run", kind: "note",
    arm: "shown", key: exposureKeyHash(KEY), cwdHash: FINGERPRINT,
    anchorFailureId: "a1", latencyMs: 10, delivered: true, bytes: 100,
    ...overrides,
  };
}

test("exposure reader distinguishes missing and unsafe files", (t) => {
  const home = tempHome(t);
  const log = join(home, "advisories.jsonl");
  assert.deepEqual(readExposureLog(home), { state: "missing" });
  assert.deepEqual(readExposureLog(join(home, "absent")), { state: "missing" });
  writeFileSync(log, "");
  truncateSync(log, ADVISORY_LOG_MAX_BYTES + 64 * 1024 + 1);
  assert.deepEqual(readExposureLog(home), { state: "unreadable" });
});

test("exposure reader rejects a directory at the log path", (t) => {
  const home = tempHome(t);
  mkdirSync(join(home, "advisories.jsonl"));
  assert.deepEqual(readExposureLog(home), { state: "unreadable" });
});

test("exposure reader rejects a symlink", { skip: process.platform === "win32" }, (t) => {
  const home = tempHome(t);
  const target = join(home, "target");
  writeFileSync(target, JSON.stringify(note()));
  symlinkSync(target, join(home, "advisories.jsonl"));
  assert.deepEqual(readExposureLog(home), { state: "unreadable" });
});

test("exposure reader retains valid rows and checks the near-cap threshold", (t) => {
  const home = tempHome(t);
  const path = join(home, "advisories.jsonl");
  const rows = [note(), note({ kind: "skip", arm: null, reason: "lock_busy" })];
  const firstLine = JSON.stringify(rows[0]);
  const otherLines = `\n{broken\n${JSON.stringify(rows[1])}\n`;
  const writeAtSize = (size: number) => {
    const padding = size - Buffer.byteLength(firstLine + otherLines);
    writeFileSync(path, firstLine + " ".repeat(padding) + otherLines);
  };

  writeAtSize(ADVISORY_LOG_MAX_BYTES - 1025);
  assert.deepEqual(readExposureLog(home), { state: "ok", rows, malformed: 1, logFull: false });
  writeAtSize(ADVISORY_LOG_MAX_BYTES - 1024);
  assert.deepEqual(readExposureLog(home), { state: "ok", rows, malformed: 1, logFull: true });
});

test("valid JSON with the wrong exposure shape counts as malformed", (t) => {
  const home = tempHome(t);
  const path = join(home, "advisories.jsonl");
  const badRows: unknown[] = [
    null, [], { ...note(), v: 2 }, { ...note(), ts: null }, { ...note(), session: 3 },
    { ...note(), lane: "other" }, { ...note(), kind: "other" }, { ...note(), arm: "other" },
    { ...note(), key: "xyz" }, { ...note(), cwdHash: null },
    { ...note(), anchorFailureId: "a".repeat(129) }, { ...note(), latencyMs: -1 },
    { ...note(), delivered: 1 }, { ...note(), bytes: -1 }, { ...note(), reason: "x".repeat(65) },
    { ...note(), reason: null },
  ];
  writeFileSync(path, badRows.map((row) => JSON.stringify(row)).join("\n") + "\n\n");
  assert.deepEqual(readExposureLog(home), {
    state: "ok", rows: [], malformed: badRows.length + 1, logFull: false,
  });
});

test("start marker accepts UTC dates and ISO timestamps up to sixty seconds ahead", (t) => {
  const home = tempHome(t);
  const path = join(home, "attempt-study-start");
  assert.deepEqual(readStudyStart(home, START), { state: "absent" });
  writeFileSync(path, "  2026-12-01\n");
  assert.deepEqual(readStudyStart(home, START), start);
  writeFileSync(path, "2026-12-01T07:01:00+07:00");
  assert.deepEqual(readStudyStart(home, START), { state: "set", ts: START + 60_000 });
  assert.deepEqual(readStudyStart(home, START - 1), { state: "invalid" });
});

test("start marker rejects invalid, oversized and non-file markers", (t) => {
  const home = tempHome(t);
  const path = join(home, "attempt-study-start");
  for (const value of ["garbage", "Dec 1, 2026", "2026-02-30", "2026-12-01" + " ".repeat(247)]) {
    writeFileSync(path, value);
    assert.deepEqual(readStudyStart(home, START), { state: "invalid" }, value);
  }
  rmSync(path);
  mkdirSync(path);
  assert.deepEqual(readStudyStart(home, START), { state: "invalid" });
});

type FixtureAttempt = {
  id: string;
  ts: number;
  session: string;
  outcome: Attempt["outcome"];
  files?: string[];
  observed?: NonNullable<Attempt["expectations"]>[number]["observed"];
};

function makeProblem(key: string, evidence: FixtureAttempt[]): { entry: ProblemEntry; records: MemoryRecord[] } {
  const records: MemoryRecord[] = [];
  const counts: ProblemEntry["counts"] = {
    attempts: evidence.length, passed: 0, possible_pass: 0, same_failure: 0,
    different_failure: 0, no_later_run: 0, unknown: 0,
  };
  const attempts = evidence.map(({ id, ts, session, outcome, files, observed }, index): Attempt => {
    const agent = { vendor: "claude-code" as const, session };
    const failure: FailureRecord = {
      kind: "failure", id, ts, cwd: CWD, cmd: CMD, exitCode: 1,
      fingerprint: FINGERPRINT, signature: [], excerpt: "", agent,
    };
    records.push(failure);
    const attempt: Attempt = {
      failureId: id, ts, cmd: CMD, outcome, sessionScoped: true, session: { vendor: agent.vendor },
      changes: files === undefined
        ? { state: "unknown" }
        : { state: "observed", files, more: 0, cardId: `card-${id}`, partial: false },
    };
    if (outcome === "passed") {
      const fix: FixRecord = { kind: "fix", id: `fix-${id}`, ts: ts + 1, cwd: CWD, cmd: CMD, failureIds: [id], agent };
      failure.resolvedBy = fix.id;
      records.push(fix);
      attempt.outcomeRecordId = fix.id;
      attempt.outcomeTs = fix.ts;
    } else if (outcome === "same_failure") {
      attempt.outcomeRecordId = evidence[index + 1]?.id;
      attempt.outcomeTs = evidence[index + 1]?.ts;
    }
    if (observed !== undefined) attempt.expectations = [{ text: "Compare run", rationaleId: `r-${id}`, observed }];
    counts[outcome]++;
    return attempt;
  });
  return {
    entry: {
      problemId: key, key, fingerprint: FINGERPRINT, family: [FINGERPRINT],
      keyStrength: "output", cwd: CWD, signature: [], counts, attempts,
      firstSeenTs: attempts[0]!.ts, lastSeenTs: attempts.at(-1)!.ts,
      latestOutcome: attempts.at(-1)!.outcome, historyMayStartEarlier: false,
    },
    records,
  };
}

function fixture(): AttemptStudyInput {
  const first = makeProblem(KEY, [
    { id: "prior", ts: START - 10, session: "prior", outcome: "passed", files: ["b.ts", "a.ts"] },
    { id: "a1", ts: START + 90, session: "s1", outcome: "same_failure", files: ["a.ts", "b.ts"], observed: "same_command_failed" },
    { id: "a2", ts: START + 95, session: "s1", outcome: "passed", observed: "same_command_passed" },
    { id: "b1", ts: START + 97, session: "s2", outcome: "no_later_run", files: ["c.ts"], observed: "no_matching_run" },
    { id: "foreign", ts: START + 99, session: "other", outcome: "passed", observed: "not_comparable" },
  ]);
  const otherKey = "other";
  const other = makeProblem(otherKey, [
    { id: "a3", ts: START + 100, session: "s1", outcome: "no_later_run" },
    { id: "mismatch", ts: START + 102, session: "m", outcome: "no_later_run" },
  ]);
  return {
    rows: [
      note({ ts: START + 104, arm: "held", session: "duplicate" }),
      note(),
      note({ arm: "held", session: "duplicate-tie" }),
      note({ ts: START + 101, anchorFailureId: "a3", key: exposureKeyHash(otherKey), bytes: 200 }),
      note({ ts: START + 102, arm: "held", session: "s2", lane: "watch", anchorFailureId: "b1", latencyMs: 50, delivered: false, bytes: 0 }),
      note({ arm: "unassigned", session: null, anchorFailureId: null, lane: "hookfail" }),
      note({ arm: "human", session: null }),
      note({ arm: null, session: null }),
      note({ session: null, anchorFailureId: null }),
      note({ session: "", anchorFailureId: null }),
      note({ anchorFailureId: null }),
      note({ anchorFailureId: "mismatch" }),
      note({ arm: "held", anchorFailureId: "missing" }),
      note({ ts: START - 1, anchorFailureId: "too-early", latencyMs: 90 }),
      note({ ts: DEADLINE + 1, anchorFailureId: "too-late", latencyMs: 100, lane: "watch" }),
      note({ kind: "skip", reason: "lock_busy", latencyMs: 9_000 }),
      note({ kind: "skip", reason: "wrapped" }),
      note({ kind: "skip", reason: "wrapped", ts: DEADLINE + 1 }),
    ],
    entries: [first.entry, other.entry],
    records: [...first.records, ...other.records],
    start: { state: "absent" },
    now: START + 4 * DAY,
    malformed: 1,
    logFull: true,
  };
}

function assertNoOutcomes(report: AttemptStudyReport): void {
  const json = JSON.stringify(report);
  assert.doesNotMatch(json, /"(?:primary|secondary|sameFailure|repeatFileSet|expectations|verdict|passed)":/u);
}

function render(report: AttemptStudyReport, home: string): string[] {
  const { head, details } = renderAttemptStudyText(report, home);
  const lines = [head, ...details];
  assert.deepEqual(causalWordViolations(lines), []);
  assert.ok(lines.every((line) => !line.includes("?")));
  return lines;
}

test("only assigned note rows with a session and anchor request memory joins", () => {
  assert.deepEqual(anchorIds(fixture().rows), new Set(["a1", "a3", "b1", "mismatch", "missing", "too-early", "too-late"]));
});

test("without a marker the report counts all eligible rows and hides outcomes", () => {
  const report = buildAttemptStudy(fixture());
  assert.equal(report.phase, "not-started");
  assert.deepEqual(report.start, { state: "absent" });
  assert.equal(report.primaryUnits, 2);
  assert.deepEqual(report.arms, {
    shown: { episodes: 2, primaryUnits: 1, outOfTail: 2 },
    held: { episodes: 1, primaryUnits: 1, outOfTail: 1 },
  });
  assert.deepEqual(report.excluded, {
    unassigned: 2, human: 1, noSession: 2, noAnchor: 1, duplicateAnchor: 2,
    keyMismatch: 1, armConflict: 0, beforeStart: 0, afterStop: 0,
  });
  assert.deepEqual({ ...report.skips }, { lock_busy: 1, wrapped: 2 });
  assert.equal(report.malformed, 1);
  assert.equal(report.logFull, true);
  assertNoOutcomes(report);
});

test("running study reports operational counts without exposing outcomes", () => {
  const input = fixture();
  const report = buildAttemptStudy({ ...input, rows: input.rows.filter((row) => row.ts <= input.now), start });
  assert.equal(report.phase, "running");
  assert.deepEqual(report.start, { state: "set", iso: "2026-12-01T00:00:00.000Z" });
  assert.equal(report.day, 5);
  assert.equal(report.primaryUnits, 2);
  assert.equal(report.excluded.beforeStart, 1);
  assert.equal(report.excluded.afterStop, 0);
  assert.deepEqual(report.latency.watch, { n: 1, p95: 50 });
  assert.deepEqual(report.latency.hookfail, { n: 1, p95: 10 });
  assert.equal(report.meanDeliveredBytes, 1300 / 12);
  assertNoOutcomes(report);
});

test("day stop uses in-window primary units and session clusters with separate denominators", () => {
  const report = buildAttemptStudy({ ...fixture(), start, now: DEADLINE + DAY });
  assert.equal(report.phase, "stopped");
  assert.equal(report.stopReason, "days");
  assert.equal(report.day, 120);
  assert.equal(report.primaryUnits, 2);
  assert.equal(report.excluded.beforeStart, 1);
  assert.equal(report.excluded.afterStop, 1);
  assert.deepEqual(report.arms, {
    shown: { episodes: 2, primaryUnits: 1, outOfTail: 0 },
    held: { episodes: 1, primaryUnits: 1, outOfTail: 1 },
  });
  assert.deepEqual(report.primary, {
    shown: { n: 1, passed: 1 }, held: { n: 1, passed: 0 },
    ...newcombeDiff(1, 1, 0, 1, Z90), mde: mde(1, 1, 0.5),
  });
  assert.deepEqual(report.secondary, {
    diff: 0.5, clusters: { shown: 1, held: 1 }, resamples: 2000,
    ...clusterBootstrapDiff([
      { arm: "shown", successes: 1, total: 2 },
      { arm: "held", successes: 0, total: 1 },
    ], { resamples: 2000, seed: 0x5eed11, level: 0.9 }),
  });
  assert.deepEqual(report.sameFailure, { shown: 0.5, held: 0 });
  assert.deepEqual(report.repeatFileSet, { shown: { subset: 1, repeats: 1 }, held: { subset: 1, repeats: 0 } });
  assert.deepEqual({ ...report.expectations.shown }, { same_command_failed: 1, same_command_passed: 1 });
  assert.deepEqual({ ...report.expectations.held }, { no_matching_run: 1 });
});

function cohort(shown: number, held: number, shownPasses: number, heldPasses: number): AttemptStudyInput {
  const rows: ExposureRow[] = [];
  const entries: ProblemEntry[] = [];
  const records: MemoryRecord[] = [];
  for (const [arm, n, passes] of [["shown", shown, shownPasses], ["held", held, heldPasses]] as const) {
    for (let i = 0; i < n; i++) {
      const id = `${arm}-${i}`;
      const ts = START + (i * 2 + (arm === "held" ? 1 : 0)) * 1_000;
      const { entry, records: evidence } = makeProblem(id, [
        { id, ts, session: id, outcome: i < passes ? "passed" : "no_later_run" },
      ]);
      entries.push(entry);
      records.push(...evidence);
      rows.push(note({ ts, arm, session: id, anchorFailureId: id, key: exposureKeyHash(id) }));
    }
  }
  return { rows, entries, records, start, now: START + DAY, malformed: 0, logFull: false };
}

test("unit stop uses the earliest 300 primary units, regardless of file order", () => {
  const input = cohort(155, 155, 80, 80);
  const report = buildAttemptStudy({ ...input, rows: [...input.rows].reverse(), now: DEADLINE + DAY });
  assert.equal(report.phase, "stopped");
  assert.equal(report.stopReason, "units");
  assert.equal(report.primaryUnits, 300);
  assert.equal(report.primary.shown.n, 150);
  assert.equal(report.primary.held.n, 150);
  assert.equal(report.excluded.afterStop, 10);
});

test("episodes tied at the unit cutoff stay in the timestamp window", () => {
  const input = cohort(151, 150, 0, 0);
  const rows = input.rows.map((row) => row.anchorFailureId === "shown-150"
    ? { ...row, ts: START + 299_000 }
    : row);
  const report = buildAttemptStudy({ ...input, rows });
  assert.equal(report.phase, "stopped");
  assert.equal(report.stopReason, "units");
  assert.equal(report.primaryUnits, 301);
  assert.equal(report.excluded.afterStop, 0);
});

test("conflicting in-window arms exclude the entire session before counting primary units", () => {
  const input = fixture();
  const rows = input.rows.map((row) => row.anchorFailureId === "a3" ? { ...row, arm: "held" as const } : row);
  const report = buildAttemptStudy({ ...input, rows });
  assert.equal(report.excluded.armConflict, 2);
  assert.equal(report.arms.shown.episodes, 0);
  assert.equal(report.arms.held.episodes, 1);
  assert.equal(report.primaryUnits, 1);
});

test("the primary Newcombe interval drives on, off and inconclusive verdicts", () => {
  for (const [shown, held, verdict] of [[120, 60, "on"], [60, 120, "off"], [75, 75, "inconclusive"]] as const) {
    const report = buildAttemptStudy(cohort(150, 150, shown, held));
    assert.equal(report.phase, "stopped");
    assert.equal(report.verdict, verdict);
    const lines = render(report, CWD);
    assert.equal(lines[0], "Attempt study stopped (300 primary units).");
    assert.ok(lines.some((line) => line.startsWith("difference shown minus held: ") && line.includes("90% CI")));
    assert.ok(lines.some((line) => line.startsWith("secondary, all episodes: ") && line.includes("2000 resamples")));
    if (verdict === "inconclusive") {
      assert.ok(lines.includes("Verdict: inconclusive. The note stays off; CLI and MCP stay."));
    }
    assert.ok(lines.includes("A friction entry from the owner in the journal sets the note off whatever this verdict says."));
  }
});

test("empty arm gives an inconclusive verdict and no fabricated interval in text", () => {
  const report = buildAttemptStudy({ ...cohort(1, 0, 1, 0), now: DEADLINE });
  assert.equal(report.phase, "stopped");
  assert.equal(report.verdict, "inconclusive");
  assert.equal(report.primary.diff, undefined);
  assert.equal(report.primary.lower, undefined);
  assert.equal(report.primary.upper, undefined);
  assert.equal(report.primary.mde, undefined);
  assert.equal(report.secondary.diff, undefined);
  assert.equal(report.secondary.lower, undefined);
  assert.equal(report.secondary.upper, undefined);
  const lines = render(report, CWD);
  assert.equal(lines[0], "Attempt study stopped (day 120).");
  assert.doesNotMatch(lines.join("\n"), /NaN|undefined|90% CI/u);
});

test("pre-stop text distinguishes absent and invalid markers and hides outcome numbers", () => {
  const input = fixture();
  const stoppedRowsRemoved = input.rows.filter((row) => row.ts <= input.now);
  const absent = buildAttemptStudy(input);
  const invalid = buildAttemptStudy({ ...input, start: { state: "invalid" } });
  const running = buildAttemptStudy({ ...input, rows: stoppedRowsRemoved, start });
  const path = join(CWD, "attempt-study-start");
  const heads = [
    "Attempt study not started. No start marker at " + path + ".",
    "Attempt study not started. Start marker at " + path + " is invalid.",
    "Attempt study running. Day 5 of 120. 2 of 300 primary units.",
  ];
  for (const [i, report] of [absent, invalid, running].entries()) {
    const lines = render(report, CWD);
    assert.equal(lines[0], heads[i]);
    assert.equal(lines[1], "shown: 2 episodes, 1 primary units. held: 1 episodes, 1 primary units.");
    assert.equal(lines[2], "Outcome numbers stay hidden until the study stops.");
    assert.doesNotMatch(lines.join("\n"), /%|points|CI/u);
    assert.ok(lines.includes("malformed rows: 1."));
    assert.ok(lines.includes("Exposure log is full. New rows are not written."));
  }
});
