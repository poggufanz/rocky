import assert from "node:assert/strict";
import test from "node:test";
import { buildProblems, type Attempt, type ProblemEntry } from "../core/attempts.js";
import { commandIdentity } from "../core/fingerprint.js";
import {
  MEMORY_FORMAT_VERSION,
  type AgentStamp,
  type AssociationRecord,
  type FailureRecord,
  type FixRecord,
  type MemoryCoverage,
  type MemoryRecord,
  type RationaleRecord,
} from "../core/memory-read.js";
import {
  ATTEMPT_HISTORY_NOTICE,
  projectProblemEntries,
} from "../mcp/attempts-projection.js";
import type { Truncation } from "../mcp/privacy.js";
import { causalWordViolations } from "./causal-words.js";

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

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
  const platform = overrides.platform ?? "linux";
  const identity = commandIdentity(cmd, { platform });
  return {
    kind: "failure",
    cwd: "/workspace/app",
    cmd,
    exitCode: 1,
    fingerprint: "1111222233334444",
    fingerprintV: 2,
    signature: ["error: assertion failed"],
    excerpt: "Error: assertion failed",
    origin: "run",
    commandIdentity: identity.value,
    identityV: 1,
    identityReliable: identity.reliable,
    platform,
    ...overrides,
  };
}

function makeFix(overrides: Partial<FixRecord> & { id: string; ts: number }): FixRecord {
  const cmd = overrides.cmd ?? "npm test";
  const platform = overrides.platform ?? "linux";
  const identity = commandIdentity(cmd, { platform });
  return {
    kind: "fix",
    cwd: "/workspace/app",
    cmd,
    failureIds: [],
    commandIdentity: identity.value,
    identityV: 1,
    identityReliable: identity.reliable,
    platform,
    ...overrides,
  };
}

function makeRationale(overrides: Partial<RationaleRecord> & { id: string; ts: number }): RationaleRecord {
  return {
    kind: "rationale",
    v: 1,
    cwd: "/workspace/app",
    agent: "claude-code",
    rationale_fidelity: "summary",
    source: "notify",
    excerpt: "adjust retry limit",
    ...overrides,
  };
}

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
  } else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
  return out;
}

test("sanitized keeps only files inside the failure directory", () => {
  const failure = makeFailure({ id: "failure-1", ts: NOW - 10 * MINUTE, cwd: "/workspace/app" });
  const rationale = makeRationale({
    id: "rationale-1",
    ts: NOW - 9 * MINUTE,
    cwd: "/workspace/app",
    links: { failureId: failure.id },
    files: ["src/a.ts", "../secret", "/etc/passwd", "./b/c.ts"],
  });
  const set = buildProblems([failure, rationale], completeCoverage(2), { now: NOW, cwd: "/workspace/app" });
  const truncation: Truncation = { fields: [] };
  const projected = projectProblemEntries(set.entries, "sanitized", 10, truncation);

  assert.equal(projected.length, 1);
  const changes = projected[0]!.attempts[0]!.changes;
  assert.deepEqual(changes, {
    state: "testimony",
    files: ["src/a.ts", "b/c.ts"],
    more: 2,
  });

  const json = JSON.stringify(projected);
  assert.equal(json.includes("secret"), false);
  assert.equal(json.includes("passwd"), false);

  // Also verify cross-platform outside paths: Windows outside path under POSIX cwd
  const crossFailure = makeFailure({ id: "failure-cross", ts: NOW - 8 * MINUTE, cwd: "/workspace/app" });
  const crossRationale = makeRationale({
    id: "rationale-cross",
    ts: NOW - 7 * MINUTE,
    cwd: "/workspace/app",
    links: { failureId: crossFailure.id },
    files: ["src/a.ts", "C:\\Users\\x\\.ssh\\id", "foo\\..\\..\\escape.txt", "/workspace/app-other/leak.ts", "./b/c.ts"],
  });
  const crossSet = buildProblems([crossFailure, crossRationale], completeCoverage(2), { now: NOW, cwd: "/workspace/app" });
  const crossProjected = projectProblemEntries(crossSet.entries, "sanitized", 10, { fields: [] });
  assert.deepEqual(crossProjected[0]!.attempts[0]!.changes, {
    state: "testimony",
    files: ["src/a.ts", "b/c.ts"],
    more: 3,
  });
  const crossJson = JSON.stringify(crossProjected);
  assert.equal(crossJson.includes(".ssh"), false);
  assert.equal(crossJson.includes("escape.txt"), false);
  assert.equal(crossJson.includes("leak.ts"), false);

  // Also verify Windows cwd with POSIX outside path, Windows outside path, and inside backslashes
  const winFailure = makeFailure({
    id: "failure-win",
    ts: NOW - 6 * MINUTE,
    cwd: "C:\\work\\app",
    platform: "win32",
  });
  const winRationale = makeRationale({
    id: "rationale-win",
    ts: NOW - 5 * MINUTE,
    cwd: "C:\\work\\app",
    links: { failureId: winFailure.id },
    files: [
      "src\\a.ts",
      "..\\secret",
      "C:\\Users\\x\\.ssh\\id",
      "/etc/passwd",
      "D:\\other\\drive.ts",
      ".\\b\\c.ts",
      "C:\\work\\app\\lib\\d.ts",
    ],
  });
  const winSet = buildProblems([winFailure, winRationale], completeCoverage(2), {
    now: NOW,
    cwd: "C:\\work\\app",
    platform: "win32",
  });
  const winProjected = projectProblemEntries(winSet.entries, "sanitized", 10, { fields: [] });
  assert.deepEqual(winProjected[0]!.attempts[0]!.changes, {
    state: "testimony",
    files: ["src/a.ts", "b/c.ts", "lib/d.ts"],
    more: 4,
  });
  const winJson = JSON.stringify(winProjected);
  assert.equal(winJson.includes("secret"), false);
  assert.equal(winJson.includes(".ssh"), false);
  assert.equal(winJson.includes("passwd"), false);
  assert.equal(winJson.includes("drive.ts"), false);
});

test("files cap at 8 with overflow in more", () => {
  const f1 = makeFailure({ id: "failure-1", ts: NOW - 10 * MINUTE });
  const f2 = makeFailure({ id: "failure-2", ts: NOW - 8 * MINUTE });
  const f3 = makeFailure({ id: "failure-3", ts: NOW - 6 * MINUTE });
  const tenFiles = Array.from({ length: 10 }, (_, i) => `src/file-${i}.ts`);
  const set = buildProblems([f1, f2, f3], completeCoverage(3), { now: NOW, cwd: "/workspace/app" });
  const entry = set.entries[0]!;

  // Enrich attempt 0 as observed with partial: true, existing more: 3, 10 inside files + 1 outside
  entry.attempts[0]!.changes = {
    state: "observed",
    files: ["../outside.ts", ...tenFiles],
    more: 3,
    cardId: "card-secret-123",
    partial: true,
  };
  // Enrich attempt 1 as observed with partial: false
  entry.attempts[1]!.changes = {
    state: "observed",
    files: ["src/one.ts"],
    more: 0,
    cardId: "card-secret-456",
    partial: false,
  };
  // Attempt 2 remains unknown

  const sanitized = projectProblemEntries(set.entries, "sanitized", 10, { fields: [] });
  const s0 = sanitized[0]!.attempts[0]!.changes;
  assert.equal(s0.state, "observed");
  assert.deepEqual(s0.files, tenFiles.slice(0, 8));
  assert.equal(s0.more, 3 + 1 + 2);
  assert.equal(s0.partial, true);
  assert.equal("cardId" in s0, false);

  const s1 = sanitized[0]!.attempts[1]!.changes;
  assert.deepEqual(s1, { state: "observed", files: ["src/one.ts"], more: 0 });
  assert.equal("partial" in s1, false);

  const s2 = sanitized[0]!.attempts[2]!.changes;
  assert.deepEqual(s2, { state: "unknown", files: [], more: 0 });

  const raw = projectProblemEntries(set.entries, "raw", 10, { fields: [] });
  const r0 = raw[0]!.attempts[0]!.changes;
  assert.equal(r0.state, "observed");
  assert.deepEqual(r0.files, ["../outside.ts", ...tenFiles.slice(0, 7)]);
  assert.equal(r0.more, 3 + 3);
  assert.equal(r0.partial, true);
  assert.equal("cardId" in r0, false);
});

test("sanitized carries no cwd, session, or record internals", () => {
  const s1: AgentStamp = { vendor: "claude-code", session: "sess-alpha", agentId: "agent-7" };
  const s2: AgentStamp = { vendor: "claude-code", session: "sess-beta" };
  const cwd = "/home/private-user/secret-repo";
  const fix = makeFix({ id: "fix-1", ts: NOW - 4 * MINUTE, cwd, failureIds: ["failure-1"], agent: s2 });
  const failure = makeFailure({
    id: "failure-1",
    ts: NOW - 5 * MINUTE,
    cwd,
    agent: s1,
    resolvedBy: fix.id,
    signature: ["line 1", "line 2", "line 3", "line 4 dropped"],
  });
  const rationale = makeRationale({
    id: "rationale-1",
    ts: NOW - 4.5 * MINUTE,
    cwd,
    links: { failureId: failure.id },
    excerpt: "try a smaller batch size",
    files: ["src/batch.ts"],
  });

  const set = buildProblems([failure, fix, rationale], completeCoverage(3), { now: NOW });
  const entry = set.entries[0]!;
  entry.attempts[0]!.expectations = [
    { text: "should pass", command: "npm test", rationaleId: "rationale-1", observed: "same_command_passed" },
  ];

  const truncation: Truncation = { fields: [] };
  const projected = projectProblemEntries(set.entries, "sanitized", 10, truncation);
  assert.equal(projected.length, 1);

  const pEntry = projected[0]!;
  assert.equal(pEntry.cwdScope, "elsewhere");
  assert.equal("cwd" in pEntry, false);
  assert.equal(pEntry.firstSeen, entry.firstSeenTs);
  assert.equal(pEntry.lastSeen, entry.lastSeenTs);
  assert.equal(pEntry.problemId, entry.problemId);
  assert.equal(pEntry.fingerprint, entry.fingerprint);
  assert.deepEqual(pEntry.signature, ["line 1", "line 2", "line 3"]);

  const json = JSON.stringify(projected);
  for (const forbidden of [
    cwd,
    "private-user",
    "secret-repo",
    "session",
    "sessionScoped",
    "crossSession",
    "unknownReason",
    "outcomeRecordId",
    "family",
    "\"key\"",
    "expectations",
    "rationaleId",
    "cardId",
    "recordId",
    "line 4 dropped",
  ]) {
    assert.equal(json.includes(forbidden), false, `expected sanitized output to omit ${forbidden}`);
  }

  // Sensitive failureId is redacted via projectOpaqueId
  const sensitiveFailure = makeFailure({ id: "api-token-leak-99", ts: NOW - 3 * MINUTE, cwd });
  const sensitiveSet = buildProblems([sensitiveFailure], completeCoverage(1), { now: NOW, cwd });
  const sensitiveProjected = projectProblemEntries(sensitiveSet.entries, "sanitized", 10, { fields: [] });
  assert.equal(sensitiveProjected[0]!.cwdScope, "here");
  assert.equal(sensitiveProjected[0]!.attempts[0]!.failureId, "[redacted]");
});

test("raw carries cwd and stored file strings", () => {
  const cwd = "/workspace/raw-repo";
  const failure = makeFailure({ id: "failure-raw-1", ts: NOW - 5 * MINUTE, cwd });
  const rationale = makeRationale({
    id: "rationale-raw-1",
    ts: NOW - 4 * MINUTE,
    cwd,
    links: { failureId: failure.id },
    files: ["src/a.ts", "../secret", "/etc/passwd", "./b/c.ts"],
  });
  const set = buildProblems([failure, rationale], completeCoverage(2), { now: NOW, cwd });
  const projected = projectProblemEntries(set.entries, "raw", 10, { fields: [] });

  assert.equal(projected.length, 1);
  assert.equal(projected[0]!.cwd, cwd);
  assert.equal(projected[0]!.cwdScope, "here");
  assert.deepEqual(projected[0]!.attempts[0]!.changes, {
    state: "testimony",
    files: ["src/a.ts", "../secret", "/etc/passwd", "./b/c.ts"],
    more: 0,
  });
});

test("attempts keep the newest N and count the rest", () => {
  const records: MemoryRecord[] = Array.from({ length: 5 }, (_, i) =>
    makeFailure({
      id: `failure-${i + 1}`,
      ts: NOW - (5 - i) * MINUTE,
      cmd: `npm test -- --run=${i + 1}`,
    }),
  );
  const set = buildProblems(records, completeCoverage(5), { now: NOW, cwd: "/workspace/app" });
  const projected = projectProblemEntries(set.entries, "sanitized", 2, { fields: [] });

  assert.equal(projected.length, 1);
  const pEntry = projected[0]!;
  assert.equal(pEntry.attemptsOmitted, 3);
  assert.equal(pEntry.attempts.length, 2);
  assert.deepEqual(
    pEntry.attempts.map((a) => a.failureId),
    ["failure-4", "failure-5"],
  );
  assert.equal(pEntry.attempts[0]!.ts < pEntry.attempts[1]!.ts, true);
  assert.equal(pEntry.firstSeen, set.entries[0]!.firstSeenTs);
  assert.equal(pEntry.lastSeen, set.entries[0]!.lastSeenTs);
  assert.equal(pEntry.counts.attempts, 5);
});

test("stated text is redacted and capped at 240", () => {
  const failure = makeFailure({ id: "failure-stated", ts: NOW - 5 * MINUTE });
  const longProse = "retry logic check ".repeat(20);
  const rationale = makeRationale({
    id: "rationale-stated",
    ts: NOW - 4 * MINUTE,
    links: { failureId: failure.id },
    excerpt: `check https://internal.example.com/path with Bearer supersecrettokenvalue123 ${longProse}`,
  });
  const set = buildProblems([failure, rationale], completeCoverage(2), { now: NOW, cwd: "/workspace/app" });
  const truncation: Truncation = { fields: [] };
  const projected = projectProblemEntries(set.entries, "sanitized", 10, truncation);

  const stated = projected[0]!.attempts[0]!.stated;
  assert.ok(stated !== undefined);
  assert.equal(stated.source, "rationale");
  assert.equal(stated.testimony, true);
  assert.equal("recordId" in stated, false);
  assert.equal(stated.text.includes("internal.example.com"), false);
  assert.equal(stated.text.includes("supersecrettokenvalue123"), false);
  assert.equal(stated.text.includes("[redacted]"), true);
  assert.equal(Array.from(stated.text).length, 240);
  assert.equal(truncation.fields.length > 0, true);

  // Also verify code-point slicing does not split astral surrogate pairs
  const astralFailure = makeFailure({ id: "failure-astral", ts: NOW - 3 * MINUTE });
  const astralRationale = makeRationale({
    id: "rationale-astral",
    ts: NOW - 2 * MINUTE,
    links: { failureId: astralFailure.id },
    excerpt: `${"a ".repeat(119)}\u{1D306} tail text after cap`,
  });
  const astralSet = buildProblems([astralFailure, astralRationale], completeCoverage(2), {
    now: NOW,
    cwd: "/workspace/app",
  });
  const astralProjected = projectProblemEntries(astralSet.entries, "sanitized", 10, { fields: [] });
  const astralStated = astralProjected[0]!.attempts[0]!.stated!;
  assert.equal(Array.from(astralStated.text).length, 240);
  assert.equal(astralStated.text.endsWith("\u{1D306} "), true);
});

test("no causal words in projected text", () => {
  const f1 = makeFailure({ id: "failure-1", ts: NOW - 20 * MINUTE, cmd: "npm test" });
  const f2 = makeFailure({ id: "failure-2", ts: NOW - 18 * MINUTE, cmd: "npm test" });
  const f3 = makeFailure({
    id: "failure-3",
    ts: NOW - 16 * MINUTE,
    cmd: "npm test",
    fingerprint: "5555666677778888",
    signature: ["error: different failure"],
  });
  const fix = makeFix({ id: "fix-1", ts: NOW - 14 * MINUTE, cmd: "npm test", failureIds: ["failure-3"] });
  f3.resolvedBy = fix.id;
  const f4 = makeFailure({
    id: "failure-4",
    ts: NOW - 12 * MINUTE,
    cmd: "npm run lint",
    fingerprint: "9999aaaabbbbcccc",
    signature: ["error: lint warning"],
  });
  const assoc: AssociationRecord = {
    kind: "association",
    id: "assoc-1",
    ts: NOW - 10 * MINUTE,
    cwd: "/workspace/app",
    cmd: "npm run build",
    candidateFailureIds: ["failure-4"],
    links: [{ id: "failure-4", basis: "program", confidence: "possible" }],
  };
  const r1 = makeRationale({
    id: "rationale-1",
    ts: NOW - 19 * MINUTE,
    links: { failureId: "failure-1" },
    excerpt: "adjust timeout threshold",
    files: ["src/retry.ts"],
  });

  const set = buildProblems([f1, f2, f3, fix, f4, assoc, r1], completeCoverage(7), {
    now: NOW,
    cwd: "/workspace/app",
  });
  const entries: ProblemEntry[] = set.entries;
  const firstAttempt: Attempt = entries[0]!.attempts[0]!;
  firstAttempt.changes = {
    state: "observed",
    files: ["src/retry.ts"],
    more: 1,
    cardId: "card-1",
    partial: true,
  };

  const sanitized = projectProblemEntries(entries, "sanitized", 10, { fields: [] });
  const raw = projectProblemEntries(entries, "raw", 10, { fields: [] });

  // Verify outcomeTs and nextFingerprint pass through where present
  const diffEntry = sanitized.find((e) => e.fingerprint === "1111222233334444");
  assert.ok(diffEntry !== undefined);
  assert.equal(diffEntry.attempts[1]!.outcome, "different_failure");
  assert.equal(diffEntry.attempts[1]!.outcomeTs, f3.ts);
  assert.equal(diffEntry.attempts[1]!.nextFingerprint, "5555666677778888");

  const allStrings = [
    ATTEMPT_HISTORY_NOTICE,
    ...collectStrings(sanitized),
    ...collectStrings(raw),
  ];
  assert.deepEqual(causalWordViolations(allStrings), []);
});
