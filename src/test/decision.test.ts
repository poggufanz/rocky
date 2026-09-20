import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRelevanceQuestions,
  confidenceOf,
  createHeuristicPort,
  rankByNoul,
} from "../ai/decision.js";

test("noul answers carry no confidence field", async () => {
  const port = createHeuristicPort();
  const state = {
    query: "module missing",
    candidates: [{ ref: "a", kind: "failure", snippet: "x" }],
  };
  const questions = buildRelevanceQuestions(state.candidates);
  assert.equal(questions.length, 1);
  assert.equal(questions[0]?.kind, "noul");
  const result = await port.evaluate(state, questions);
  assert.equal(result.answers.length, 1);
  const answer = result.answers[0];
  assert.equal(answer?.kind, "noul");
  assert.ok(!("confidence" in (answer as unknown as Record<string, unknown>)));
});

test("heuristic keeps baseline order with uniform scores", async () => {
  const port = createHeuristicPort();
  const state = {
    query: "q",
    candidates: [
      { ref: "b", kind: "failure", snippet: "two" },
      { ref: "a", kind: "failure", snippet: "one" },
    ],
  };
  const result = await port.evaluate(state, buildRelevanceQuestions(state.candidates));
  assert.equal(result.engine, "heuristic");
  assert.equal(result.status, "used");
  assert.deepEqual(result.evidenceRefs, ["b", "a"]);
});

test("rankByNoul is stable on exact ties and sinks unscored refs", () => {
  const order = rankByNoul(
    ["a", "b", "c", "d"],
    new Map([["b", 0.9], ["a", 0.9]]),
  );
  assert.deepEqual(order, ["a", "b", "c", "d"]);
});

test("confidenceOf reads the winning mass", () => {
  assert.equal(confidenceOf({ a: 0.1, b: 0.85, c: 0.05 }), 0.85);
  assert.equal(confidenceOf({}), 0);
});
