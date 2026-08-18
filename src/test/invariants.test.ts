import test from "node:test";
import assert from "node:assert/strict";
import { matchesGlob, parseInvariants } from "../core/invariants.js";

test("parseInvariants reads well-formed blocks with optional Why", () => {
  const text = [
    "Invariant: payment may commit at most once",
    "Guarded by: src/payment/**, src/retry-worker.ts",
    "Why: duplicate settlement incident",
    "",
    "Invariant: memory file is append-only",
    "Guarded by: src/core/memory.ts",
  ].join("\n");
  const { notes, errors } = parseInvariants(text);
  assert.equal(errors.length, 0);
  assert.equal(notes.length, 2);
  assert.equal(notes[0].invariant, "payment may commit at most once");
  assert.deepEqual(notes[0].guardedBy, ["src/payment/**", "src/retry-worker.ts"]);
  assert.equal(notes[0].why, "duplicate settlement incident");
  assert.equal(notes[1].why, undefined);
});

test("parseInvariants tolerates unknown lines and keeps later blocks after a broken one", () => {
  const text = [
    "# heading noise",
    "Invariant: block without guard",
    "",
    "Invariant: good block",
    "Guarded by: src/a.ts",
    "random prose line",
  ].join("\n");
  const { notes, errors } = parseInvariants(text);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].invariant, "good block");
  assert.equal(errors.length, 1);
});

test("matchesGlob covers **, *, ? and path separator normalization", () => {
  assert.ok(matchesGlob("src/payment/**", "src/payment/worker/retry.ts"));
  assert.ok(matchesGlob("src/payment/**", "src/payment/index.ts"));
  assert.ok(!matchesGlob("src/payment/**", "src/billing/index.ts"));
  assert.ok(matchesGlob("src/*.ts", "src/index.ts"));
  assert.ok(!matchesGlob("src/*.ts", "src/deep/index.ts"));
  assert.ok(matchesGlob("**/*.test.ts", "src/test/journal.test.ts"));
  assert.ok(matchesGlob("src/?.ts", "src/a.ts"));
  assert.ok(!matchesGlob("src/?.ts", "src/ab.ts"));
  assert.ok(matchesGlob("src/payment/**", "src\\payment\\retry.ts"));
  assert.ok(!matchesGlob("src/index.ts", "src/index_ts"));
});
