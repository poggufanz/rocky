import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureRationales, weakLinkFor } from "../agent/logs/capture.js";
import type { CanonicalRationaleEvent, LogAdapter } from "../agent/logs/types.js";
import { groupSessions, sessionsCommand } from "../commands/sessions.js";
import { why } from "../commands/dictionary.js";
import { pendingPath, recordTriple, resolveFixOnSuccess } from "../core/memory.js";
import { cwdIdentityKey, loadMemory, sameCwd } from "../core/memory-read.js";
import type { AssociationRecord, FailureRecord, FixRecord, MemoryRecord, RationaleRecord } from "../core/memory-read.js";
import {
  fixFromElsewhere,
  getFix,
  possibleFixesForFailure,
  queryRecall,
  queryRecentFailures,
  queryStats,
  recentUnresolvedFailures,
} from "../core/memory-query.js";

// One directory, several spellings. The Git Bash hook records the MSYS-converted
// `C:/...`; `rocky run` and the PowerShell hook record `C:\...`. Equality widens
// for exactly this on win32 and nowhere else, so every site below asserts both
// directions: the same directory links where it may, and a different directory
// or a POSIX spelling difference never does.
type Platform = NodeJS.Platform | "unknown";

const GIT_BASH = "C:/Users/x/p";
const NATIVE = "C:\\Users\\x\\p";
const OTHER = "C:\\Users\\x\\q";
const WIDENS = process.platform === "win32";

const MINUTE = 60_000;
const NOW = Date.now();

// --- the helper itself: explicit platform, so every OS runs the whole table --

const TABLE: ReadonlyArray<readonly [string, string, Platform, boolean, string]> = [
  ["C:/Users/x/p", "C:\\Users\\x\\p", "win32", true, "forward versus back slash"],
  ["c:\\users\\x\\p", "C:\\Users\\x\\p\\", "win32", true, "drive and folder case plus a trailing separator"],
  ["C:\\a", "C:\\b", "win32", false, "different directories"],
  ["/home/x/p", "/home/x/p/", "linux", false, "a POSIX trailing separator is a different spelling"],
  ["/home/X", "/home/x", "linux", false, "POSIX is case sensitive"],
  ["C:\\a", "C:\\ab", "win32", false, "a shared prefix is not the same directory"],
  ["C:\\a\\b", "C:\\a", "win32", false, "a child is not its parent"],
  ["C:/Users/x/p//", "C:\\Users\\x\\p", "win32", true, "repeated trailing separators"],
  ["C:\\", "C:/", "win32", true, "a drive root keeps its separator in both spellings"],
  ["C:\\", "C:", "win32", false, "the drive root is not that drive's working directory"],
  ["\\", "", "win32", false, "the current-drive root is not an empty cwd"],
  ["//SERVER/share/p/", "\\\\server\\share\\p", "win32", true, "UNC spellings"],
  ["", "", "win32", true, "two empty cwds stay equal"],
  ["C:/Users/x/p", "C:\\Users\\x\\p", "unknown", false, "an unknown platform compares exactly"],
  ["C:/Users/x/p", "C:\\Users\\x\\p", "darwin", false, "a non-Windows platform compares exactly"],
  ["/Users/x/p", "/users/x/p", "darwin", false, "macOS compares exactly too"],
  ["/a\\b", "/a/b", "linux", false, "a backslash is an ordinary POSIX name character"],
];

for (const [a, b, platform, expected, reason] of TABLE) {
  test(`sameCwd(${JSON.stringify(a)}, ${JSON.stringify(b)}, ${platform}) is ${expected}: ${reason}`, () => {
    assert.equal(sameCwd(a, b, platform), expected);
    assert.equal(sameCwd(b, a, platform), expected, "symmetric");
    assert.equal(sameCwd(a, a, platform), true, "reflexive");
    assert.equal(sameCwd(b, b, platform), true, "reflexive");
    assert.equal(
      cwdIdentityKey(a, platform) === cwdIdentityKey(b, platform),
      expected,
      "the grouping key must agree with the comparison",
    );
  });
}

test("sameCwd fails closed on a malformed in-memory cwd instead of throwing", () => {
  const malformed = undefined as unknown as string;
  assert.equal(sameCwd(malformed, NATIVE, "win32"), false);
  assert.equal(sameCwd(NATIVE, malformed, "win32"), false);
});

// --- fix linking: the primary bug --------------------------------------------

function failureAt(cwd: string, id = "f1", ts = NOW - 10 * MINUTE): FailureRecord {
  return {
    kind: "failure", id, ts, cwd, cmd: "node fail.js", exitCode: 1,
    fingerprint: `fp-${id}`, signature: ["module missing"], excerpt: "module missing",
  };
}

function fixAt(cwd: string, failureIds: string[], id = "x1", ts = NOW - 5 * MINUTE): FixRecord {
  return { kind: "fix", id, ts, cwd, cmd: "node fail.js", failureIds };
}

function seedMemory(records: readonly object[]): { home: string; path: string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rocky-samecwd-")));
  const path = join(home, "memory.jsonl");
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  return { home, path };
}

test("a success heard under another spelling of the directory links, confirmed, only where spellings may widen", () => {
  const links = recentUnresolvedFailures([failureAt(GIT_BASH)], "node fail.js", { cwd: NATIVE, now: NOW });
  assert.equal(links.length, WIDENS ? 1 : 0);
  if (WIDENS) {
    assert.equal(links[0].confidence, "confirmed");
    assert.equal(links[0].basis, "identity");
  }
  assert.deepEqual(
    recentUnresolvedFailures([failureAt(GIT_BASH)], "node fail.js", { cwd: OTHER, now: NOW }),
    [],
    "a different directory never links",
  );
});

test("the loader resolves across spellings, every record keeps its own spelling, and the fix is not 'from elsewhere'", () => {
  const { path } = seedMemory([failureAt(GIT_BASH), fixAt(NATIVE, ["f1"])]);
  const loaded = loadMemory(path, NOW);
  const failure = loaded.find((record): record is FailureRecord => record.kind === "failure")!;
  const fix = loaded.find((record): record is FixRecord => record.kind === "fix")!;
  assert.equal(failure.resolvedBy, WIDENS ? "x1" : undefined);
  assert.equal(failure.cwd, GIT_BASH, "records keep the spelling they were heard under");
  assert.equal(fix.cwd, NATIVE);
  assert.equal(queryStats(loaded, { now: NOW }).resolved, WIDENS ? 1 : 0);
  assert.equal(fixFromElsewhere(fix, failure.cwd), WIDENS ? undefined : NATIVE);
  assert.equal(getFix(loaded, failure, NOW)?.id, "x1", "reachable as a local fix or as a fix from elsewhere");
});

test("a fix from a different directory is still reported as from elsewhere, on every platform", () => {
  const fix = fixAt(OTHER, ["f1"]);
  assert.equal(fixFromElsewhere(fix, NATIVE), OTHER);
  assert.equal(fixFromElsewhere(fix, GIT_BASH), OTHER);
});

test("an unconfirmed fix from the same directory is never served as a fix from elsewhere, whatever its spelling", () => {
  const unconfirmed = failureAt(GIT_BASH);
  assert.equal(getFix([unconfirmed, fixAt(GIT_BASH, ["f1"])], unconfirmed, NOW), undefined);
  assert.equal(getFix([unconfirmed, fixAt(NATIVE, ["f1"])], unconfirmed, NOW)?.id, WIDENS ? undefined : "x1");
  assert.equal(getFix([unconfirmed, fixAt(OTHER, ["f1"])], unconfirmed, NOW)?.id, "x1", "a different directory is still elsewhere");
});

test("crash recovery clears pending for a resolution heard under other spellings of this directory", async () => {
  await withHome([failureAt(GIT_BASH), fixAt(NATIVE, ["f1"])], () => {
    writeFileSync(pendingPath(), "", "utf8");
    const result = resolveFixOnSuccess("node fail.js", "c:/USERS/x/p/");
    assert.deepEqual(result, { confirmedResolved: 0, possibleAssociated: 0 });
    assert.equal(existsSync(pendingPath()), !WIDENS, "only a same-directory resolution may clear the pending marker");
  });
});

test("a directory that merely shares a name prefix never links", () => {
  const sibling = failureAt("C:\\Users\\x\\p-other");
  assert.deepEqual(recentUnresolvedFailures([sibling], "node fail.js", { cwd: NATIVE, now: NOW }), []);
});

// --- scope filters and provenance --------------------------------------------

test("cwd scope: recall, recent failures, and stats find a directory under any spelling of it", () => {
  const records: MemoryRecord[] = [failureAt(GIT_BASH)];
  const here = { cwd: NATIVE, now: NOW };
  assert.equal(queryRecall(records, { query: "module missing", ...here }).length, WIDENS ? 1 : 0);
  assert.equal(queryRecentFailures(records, here).length, WIDENS ? 1 : 0);
  assert.equal(queryStats(records, here).failures, WIDENS ? 1 : 0);
  const elsewhere = { cwd: OTHER, now: NOW };
  assert.equal(queryRecall(records, { query: "module missing", ...elsewhere }).length, 0);
  assert.equal(queryRecentFailures(records, elsewhere).length, 0);
  assert.equal(queryStats(records, elsewhere).failures, 0);
});

test("a possible fix from the same directory is not 'from elsewhere' under another spelling, and keeps its own spelling", () => {
  const failure = failureAt(GIT_BASH);
  const association = (cwd: string): AssociationRecord => ({
    kind: "association", id: "a1", ts: NOW - MINUTE, cwd, cmd: "node other.js",
    candidateFailureIds: ["f1"], links: [{ id: "f1", basis: "program", confidence: "possible" }],
  });
  const [same] = possibleFixesForFailure([failure, association(NATIVE)], failure, NOW);
  assert.equal(same.fromElsewhere, !WIDENS);
  assert.equal(same.cwd, NATIVE);
  const [other] = possibleFixesForFailure([failure, association(OTHER)], failure, NOW);
  assert.equal(other.fromElsewhere, true);
});

// --- sessions ----------------------------------------------------------------

const rec = (kind: string, id: string, ts: number, cwd: string): MemoryRecord =>
  ({ kind, id, ts, cwd } as unknown as MemoryRecord);

test("sessions: two spellings of one directory form one session, a different directory stays apart", () => {
  const groups = groupSessions([
    rec("failure", "f1", NOW - 10 * MINUTE, GIT_BASH),
    rec("fix", "x1", NOW - 9 * MINUTE, NATIVE),
    rec("failure", "f2", NOW - 8 * MINUTE, OTHER),
  ]);
  assert.equal(groups.length, WIDENS ? 2 : 3);
  const withFix = groups.find((group) => group.counts.fixes === 1)!;
  assert.equal(withFix.counts.failures, WIDENS ? 1 : 0);
  assert.ok([GIT_BASH, NATIVE].includes(withFix.cwd), "a group shows a spelling that was heard, never a normalized one");
  assert.equal(groups.find((group) => group.cwd === OTHER)?.counts.failures, 1);
});

function captureStderr(run: () => number): { code: number; stderr: string } {
  const original = process.stderr.write;
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { code: run(), stderr };
  } finally {
    process.stderr.write = original;
  }
}

test("sessions detail lists every member of a merged session, whichever spelling it was heard under", () => {
  const { home } = seedMemory([failureAt(GIT_BASH), fixAt(NATIVE, ["f1"])]);
  const saved = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  try {
    const { code, stderr } = captureStderr(() => sessionsCommand(["1"]));
    assert.equal(code, 0);
    assert.match(stderr, /fixed 1 failure/);
    assert.equal(/module missing/.test(stderr), WIDENS, "the failure joins the fix's session only on Windows");
  } finally {
    if (saved === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = saved;
  }
});

// --- rationale lanes ---------------------------------------------------------

test("weakLinkFor links evidence heard under another spelling of the directory, never a different directory", () => {
  const records: MemoryRecord[] = [failureAt(GIT_BASH)];
  assert.deepEqual(weakLinkFor(records, NOW - 9 * MINUTE, NATIVE, NOW), WIDENS ? { failureId: "f1" } : undefined);
  assert.equal(weakLinkFor(records, NOW - 9 * MINUTE, OTHER, NOW), undefined);
});

function scriptedAdapter(event: CanonicalRationaleEvent): LogAdapter {
  return {
    agent: "claude-code",
    discover: () => [event.logPath],
    scan: () => ({ events: [event], nextOffset: 1 }),
  };
}

function eventAt(ts: number, touchedFiles?: string[]): CanonicalRationaleEvent {
  return {
    agent: "claude-code", sessionId: "s1", turnRef: "u1", ts, text: "a thought",
    fidelity: "raw", source: "log-thinking", logPath: "/fake/s1.jsonl",
    ...(touchedFiles === undefined ? {} : { touchedFiles }),
  };
}

function isRationale(record: { kind: string }): record is RationaleRecord {
  return record.kind === "rationale";
}

/** Run `run` against a fresh ROCKY_HOME, seeded with `records` when there are any. */
async function withHome<T>(records: readonly object[], run: () => Promise<T> | T): Promise<T> {
  const home = records.length > 0
    ? seedMemory(records).home
    : realpathSync(mkdtempSync(join(tmpdir(), "rocky-samecwd-")));
  const saved = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  try {
    return await run();
  } finally {
    if (saved === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = saved;
  }
}

test("captureRationales weak-links to a failure heard under another spelling of the repo directory", async () => {
  await withHome([failureAt(GIT_BASH, "f1", NOW - 5 * MINUTE)], () => {
    const result = captureRationales(NATIVE, NOW, { adapters: [scriptedAdapter(eventAt(NOW - 4 * MINUTE))] });
    assert.equal(result.written, 1);
    assert.equal(result.unlinked, WIDENS ? 0 : 1);
    const rationale = loadMemory().find(isRationale);
    assert.equal(rationale?.links?.failureId, WIDENS ? "f1" : undefined);
  });
});

test("captureRationales structurally links a touched file to a triple heard under another spelling of the repo directory", async () => {
  const touched = "/work/repo/src/q.ts";
  await withHome([], () => {
    const triple = recordTriple({
      ts: NOW - 5 * MINUTE,
      cwd: GIT_BASH,
      agent: "claude-code",
      mechanism: { files: [{ path: touched, plusMinus: [1, 1], props: [] }], truncatedFiles: 0 },
    });
    const result = captureRationales(NATIVE, NOW, { adapters: [scriptedAdapter(eventAt(NOW - 4 * MINUTE, [touched]))] });
    assert.equal(result.written, 1);
    const rationale = loadMemory().find(isRationale);
    assert.equal(rationale?.links?.tripleId, WIDENS ? triple.id : undefined);
  });
});

test("why --add links to the newest failure heard under another spelling of this directory", async () => {
  const here = process.cwd();
  const respelled = WIDENS ? here.replaceAll("\\", "/") : `${here}/`;
  await withHome([failureAt(respelled, "f1", NOW - 5 * MINUTE)], () => {
    assert.equal(why(["--add", "spelling does not matter"], { say: () => undefined, now: NOW }), 0);
    const rationale = loadMemory().find(isRationale);
    assert.equal(rationale?.links?.failureId, WIDENS ? "f1" : undefined);
  });
});
