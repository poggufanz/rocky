import test from "node:test";
import assert from "node:assert/strict";
import { matchConcepts, CONCEPTS } from "../core/concepts.js";

test("cs lexicon has four new ids unique lowercase", () => {
  const ids = CONCEPTS.map((c) => c.id);
  for (const want of ["control-flow", "program-state", "decomposition", "data-aggregation"]) {
    assert.ok(ids.includes(want), `missing ${want}`);
  }
  assert.equal(new Set(ids).size, ids.length);
});

test("control-flow fires on loop branch language", () => {
  const hits = matchConcepts("loop iteration breaks when condition fails, retry the branch step");
  assert.ok(hits.some((h) => h.concept.id === "control-flow"));
});

test("program-state fires on mutation language", () => {
  const hits = matchConcepts("state mutation leaves stale state after assign, invariant update missing");
  assert.ok(hits.some((h) => h.concept.id === "program-state"));
});

test("decomposition fires on subtask language", () => {
  const hits = matchConcepts("decompose big task into subtask steps, one function per module separation");
  assert.ok(hits.some((h) => h.concept.id === "decomposition"));
});

test("data-aggregation fires on threshold language", () => {
  const hits = matchConcepts("aggregate sum average then filter by threshold budget group");
  assert.ok(hits.some((h) => h.concept.id === "data-aggregation"));
});
