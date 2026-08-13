import test from "node:test";
import assert from "node:assert/strict";
import type { FailureRecord, FixRecord, MemoryRecord, TripleRecord } from "../core/memory.js";
import {
  createMemoryQueries,
  queryRecall,
  queryRecentFailures,
  queryStats,
  recentUnresolvedFailures,
  searchKnowledge,
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

test("link query uses injected cwd and clock without changing process cwd", () => {
  const before = process.cwd();
  const hits = recentUnresolvedFailures([failureB], "npm test", {
    cwd: "/work/b", now: 500, windowMs: 1000,
  });
  assert.deepEqual(hits.map((hit) => hit.failure.id), ["f2"]);
  assert.deepEqual(hits.map((hit) => hit.basis), ["signature"]);
  assert.equal(process.cwd(), before);
});

test("recentUnresolvedFailures grades signature vs program basis", () => {
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

  // same signature ("rocky setup") -> strong link
  const signatureHit = recentUnresolvedFailures([setupFail], "rocky setup --yes", { cwd: "/work/c", now });
  assert.deepEqual(signatureHit.map((h) => ({ id: h.failure.id, basis: h.basis })), [{ id: "s1", basis: "signature" }]);

  // same base program, different signature -> weak link
  const programHit = recentUnresolvedFailures([yesFail], "rocky --help", { cwd: "/work/c", now });
  assert.deepEqual(programHit.map((h) => ({ id: h.failure.id, basis: h.basis })), [{ id: "s2", basis: "program" }]);

  // flagship case: npm run build -> npm rebuild sharp must still link (program basis)
  const npmHit = recentUnresolvedFailures([buildFail], "npm rebuild sharp", { cwd: "/work/c", now });
  assert.deepEqual(npmHit.map((h) => ({ id: h.failure.id, basis: h.basis })), [{ id: "s3", basis: "program" }]);
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
