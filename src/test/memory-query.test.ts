import test from "node:test";
import assert from "node:assert/strict";
import type { AssociationRecord, FailureRecord, FixRecord, MemoryRecord, NoteRecord, TripleRecord } from "../core/memory.js";
import { fingerprint, fingerprintSignature, legacyFingerprint, signatureLines } from "../core/fingerprint.js";
import { pathIdentityHash } from "../core/memory-read.js";
import {
  LINK_WINDOW_MS,
  createMemoryQueries,
  fetchRecord,
  findByFingerprint,
  possibleFixesForFailure,
  queryRecall,
  queryRecentFailures,
  queryStats,
  recentUnresolvedFailures,
  searchKnowledge,
  whyFile,
  whyFileEvidence,
  getFix,
} from "../core/memory-query.js";

const failureA: FailureRecord = {
  kind: "failure", id: "f1", ts: 100, cwd: "/work/a", cmd: "npm test",
  exitCode: 1, fingerprint: "fp-a", signature: ["module missing"], excerpt: "module missing",
};
const failureB: FailureRecord = {
  kind: "failure", id: "f2", ts: 200, cwd: "/work/b", cmd: "npm test",
  exitCode: 1, fingerprint: "fp-b", signature: ["type error"], excerpt: "type error",
  origin: "hook",
};
const fixA: FixRecord = {
  kind: "fix", id: "x1", ts: 300, cwd: "/work/a", cmd: "npm install", failureIds: ["f1"],
};
const records: MemoryRecord[] = [{ ...failureA, resolvedBy: "x1" }, failureB, fixA];

const tripleA: TripleRecord = {
  kind: "triple", id: "t1", ts: 400, cwd: "/work/a", schemaV: 1,
  agent: "codex", origin: "agent-hook", intent: { text: "naikin button" },
  rationale: { text: "spacing", tags: ["margin"], source: "transcript" },
  mechanism: {
    files: [{ path: "src/app.css", plusMinus: [2, 1], props: ["margin-top"] }],
    truncatedFiles: 0,
  },
};

test("queryStats applies cwd consistently", () => {
  assert.deepEqual(queryStats(records), {
    failures: 2, fixEvents: 1, resolved: 1, unresolved: 1,
    confirmedFixes: 1, possibleFixes: 0, triples: 0, notes: 0, total: 3,
  });
  assert.deepEqual(queryStats(records, { cwd: "/work/a" }), {
    failures: 1, fixEvents: 1, resolved: 1, unresolved: 0,
    confirmedFixes: 1, possibleFixes: 0, triples: 0, notes: 0, total: 2,
  });
});

test("queryRecentFailures is newest-first and filters unresolved", () => {
  const hits = queryRecentFailures(records, { unresolvedOnly: true, limit: 10 });
  assert.deepEqual(hits.map((hit) => hit.failure.id), ["f2"]);
});

test("queryRecall preserves fuzzy matching and exact cwd filter", () => {
  assert.deepEqual(queryRecall(records, { query: "module missing", cwd: "/work/a" }).map((hit) => hit.failure.id), ["f1"]);
  assert.deepEqual(queryRecall(records, { query: "module missing", cwd: "/work/b" }), []);
});

test("queryRecall preserves explicit zero limit", () => {
  assert.deepEqual(queryRecall([failureA], { query: "module missing", limit: 0 }), []);
});

test("queryRecall deduplicates a fingerprint family before applying limit ordering", () => {
  const familyOne: FailureRecord = {
    ...failureA,
    id: "family-a1",
    ts: 100,
    cwd: "/work/family",
    cmd: "needle",
    fingerprint: "family-fingerprint",
    fingerprintV: 2,
    signature: ["needle"],
    excerpt: "needle",
  };
  const middle: FailureRecord = {
    ...familyOne,
    id: "family-b",
    ts: 200,
    fingerprint: "middle-fingerprint",
    cmd: "needle broad extra",
    signature: ["needle broad extra"],
    excerpt: "needle broad extra",
  };
  const familyTwo: FailureRecord = {
    ...familyOne,
    id: "family-a2",
    ts: 300,
    resolvedBy: "family-fix",
    cmd: "needle broad extra many tokens",
    signature: ["needle broad extra many tokens"],
    excerpt: "needle broad extra many tokens",
  };
  const fix: FixRecord = {
    kind: "fix",
    id: "family-fix",
    ts: 400,
    cwd: "/work/family",
    cmd: "fix family",
    failureIds: [familyTwo.id],
  };
  assert.deepEqual(
    queryRecall([familyOne, middle, familyTwo, fix], { query: "needle", cwd: "/work/family", limit: 1 })
      .map((hit) => hit.failure.id),
    [middle.id],
  );
});

test("queryStats reports all remembered knowledge kinds and fix confidence", () => {
  const possible: AssociationRecord = {
    kind: "association", id: "possible-a", ts: 250, cwd: "/work/a", cmd: "npm run build",
    candidateFailureIds: ["f2"], links: [{ id: "f2", basis: "program", confidence: "possible" }],
  };
  const triple: TripleRecord = {
    ...tripleA, id: "triple-stats", ts: 350,
  };
  const note: NoteRecord = {
    kind: "note", id: "note-stats", ts: 360, cwd: "/work/a", cmd: "rocky note",
    file: "src/app.ts", line: 3, subject: "cache", answer: "banana",
  };
  const result = queryStats([...records, possible, triple, note]);
  assert.equal(result.failures, 2);
  assert.equal(result.fixEvents, 1);
  assert.equal(result.resolved, 1);
  assert.equal(result.unresolved, 1);
  assert.equal(result.confirmedFixes, 1);
  assert.equal(result.possibleFixes, 1);
  assert.equal(result.triples, 1);
  assert.equal(result.notes, 1);
  assert.equal(result.total, 6);
});

test("future records stay inert across operational query surfaces but remain fetchable", () => {
  const now = 1_800_000_000_000;
  const futureFailure: FailureRecord = {
    ...failureA,
    id: "future-query-failure",
    ts: now + 1,
    fingerprint: "future-query-fingerprint",
    cmd: "npm run future-only-token",
    signature: ["future-only-token"],
  };
  const futureFix: FixRecord = {
    ...fixA,
    id: "future-query-fix",
    ts: now + 2,
    cmd: "npm run future-only-token",
    failureIds: [futureFailure.id],
  };
  const exactFailure: FailureRecord = {
    ...failureB,
    id: "exact-query-failure",
    ts: now,
    fingerprint: "exact-query-fingerprint",
    cmd: "npm run exact-query",
    signature: ["exact-query"],
  };
  const input = [futureFailure, futureFix, exactFailure];

  assert.deepEqual(findByFingerprint(input, futureFailure.fingerprint, now), []);
  assert.equal(getFix(input, futureFailure, now), undefined);
  assert.deepEqual(queryRecall(input, { query: "future-only-token", now }), []);
  assert.deepEqual(queryRecentFailures(input, { now }).map((hit) => hit.failure.id), [exactFailure.id]);
  assert.deepEqual(queryStats(input, { now }), {
    failures: 1, fixEvents: 0, resolved: 0, unresolved: 1,
    confirmedFixes: 0, possibleFixes: 0, triples: 0, notes: 0, total: 1,
  });
  assert.deepEqual(searchKnowledge(input, { query: "future-only-token", now }), []);
  assert.equal(fetchRecord(input, futureFailure.id)?.id, futureFailure.id, "raw/fetch state remains retained");
});

test("queryRecall keeps an explicit cross-directory fix visible without resolving the failure", () => {
  const failure: FailureRecord = {
    kind: "failure", id: "cross-recall-failure", ts: 100, cwd: "/work/source", cmd: "npm test",
    exitCode: 1, fingerprint: "fp-cross-recall", signature: ["module missing"], excerpt: "module missing",
  };
  const fix: FixRecord = {
    kind: "fix", id: "cross-recall-fix", ts: 200, cwd: "/work/fix", cmd: "npm test",
    failureIds: [failure.id],
  };
  const hit = queryRecall([failure, fix], { query: "module missing", cwd: failure.cwd })[0];
  assert.equal(hit?.fix?.id, fix.id);
  assert.equal(failure.resolvedBy, undefined, "passive recall must not mutate attribution");
});

test("cross-directory confirmation never counts as local stats", () => {
  const failure: FailureRecord = {
    kind: "failure", id: "cross-stats-failure", ts: 100, cwd: "/work/source", cmd: "npm test",
    exitCode: 1, fingerprint: "fp-cross-stats", signature: ["module missing"], excerpt: "module missing",
    resolvedBy: "cross-stats-fix",
  };
  const fix: FixRecord = {
    kind: "fix", id: "cross-stats-fix", ts: 200, cwd: "/work/other", cmd: "npm test",
    failureIds: [failure.id],
  };
  assert.deepEqual(queryStats([failure, fix]), {
    failures: 1, fixEvents: 0, resolved: 0, unresolved: 1,
    confirmedFixes: 0, possibleFixes: 0, triples: 0, notes: 0, total: 2,
  });
});

test("query indices are first-wins for duplicate IDs", () => {
  const failure: FailureRecord = { ...failureA, id: "duplicate-query-failure", resolvedBy: "duplicate-query-fix" };
  const first: FixRecord = { ...fixA, id: "duplicate-query-fix", failureIds: [failure.id], cmd: "npm run build" };
  const later: FixRecord = { ...first, cmd: "rm -rf /" };
  const duplicateFailure: FailureRecord = { ...failure, cmd: "rm -rf /", fingerprint: "duplicate-later" };
  const input = [failure, duplicateFailure, first, later];
  assert.equal(getFix(input, failure)?.cmd, "npm run build");
  assert.deepEqual(queryStats(input), {
    failures: 1, fixEvents: 1, resolved: 1, unresolved: 0,
    confirmedFixes: 1, possibleFixes: 0, triples: 0, notes: 0, total: 2,
  });
  assert.equal(queryRecall(input, { query: "module missing" })[0]?.fix?.cmd, "npm run build");
});

test("query fix index observes same-array mutation on each call", () => {
  const failure: FailureRecord = { ...failureA, id: "mutable-failure", resolvedBy: undefined };
  const fix: FixRecord = { ...fixA, id: "mutable-fix", failureIds: [failure.id] };
  const mutable: MemoryRecord[] = [failure];
  assert.equal(getFix(mutable, failure), undefined);
  mutable.push(fix);
  failure.resolvedBy = fix.id;
  assert.equal(getFix(mutable, failure)?.id, fix.id);
});

test("link query uses injected cwd and clock without changing process cwd", () => {
  const before = process.cwd();
  const hits = recentUnresolvedFailures([failureB], "npm test", {
    cwd: "/work/b", now: 500, windowMs: 1000,
  });
  assert.deepEqual(hits.map((hit) => hit.failure.id), ["f2"]);
  assert.deepEqual(hits.map((hit) => hit.basis), ["identity"]);
  assert.deepEqual(hits.map((hit) => hit.confidence), ["confirmed"]);
  assert.equal(process.cwd(), before);
});

test("recentUnresolvedFailures grades exact identity vs program basis", () => {
  const setupFail: FailureRecord = {
    kind: "failure", id: "s1", ts: 0, cwd: "/work/c", cmd: "rocky setup",
    exitCode: 1, fingerprint: "fp-s1", signature: ["boom"], excerpt: "boom",
  };
  const yesFail: FailureRecord = {
    kind: "failure", id: "s2", ts: 0, cwd: "/work/c", cmd: "rocky setup --yes",
    exitCode: 1, fingerprint: "fp-s2", signature: ["boom"], excerpt: "boom",
  };
  const buildFail: FailureRecord = {
    kind: "failure", id: "s3", ts: 0, cwd: "/work/c", cmd: "npm run build",
    exitCode: 1, fingerprint: "fp-s3", signature: ["boom"], excerpt: "boom",
  };
  const now = setupFail.ts + 2 * 60 * 1000; // 2 minutes later

  // same complete identity -> confirmed link
  const signatureHit = recentUnresolvedFailures([setupFail], "rocky setup", { cwd: "/work/c", now });
  assert.deepEqual(signatureHit.map((h) => ({ id: h.failure.id, basis: h.basis, confidence: h.confidence })), [
    { id: "s1", basis: "identity", confidence: "confirmed" },
  ]);

  // same base program, different signature -> weak link
  const programHit = recentUnresolvedFailures([yesFail], "rocky --help", { cwd: "/work/c", now });
  assert.deepEqual(programHit.map((h) => ({ id: h.failure.id, basis: h.basis, confidence: h.confidence })), [
    { id: "s2", basis: "program", confidence: "possible" },
  ]);

  // flagship case: npm run build -> npm rebuild sharp must still link (program basis)
  const npmHit = recentUnresolvedFailures([buildFail], "npm rebuild sharp", { cwd: "/work/c", now });
  assert.deepEqual(npmHit.map((h) => ({ id: h.failure.id, basis: h.basis, confidence: h.confidence })), [
    { id: "s3", basis: "program", confidence: "possible" },
  ]);
});

test("possible associations never count as confirmed fix events", () => {
  const association: AssociationRecord = {
    kind: "association", id: "a1", ts: 300, cwd: "/work/b", cmd: "npm run unrelated",
    candidateFailureIds: ["f2"], links: [{ id: "f2", basis: "program", confidence: "possible" }],
  };
  assert.deepEqual(queryStats([failureB, association]), {
    failures: 1, fixEvents: 0, resolved: 0, unresolved: 1,
    confirmedFixes: 0, possibleFixes: 1, triples: 0, notes: 0, total: 2,
  });
  const downgradedLegacy: FixRecord = {
    kind: "fix", id: "legacy-weak", ts: 301, cwd: "/work/b", cmd: "npm run unrelated",
    failureIds: ["f2"], links: [{ id: "f2", basis: "program" }],
  };
  assert.equal(queryStats([failureB, downgradedLegacy]).fixEvents, 0);
});

test("same-program candidates stay possible and never become confirmed resolutions", () => {
  const failure: FailureRecord = {
    kind: "failure", id: "weak-1", ts: 100, cwd: "/work/weak", cmd: "npm run broken-alpha",
    exitCode: 67, fingerprint: "fp-weak", signature: ["synthetic failure"], excerpt: "synthetic failure",
    commandIdentity: "[\"npm\",\"run\",\"broken-alpha\"]", identityV: 1, identityReliable: true, platform: "linux",
  };
  const links = recentUnresolvedFailures([failure], "npm run unrelated-beta", {
    cwd: "/work/weak", now: 200,
  });

  assert.deepEqual(links.map((link) => link.basis), ["program"]);
  assert.deepEqual(links.map((link) => link.confidence), ["possible"]);
});

test("different wrapper effects cannot become confirmed links", () => {
  const failure: FailureRecord = {
    kind: "failure", id: "wrapper-1", ts: 100, cwd: "/work/wrapper", cmd: "sudo -u root npm test",
    exitCode: 1, fingerprint: "fp-wrapper", signature: ["synthetic failure"], excerpt: "synthetic failure",
  };
  for (const command of ["sudo -u alice npm test", "npm test", "env -C /work/b npm test"]) {
    const links = recentUnresolvedFailures([failure], command, { cwd: "/work/wrapper", now: 200 });
    assert.ok(links.every((link) => link.confidence === "possible"));
  }
});

test("identical unparsed expansions remain possible rather than confirmed", () => {
  for (const cmd of ["node tests/*.mjs", 'node "%SCRIPT%" mode-a']) {
    const failure: FailureRecord = {
      kind: "failure", id: `ambiguous-${cmd}`, ts: 100, cwd: "/work/ambiguous", cmd,
      exitCode: 1, fingerprint: "fp-ambiguous", signature: ["synthetic failure"], excerpt: "synthetic failure",
    };
    const links = recentUnresolvedFailures([failure], cmd, { cwd: "/work/ambiguous", now: 200 });
    assert.deepEqual(links.map((link) => link.confidence), ["possible"]);
  }
});

test("exact identity is confirmed while cwd and selected-window isolation remain intact", () => {
  const failure: FailureRecord = {
    kind: "failure", id: "exact-1", ts: 100, cwd: "/work/exact", cmd: "node script.mjs mode-a",
    exitCode: 1, fingerprint: "fp-exact", signature: ["synthetic failure"], excerpt: "synthetic failure",
    commandIdentity: "[\"node\",\"script.mjs\",\"mode-a\"]", identityV: 1, identityReliable: true, platform: "linux",
  };
  const exact = recentUnresolvedFailures([failure], "node script.mjs mode-a", {
    cwd: "/work/exact", now: 200, windowMs: 200,
  });
  assert.deepEqual(exact.map((link) => ({ basis: link.basis, confidence: link.confidence })), [
    { basis: "identity", confidence: "confirmed" },
  ]);
  assert.deepEqual(recentUnresolvedFailures([failure], "node script.mjs mode-a", {
    cwd: "/work/other", now: 200, windowMs: 200,
  }), []);
  assert.deepEqual(recentUnresolvedFailures([failure], "node script.mjs mode-a", {
    cwd: "/work/exact", now: 301, windowMs: 200,
  }), []);
});

test("recentUnresolvedFailures narrows to an 8h window by default, widens with windowMs", () => {
  const nineHoursAgo: FailureRecord = {
    kind: "failure", id: "o1", ts: 0, cwd: "/work/d", cmd: "npm test",
    exitCode: 1, fingerprint: "fp-o1", signature: ["boom"], excerpt: "boom",
  };
  const now = 9 * 60 * 60 * 1000; // 9 hours later

  assert.deepEqual(recentUnresolvedFailures([nineHoursAgo], "npm test", { cwd: "/work/d", now }), []);
  assert.deepEqual(
    recentUnresolvedFailures([nineHoursAgo], "npm test", { cwd: "/work/d", now, windowMs: 1000 * 60 * 60 * 24 })
      .map((h) => h.failure.id),
    ["o1"],
  );
});

test("recentUnresolvedFailures excludes future failures but includes failure exactly at now", () => {
  const now = 1_800_000_000_000;
  const atNow: FailureRecord = {
    ...failureB,
    id: "at-now",
    ts: now,
    cwd: "/work/b",
    commandIdentity: JSON.stringify(["npm", "test"]),
    identityV: 1,
    identityReliable: true,
    platform: "linux",
  };
  const future: FailureRecord = { ...atNow, id: "future", ts: now + 1 };
  const hits = recentUnresolvedFailures([atNow, future], "npm test", {
    cwd: "/work/b", now, windowMs: LINK_WINDOW_MS,
  });
  assert.deepEqual(hits.map((hit) => hit.failure.id), ["at-now"]);
});

test("recentUnresolvedFailures excludes other cwds, resolved failures, and other base programs", () => {
  const otherCwd: FailureRecord = {
    kind: "failure", id: "n1", ts: 0, cwd: "/work/e", cmd: "npm test",
    exitCode: 1, fingerprint: "fp-n1", signature: ["boom"], excerpt: "boom",
  };
  const resolved: FailureRecord = {
    kind: "failure", id: "n2", ts: 0, cwd: "/work/f", cmd: "npm test",
    exitCode: 1, fingerprint: "fp-n2", signature: ["boom"], excerpt: "boom", resolvedBy: "x9",
  };
  const otherProgram: FailureRecord = {
    kind: "failure", id: "n3", ts: 0, cwd: "/work/f", cmd: "cargo build",
    exitCode: 1, fingerprint: "fp-n3", signature: ["boom"], excerpt: "boom",
  };

  assert.deepEqual(recentUnresolvedFailures([otherCwd], "npm test", { cwd: "/work/f", now: 1000 }), []);
  assert.deepEqual(recentUnresolvedFailures([resolved], "npm test", { cwd: "/work/f", now: 1000 }), []);
  assert.deepEqual(recentUnresolvedFailures([otherProgram], "npm test", { cwd: "/work/f", now: 1000 }), []);
});

test("createMemoryQueries reloads memory for every query", () => {
  let loads = 0;
  const queries = createMemoryQueries(() => {
    loads += 1;
    return records;
  });

  queries.recall({ query: "module missing" });
  queries.recentFailures();
  queries.stats();

  assert.equal(loads, 3);
});

test("searchKnowledge merges failure, fix, and triple sources with kind filter", () => {
  const mixed: MemoryRecord[] = [
    { ...failureA, cmd: "npm install", signature: ["permission denied"] },
    { ...fixA, cmd: "npm cache clean" },
    tripleA,
    { ...failureB, cmd: "cargo test", signature: ["borrow error"] },
  ];

  const all = searchKnowledge(mixed, { query: "npm" });
  assert.deepEqual(new Set(all.map((hit) => hit.kind)), new Set(["failure", "fix"]));

  const onlyFix = searchKnowledge(mixed, { query: "npm", kind: "fix" });
  assert.ok(onlyFix.every((hit) => hit.kind === "fix") && onlyFix.length === 1);

  const triples = searchKnowledge(mixed, { query: "naikin" });
  assert.equal(triples[0]?.kind, "triple");
  assert.equal(searchKnowledge(mixed, { query: "npm", limit: 1 }).length, 1);
});

test("searchKnowledge orders equal scores newest first and clamps limits", () => {
  const older = { ...failureA, id: "older", ts: 100, cmd: "npm test" };
  const newer = { ...failureA, id: "newer", ts: 200, cmd: "npm test" };
  assert.deepEqual(searchKnowledge([older, newer], { query: "npm", limit: 0 }).map((hit) => hit.id), ["newer"]);
  assert.equal(searchKnowledge([older, newer], { query: "npm", limit: 99 }).length, 2);
});

test("createMemoryQueries wires knowledge search, fetch, and why-file queries", () => {
  const queries = createMemoryQueries(() => [tripleA, failureA, fixA]);
  assert.equal(queries.searchKnowledge({ query: "naikin" })[0]?.id, "t1");
  assert.equal(queries.fetchRecord("t1")?.kind, "triple");
  assert.equal(queries.fetchRecord("missing"), undefined);
  assert.deepEqual(queries.whyFile("src/app.css").map((record) => record.id), ["t1"]);
});

test("why-file evidence treats future triples as inert and retains unknown coverage", () => {
  const future: TripleRecord = {
    ...tripleA,
    id: "future-why",
    ts: 501,
    mechanism: {
      files: [{ path: "src/future.ts", plusMinus: [1, 0], props: ["future"], provenance: "tool-observed" }],
      truncatedFiles: 0, baseline: "captured", coverageStatus: "complete",
    },
  };
  const evidence = whyFileEvidence([future], "src/future.ts", 5, 500);
  assert.deepEqual(evidence.matches, []);
  assert.equal(evidence.coverageIncomplete, true);
  assert.equal(evidence.coverage.status, "unknown");
});

test("why-file evidence preserves malformed traversal incompleteness beside valid proof", () => {
  const valid: TripleRecord = {
    ...tripleA,
    id: "valid-why",
    ts: 100,
    platform: "linux",
    mechanism: {
      files: [{ path: "src/a.ts", plusMinus: [1, 0], props: ["a"], provenance: "tool-observed" }],
      truncatedFiles: 0,
      baseline: "captured",
      coverageStatus: "complete",
    },
  };
  const malformed = { kind: "triple" } as unknown as MemoryRecord;
  const evidence = whyFileEvidence([valid, malformed], "src/a.ts", 5, 100);
  assert.deepEqual(evidence.matches.map((record) => record.id), ["valid-why"]);
  assert.equal(evidence.coverageIncomplete, true);
  assert.equal(evidence.coverage.complete, false);
  assert.equal(evidence.coverage.status, "unknown");
});

test("why-file evidence discloses trusted-root basename collisions without selecting a suffix", () => {
  const make = (id: string, path: string): TripleRecord => ({
    ...tripleA,
    id,
    ts: 100,
    cwd: "/repo",
    platform: "linux",
    mechanism: {
      files: [{ path, plusMinus: [1, 0], props: [id], provenance: "tool-observed" }],
      truncatedFiles: 0,
      baseline: "captured",
      coverageStatus: "complete",
    },
  });
  const evidence = whyFileEvidence([
    make("src-index", "src/index.ts"),
    make("test-index", "test/index.ts"),
  ], "index.ts", 5, 100);
  assert.deepEqual(evidence.matches, []);
  assert.equal(evidence.ambiguousPath, true);
  assert.equal(evidence.coverageIncomplete, true);
  assert.equal(evidence.coverage.status, "unknown");
});

test("why-file evidence keeps an unmatched relative-root path unknown", () => {
  const record: TripleRecord = {
    ...tripleA,
    id: "known-relative",
    ts: 100,
    cwd: "project",
    platform: "linux",
    mechanism: {
      files: [{ path: "src/known.ts", plusMinus: [1, 0], props: ["known"], provenance: "tool-observed" }],
      truncatedFiles: 0,
      baseline: "captured",
      coverageStatus: "complete",
    },
  };
  const evidence = whyFileEvidence([record], "src/missing.ts", 5, 100);
  assert.deepEqual(evidence.matches, []);
  assert.equal(evidence.coverageIncomplete, true);
  assert.equal(evidence.coverage.complete, false);
  assert.equal(evidence.coverage.status, "unknown");
});

test("why-file evidence honors an identity-hash witness before display suffixes", () => {
  const record: TripleRecord = {
    ...tripleA,
    id: "hashed-witness",
    ts: 100,
    cwd: "/repo",
    platform: "linux",
    mechanism: {
      files: [
        {
          path: "[redacted]",
          identityHash: pathIdentityHash("/repo/src/index.ts", { platform: "linux", canonical: true }),
          plusMinus: [9, 2], props: ["hashed"], provenance: "tool-observed",
        },
        { path: "web/src/index.ts", plusMinus: [1, 0], props: ["suffix"], provenance: "tool-observed" },
      ],
      truncatedFiles: 0, baseline: "captured", coverageStatus: "complete",
    },
  };
  const evidence = whyFileEvidence([record], "src/index.ts", 5, 100);
  assert.deepEqual(evidence.matches.map((candidate) => candidate.id), ["hashed-witness"]);
  assert.equal(evidence.coverageIncomplete, false);
});

test("why-file evidence rejects absolute cross-root legacy suffixes without platform", () => {
  const record: TripleRecord = {
    ...tripleA,
    id: "cross-root-legacy",
    ts: 100,
    cwd: "/repo",
    mechanism: {
      files: [{ path: "/other/src/index.ts", plusMinus: [1, 0], props: ["other"], provenance: "tool-observed" }],
      truncatedFiles: 0, baseline: "captured", coverageStatus: "complete",
    },
  };
  const evidence = whyFileEvidence([record], "src/index.ts", 5, 100);
  assert.deepEqual(evidence.matches, []);
  assert.deepEqual(evidence.possible, []);
  assert.equal(evidence.coverageIncomplete, true);
  assert.equal(evidence.coverage.status, "unknown");
  assert.deepEqual(whyFile([record], "src/index.ts", 5, 100), []);
});

test("knowledge hits expose record provenance and bounded file coverage", () => {
  const triple: TripleRecord = {
    ...tripleA,
    id: "knowledge-provenance",
    ts: 500,
    intent: { text: "banana cache" },
    mechanism: {
      files: [
        { path: "first.ts", plusMinus: [1, 0], props: [], provenance: "tool-observed" },
        { path: "second.ts", plusMinus: [2, 0], props: [], provenance: "git-diff-inferred" },
      ],
      truncatedFiles: 3,
      baseline: "unknown",
    },
  };
  const hit = searchKnowledge([triple], { query: "banana" })[0];
  assert.equal(hit?.id, "knowledge-provenance");
  assert.equal(hit?.agent, "codex");
  assert.equal(hit?.source, "agent-hook");
  assert.deepEqual(hit?.filesCovered, ["first.ts", "second.ts"]);
  assert.equal(hit?.truncatedFiles, 3);
  assert.equal(hit?.complete, false);
});

test("findByFingerprint dual lookup finds a v0.5 record after algorithm upgrade", () => {
  const stderr = "Error: module missing at /tmp/cache-123";
  const legacy: FailureRecord = {
    kind: "failure", id: "legacy-fingerprint", ts: 100, cwd: "/work/a", cmd: "npm test",
    exitCode: 1, fingerprint: legacyFingerprint(stderr, "npm test", 1), signature: ["error: module missing at <path>"], excerpt: stderr,
  };
  const current = fingerprint(stderr, "npm test", 1);
  assert.deepEqual(findByFingerprint([legacy], [current, legacy.fingerprint], 100).map((record) => record.id), [legacy.id]);
  assert.deepEqual(findByFingerprint([legacy], current, 100).map((record) => record.id), [legacy.id]);
  assert.deepEqual(findByFingerprint([legacy], legacy.fingerprint, 100).map((record) => record.id), [legacy.id]);
});

test("dual lookup rejects a legacy HTTP/port hash from different current semantics", () => {
  const oldStderr = "Error: HTTP 404 from port 9200";
  const newStderr = "Error: HTTP 500 from port 5432";
  const legacy: FailureRecord = {
    kind: "failure", id: "legacy-wrong-semantics", ts: 100, cwd: "/work/a", cmd: "curl", exitCode: 1,
    fingerprint: legacyFingerprint(oldStderr, "curl", 1), signature: signatureLines(oldStderr), excerpt: oldStderr,
  };
  const candidates = [fingerprint(newStderr, "curl", 1), legacyFingerprint(newStderr, "curl", 1)];
  assert.deepEqual(findByFingerprint([legacy], candidates, 100), []);
});

test("absent and v1 records carrying a v2 hash are not trusted as current evidence", () => {
  const stderr = "Error: HTTP 404 from port 9200";
  for (const [id, fingerprintV] of [["unmarked-current-hash", undefined], ["v1-current-hash", 1]] as const) {
    const record: FailureRecord = {
      kind: "failure", id, ts: 100, cwd: "/work/a", cmd: "curl", exitCode: 1,
      fingerprint: fingerprint(stderr, "curl", 1), signature: signatureLines(stderr), excerpt: stderr, fingerprintV,
    };
    assert.deepEqual(findByFingerprint([record], record.fingerprint, 100), [], id);
  }
});

test("a proven v1 signature cannot use a forged excerpt for exact recurrence", () => {
  const oldStderr = "Error: HTTP 404 from port 9200";
  const forgedStderr = "Error: HTTP 500 from port 5432";
  const record: FailureRecord = {
    kind: "failure", id: "forged-excerpt", ts: 100, cwd: "/work/a", cmd: "curl", exitCode: 1,
    fingerprint: legacyFingerprint(oldStderr, "curl", 1), signature: ["error http # from port #"], excerpt: forgedStderr,
  };
  assert.deepEqual(findByFingerprint([record], fingerprint(forgedStderr, "curl", 1), 100), []);
  const current: FailureRecord = {
    ...record, id: "current-500", ts: 200, fingerprint: fingerprint(forgedStderr, "curl", 1), fingerprintV: 2,
    signature: signatureLines(forgedStderr), excerpt: forgedStderr,
  };
  assert.deepEqual(queryRecall([record, current], { query: "curl", limit: 5 }).map((hit) => hit.failure.id), [current.id, record.id]);
});

test("recall migration does not canonicalize legacy evidence onto a different v2 semantic", () => {
  const oldStderr = "Error: HTTP 404 from port 9200";
  const newStderr = "Error: HTTP 500 from port 5432";
  const legacy: FailureRecord = {
    kind: "failure", id: "legacy-recall-404", ts: 100, cwd: "/work/a", cmd: "curl", exitCode: 1,
    fingerprint: legacyFingerprint(oldStderr, "curl", 1), signature: signatureLines(oldStderr), excerpt: oldStderr,
  };
  const current: FailureRecord = {
    kind: "failure", id: "current-recall-500", ts: 200, cwd: "/work/a", cmd: "curl", exitCode: 1,
    fingerprint: fingerprint(newStderr, "curl", 1), fingerprintV: 2,
    signature: signatureLines(newStderr), excerpt: newStderr,
  };
  assert.deepEqual(queryRecall([legacy, current], { query: "curl", limit: 5 }).map((hit) => hit.failure.id), [current.id, legacy.id]);
  assert.deepEqual(searchKnowledge([legacy, current], { query: "curl", kind: "failure", limit: 5 }).map((hit) => hit.id), [current.id, legacy.id]);
});

test("current-only fingerprint lookup rejects lossy legacy URL excerpts", () => {
  const stderr = "Error fetch https://host/path?token=123#frag";
  const legacy: FailureRecord = {
    kind: "failure", id: "legacy-url-fingerprint", ts: 100, cwd: "/work/a", cmd: "curl", exitCode: 1,
    fingerprint: legacyFingerprint(stderr, "curl", 1),
    signature: ["error fetch https:/<path>?token=#"],
    excerpt: stderr,
  };
  assert.deepEqual(findByFingerprint([legacy], fingerprint(stderr, "curl", 1), 100), []);
});

test("current-only lookup bridges legacy command fingerprints without stderr", () => {
  const legacy: FailureRecord = {
    kind: "failure", id: "legacy-command-fingerprint", ts: 100, cwd: "/work/a", cmd: "false", exitCode: 1,
    fingerprint: legacyFingerprint("", "false", 1), signature: [], excerpt: "",
  };
  assert.deepEqual(findByFingerprint([legacy], fingerprint("", "false", 1), 100).map((record) => record.id), [legacy.id]);
});

test("current-only legacy derivation validates persisted fingerprint provenance", () => {
  const stderr = "Error: module missing at /tmp/cache-123";
  const forged: FailureRecord = {
    kind: "failure", id: "forged-legacy-fingerprint", ts: 100, cwd: "/work/a", cmd: "npm test", exitCode: 1,
    fingerprint: "not-the-v1-hash", signature: ["error: module missing at <path>"], excerpt: stderr,
  };
  assert.deepEqual(findByFingerprint([forged], fingerprint(stderr, "npm test", 1), 100), []);
});

test("recall deduplicates a legacy and current record for one fingerprint family", () => {
  const stderr = "Error: module missing at /tmp/cache-123";
  const legacy: FailureRecord = {
    kind: "failure", id: "legacy-family", ts: 100, cwd: "/work/a", cmd: "npm test", exitCode: 1,
    fingerprint: legacyFingerprint(stderr, "npm test", 1), signature: ["error: module missing at <path>"], excerpt: stderr,
  };
  const current: FailureRecord = {
    ...legacy,
    id: "current-family",
    ts: 200,
    fingerprint: fingerprint(stderr, "npm test", 1),
    fingerprintV: 2,
  };
  assert.deepEqual(queryRecall([legacy, current], { query: "module missing" }).map((hit) => hit.failure.id), [current.id]);
});

test("recall and MCP knowledge deduplicate silent legacy/current records", () => {
  const cmd = "false";
  const legacy: FailureRecord = {
    kind: "failure", id: "legacy-silent-family", ts: 100, cwd: "/work/a", cmd, exitCode: 1,
    fingerprint: legacyFingerprint("", cmd, 1), signature: [], excerpt: "",
  };
  const current: FailureRecord = {
    ...legacy, id: "current-silent-family", ts: 200, fingerprint: fingerprint("", cmd, 1), fingerprintV: 2,
  };
  assert.deepEqual(queryRecall([legacy, current], { query: "false" }).map((hit) => hit.failure.id), [current.id]);
  assert.deepEqual(searchKnowledge([legacy, current], { query: "false", kind: "failure" }).map((hit) => hit.id), [current.id]);
});

test("recall and MCP knowledge deduplicate hook-origin legacy/current records", () => {
  const cmd = "npm run build";
  const legacy: FailureRecord = {
    kind: "failure", id: "legacy-hook-family", ts: 100, cwd: "/work/a", cmd, exitCode: 1,
    fingerprint: legacyFingerprint("", cmd, 1), signature: ["npm run build"], excerpt: "exit 1", origin: "hook",
  };
  const current: FailureRecord = {
    ...legacy, id: "current-hook-family", ts: 200, fingerprint: fingerprint("", cmd, 1), fingerprintV: 2,
  };
  assert.deepEqual(queryRecall([legacy, current], { query: "npm run build" }).map((hit) => hit.failure.id), [current.id]);
  assert.deepEqual(searchKnowledge([legacy, current], { query: "npm run build", kind: "failure" }).map((hit) => hit.id), [current.id]);
});

test("watch and silent legacy command hashes require a current semantic witness", () => {
  const cmd = "node worker.js";
  const legacy: FailureRecord = {
    kind: "failure", id: "legacy-watch-family", ts: 100, cwd: "/work/a", cmd, exitCode: 17,
    fingerprint: legacyFingerprint("", cmd, 17), signature: [], excerpt: "", origin: "watch",
  };
  const current: FailureRecord = {
    ...legacy, id: "current-watch-family", ts: 200, fingerprint: fingerprint("", cmd, 17), fingerprintV: 2,
  };
  assert.deepEqual(findByFingerprint([legacy], current.fingerprint, 300).map((record) => record.id), [legacy.id]);
  assert.deepEqual(queryRecall([legacy, current], { query: "node worker.js" }).map((hit) => hit.failure.id), [current.id]);
  assert.deepEqual(searchKnowledge([legacy, current], { query: "node worker.js", kind: "failure" }).map((hit) => hit.id), [current.id]);
});

test("malformed fingerprint provenance cannot create a migration family", () => {
  const current: FailureRecord = {
    ...failureA, id: "malformed-current", ts: 200, fingerprint: "0123456789abcdef", fingerprintV: 2,
  };
  const forged: FailureRecord = {
    ...failureA, id: "forged-legacy", ts: 100, fingerprint: "0123456789abcdef", signature: ["different evidence"], excerpt: "different evidence",
  };
  assert.deepEqual(findByFingerprint([forged], current.fingerprint, 300), []);
  assert.deepEqual(queryRecall([forged, current], { query: "different evidence" }).map((hit) => hit.failure.id), [forged.id]);
  assert.deepEqual(searchKnowledge([forged, current], { query: "different evidence", kind: "failure" }).map((hit) => hit.id), [forged.id]);
});

test("unproven legacy records with the same hash stay separate in recall", () => {
  const alpha: FailureRecord = {
    ...failureA, id: "legacy-alpha", ts: 100, cwd: "/work/a", cmd: "tool", fingerprint: "0123456789abcdef",
    signature: ["alpha evidence"], excerpt: "alpha evidence",
  };
  const beta: FailureRecord = {
    ...failureA, id: "legacy-beta", ts: 200, cwd: "/work/a", cmd: "tool", fingerprint: "0123456789abcdef",
    signature: ["beta evidence"], excerpt: "beta evidence",
  };
  assert.deepEqual(queryRecall([alpha, beta], { query: "alpha beta", limit: 5 }).map((hit) => hit.failure.id), [beta.id, alpha.id]);
  assert.deepEqual(searchKnowledge([alpha, beta], { query: "alpha beta", kind: "failure", limit: 5 }).map((hit) => hit.id), [beta.id, alpha.id]);
});

test("trusted v1 excerpts add numeric retrieval evidence without exact migration authority", () => {
  const make = (id: string, stderr: string): FailureRecord => ({
    ...failureA,
    id,
    ts: id.includes("404") ? 100 : 200,
    cwd: "/work/a",
    cmd: "curl",
    fingerprint: legacyFingerprint(stderr, "curl", 1),
    signature: ["error http # from port #"],
    excerpt: stderr,
  });
  const records = [make("v1-404-9200", "Error: HTTP 404 from port 9200"), make("v1-500-5432", "Error: HTTP 500 from port 5432")];
  assert.equal(queryRecall(records, { query: "404", limit: 2 })[0]?.failure.id, "v1-404-9200");
  assert.equal(queryRecall(records, { query: "9200", limit: 2 })[0]?.failure.id, "v1-404-9200");
  assert.equal(searchKnowledge(records, { query: "404", kind: "failure" })[0]?.id, "v1-404-9200");
  assert.equal(searchKnowledge(records, { query: "9200", kind: "failure" })[0]?.id, "v1-404-9200");
});

test("proven v1 duplicates deduplicate by legacy fingerprint without a v2 witness", () => {
  const make = (id: string, ts: number, status: number): FailureRecord => ({
    ...failureA,
    id,
    ts,
    cwd: "/work/a",
    cmd: "curl",
    fingerprint: legacyFingerprint(`Error: HTTP ${status} from port 9200`, "curl", 1),
    signature: ["error: http # from port #"],
    excerpt: `Error: HTTP ${status} from port 9200`,
  });
  const records = [make("legacy-valid-404", 100, 404), make("legacy-valid-500", 200, 500)];
  assert.deepEqual(queryRecall(records, { query: "curl", limit: 5 }).map((hit) => hit.failure.id), ["legacy-valid-500"]);
  assert.deepEqual(searchKnowledge(records, { query: "curl", kind: "failure", limit: 5 }).map((hit) => hit.id), ["legacy-valid-500"]);
});

test("valid and malformed legacy records sharing a hash use legacy-family and per-record keys", () => {
  const valid = {
    ...failureA,
    id: "legacy-valid",
    ts: 100,
    cwd: "/work/a",
    cmd: "tool",
    fingerprint: legacyFingerprint("Error: HTTP 404 from port 9200", "tool", 1),
    signature: ["error: http # from port #"],
    excerpt: "Error: HTTP 404 from port 9200",
  } satisfies FailureRecord;
  const malformed = [
    { ...valid, id: "legacy-malformed-alpha", ts: 200, signature: ["error alpha"], excerpt: "error alpha" },
    { ...valid, id: "legacy-malformed-beta", ts: 300, signature: ["error beta"], excerpt: "error beta" },
  ];
  const all = [valid, ...malformed];
  assert.deepEqual(queryRecall(all, { query: "tool error", limit: 5 }).map((hit) => hit.failure.id), [
    "legacy-malformed-beta", "legacy-malformed-alpha", "legacy-valid",
  ]);
  assert.deepEqual(searchKnowledge(all, { query: "tool error", kind: "failure", limit: 5 }).map((hit) => hit.id), [
    "legacy-malformed-beta", "legacy-malformed-alpha", "legacy-valid",
  ]);
});

test("malformed same-hash legacy records stay separate beside a migrated current family", () => {
  const signature = ["error module missing at <path>"];
  const legacy: FailureRecord = {
    ...failureA,
    id: "legacy-migrated",
    ts: 100,
    cwd: "/work/a",
    cmd: "tool",
    fingerprint: legacyFingerprint("Error module missing at /tmp/cache-123", "tool", 1),
    signature,
    excerpt: "Error module missing at /tmp/cache-123",
  };
  const current: FailureRecord = {
    ...legacy,
    id: "current-migrated",
    ts: 200,
    fingerprint: fingerprintSignature(signature, legacy.cmd, legacy.exitCode),
    fingerprintV: 2,
  };
  const malformed: FailureRecord = {
    ...legacy,
    id: "legacy-malformed-mixed",
    ts: 300,
    signature: ["module forged"],
    excerpt: "module forged",
  };
  const all = [legacy, current, malformed];
  assert.deepEqual(queryRecall(all, { query: "tool module", limit: 5 }).map((hit) => hit.failure.id), [malformed.id, current.id]);
  assert.deepEqual(searchKnowledge(all, { query: "tool module", kind: "failure", limit: 5 }).map((hit) => hit.id), [malformed.id, current.id]);
});

test("silent and hook v1 duplicates use proven command-only legacy families", () => {
  const silentCmd = "false";
  const silentFingerprint = legacyFingerprint("", silentCmd, 1);
  const silent = [100, 200].map((ts, index): FailureRecord => ({
    kind: "failure", id: `legacy-silent-${index}`, ts, cwd: "/work/a", cmd: silentCmd, exitCode: 1,
    fingerprint: silentFingerprint, signature: [], excerpt: "",
  }));
  const hookCmd = "npm run build";
  const hookFingerprint = legacyFingerprint("", hookCmd, 1);
  const hooks = [300, 400].map((ts, index): FailureRecord => ({
    kind: "failure", id: `legacy-hook-${index}`, ts, cwd: "/work/a", cmd: hookCmd, exitCode: 1,
    fingerprint: hookFingerprint, signature: [hookCmd], excerpt: "exit 1", origin: "hook",
  }));
  for (const group of [silent, hooks]) {
    assert.equal(queryRecall(group, { query: group[0]!.cmd, limit: 5 }).length, 1);
    assert.equal(searchKnowledge(group, { query: group[0]!.cmd, kind: "failure", limit: 5 }).length, 1);
  }
});

test("port query ranks exact semantic port above nearby ports", () => {
  const records: FailureRecord[] = [
    {
      ...failureA, id: "port-5432", ts: 100, cmd: "connect service", fingerprint: "port-5432",
      signature: ["error connect refused on port 5432"], excerpt: "connect refused on port 5432",
    },
    {
      ...failureB, id: "port-9200", ts: 200, cmd: "connect service", fingerprint: "port-9200",
      signature: ["error connect refused on port 9200"], excerpt: "connect refused on port 9200",
    },
    {
      ...failureA, id: "port-6379", ts: 300, cmd: "connect service", fingerprint: "port-6379",
      signature: ["error connect refused on port 6379"], excerpt: "connect refused on port 6379",
    },
  ];
  assert.equal(queryRecall(records, { query: "connect refused port 9200", limit: 3 })[0]?.failure.id, "port-9200");
  assert.equal(searchKnowledge(records, { query: "connect refused port 9200", kind: "failure" })[0]?.id, "port-9200");
});

test("persisted signatures retain semantic status and port evidence", () => {
  const records: FailureRecord[] = [
    {
      ...failureA,
      id: "persisted-9200",
      cmd: "curl",
      fingerprint: "persisted-9200",
      signature: signatureLines("Error HTTP 404 from port 9200"),
      excerpt: "Error HTTP 404 from port 9200",
    },
    {
      ...failureB,
      id: "persisted-5432",
      cmd: "curl",
      fingerprint: "persisted-5432",
      signature: signatureLines("Error HTTP 404 from port 5432"),
      excerpt: "Error HTTP 404 from port 5432",
    },
  ];
  assert.equal(queryRecall(records, { query: "HTTP 404 port 9200" })[0]?.failure.id, "persisted-9200");
});

test("numeric-only queries discriminate HTTP statuses and ports in recall and knowledge search", () => {
  const records: FailureRecord[] = [
    {
      ...failureA, id: "status-404", ts: 100, cmd: "curl", fingerprint: "status-404",
      signature: ["error HTTP 404"], excerpt: "error HTTP 404",
    },
    {
      ...failureB, id: "status-500", ts: 200, cmd: "curl", fingerprint: "status-500",
      signature: ["error HTTP 500"], excerpt: "error HTTP 500",
    },
    {
      ...failureA, id: "port-9200-numeric", ts: 300, cmd: "connect service", fingerprint: "port-9200-numeric",
      signature: ["error connection refused on port 9200"], excerpt: "error connection refused on port 9200",
    },
    {
      ...failureB, id: "port-5432-numeric", ts: 400, cmd: "connect service", fingerprint: "port-5432-numeric",
      signature: ["error connection refused on port 5432"], excerpt: "error connection refused on port 5432",
    },
  ];
  assert.equal(queryRecall(records.slice(0, 2), { query: "404" })[0]?.failure.id, "status-404");
  assert.equal(queryRecall(records.slice(2), { query: "9200" })[0]?.failure.id, "port-9200-numeric");
  assert.equal(searchKnowledge(records.slice(0, 2), { query: "404", kind: "failure" })[0]?.id, "status-404");
  assert.equal(searchKnowledge(records.slice(2), { query: "9200", kind: "failure" })[0]?.id, "port-9200-numeric");
});

test("network context preserves ports for single-label hostnames", () => {
  const records: FailureRecord[] = [
    { ...failureA, id: "redis-6379", ts: 100, cmd: "connect redis", fingerprint: "redis-6379", signature: ["error connect redis:6379"], excerpt: "error connect redis:6379" },
    { ...failureB, id: "redis-5432", ts: 200, cmd: "connect redis", fingerprint: "redis-5432", signature: ["error connect redis:5432"], excerpt: "error connect redis:5432" },
  ];
  assert.equal(queryRecall(records, { query: "6379", limit: 2 })[0]?.failure.id, "redis-6379");
  assert.equal(searchKnowledge(records, { query: "6379", kind: "failure" })[0]?.id, "redis-6379");
});

test("Unicode recall normalizes composed and combining forms across all supported scripts", () => {
  const records: FailureRecord[] = [
    { ...failureA, id: "cyrillic", ts: 100, cmd: "tool", fingerprint: "lang-cyrillic", signature: ["ошибка проводка"], excerpt: "ошибка проводка" },
    { ...failureA, id: "arabic", ts: 101, cmd: "tool", fingerprint: "lang-arabic", signature: ["خطأ ملف"], excerpt: "خطأ ملف" },
    { ...failureA, id: "accented", ts: 102, cmd: "tool", fingerprint: "lang-accented", signature: ["café"], excerpt: "café" },
    { ...failureA, id: "greek", ts: 103, cmd: "tool", fingerprint: "lang-greek", signature: ["σφάλμα αρχείο"], excerpt: "σφάλμα αρχείο" },
    { ...failureA, id: "cjk", ts: 104, cmd: "tool", fingerprint: "lang-cjk", signature: ["错误 文件"], excerpt: "错误 文件" },
  ];
  const queries = ["ошибка", "خطأ", "cafe\u0301", "σφάλμα", "错误"];
  const ids = ["cyrillic", "arabic", "accented", "greek", "cjk"];
  for (let index = 0; index < queries.length; index++) {
    const query = queries[index]!;
    const id = ids[index]!;
    assert.equal(queryRecall(records, { query })[0]?.failure.id, id, `recall ${id}`);
    assert.equal(searchKnowledge(records, { query, kind: "failure" })[0]?.id, id, `knowledge ${id}`);
  }
});

test("one exact distinctive token survives long signatures", () => {
  const make = (count: number, id: string): FailureRecord => ({
    ...failureA,
    id,
    fingerprint: id,
    cmd: "tool diagnose",
    signature: [Array.from({ length: count }, (_, index) => `context-${index}`).concat("needle-unique").join(" ")],
    excerpt: "needle-unique",
  });
  for (const count of [25, 100]) {
    const hit = queryRecall([make(count, `long-${count}`)], { query: "needle-unique" });
    assert.equal(hit[0]?.failure.id, `long-${count}`);
  }
});

test("possibleFixesForFailure sorts newest first, tie-breaks by linkBasisRank, and caps at three", () => {
  const failure: FailureRecord = {
    kind: "failure", id: "possible-f1", ts: 10, cwd: "/work/possible",
    cmd: "npm run broken-alpha", exitCode: 1, fingerprint: "fp-possible-f1",
    signature: ["boom"], excerpt: "boom",
  };
  const make = (id: string, ts: number, basis: string): AssociationRecord => ({
    kind: "association", id, ts, cwd: "/work/possible", cmd: `fix-${id}`,
    candidateFailureIds: [failure.id], links: [{ id: failure.id, basis, confidence: "possible" }],
  });
  const strongTie = make("a-strong-tie", 300, "program");
  const weakTie = make("a-weak-tie", 300, "sequence");
  const middle = make("a-middle", 200, "program");
  const oldest = make("a-oldest", 100, "program");
  const unrelated: AssociationRecord = {
    kind: "association", id: "a-unrelated", ts: 400, cwd: "/work/possible", cmd: "fix-unrelated",
    candidateFailureIds: ["some-other-failure"], links: [{ id: "some-other-failure", basis: "program", confidence: "possible" }],
  };
  const found = possibleFixesForFailure([failure, strongTie, weakTie, middle, oldest, unrelated], failure);
  assert.deepEqual(found.map((candidate) => candidate.cmd), ["fix-a-strong-tie", "fix-a-weak-tie", "fix-a-middle"]);
  assert.equal(found.length, 3, "capped at three even though four candidates match");
});

test("possibleFixesForFailure marks a different cwd as fromElsewhere and stays weak", () => {
  const failure: FailureRecord = {
    kind: "failure", id: "elsewhere-f1", ts: 10, cwd: "/work/here",
    cmd: "npm run broken-alpha", exitCode: 1, fingerprint: "fp-elsewhere-f1",
    signature: ["boom"], excerpt: "boom",
  };
  const association: AssociationRecord = {
    kind: "association", id: "a-elsewhere", ts: 100, cwd: "/work/there", cmd: "fix-elsewhere",
    candidateFailureIds: [failure.id], links: [{ id: failure.id, basis: "program", confidence: "possible" }],
  };
  const [candidate] = possibleFixesForFailure([failure, association], failure);
  assert.equal(candidate?.fromElsewhere, true);
  assert.equal(candidate?.cwd, "/work/there");
  assert.equal(candidate?.basis, "program");
});

test("possibleFixesForFailure falls back to the weakest rank when only candidateFailureIds matches", () => {
  const failure: FailureRecord = {
    kind: "failure", id: "candidate-only-f1", ts: 10, cwd: "/work/candidate-only",
    cmd: "npm run broken-alpha", exitCode: 1, fingerprint: "fp-candidate-only-f1",
    signature: ["boom"], excerpt: "boom",
  };
  const association: AssociationRecord = {
    kind: "association", id: "a-candidate-only", ts: 100, cwd: "/work/candidate-only", cmd: "fix-candidate-only",
    candidateFailureIds: [failure.id], links: [],
  };
  const [candidate] = possibleFixesForFailure([failure, association], failure);
  assert.equal(candidate?.basis, "unknown");
});

test("possibleFixesForFailure ignores a future-dated association", () => {
  const now = 1_800_000_000_000;
  const failure: FailureRecord = {
    kind: "failure", id: "future-possible-f1", ts: now - 1_000, cwd: "/work/future-possible",
    cmd: "npm run broken-alpha", exitCode: 1, fingerprint: "fp-future-possible-f1",
    signature: ["boom"], excerpt: "boom",
  };
  const future: AssociationRecord = {
    kind: "association", id: "a-future", ts: now + 1, cwd: "/work/future-possible", cmd: "fix-future",
    candidateFailureIds: [failure.id], links: [{ id: failure.id, basis: "program", confidence: "possible" }],
  };
  assert.deepEqual(possibleFixesForFailure([failure, future], failure, now), []);
});

test("possibleFixesForFailure writes nothing and never changes stats", () => {
  const failure: FailureRecord = {
    kind: "failure", id: "pure-read-f1", ts: 10, cwd: "/work/pure-read",
    cmd: "npm run broken-alpha", exitCode: 1, fingerprint: "fp-pure-read-f1",
    signature: ["boom"], excerpt: "boom",
  };
  const association: AssociationRecord = {
    kind: "association", id: "a-pure-read", ts: 100, cwd: "/work/pure-read", cmd: "fix-pure-read",
    candidateFailureIds: [failure.id], links: [{ id: failure.id, basis: "program", confidence: "possible" }],
  };
  const input: MemoryRecord[] = [failure, association];
  const before = queryStats(input);
  possibleFixesForFailure(input, failure);
  assert.deepEqual(input, [failure, association], "records must be untouched");
  assert.deepEqual(queryStats(input), before, "stats must not change from a read");
});

test("queryRecall attaches the top possible fix only when the hit has no confirmed fix", () => {
  const unresolved: FailureRecord = {
    kind: "failure", id: "recall-possible-unresolved", ts: 10, cwd: "/work/recall-possible",
    cmd: "npm run broken-alpha", exitCode: 1, fingerprint: "fp-recall-possible-unresolved",
    signature: ["needle unresolved"], excerpt: "needle unresolved",
  };
  const association: AssociationRecord = {
    kind: "association", id: "a-recall-possible", ts: 100, cwd: "/work/recall-possible", cmd: "npm run unrelated-beta",
    candidateFailureIds: [unresolved.id], links: [{ id: unresolved.id, basis: "program", confidence: "possible" }],
  };
  const unresolvedHit = queryRecall([unresolved, association], { query: "needle unresolved" })[0];
  assert.deepEqual(unresolvedHit?.possible, {
    cmd: "npm run unrelated-beta", ts: 100, cwd: "/work/recall-possible", basis: "program", fromElsewhere: false,
  });

  const resolved: FailureRecord = {
    kind: "failure", id: "recall-possible-resolved", ts: 10, cwd: "/work/recall-possible",
    cmd: "npm run broken-alpha", exitCode: 1, fingerprint: "fp-recall-possible-resolved",
    signature: ["needle resolved"], excerpt: "needle resolved", resolvedBy: "recall-possible-fix",
  };
  const confirmedFix: FixRecord = {
    kind: "fix", id: "recall-possible-fix", ts: 50, cwd: "/work/recall-possible", cmd: "npm rebuild sharp",
    failureIds: [resolved.id],
  };
  const otherAssociation: AssociationRecord = {
    kind: "association", id: "a-recall-possible-2", ts: 200, cwd: "/work/recall-possible", cmd: "npm run should-not-appear",
    candidateFailureIds: [resolved.id], links: [{ id: resolved.id, basis: "program", confidence: "possible" }],
  };
  const resolvedHit = queryRecall([resolved, confirmedFix, otherAssociation], { query: "needle resolved" })[0];
  assert.equal(resolvedHit?.fix?.id, confirmedFix.id);
  assert.equal(resolvedHit?.possible, undefined, "a confirmed fix must never be paired with a possible candidate");
});

// Finding 1, final whole-branch review: recall's possible-fix search used to
// look only at the single representative (deduplicated) failure recall's
// scoring happened to pick, while run/watch walk every prior same-fingerprint
// occurrence newest-first. This test pins a real scenario where recall's own
// dedup picks the *newest* occurrence as the hit, but the only association
// candidate is linked to an *older* occurrence of the identical (canonical)
// fingerprint — exactly the case run/watch already surface via
// `findByFingerprint` + `speakablePossibleFix`. It fails under the old
// hit.failure-only search and passes once recall walks occurrences the same
// way.
test("queryRecall surfaces a possible fix linked to an older same-fingerprint occurrence, matching run/watch's newest-first walk", () => {
  const sharedFingerprint = "abcdef0123456789";
  const olderOccurrence: FailureRecord = {
    kind: "failure", id: "dup-fp-older", ts: 10, cwd: "/work/dupfp",
    cmd: "npm run broken-alpha", exitCode: 1, fingerprint: sharedFingerprint, fingerprintV: 2,
    signature: ["needle recur"], excerpt: "needle recur",
  };
  const newerOccurrence: FailureRecord = {
    kind: "failure", id: "dup-fp-newer", ts: 500, cwd: "/work/dupfp",
    cmd: "npm run broken-alpha", exitCode: 1, fingerprint: sharedFingerprint, fingerprintV: 2,
    signature: ["needle recur"], excerpt: "needle recur",
  };
  const association: AssociationRecord = {
    kind: "association", id: "a-dup-fp", ts: 50, cwd: "/work/dupfp", cmd: "npm run known-fix",
    candidateFailureIds: [olderOccurrence.id], links: [{ id: olderOccurrence.id, basis: "program", confidence: "possible" }],
  };
  const hit = queryRecall([olderOccurrence, newerOccurrence, association], { query: "needle recur" })[0];
  assert.equal(hit?.failure.id, newerOccurrence.id, "recall still surfaces the newest occurrence as the representative hit");
  assert.deepEqual(hit?.possible, {
    cmd: "npm run known-fix", ts: 50, cwd: "/work/dupfp", basis: "program", fromElsewhere: false,
  }, "a candidate linked only to an older occurrence of the same fingerprint must still surface, like run/watch");
});

test("rare exact token boost remains active when token appears twice among many records", () => {
  const make = (index: number, includeRare: boolean): FailureRecord => ({
    ...failureA,
    id: `rare-${index}`,
    ts: 1_000 + index,
    fingerprint: `rare-${index}`,
    cmd: "tool diagnose",
    signature: [Array.from({ length: 100 }, (_, item) => `context-${index}-${item}`)
      .concat(includeRare ? ["rare-needle"] : [])
      .join(" ")],
    excerpt: includeRare ? "rare-needle" : "context",
  });
  const records = Array.from({ length: 50 }, (_, index) => make(index, index < 2));
  const hits = queryRecall(records, { query: "rare-needle", limit: 3 });
  assert.deepEqual(hits.map((hit) => hit.failure.id), ["rare-1", "rare-0"]);
  assert.ok(hits.every((hit) => hit.score >= 0.06));
});
