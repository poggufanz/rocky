import test from "node:test";
import assert from "node:assert/strict";
import { matchConcepts, CONCEPTS } from "../core/concepts.js";

test("matches idempotency from intent text", () => {
  const hits = matchConcepts("make payment retry idempotent so it never commits twice");
  assert.ok(hits.some((h) => h.concept.id === "idempotency"));
});

test("alias maps user phrase to concept", () => {
  const aliases = new Map([["jangan jalan dua kali", "idempotency"]]);
  const hits = matchConcepts("jangan jalan dua kali pas retry", aliases);
  assert.ok(hits.some((h) => h.concept.id === "idempotency"));
});

test("unrelated text stays silent", () => {
  assert.deepEqual(matchConcepts("rename variable in readme"), []);
});

test("lexicon ids are unique and lowercase", () => {
  const ids = CONCEPTS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.equal(id, id.toLowerCase());
});

test("single keyword alone does not match", () => {
  assert.deepEqual(matchConcepts("deadlock"), []);
});

test("blank alias phrase is ignored", () => {
  const hits = matchConcepts("anything", new Map([["", "auth"]]));
  assert.ok(!hits.some((h) => h.concept.id === "auth"));
});

test("alias does not match inside another word", () => {
  const hits = matchConcepts("unblock the pipeline", new Map([["lock", "locking"]]));
  assert.ok(!hits.some((h) => h.concept.id === "locking"));
});

test("lexicon keywords are all lowercase", () => {
  for (const concept of CONCEPTS) {
    for (const kw of concept.keywords) assert.equal(kw, kw.toLowerCase());
  }
});
