import test from "node:test";
import assert from "node:assert/strict";
import {
  JEV_MODEL,
  buildJevBody,
  buildJevState,
  createJevPort,
  isValidNoulAnswer,
  jevBodyFits,
} from "../ai/jev.js";
import { buildRelevanceQuestions } from "../ai/decision.js";

test("jev state bounds and redacts snippet-only input", () => {
  const state = buildJevState("query text", [
    { ref: "r1", kind: "failure", snippet: `short ghp_${"a".repeat(40)} tail` },
    { ref: "r2", kind: "failure", snippet: "x".repeat(2000) },
  ]);
  assert.ok(state.candidates[0]?.snippet !== undefined);
  assert.ok(!(state.candidates[0]?.snippet ?? "").includes("ghp_"));
  assert.ok((state.candidates[1]?.snippet.length ?? 0) <= 540);
});

test("payload pins the versioned model, never the alias", () => {
  assert.equal(JEV_MODEL, "jev-1.13.0");
  const state = buildJevState("q", [{ ref: "r1", kind: "failure", snippet: "s" }]);
  const body = buildJevBody(state, buildRelevanceQuestions(state.candidates));
  assert.equal(body.model, "jev-1.13.0");
  assert.deepEqual(Object.keys(body.questions), ["q_r1"]);
  assert.ok(jevBodyFits(body));
});

test("tie rule keeps baseline order on exact noul ties", async () => {
  const fetchImpl = (async (): Promise<Response> => {
    const payload = {
      model: "jev-1.13.0",
      usage: { input_tokens: 10, output_tokens: 2 },
      answers: {
        q_a: { type: "noul", noul: 0.5 },
        q_b: { type: "noul", noul: 0.5 },
      },
    };
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
  const port = createJevPort({ apiKey: "test-key", fetchImpl });
  const state = {
    query: "q",
    candidates: [
      { ref: "a", kind: "failure", snippet: "one" },
      { ref: "b", kind: "failure", snippet: "two" },
    ],
  };
  const result = await port.evaluate(state, buildRelevanceQuestions(state.candidates));
  assert.equal(result.status, "used");
  assert.deepEqual(result.evidenceRefs, ["a", "b"]);
});

test("missing key reports disabled with baseline order", async () => {
  const port = createJevPort({ apiKey: "" });
  const state = {
    query: "q",
    candidates: [{ ref: "a", kind: "failure", snippet: "one" }],
  };
  const result = await port.evaluate(state, buildRelevanceQuestions(state.candidates));
  assert.equal(result.engine, "jev");
  assert.equal(result.status, "disabled");
  assert.deepEqual(result.evidenceRefs, ["a"]);
});

test("timeout and invalid output never impute scores", async () => {
  const timeoutFetch = ((_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    throw new Error("request timed out");
  }) as typeof fetch;
  const timeoutPort = createJevPort({ apiKey: "k", fetchImpl: timeoutFetch });
  const state = {
    query: "q",
    candidates: [{ ref: "a", kind: "failure", snippet: "one" }],
  };
  const timedOut = await timeoutPort.evaluate(state, buildRelevanceQuestions(state.candidates));
  assert.equal(timedOut.status, "timeout");
  assert.deepEqual(timedOut.evidenceRefs, ["a"]);
  assert.deepEqual(timedOut.answers, []);

  const badFetch = (async (): Promise<Response> =>
    new Response(JSON.stringify({ model: "jev-1.13.0", answers: {} }), { status: 200 })) as typeof fetch;
  const badPort = createJevPort({ apiKey: "k", fetchImpl: badFetch });
  const invalid = await badPort.evaluate(state, buildRelevanceQuestions(state.candidates));
  assert.equal(invalid.status, "invalid_output");
  assert.deepEqual(invalid.evidenceRefs, ["a"]);
});

test("noul answer validation rejects confidence-shaped impostors", () => {
  assert.equal(isValidNoulAnswer({ type: "noul", noul: 0.7 }), true);
  assert.equal(isValidNoulAnswer({ type: "noul", noul: 0.7, confidence: 0.9 }), true);
  assert.equal(isValidNoulAnswer({ type: "noul" }), false);
  assert.equal(isValidNoulAnswer({ type: "choice", choice: "a" }), false);
});
