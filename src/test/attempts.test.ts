import assert from "node:assert/strict";
import test from "node:test";
import { buildProblems, selectProblemEntries, type AttemptOutcome } from "../core/attempts.js";
import { commandFingerprint, commandIdentity, fingerprint, legacyFingerprint } from "../core/fingerprint.js";
import {
  MEMORY_FORMAT_VERSION,
  resolveMemoryRecords,
  type AgentStamp,
  type FailureRecord,
  type FixRecord,
  type MemoryCoverage,
  type MemoryRecord,
  type RationaleRecord,
} from "../core/memory-read.js";
import { sanitizeTestimony } from "../core/redact.js";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

function completeCoverage(scanned = 1): MemoryCoverage {
  return {
    version: MEMORY_FORMAT_VERSION,
    scanned,
    skipped: 0,
    truncated: 0,
    bytesScanned: 100,
    bytesTotal: 100,
    complete: true,
  };
}

function makeFailure(overrides: Partial<FailureRecord> & { id: string; ts: number }): FailureRecord {
  const cmd = overrides.cmd ?? "npm test";
  const identity = commandIdentity(cmd, { platform: overrides.platform ?? "linux" });
  return {
    kind: "failure",
    cwd: "/app",
    cmd,
    exitCode: 1,
    fingerprint: "1111222233334444",
    fingerprintV: 2,
    signature: ["error: test failed"],
    excerpt: "Error: test failed",
    origin: "run",
    commandIdentity: identity.value,
    identityV: 1,
    identityReliable: identity.reliable,
    platform: "linux",
    ...overrides,
  };
}

function makeFix(overrides: Partial<FixRecord> & { id: string; ts: number }): FixRecord {
  const cmd = overrides.cmd ?? "npm test";
  const identity = commandIdentity(cmd, { platform: overrides.platform ?? "linux" });
  return {
    kind: "fix",
    cwd: "/app",
    cmd,
    failureIds: [],
    commandIdentity: identity.value,
    identityV: 1,
    identityReliable: identity.reliable,
    platform: "linux",
    ...overrides,
  };
}

test("incomplete non-tail coverage gives unknown coverage", () => {
  const coverage: MemoryCoverage = {
    version: MEMORY_FORMAT_VERSION,
    scanned: 3,
    skipped: 2,
    truncated: 0,
    bytesScanned: 100,
    bytesTotal: 100,
    complete: false,
  };
  const failure = makeFailure({ id: "f1", ts: NOW - HOUR });
  const result = buildProblems([failure], coverage, { now: NOW });
  assert.equal(result.entries.length, 1);
  const attempt = result.entries[0]!.attempts[0]!;
  assert.equal(attempt.outcome, "unknown");
  assert.equal(attempt.unknownReason, "coverage");
});

test("open window is no_later_run", () => {
  const failure = makeFailure({ id: "f1", ts: NOW - HOUR });
  const result = buildProblems([failure], completeCoverage(1), { now: NOW });
  assert.equal(result.entries.length, 1);
  const attempt = result.entries[0]!.attempts[0]!;
  assert.equal(attempt.outcome, "no_later_run");
  assert.equal(attempt.unknownReason, undefined);
});

test("unstamped fix resolves stamped failure without marking crossSession", () => {
  const s1: AgentStamp = { vendor: "claude-code", session: "s1" };
  const fix = makeFix({ id: "x1", ts: NOW - 30_000, failureIds: ["f1"] });
  const failure = makeFailure({ id: "f1", ts: NOW - 60_000, agent: s1 });
  resolveMemoryRecords([failure, fix], NOW);
  assert.equal(failure.resolvedBy, "x1");
  const result = buildProblems([failure, fix], completeCoverage(2), { now: NOW });
  assert.equal(result.entries.length, 1);
  const attempt = result.entries[0]!.attempts[0]!;
  assert.equal(attempt.outcome, "passed");
  assert.equal(attempt.outcomeRecordId, "x1");
  assert.equal(attempt.outcomeTs, fix.ts);
  assert.equal(attempt.sessionScoped, true);
  assert.deepEqual(attempt.session, { vendor: "claude-code" });
  assert.equal(attempt.crossSession, undefined);
});

test("rejected cross-session fix leaves resolvedBy unset for later same-session fix", () => {
  const s1: AgentStamp = { vendor: "claude-code", session: "s1" };
  const s2: AgentStamp = { vendor: "claude-code", session: "s2" };
  const failure = makeFailure({ id: "f1", ts: NOW - 90_000, agent: s1 });
  const crossFix = makeFix({ id: "x1", ts: NOW - 60_000, failureIds: ["f1"], agent: s2 });
  const sameFix = makeFix({ id: "x2", ts: NOW - 30_000, failureIds: ["f1"], agent: s1 });
  resolveMemoryRecords([failure, crossFix, sameFix], NOW);
  assert.equal(failure.resolvedBy, "x2");
  const result = buildProblems([failure, crossFix, sameFix], completeCoverage(3), { now: NOW });
  assert.equal(result.entries.length, 1);
  const attempt = result.entries[0]!.attempts[0]!;
  assert.equal(attempt.outcome, "passed");
  assert.equal(attempt.outcomeRecordId, "x2");
  assert.equal(attempt.outcomeTs, sameFix.ts);
  assert.equal(attempt.crossSession, undefined);
});

test("stamped records in different sessions are skipped", () => {
  const s1: AgentStamp = { vendor: "claude-code", session: "s1" };
  const s2: AgentStamp = { vendor: "claude-code", session: "s2" };
  const f1 = makeFailure({ id: "f1", ts: NOW - 60_000, agent: s1 });
  const f2 = makeFailure({ id: "f2", ts: NOW - 30_000, agent: s2 });
  const result = buildProblems([f1, f2], completeCoverage(2), { now: NOW });
  assert.equal(result.entries.length, 1);
  assert.deepEqual(
    result.entries[0]!.attempts.map((attempt) => attempt.outcome),
    ["no_later_run", "no_later_run"],
  );
});

test("stamped subagents in same session with different agentId are skipped", () => {
  const a1: AgentStamp = { vendor: "claude-code", session: "s1", agentId: "sub-1" };
  const a2: AgentStamp = { vendor: "claude-code", session: "s1", agentId: "sub-2" };
  const f1 = makeFailure({ id: "f1", ts: NOW - 60_000, agent: a1 });
  const f2 = makeFailure({ id: "f2", ts: NOW - 30_000, agent: a2 });
  const result = buildProblems([f1, f2], completeCoverage(2), { now: NOW });
  assert.equal(result.entries.length, 1);
  assert.deepEqual(
    result.entries[0]!.attempts.map((attempt) => attempt.outcome),
    ["no_later_run", "no_later_run"],
  );
  assert.deepEqual(result.entries[0]!.attempts[0]!.session, { vendor: "claude-code", agentId: "sub-1" });
});

test("command family never merges with output family", () => {
  const sharedFp = "aaaa1111bbbb2222";
  const hookFailure = makeFailure({
    id: "f-hook",
    ts: NOW - 60_000,
    origin: "hook",
    fingerprint: sharedFp,
    signature: [],
    excerpt: "",
  });
  const runFailure = makeFailure({
    id: "f-run",
    ts: NOW - 30_000,
    origin: "run",
    fingerprint: sharedFp,
    signature: ["error: something"],
    excerpt: "Error: something",
  });
  const result = buildProblems([hookFailure, runFailure], completeCoverage(2), { now: NOW });
  assert.equal(result.entries.length, 2);
  assert.deepEqual(
    result.entries.map((entry) => entry.keyStrength),
    ["output", "command"],
  );
  assert.equal(result.entries[1]!.attempts[0]!.outcome, "different_failure");
  assert.equal(result.entries[1]!.attempts[0]!.nextFingerprint, sharedFp);
});

test("run failure falling back to commandFingerprint enters command family", () => {
  const cmdFp = commandFingerprint("npm test", 1);
  const f1 = makeFailure({
    id: "f1",
    ts: NOW - 60_000,
    origin: "run",
    fingerprint: cmdFp,
    signature: [],
    excerpt: "",
  });
  const f2 = makeFailure({
    id: "f2",
    ts: NOW - 30_000,
    origin: "hook",
    fingerprint: cmdFp,
    signature: [],
    excerpt: "",
  });
  const result = buildProblems([f1, f2], completeCoverage(2), { now: NOW });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0]!.keyStrength, "command");
  assert.deepEqual(
    result.entries[0]!.attempts.map((attempt) => attempt.outcome),
    ["same_failure", "no_later_run"],
  );
});

test("stated is sanitized", () => {
  const hostile = "\u202eok\u001b[31m\nsk-abcdefghijklmnopqrstuv";
  const sanitized = sanitizeTestimony(hostile);
  assert.equal(/[\u202a-\u202e\u200b-\u200f\u001b\n\r\t]/u.test(sanitized), false);
  assert.equal(sanitized.includes("sk-abcdefghijklmnopqrstuv"), false);
  assert.match(sanitized, /\[redacted openai key\]/);

  const failure = makeFailure({ id: "f1", ts: NOW - 60_000 });
  const rationale: RationaleRecord = {
    kind: "rationale",
    id: "r1",
    ts: NOW - 50_000,
    v: 1,
    cwd: "/app",
    agent: "claude-code",
    rationale_fidelity: "raw",
    source: "notify",
    excerpt: hostile,
    links: { failureId: "f1" },
    files: ["src/auth.ts"],
  };
  const result = buildProblems([failure, rationale], completeCoverage(2), { now: NOW });
  const attempt = result.entries[0]!.attempts[0]!;
  assert.deepEqual(attempt.changes, {
    state: "testimony",
    files: ["src/auth.ts"],
    rationaleId: "r1",
  });
  assert.equal(attempt.stated?.source, "rationale");
  assert.equal(attempt.stated?.recordId, "r1");
  assert.equal(attempt.stated?.text, sanitized);
});

test("single fingerprint mode returns one entry", () => {
  const f1 = makeFailure({ id: "f1", ts: NOW - 120_000, fingerprint: "aaaa000000000001" });
  const f2 = makeFailure({ id: "f2", ts: NOW - 60_000, fingerprint: "bbbb000000000002" });
  const f3 = makeFailure({ id: "f3", ts: NOW - 30_000, fingerprint: "aaaa000000000001" });
  const records: MemoryRecord[] = [f1, f2, f3];

  const byFp = buildProblems(records, completeCoverage(3), { now: NOW, fingerprint: "aaaa000000000001" });
  assert.equal(byFp.entries.length, 1);
  assert.equal(byFp.entries[0]!.fingerprint, "aaaa000000000001");
  assert.equal(byFp.entries[0]!.attempts.length, 2);

  const targetProblemId = byFp.entries[0]!.problemId;
  const byProblemId = buildProblems(records, completeCoverage(3), { now: NOW, fingerprint: targetProblemId });
  assert.equal(byProblemId.entries.length, 1);
  assert.equal(byProblemId.entries[0]!.problemId, targetProblemId);
});

test("counts add up", () => {
  const f1 = makeFailure({ id: "f1", ts: NOW - 300_000, fingerprint: "aaaa000000000001" });
  const f2 = makeFailure({ id: "f2", ts: NOW - 240_000, fingerprint: "aaaa000000000001" });
  const fOther = makeFailure({ id: "f-other", ts: NOW - 180_000, fingerprint: "cccc000000000003" });
  const f3 = makeFailure({ id: "f3", ts: NOW - 120_000, fingerprint: "aaaa000000000001" });
  const fix = makeFix({ id: "x1", ts: NOW - 60_000, failureIds: ["f3"] });
  const f4 = makeFailure({ id: "f4", ts: NOW - 30_000, fingerprint: "aaaa000000000001" });
  const records: MemoryRecord[] = [f1, f2, fOther, f3, { ...f3, id: "f3-dup-ignored" } as unknown as MemoryRecord];
  // Use clean list with f1, f2, fOther, f3, fix, f4
  const cleanRecords: MemoryRecord[] = [
    f1,
    f2,
    fOther,
    { ...f3, resolvedBy: fix.id },
    fix,
    f4,
  ];
  void records;

  const result = buildProblems(cleanRecords, completeCoverage(6), { now: NOW });
  const entry = result.entries.find((item) => item.fingerprint === "aaaa000000000001")!;
  assert.ok(entry);
  assert.equal(entry.counts.attempts, entry.attempts.length);
  assert.equal(entry.counts.attempts, 4);
  const outcomes: AttemptOutcome[] = [
    "passed",
    "possible_pass",
    "same_failure",
    "different_failure",
    "no_later_run",
    "unknown",
  ];
  const outcomeSum = outcomes.reduce((sum, key) => sum + entry.counts[key], 0);
  assert.equal(outcomeSum, entry.counts.attempts);
  assert.deepEqual(
    entry.attempts.map((attempt) => attempt.outcome),
    ["same_failure", "different_failure", "passed", "no_later_run"],
  );
  assert.equal(entry.latestOutcome, "no_later_run");
});

test("unlinked reliable fix produces unknown unlinked-pass", () => {
  const f1 = makeFailure({ id: "f1", ts: NOW - 60_000 });
  const x1 = makeFix({ id: "x1", ts: NOW - 30_000, failureIds: [] });
  const result = buildProblems([f1, x1], completeCoverage(2), { now: NOW });
  const attempt = result.entries[0]!.attempts[0]!;
  assert.equal(attempt.outcome, "unknown");
  assert.equal(attempt.unknownReason, "unlinked-pass");
  assert.equal(attempt.outcomeRecordId, "x1");
});

test("opts.cwd sets cwdScope without filtering entries", () => {
  const fHere = makeFailure({
    id: "f1",
    ts: NOW - 60_000,
    cwd: "C:\\Work\\App",
    platform: "win32",
    fingerprint: "aaaa000000000001",
  });
  const fElsewhere = makeFailure({
    id: "f2",
    ts: NOW - 30_000,
    cwd: "C:\\Work\\Other",
    platform: "win32",
    fingerprint: "bbbb000000000002",
  });
  const result = buildProblems([fHere, fElsewhere], completeCoverage(2), {
    now: NOW,
    cwd: "c:/work/app/",
    platform: "win32",
  });
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0]!.cwdScope, "elsewhere");
  assert.equal(result.entries[1]!.cwdScope, "here");
});

test("migrated legacy command-only run failure stays in output family", () => {
  const cmd = "npm test";
  const legacyFp = legacyFingerprint("", cmd, 1);
  const cmdFp = commandFingerprint(cmd, 1);
  assert.notEqual(legacyFp, cmdFp);

  const legacyRun: FailureRecord = {
    ...makeFailure({
      id: "f-legacy-cmd-only",
      ts: NOW - 60_000,
      origin: "run",
      cmd,
      fingerprint: legacyFp,
      signature: [],
      excerpt: "",
    }),
    fingerprintV: undefined,
  };
  const v2CmdWitness = makeFailure({
    id: "f-v2-cmd-only",
    ts: NOW - 30_000,
    origin: "run",
    cmd,
    fingerprint: cmdFp,
    fingerprintV: 2,
    signature: [],
    excerpt: "",
  });

  const result = buildProblems([legacyRun, v2CmdWitness], completeCoverage(2), { now: NOW });
  assert.equal(result.ungroupedLegacy, 0);
  assert.equal(result.entries.length, 2);

  const commandEntry = result.entries.find((entry) => entry.keyStrength === "command");
  const outputEntry = result.entries.find((entry) => entry.keyStrength === "output");
  assert.ok(commandEntry);
  assert.ok(outputEntry);
  assert.equal(commandEntry.fingerprint, cmdFp);
  assert.deepEqual(commandEntry.family, [cmdFp]);
  assert.equal(outputEntry.fingerprint, cmdFp);
  assert.deepEqual(outputEntry.family, [legacyFp]);
});

test("one pass record id counts as passed once for newest linked failure at same timestamp", () => {
  const fix = makeFix({ id: "x1", ts: NOW - 30_000, failureIds: ["f1", "f2"] });
  const f1 = makeFailure({ id: "f1", ts: NOW - 60_000, resolvedBy: fix.id });
  const f2 = makeFailure({ id: "f2", ts: NOW - 60_000, resolvedBy: fix.id });

  const sameTsResult = buildProblems([f1, f2, fix], completeCoverage(3), { now: NOW });
  assert.equal(sameTsResult.entries.length, 1);
  const sameTsEntry = sameTsResult.entries[0]!;
  assert.deepEqual(
    sameTsEntry.attempts.map((attempt) => attempt.outcome),
    ["same_failure", "passed"],
  );
  assert.equal(sameTsEntry.attempts[0]!.failureId, "f1");
  assert.equal(sameTsEntry.attempts[0]!.outcomeRecordId, "f2");
  assert.equal(sameTsEntry.attempts[0]!.outcomeTs, f2.ts);
  assert.equal(sameTsEntry.attempts[1]!.failureId, "f2");
  assert.equal(sameTsEntry.attempts[1]!.outcomeRecordId, "x1");
  assert.equal(sameTsEntry.attempts[1]!.outcomeTs, fix.ts);
  assert.equal(sameTsEntry.counts.attempts, 2);
  assert.equal(sameTsEntry.counts.passed, 1);
  assert.equal(sameTsEntry.counts.same_failure, 1);
  assert.equal(sameTsEntry.latestOutcome, "passed");

  const s1: AgentStamp = { vendor: "claude-code", session: "s1" };
  const s2: AgentStamp = { vendor: "claude-code", session: "s2" };
  const crossFix = makeFix({ id: "x2", ts: NOW - 30_000, failureIds: ["f3", "f4"] });
  const f3 = makeFailure({ id: "f3", ts: NOW - 70_000, resolvedBy: crossFix.id, agent: s1 });
  const f4 = makeFailure({ id: "f4", ts: NOW - 60_000, resolvedBy: crossFix.id, agent: s2 });

  const crossResult = buildProblems([f3, f4, crossFix], completeCoverage(3), { now: NOW });
  assert.equal(crossResult.entries.length, 1);
  const crossEntry = crossResult.entries[0]!;
  assert.deepEqual(
    crossEntry.attempts.map((attempt) => attempt.outcome),
    ["same_failure", "passed"],
  );
  assert.equal(crossEntry.attempts[0]!.failureId, "f3");
  assert.equal(crossEntry.attempts[0]!.outcomeRecordId, "f4");
  assert.equal(crossEntry.attempts[0]!.outcomeTs, f4.ts);
  assert.equal(crossEntry.attempts[0]!.crossSession, true);
  assert.equal(crossEntry.attempts[1]!.failureId, "f4");
  assert.equal(crossEntry.attempts[1]!.outcomeRecordId, "x2");
  assert.equal(crossEntry.attempts[1]!.crossSession, undefined);
  assert.equal(crossEntry.counts.passed, 1);
  assert.equal(crossEntry.counts.same_failure, 1);
  assert.equal(crossEntry.counts.attempts, 2);

  const sameSessionFix = makeFix({ id: "x3", ts: NOW - 30_000, failureIds: ["f5", "f6"] });
  const f5 = makeFailure({ id: "f5", ts: NOW - 60_000, resolvedBy: sameSessionFix.id, agent: s1 });
  const f6 = makeFailure({ id: "f6", ts: NOW - 60_000, resolvedBy: sameSessionFix.id, agent: s1 });

  const sameSessionResult = buildProblems([f5, f6, sameSessionFix], completeCoverage(3), { now: NOW });
  assert.equal(sameSessionResult.entries.length, 1);
  const sameSessionEntry = sameSessionResult.entries[0]!;
  assert.deepEqual(
    sameSessionEntry.attempts.map((attempt) => attempt.outcome),
    ["same_failure", "passed"],
  );
  assert.equal(sameSessionEntry.attempts[0]!.failureId, "f5");
  assert.equal(sameSessionEntry.attempts[0]!.outcomeRecordId, "f6");
  assert.equal(sameSessionEntry.attempts[0]!.outcomeTs, f6.ts);
  assert.equal(sameSessionEntry.attempts[0]!.crossSession, undefined);
  assert.equal("crossSession" in sameSessionEntry.attempts[0]!, false);
  assert.equal(sameSessionEntry.attempts[1]!.failureId, "f6");
  assert.equal(sameSessionEntry.attempts[1]!.outcomeRecordId, "x3");
  assert.equal(sameSessionEntry.attempts[1]!.crossSession, undefined);
  assert.equal("crossSession" in sameSessionEntry.attempts[1]!, false);
  assert.equal(sameSessionEntry.counts.passed, 1);
  assert.equal(sameSessionEntry.counts.same_failure, 1);
  assert.equal(sameSessionEntry.counts.attempts, 2);
});

test("fingerprint filtering preserves ungroupedLegacy count even when filtered out", () => {
  const unprovenLegacy: FailureRecord = {
    ...makeFailure({
      id: "f-legacy-unproven",
      ts: NOW - 60_000,
      fingerprint: "deadbeefdeadbeef",
      signature: ["error: stale or unprovable"],
      excerpt: "Error: stale or unprovable",
    }),
    fingerprintV: undefined,
  };
  const v2Failure = makeFailure({
    id: "f-v2",
    ts: NOW - 30_000,
    fingerprint: "aaaa000000000001",
  });

  const matchOther = buildProblems([unprovenLegacy, v2Failure], completeCoverage(2), {
    now: NOW,
    fingerprint: "aaaa000000000001",
  });
  assert.equal(matchOther.entries.length, 1);
  assert.equal(matchOther.entries[0]!.fingerprint, "aaaa000000000001");
  assert.equal(matchOther.ungroupedLegacy, 1);

  const matchNone = buildProblems([unprovenLegacy, v2Failure], completeCoverage(2), {
    now: NOW,
    fingerprint: "ffffffffffffffff",
  });
  assert.equal(matchNone.entries.length, 0);
  assert.equal(matchNone.ungroupedLegacy, 1);
});

test("selectProblemEntries default listing matches the CLI rule", () => {
  const DAY = 86_400_000;
  const THIRTY_DAYS_MS = 30 * DAY;

  // Kept: 2 recent non-passed attempts in /app (ranks first)
  const a1 = makeFailure({ id: "a1", ts: NOW - 4 * HOUR, fingerprint: "aaaa000000000001", cwd: "/app" });
  const a2 = makeFailure({ id: "a2", ts: NOW - 3 * HOUR, fingerprint: "aaaa000000000001", cwd: "/app" });

  // Kept: 2 recent attempts in /app, one passed -> 1 recent non-passed (ranks second even though newer)
  const bFix = makeFix({ id: "bx", ts: NOW - 30 * 60_000, cwd: "/app", failureIds: ["b2"] });
  const b1 = makeFailure({ id: "b1", ts: NOW - 2 * HOUR, fingerprint: "bbbb000000000002", cwd: "/app" });
  const b2 = makeFailure({ id: "b2", ts: NOW - HOUR, fingerprint: "bbbb000000000002", cwd: "/app", resolvedBy: bFix.id });

  // Dropped: only 1 attempt in /app
  const c1 = makeFailure({ id: "c1", ts: NOW - 20 * 60_000, fingerprint: "cccc000000000003", cwd: "/app" });

  // Dropped: 2 attempts in /app, but one is older than 30 days (only 1 recent)
  const d1 = makeFailure({ id: "d1", ts: NOW - THIRTY_DAYS_MS - 1_000, fingerprint: "dddd000000000004", cwd: "/app" });
  const d2 = makeFailure({ id: "d2", ts: NOW - 10 * 60_000, fingerprint: "dddd000000000004", cwd: "/app" });

  // Other cwd: 2 recent non-passed attempts, newest overall -> dropped unless allDirs
  const e1 = makeFailure({ id: "e1", ts: NOW - 15 * 60_000, fingerprint: "eeee000000000005", cwd: "/other" });
  const e2 = makeFailure({ id: "e2", ts: NOW - 5 * 60_000, fingerprint: "eeee000000000005", cwd: "/other" });

  const records: MemoryRecord[] = [d1, a1, a2, b1, b2, bFix, c1, e1, d2, e2];
  const coverage = completeCoverage(records.length);

  const here = selectProblemEntries(records, coverage, {
    now: NOW,
    cwd: "/app",
    query: undefined,
    allDirs: false,
    limit: 10,
  });
  assert.equal(here.cutoffTs, NOW - THIRTY_DAYS_MS);
  assert.equal(here.set.coverage, coverage);
  assert.equal(here.set.entries.length, 5);
  assert.deepEqual(
    here.entries.map((entry) => entry.fingerprint),
    ["aaaa000000000001", "bbbb000000000002"],
  );

  const all = selectProblemEntries(records, coverage, {
    now: NOW,
    cwd: "/app",
    query: undefined,
    allDirs: true,
    limit: 10,
  });
  assert.equal(all.cutoffTs, NOW - THIRTY_DAYS_MS);
  assert.deepEqual(
    all.entries.map((entry) => entry.fingerprint),
    ["eeee000000000005", "aaaa000000000001", "bbbb000000000002"],
  );

  const limited = selectProblemEntries(records, coverage, {
    now: NOW,
    cwd: "/app",
    query: undefined,
    allDirs: true,
    limit: 2,
  });
  assert.deepEqual(
    limited.entries.map((entry) => entry.fingerprint),
    ["eeee000000000005", "aaaa000000000001"],
  );
});

test("selectProblemEntries fingerprint and query modes", () => {
  const legacySig = ["error: redis socket hung up"];
  const legacyFp = legacyFingerprint("Error: redis socket hung up", "npm test", 1);
  const canonicalFp = fingerprint("Error: redis socket hung up", "npm test", 1);
  assert.notEqual(legacyFp, canonicalFp);

  const fLegacy: FailureRecord = {
    ...makeFailure({
      id: "f-legacy",
      ts: NOW - 4 * HOUR,
      cwd: "/app",
      cmd: "npm test",
      fingerprint: legacyFp,
      signature: legacySig,
      excerpt: "Error: redis socket hung up",
    }),
    fingerprintV: undefined,
  };
  const fV2 = makeFailure({
    id: "f-v2",
    ts: NOW - 3 * HOUR,
    cwd: "/app",
    cmd: "npm test",
    fingerprint: canonicalFp,
    signature: legacySig,
    excerpt: "Error: redis socket hung up",
  });
  const fOtherDirSameFp = makeFailure({
    id: "f-other-dir",
    ts: NOW - 2 * HOUR,
    cwd: "/other",
    cmd: "npm test",
    fingerprint: canonicalFp,
    signature: legacySig,
    excerpt: "Error: redis socket hung up",
  });
  const fSecond = makeFailure({
    id: "f-second",
    ts: NOW - HOUR,
    cwd: "/app",
    cmd: "npm run lint",
    fingerprint: "3333cccc4444dddd",
    signature: ["error: redis timeout on lint"],
    excerpt: "Error: redis timeout on lint",
  });

  const records: MemoryRecord[] = [fLegacy, fV2, fOtherDirSameFp, fSecond];
  const coverage = completeCoverage(records.length);

  // 16-hex canonical fingerprint mode respects cwdScope unless allDirs
  const byFpHere = selectProblemEntries(records, coverage, {
    now: NOW,
    cwd: "/app",
    query: canonicalFp,
    allDirs: false,
    limit: 10,
  });
  assert.equal(byFpHere.cutoffTs, undefined);
  assert.equal(byFpHere.entries.length, 1);
  assert.equal(byFpHere.entries[0]!.fingerprint, canonicalFp);
  assert.equal(byFpHere.entries[0]!.cwd, "/app");

  // 16-hex family member (legacy fingerprint) matches migrated entry
  const byFamily = selectProblemEntries(records, coverage, {
    now: NOW,
    cwd: "/app",
    query: legacyFp,
    allDirs: false,
    limit: 10,
  });
  assert.equal(byFamily.cutoffTs, undefined);
  assert.equal(byFamily.entries.length, 1);
  assert.equal(byFamily.entries[0]!.problemId, byFpHere.entries[0]!.problemId);

  // 16-hex problemId matches entry
  const targetProblemId = byFpHere.entries[0]!.problemId;
  const byProblemId = selectProblemEntries(records, coverage, {
    now: NOW,
    cwd: "/app",
    query: targetProblemId,
    allDirs: false,
    limit: 10,
  });
  assert.equal(byProblemId.cutoffTs, undefined);
  assert.equal(byProblemId.entries.length, 1);
  assert.equal(byProblemId.entries[0]!.problemId, targetProblemId);

  // 16-hex with allDirs returns both cwds and honors limit
  const byFpAll = selectProblemEntries(records, coverage, {
    now: NOW,
    cwd: "/app",
    query: canonicalFp,
    allDirs: true,
    limit: 10,
  });
  assert.equal(byFpAll.entries.length, 2);

  const byFpLimited = selectProblemEntries(records, coverage, {
    now: NOW,
    cwd: "/app",
    query: canonicalFp,
    allDirs: true,
    limit: 1,
  });
  assert.equal(byFpLimited.entries.length, 1);

  // Text query picks via recall hit family, filters cwd, and honors limit
  const byTextAllHere = selectProblemEntries(records, coverage, {
    now: NOW,
    cwd: "/app",
    query: "redis",
    allDirs: false,
    limit: 10,
  });
  assert.equal(byTextAllHere.cutoffTs, undefined);
  assert.equal(byTextAllHere.entries.length, 2);
  assert.deepEqual(
    new Set(byTextAllHere.entries.map((entry) => entry.fingerprint)),
    new Set([canonicalFp, "3333cccc4444dddd"]),
  );

  const byTextLimited = selectProblemEntries(records, coverage, {
    now: NOW,
    cwd: "/app",
    query: "redis",
    allDirs: false,
    limit: 1,
  });
  assert.equal(byTextLimited.cutoffTs, undefined);
  assert.equal(byTextLimited.entries.length, 1);

  // Text query with allDirs includes other directory entry too
  const byTextAllDirs = selectProblemEntries(records, coverage, {
    now: NOW,
    cwd: "/app",
    query: "redis",
    allDirs: true,
    limit: 10,
  });
  assert.equal(byTextAllDirs.entries.length, 3);
});

