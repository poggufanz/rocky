import test from "node:test";
import assert from "node:assert/strict";
import { explainFor, CS_CONCEPT_IDS } from "../core/cs-explain.js";

test("unknown concept returns undefined", () => {
  assert.equal(explainFor("nope", "x = 1"), undefined);
});

test("control-flow returns bounded triple without question mark", () => {
  const out = explainFor("control-flow", "for (let i = 0; i < 3; i += 1) { total += i; }");
  assert.ok(out);
  assert.equal(out?.conceptId, "control-flow");
  assert.ok((out?.definition.length ?? 999) <= 280);
  assert.ok((out?.trace.length ?? 99) <= 5);
  assert.ok((out?.check.endsWith(", question") ?? false));
  assert.ok(!(out?.check.includes("?") ?? true));
});

test("all four ids explain", () => {
  for (const id of CS_CONCEPT_IDS) {
    const out = explainFor(id, "sum = 0\nfor (let i = 0; i < 3; i += 1) { sum += i; }");
    assert.ok(out, `missing ${id}`);
  }
});
