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
