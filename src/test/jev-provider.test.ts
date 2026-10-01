import test from "node:test";
import assert from "node:assert/strict";
import {
  JEV_CREDIT_SHORTFALL_DETAIL,
  JEV_MODEL,
  JEV_OPENROUTER_ENDPOINT,
  JEV_OPENROUTER_MODEL,
  buildJevBody,
  buildJevOpenRouterBody,
  buildJevState,
  createJevPort,
  resolveActiveJevKey,
  resolveJevKey,
  resolveOpenRouterKey,
} from "../ai/jev.js";
import { buildRelevanceQuestions } from "../ai/decision.js";

const stateOf = (refs: readonly string[] = ["a", "b"]): {
  query: string;
  candidates: { ref: string; kind: string; snippet: string }[];
} => ({
  query: "q",
  candidates: refs.map((ref) => ({ ref, kind: "failure", snippet: `snippet ${ref}` })),
});

function stubFetch(handler: (url: unknown, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return ((url: unknown, init?: RequestInit): Promise<Response> =>
    Promise.resolve(handler(url, init ?? {}))) as typeof fetch;
}

function answersPayload(answers: Record<string, { type: "noul"; noul: number }>, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ model: JEV_OPENROUTER_MODEL, answers, ...extra }), { status: 200 });
}

test("provider constants pin the alpha endpoint and model id", () => {
  assert.equal(JEV_OPENROUTER_ENDPOINT, "https://openrouter.ai/api/alpha/decisions");
  assert.equal(JEV_OPENROUTER_MODEL, "typesafe/jev-1.13");
  assert.equal(JEV_MODEL, "jev-1.13.0");
});

test("native body preserves criteria as-is; openrouter body always carries both keys", () => {
  const sent = buildJevState("q", [{ ref: "a", kind: "failure", snippet: "s" }]);
  const native = buildJevBody(sent, buildRelevanceQuestions(sent.candidates));
  assert.equal(native.model, "jev-1.13.0");
  assert.deepEqual(Object.keys(native.questions.q_a?.criteria ?? {}).sort(), ["false", "true"]);

  const bare = buildJevOpenRouterBody(sent, [{ kind: "noul", id: "q_a", instructions: "judge" }]);
  assert.equal(bare.model, "typesafe/jev-1.13");
  const criteria = bare.questions.q_a?.criteria;
  assert.ok(typeof criteria?.true === "string" && criteria.true.length > 0);
  assert.ok(typeof criteria?.false === "string" && criteria.false.length > 0);
});

function envOf(value: Record<string, string>): NodeJS.ProcessEnv {
  return value as unknown as NodeJS.ProcessEnv;
}

test("key resolution never crosses slots: each provider reads only its own", () => {
  assert.equal(resolveJevKey(envOf({ TYPESAFE_API_KEY: "env" }), "stored"), "env");
  assert.equal(resolveOpenRouterKey(envOf({ OPENROUTER_API_KEY: "env" }), "stored"), "env");
  assert.equal(
    resolveActiveJevKey("openrouter", envOf({ TYPESAFE_API_KEY: "jev-env", OPENROUTER_API_KEY: "" }), "jev-stored", ""),
    "",
  );
  assert.equal(
    resolveActiveJevKey("openrouter", envOf({ TYPESAFE_API_KEY: "jev-env", OPENROUTER_API_KEY: "or-env" }), "jev-stored", "or-stored"),
    "or-env",
  );
  assert.equal(
    resolveActiveJevKey("typesafe", envOf({ OPENROUTER_API_KEY: "or-env" }), "jev-stored", "or-stored"),
    "jev-stored",
  );
  assert.equal(resolveActiveJevKey("openrouter", envOf({}), "", "or-stored"), "or-stored");
});

test("openrouter used call posts both-criteria body and surfaces usage.cost", async () => {
  const seen: { body: { model?: unknown; questions?: Record<string, { criteria?: Record<string, unknown> }> } | null; url: unknown; auth: string } = { body: null, url: null, auth: "" };
  const fetchImpl = stubFetch((url, init) => {
    seen.url = url;
    seen.auth = String((init.headers as Record<string, string>).Authorization ?? "");
    seen.body = JSON.parse(String(init.body)) as NonNullable<typeof seen.body>;
    return answersPayload(
      { q_a: { type: "noul", noul: 0.9 }, q_b: { type: "noul", noul: 0.1 } },
      { id: "gen-1", provider: { name: "TypeSafe" }, usage: { cost: 0.000042 } },
    );
  });
  const port = createJevPort({ provider: "openrouter", apiKey: "or-key", fetchImpl });
  const result = await port.evaluate(stateOf(), buildRelevanceQuestions(stateOf().candidates));
  assert.equal(result.engine, "jev");
  assert.equal(result.status, "used");
  assert.deepEqual(result.evidenceRefs, ["a", "b"]);
  assert.equal(result.cost, 0.000042);
  assert.equal(seen.url, JEV_OPENROUTER_ENDPOINT);
  assert.equal(seen.auth, "Bearer or-key");
  if (seen.body === null) throw new Error("openrouter body was not posted");
  const posted: { model?: unknown; questions?: Record<string, { criteria?: Record<string, unknown> }> } = seen.body;
  assert.equal(posted.model, JEV_OPENROUTER_MODEL);
  for (const question of Object.values(posted.questions ?? {})) {
    assert.ok(typeof question.criteria?.true === "string" && (question.criteria.true as string).length > 0);
    assert.ok(typeof question.criteria?.false === "string" && (question.criteria.false as string).length > 0);
  }
});

test("openrouter accepts a valid response without an exact model echo", async () => {
  const fetchImpl = stubFetch(() =>
    answersPayload({ q_a: { type: "noul", noul: 0.7 } }, { model: "something-else" }),
  );
  const port = createJevPort({ provider: "openrouter", apiKey: "or-key", fetchImpl });
  const result = await port.evaluate(stateOf(["a"]), buildRelevanceQuestions(stateOf(["a"]).candidates));
  assert.equal(result.status, "used");
  assert.deepEqual(result.evidenceRefs, ["a"]);
});

test("native still rejects a mismatched model echo", async () => {
  const fetchImpl = stubFetch(() =>
    new Response(JSON.stringify({ model: "other", answers: { q_a: { type: "noul", noul: 0.7 } } }), { status: 200 }),
  );
  const port = createJevPort({ apiKey: "k", fetchImpl });
  const result = await port.evaluate(stateOf(["a"]), buildRelevanceQuestions(stateOf(["a"]).candidates));
  assert.equal(result.status, "invalid_output");
  assert.deepEqual(result.evidenceRefs, ["a"]);
});

test("openrouter 402 maps to unavailable with an explicit credits disclosure", async () => {
  const fetchImpl = stubFetch(() => new Response(JSON.stringify({ error: { message: "credits" } }), { status: 402 }));
  const port = createJevPort({ provider: "openrouter", apiKey: "or-key", fetchImpl });
  const result = await port.evaluate(stateOf(["a"]), buildRelevanceQuestions(stateOf(["a"]).candidates));
  assert.equal(result.engine, "jev");
  assert.equal(result.status, "unavailable");
  assert.equal(result.detail, JEV_CREDIT_SHORTFALL_DETAIL);
  assert.deepEqual(result.evidenceRefs, ["a"]);
});

test("missing active-provider key reports disabled with baseline, never mocked", async () => {
  let called = false;
  const fetchImpl = stubFetch(() => {
    called = true;
    return answersPayload({ q_a: { type: "noul", noul: 0.9 } });
  });
  const openrouter = createJevPort({ provider: "openrouter", apiKey: "", fetchImpl });
  const disabled = await openrouter.evaluate(stateOf(["a"]), buildRelevanceQuestions(stateOf(["a"]).candidates));
  assert.equal(disabled.status, "disabled");
  assert.deepEqual(disabled.evidenceRefs, ["a"]);
  assert.equal(called, false);

  const native = createJevPort({ apiKey: "", fetchImpl });
  const nativeDisabled = await native.evaluate(stateOf(["a"]), buildRelevanceQuestions(stateOf(["a"]).candidates));
  assert.equal(nativeDisabled.status, "disabled");
  assert.deepEqual(nativeDisabled.evidenceRefs, ["a"]);
});
