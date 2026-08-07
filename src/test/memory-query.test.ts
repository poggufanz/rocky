import test from "node:test";
import assert from "node:assert/strict";
import type { FailureRecord, FixRecord, MemoryRecord } from "../core/memory.js";
import {
  createMemoryQueries,
  queryRecall,
  queryRecentFailures,
  queryStats,
  recentUnresolvedFailures,
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
  assert.deepEqual(hits.map((hit) => hit.id), ["f2"]);
  assert.equal(process.cwd(), before);
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
