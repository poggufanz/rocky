import test from "node:test";
import assert from "node:assert/strict";
import { buildChatStructure, validateChatStructure } from "../ai/chat-structure.js";

const evidence = [
  { ref: "failure-aaa", kind: "failure", snippet: "npm run build failed on step 3" },
  { ref: "fix-bbb", kind: "fix", snippet: "reran with clean cache" },
];

test("valid structurer output passes the allowlist", () => {
  const value = {
    query: "npm run build",
    candidates: [
      { ref: "failure-aaa", kind: "failure", snippet: "npm run build failed on step 3" },
    ],
  };
  assert.equal(validateChatStructure(value, ["failure-aaa", "fix-bbb"]), true);
});

test("invented ref outside the retrieved set is rejected", () => {
  const value = {
    query: "npm run build",
    candidates: [
      { ref: "failure-zzz", kind: "failure", snippet: "something the retriever never saw" },
    ],
  };
  assert.equal(validateChatStructure(value, ["failure-aaa", "fix-bbb"]), false);
});

test("duplicate refs are rejected", () => {
  const value = {
    query: "npm run build",
    candidates: [
      { ref: "failure-aaa", kind: "failure", snippet: "one" },
      { ref: "failure-aaa", kind: "failure", snippet: "two" },
    ],
  };
  assert.equal(validateChatStructure(value, ["failure-aaa"]), false);
});

test("malformed shapes are rejected: empty query, bad candidate, too many", () => {
  assert.equal(
    validateChatStructure({ query: "", candidates: [] }, []),
    false,
  );
  assert.equal(
    validateChatStructure({ query: "q", candidates: [{ ref: "a", kind: "failure" }] }, ["a"]),
    false,
  );
  assert.equal(
    validateChatStructure({ query: "q", candidates: "nope" }, ["a"]),
    false,
  );
  assert.equal(validateChatStructure(null, []), false);
  const many = Array.from({ length: 11 }, (_, i) => ({
    ref: `ref-${i}`,
    kind: "failure",
    snippet: "s",
  }));
  assert.equal(
    validateChatStructure({ query: "q", candidates: many }, many.map((c) => c.ref)),
    false,
  );
});

test("deterministic fallback bounds and keeps only retrieved refs", () => {
  const built = buildChatStructure("npm run build", evidence);
  assert.equal(built.query, "npm run build");
  assert.deepEqual(
    built.candidates.map((c) => c.ref),
    ["failure-aaa", "fix-bbb"],
  );
  assert.equal(validateChatStructure(built, ["failure-aaa", "fix-bbb"]), true);

  const long = buildChatStructure("q".repeat(5000), [
    { ref: "r1", kind: "failure", snippet: `short ghp_${"a".repeat(40)} tail` },
    { ref: "r2", kind: "failure", snippet: "x".repeat(2000) },
  ]);
  assert.ok(long.query.length <= 1032);
  assert.ok(!(long.candidates[0]?.snippet ?? "").includes("ghp_"));
  assert.ok((long.candidates[1]?.snippet.length ?? 0) <= 532);
  assert.equal(validateChatStructure(long, ["r1", "r2"]), true);

  const empty = buildChatStructure("hello", []);
  assert.deepEqual(empty.candidates, []);
  assert.equal(validateChatStructure(empty, []), true);
});
