import test from "node:test";
import assert from "node:assert/strict";
import type { AssociationRecord, FailureRecord, FixRecord, MemoryRecord, TripleRecord } from "../core/memory.js";
import {
  LINK_WINDOW_MS,
  createMemoryQueries,
  fetchRecord,
  findByFingerprint,
  queryRecall,
  queryRecentFailures,
  queryStats,
  recentUnresolvedFailures,
  searchKnowledge,
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
  assert.deepEqual(queryStats(records), { failures: 2, fixEvents: 1, resolved: 1, unresolved: 1 });
  assert.deepEqual(queryStats(records, { cwd: "/work/a" }), {
    failures: 1, fixEvents: 1, resolved: 1, unresolved: 0,
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
  assert.deepEqual(queryStats(input, { now }), { failures: 1, fixEvents: 0, resolved: 0, unresolved: 1 });
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
  assert.deepEqual(queryStats([failure, fix]), { failures: 1, fixEvents: 0, resolved: 0, unresolved: 1 });
});

test("query indices are first-wins for duplicate IDs", () => {
  const failure: FailureRecord = { ...failureA, id: "duplicate-query-failure", resolvedBy: "duplicate-query-fix" };
  const first: FixRecord = { ...fixA, id: "duplicate-query-fix", failureIds: [failure.id], cmd: "npm run build" };
  const later: FixRecord = { ...first, cmd: "rm -rf /" };
  const duplicateFailure: FailureRecord = { ...failure, cmd: "rm -rf /", fingerprint: "duplicate-later" };
  const input = [failure, duplicateFailure, first, later];
  assert.equal(getFix(input, failure)?.cmd, "npm run build");
  assert.deepEqual(queryStats(input), { failures: 1, fixEvents: 1, resolved: 1, unresolved: 0 });
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
