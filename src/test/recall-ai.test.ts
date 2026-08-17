import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OllamaClient } from "../ai/ollama.js";
import { disabledRecallWithAi, type RecallWithAiPort } from "../ai/port.js";
import * as recallAi from "../ai/recall-ai.js";
import {
  createRecallAiPort,
  parseModelRecallOutput,
  singleFlightRecallAi,
} from "../ai/recall-ai.js";
import { RECALL_AI_SCHEMA } from "../ai/schema.js";
import { loadConfig, type ConfigLoadResult } from "../core/config-read.js";
import type { MemoryRecord } from "../core/memory-read.js";
import { createMemoryQueries, type RecallHit } from "../core/memory-query.js";
import { MAX_FIELD_BYTES, projectRecallHits } from "../mcp/privacy.js";

const records = Object.freeze([
  Object.freeze({
    kind: "failure" as const,
    id: "persisted-failure-one-9d3f",
    ts: 100,
    cwd: "/private/one",
    cmd: "module missing",
    exitCode: 1,
    fingerprint: "fp-one",
    signature: Object.freeze(["module missing"]),
    excerpt: "Bearer first-secret",
  }),
  Object.freeze({
    kind: "failure" as const,
    id: "persisted-failure-two-5a1c",
    ts: 200,
    cwd: "/private/two",
    cmd: "npm install module missing --token second-secret",
    exitCode: 1,
    fingerprint: "fp-two",
    signature: Object.freeze(["module missing"]),
    excerpt: "private excerpt",
    resolvedBy: "persisted-fix-two-7b2e",
  }),
  Object.freeze({
    kind: "fix" as const,
    id: "persisted-fix-two-7b2e",
    ts: 210,
    cwd: "/private/two",
    cmd: "npm install --legacy-peer-deps",
    failureIds: Object.freeze(["persisted-failure-two-5a1c"]),
  }),
]) as unknown as readonly MemoryRecord[];

const hits = Object.freeze(createMemoryQueries(() => [...records]).recall({ query: "module missing", limit: 2 }));
assert.deepEqual(hits.map((hit) => hit.failure.id), ["persisted-failure-one-9d3f", "persisted-failure-two-5a1c"]);

const enabledConfig = (exposure: "sanitized" | "raw" = "sanitized"): ConfigLoadResult => ({
  status: "valid",
  path: "/test/config.json",
  config: { version: 1, ai: { enabled: true, provider: "ollama", model: "test-model", exposure } },
});

function configLoader(result: ConfigLoadResult): typeof loadConfig {
  return () => result;
}

function validOutput(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    act: "known_fix",
    ranked_candidates: ["c1", "c2"],
    evidence_refs: ["c2.failure", "c2.fix"],
    confidence: 0.82,
    explanation: "Dependency version differs from remembered working command.",
    ...overrides,
  };
}

interface FakeOllama {
  client: OllamaClient;
  calls: { model: string; prompt: string; schema: Record<string, unknown>; signal?: AbortSignal }[];
}

function fakeOllama(value: unknown | ((signal?: AbortSignal) => unknown | Promise<unknown>)): FakeOllama {
  const calls: FakeOllama["calls"] = [];
  return {
    calls,
    client: {
      async listInstalledModels() { return []; },
      async probeModel() { return { supported: true }; },
      async generateStructured(model, prompt, schema, signal) {
        calls.push({ model, prompt, schema, signal });
        return typeof value === "function" ? await value(signal) : value;
      },
    },
  };
}

function configuredPortReturning(
  value: unknown | ((signal?: AbortSignal) => unknown | Promise<unknown>),
  config: ConfigLoadResult = enabledConfig(),
) {
  const ollama = fakeOllama(value);
  return { port: createRecallAiPort({ loadConfig: configLoader(config), ollama: ollama.client }), ollama };
}

function maximumRawHit(index: number): RecallHit {
  const field = String(index).repeat(MAX_FIELD_BYTES);
  return {
    failure: {
      kind: "failure", id: field, ts: index, cwd: field, cmd: field, exitCode: 1,
      fingerprint: field, signature: [field], excerpt: field,
    },
    fix: {
      kind: "fix", id: field, ts: index, cwd: field, cmd: field, failureIds: [field],
    },
    score: 1,
  };
}

function ids(source: readonly RecallHit[] = hits): string[] {
  return source.map((_, index) => `c${index + 1}`);
}

function input(source: readonly RecallHit[] = hits, exposure: "sanitized" | "raw" = "sanitized") {
  return { query: "module missing", hits: source, exposure } as const;
}

function promptFrom(ollama: FakeOllama): Record<string, unknown> {
  assert.equal(ollama.calls.length, 1);
  assert.ok(Buffer.byteLength(ollama.calls[0].prompt, "utf8") <= 8192);
  return JSON.parse(ollama.calls[0].prompt) as Record<string, unknown>;
}

test("schema is closed and requires the complete model contract", () => {
  assert.deepEqual(RECALL_AI_SCHEMA, {
    type: "object",
    additionalProperties: false,
    properties: {
      act: { type: "string", enum: ["known_fix", "unresolved", "ambiguous"] },
      ranked_candidates: { type: "array", items: { type: "string" }, maxItems: 5, uniqueItems: true },
      evidence_refs: { type: "array", items: { type: "string" }, maxItems: 10, uniqueItems: true },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      explanation: { type: "string", maxLength: 300 },
    },
    required: ["act", "ranked_candidates", "evidence_refs", "confidence", "explanation"],
  });
});

test("valid output ranks only request-local candidates", async () => {
  const { port } = configuredPortReturning({
    act: "known_fix",
    ranked_candidates: ["c2", "c1"],
    evidence_refs: ["c2.failure", "c2.fix"],
    confidence: 0.82,
    explanation: "Dependency version differs from remembered working command.",
  });

  const result = await port.run(input(), new AbortController().signal);

  assert.equal(result.aiStatus, "used");
  assert.deepEqual(result.rankedCandidateIds, ["c2", "c1"]);
  assert.deepEqual(result.evidenceRefs, ["c2.failure", "c2.fix"]);
});

test("low confidence discards all model additions", async () => {
  const { port } = configuredPortReturning(validOutput({ confidence: 0.59 }));

  const result = await port.run(input(), new AbortController().signal);

  assert.deepEqual(result, { aiStatus: "low_confidence", rankedCandidateIds: ["c1", "c2"] });
});

test("disabled and missing configuration never contacts Ollama", async () => {
  for (const config of [
    { status: "valid", path: "/test/config.json", config: { version: 1 as const, ai: { enabled: false as const } } },
    { status: "missing", path: "/test/config.json", config: { version: 1 as const, ai: { enabled: false as const } } },
  ] as const) {
    const { port, ollama } = configuredPortReturning(validOutput(), config);
    assert.deepEqual(await port.run(input(), new AbortController().signal), {
      aiStatus: "disabled", rankedCandidateIds: ["c1", "c2"],
    });
    assert.equal(ollama.calls.length, 0);
  }
});

test("invalid configuration is not overwritten and never contacts Ollama", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rocky-recall-ai-"));
  const configPath = join(directory, "config.json");
  writeFileSync(configPath, "{broken\n", "utf8");
  const ollama = fakeOllama(validOutput());
  const port = createRecallAiPort({ loadConfig: () => loadConfig(configPath), ollama: ollama.client });

  assert.deepEqual(await port.run(input(), new AbortController().signal), {
    aiStatus: "disabled", rankedCandidateIds: ["c1", "c2"],
  });
  assert.equal(ollama.calls.length, 0);
  assert.equal(readFileSync(configPath, "utf8"), "{broken\n");
});

test("no deterministic hits skips Ollama", async () => {
  const { port, ollama } = configuredPortReturning(validOutput());

  assert.deepEqual(await port.run(input([]), new AbortController().signal), {
    aiStatus: "no_hits", rankedCandidateIds: [],
  });
  assert.equal(ollama.calls.length, 0);
});

test("reloads configuration for every recall call", async () => {
  const results: ConfigLoadResult[] = [enabledConfig(), {
    status: "valid", path: "/test/config.json", config: { version: 1, ai: { enabled: false } },
  }];
  const ollama = fakeOllama(validOutput());
  const port = createRecallAiPort({
    loadConfig: () => results.shift() ?? enabledConfig(),
    ollama: ollama.client,
  });

  assert.equal((await port.run(input(), new AbortController().signal)).aiStatus, "used");
  assert.equal((await port.run(input(), new AbortController().signal)).aiStatus, "disabled");
  assert.equal(ollama.calls.length, 1);
});

test("strictest caller and configured exposure controls the prompt", async () => {
  for (const [caller, configured] of [
    ["sanitized", "raw"],
    ["raw", "sanitized"],
  ] as const) {
    const { port, ollama } = configuredPortReturning(validOutput(), enabledConfig(configured));
    await port.run(input(hits, caller), new AbortController().signal);
    const prompt = JSON.stringify(promptFrom(ollama));
    assert.doesNotMatch(prompt, /persisted-failure|private|first-secret|second-secret/);
  }
});

test("raw prompt may use projected raw evidence without unprojected fields", async () => {
  const { port, ollama } = configuredPortReturning(validOutput(), enabledConfig("raw"));
  await port.run(input(hits, "raw"), new AbortController().signal);
  const prompt = JSON.stringify(promptFrom(ollama));

  assert.match(prompt, /private\/two|second-secret/);
  assert.doesNotMatch(prompt, /"score"|resolvedBy/);
});

test("raw prompt and outcome preserve sparse source-local candidate identity", async () => {
  const third: RecallHit = {
    failure: {
      kind: "failure", id: "third", ts: 3, cwd: "/work", cmd: "original third command", exitCode: 1,
      fingerprint: "third-fingerprint", signature: ["third failure"], excerpt: "third excerpt",
    },
    score: 1,
  };
  const sparseHits = [maximumRawHit(1), maximumRawHit(2), third];
  const { port, ollama } = configuredPortReturning(validOutput({
    ranked_candidates: ["c3", "c1"],
    evidence_refs: ["c3.failure"],
  }), enabledConfig("raw"));

  const result = await port.run(input(sparseHits, "raw"), new AbortController().signal);
  const prompt = promptFrom(ollama);
  const candidates = prompt.candidates as Array<{ id: string; failure: { command: string } }>;

  assert.deepEqual(candidates.map((candidate) => candidate.id), ["c1", "c3"]);
  assert.equal(candidates.find((candidate) => candidate.id === "c3")?.failure.command, "original third command");
  assert.equal(candidates.some((candidate) => candidate.id === "c2"), false);
  assert.deepEqual(result, {
    aiStatus: "used",
    rankedCandidateIds: ["c3", "c1", "c2"],
    act: "known_fix",
    evidenceRefs: ["c3.failure"],
    confidence: 0.82,
    explanation: "Dependency version differs from remembered working command.",
  });
});

test("production port preserves an explicit sparse identity map through prompt and fallbacks", async () => {
  const third: RecallHit = {
    failure: {
      kind: "failure", id: "third", ts: 3, cwd: "/work", cmd: "original third command", exitCode: 1,
      fingerprint: "third-fingerprint", signature: ["third failure"], excerpt: "third excerpt",
    },
    score: 1,
  };
  const sparseHits = [third];
  const { port, ollama } = configuredPortReturning(validOutput({
    ranked_candidates: ["c3"],
    evidence_refs: ["c3.failure"],
    act: "unresolved",
  }), enabledConfig("raw"));
  const sparseInput = { ...input(sparseHits, "raw"), candidateIds: ["c3"] };

  const result = await port.run(sparseInput, new AbortController().signal);
  const prompt = promptFrom(ollama);
  const candidates = prompt.candidates as Array<{ id: string; failure: { command: string } }>;
  assert.deepEqual(candidates.map((candidate) => candidate.id), ["c3"]);
  assert.doesNotMatch(JSON.stringify(prompt), /original first|original second|c1|c2/u);
  assert.deepEqual(result.rankedCandidateIds, ["c3"]);

  const disabled = configuredPortReturning(validOutput(), {
    status: "valid", path: "/test/config.json", config: { version: 1, ai: { enabled: false } },
  }).port;
  assert.deepEqual(await disabled.run(sparseInput, new AbortController().signal), {
    aiStatus: "disabled", rankedCandidateIds: ["c3"],
  });
  assert.deepEqual(await disabledRecallWithAi.run(sparseInput, new AbortController().signal), {
    aiStatus: "disabled", rankedCandidateIds: ["c3"],
  });
  assert.deepEqual(await disabledRecallWithAi.run({ ...sparseInput, candidateIds: ["c20001"] }, new AbortController().signal), {
    aiStatus: "invalid_output", rankedCandidateIds: [],
  });

  const invalid = configuredPortReturning(validOutput({ ranked_candidates: ["c2"] }), enabledConfig("raw")).port;
  assert.deepEqual(await invalid.run(sparseInput, new AbortController().signal), {
    aiStatus: "invalid_output", rankedCandidateIds: ["c3"],
  });

  const overCap = configuredPortReturning(validOutput(), enabledConfig("raw")).port;
  assert.deepEqual(await overCap.run({ ...input(sparseHits, "raw"), candidateIds: ["c20001"] }, new AbortController().signal), {
    aiStatus: "invalid_output", rankedCandidateIds: [],
  });
});

test("oversized CLI query produces parseable bounded prompt with query truncation marker", async () => {
  const { port, ollama } = configuredPortReturning(validOutput());
  const oversized = "very long query ".repeat(3_000);
  await port.run({ ...input(), query: oversized }, new AbortController().signal);
  const prompt = promptFrom(ollama);

  assert.ok((prompt.truncatedFields as string[]).includes("query"));
  assert.notEqual(prompt.query, oversized);
  assert.ok(Array.isArray(prompt.candidates));
});

test("prompt admits at most five projected request-local candidates", async () => {
  const many = Object.freeze(Array.from({ length: 6 }, (_, index) => ({
    failure: Object.freeze({
      kind: "failure" as const, id: `persisted-${index}`, ts: index, cwd: "/private",
      cmd: `module missing ${index}`, exitCode: 1, fingerprint: `fp-${index}`,
      signature: Object.freeze(["module missing"]), excerpt: "private",
    }),
    score: 1,
  })) as RecallHit[]);
  const { port, ollama } = configuredPortReturning(validOutput());
  await port.run(input(many), new AbortController().signal);
  const prompt = promptFrom(ollama);

  assert.equal((prompt.candidates as unknown[]).length, 5);
});

test("validator rejects candidate escapes, duplicate rankings, invalid acts, and persistence references", () => {
  const projected = projectRecallHits(hits, "sanitized").items;
  for (const output of [
    validOutput({ ranked_candidates: ["c3"] }),
    validOutput({ ranked_candidates: ["c1", "c1"] }),
    validOutput({ act: "invented" }),
    validOutput({ ranked_candidates: ["persisted-failure-one-9d3f"] }),
  ]) {
    assert.equal(parseModelRecallOutput(output, projected), undefined);
  }
});

test("validator rejects invalid fix evidence and unknown schema members", () => {
  const projected = projectRecallHits(hits, "sanitized").items;
  assert.equal(parseModelRecallOutput(validOutput({ evidence_refs: ["c1.fix"] }), projected), undefined);
  assert.equal(parseModelRecallOutput(validOutput({ untrusted_extra: true }), projected), undefined);
});

test("invalid model output falls back without retaining partial additions", async () => {
  for (const output of [
    validOutput({ ranked_candidates: ["c2", "c2"] }),
    validOutput({ act: "not-an-act" }),
    validOutput({ evidence_refs: ["c1.fix"] }),
  ]) {
    const { port } = configuredPortReturning(output);
    assert.deepEqual(await port.run(input(), new AbortController().signal), {
      aiStatus: "invalid_output", rankedCandidateIds: ["c1", "c2"],
    });
  }
});

test("malformed JSON and code fences are invalid model output", async () => {
  const malformed = configuredPortReturning(() => { throw new SyntaxError("Unexpected token"); });
  assert.deepEqual(await malformed.port.run(input(), new AbortController().signal), {
    aiStatus: "invalid_output", rankedCandidateIds: ["c1", "c2"],
  });
  const fenced = configuredPortReturning(validOutput({ explanation: "```sh\nnpm install\n```" }));
  assert.deepEqual(await fenced.port.run(input(), new AbortController().signal), {
    aiStatus: "invalid_output", rankedCandidateIds: ["c1", "c2"],
  });
});

test("valid explanations remove terminal, bidi, newline, and control characters", async () => {
  const { port } = configuredPortReturning(validOutput({ explanation: "  hello\u001b[31m\u202eworld\u2069\nnext\u0007  " }));
  const result = await port.run(input(), new AbortController().signal);

  assert.equal(result.aiStatus, "used");
  assert.equal(result.explanation, "helloworld next");
});

test("explanation strips complete ANSI OSC sequences rather than retaining terminal payload", async () => {
  const { port } = configuredPortReturning(validOutput({ explanation: "hello\u001b]0;private terminal title\u0007 world" }));
  const result = await port.run(input(), new AbortController().signal);

  assert.equal(result.explanation, "hello world");
});

test("command-shaped explanation remains quoted untrusted data", async () => {
  const { port } = configuredPortReturning(validOutput({ explanation: "rm -rf / should never run" }));
  const result = await port.run(input(), new AbortController().signal);

  assert.equal(result.explanation, "rm -rf / should never run");
  assert.equal(JSON.stringify(result.explanation), '"rm -rf / should never run"');
});

test("schema-overlength explanation invalidates the entire model result", async () => {
  const { port } = configuredPortReturning(validOutput({ explanation: "🙂".repeat(301) }));
  const result = await port.run(input(), new AbortController().signal);

  assert.deepEqual(result, { aiStatus: "invalid_output", rankedCandidateIds: ["c1", "c2"] });
});

test("explanation strips C1 CSI OSC ST and ANSI device-control sequences", async () => {
  const { port } = configuredPortReturning(validOutput({
    explanation: "before\u009b31mCSI\u009dprivate title\u009c\u001bPprivate dcs\u001b\\\u0090private c1 dcs\u009cafter\u0085end",
  }));
  const result = await port.run(input(), new AbortController().signal);

  assert.equal(result.aiStatus, "used");
  assert.equal(result.explanation, "beforeCSIafter end");
  assert.doesNotMatch(result.explanation ?? "", /[\u0000-\u001f\u007f-\u009f]/);
});

test("formatter labels and JSON-escapes command-shaped untrusted explanation text", () => {
  const formatter = (recallAi as Record<string, unknown>).formatModelExplanation;
  assert.equal(typeof formatter, "function");
  if (typeof formatter !== "function") return;

  assert.equal(
    formatter('rm -rf / && echo "quoted"\n\u0007'),
    'model-generated interpretation (untrusted): "rm -rf / && echo \\"quoted\\"\\n\\u0007"',
  );
});

test("timeout, cancellation, model missing, and unavailable all preserve deterministic ranking", async () => {
  const cases: [unknown | (() => unknown), AbortSignal, string][] = [
    [() => { throw new Error("Ollama request timed out"); }, new AbortController().signal, "timeout"],
    [() => { throw new Error("model not found"); }, new AbortController().signal, "model_missing"],
    [() => { throw new Error("connect ECONNREFUSED"); }, new AbortController().signal, "unavailable"],
  ];
  const cancelled = new AbortController();
  cancelled.abort(new Error("caller cancelled"));
  cases.push([validOutput(), cancelled.signal, "cancelled"]);

  for (const [response, signal, aiStatus] of cases) {
    const { port } = configuredPortReturning(response);
    assert.deepEqual(await port.run(input(), signal), { aiStatus, rankedCandidateIds: ["c1", "c2"] });
  }
});

test("a late model response cannot override in-flight caller cancellation", async () => {
  let resolveResponse: ((value: unknown) => void) | undefined;
  const { port, ollama } = configuredPortReturning(() => new Promise((resolve) => { resolveResponse = resolve; }));
  const controller = new AbortController();
  const result = port.run(input(), controller.signal);

  assert.equal(ollama.calls.length, 1);
  controller.abort(new Error("caller cancelled"));
  resolveResponse?.(validOutput());
  assert.deepEqual(await result, { aiStatus: "cancelled", rankedCandidateIds: ["c1", "c2"] });
});

test("end-to-end recall deadline starts before inference and remains distinct from caller cancellation", { timeout: 2_000 }, async () => {
  let receivedSignal: AbortSignal | undefined;
  const ollama = fakeOllama((signal?: AbortSignal) => new Promise((resolve, reject) => {
    receivedSignal = signal;
    const timer = setTimeout(() => resolve(validOutput()), 750);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  }));
  const dependencies = {
    loadConfig: configLoader(enabledConfig()),
    ollama: ollama.client,
    deadlineMs: 250,
  };
  const port = createRecallAiPort(dependencies);
  const caller = new AbortController();
  const started = Date.now();

  const result = await port.run(input(), caller.signal);
  const elapsedMs = Date.now() - started;

  assert.deepEqual(result, { aiStatus: "timeout", rankedCandidateIds: ["c1", "c2"] });
  assert.equal(caller.signal.aborted, false);
  assert.equal(receivedSignal?.aborted, true);
  assert.ok(elapsedMs >= 100 && elapsedMs < 4_000, `deadline completed in ${elapsedMs}ms`);
});

test("model ranking appends omitted candidates in deterministic original order", async () => {
  const { port } = configuredPortReturning(validOutput({ ranked_candidates: ["c2"], evidence_refs: ["c2.failure"] }));
  const result = await port.run(input(), new AbortController().signal);

  assert.deepEqual(result.rankedCandidateIds, ["c2", "c1"]);
});

test("single-flight returns immediate busy fallback without queuing", async () => {
  let resolveFirst: ((value: ReturnType<RecallWithAiPort["run"]> extends Promise<infer T> ? T : never) => void) | undefined;
  const inner: RecallWithAiPort = {
    async run() {
      return await new Promise((resolve) => { resolveFirst = resolve; });
    },
  };
  const port = singleFlightRecallAi(inner);
  const first = port.run(input(), new AbortController().signal);

  assert.deepEqual(await port.run(input(), new AbortController().signal), {
    aiStatus: "busy", rankedCandidateIds: ["c1", "c2"],
  });
  const sparseInput = { ...input([hits[0]!, hits[1]!]), candidateIds: ["c1", "c3"] };
  assert.deepEqual(await port.run(sparseInput, new AbortController().signal), {
    aiStatus: "busy", rankedCandidateIds: ["c1", "c3"],
  });
  assert.deepEqual(await port.run({ ...sparseInput, candidateIds: ["c20001", "c3"] }, new AbortController().signal), {
    aiStatus: "busy", rankedCandidateIds: [],
  });
  const moreThanFive = Object.freeze(Array.from({ length: 6 }, (_, index) => ({
    failure: Object.freeze({
      kind: "failure" as const, id: `busy-${index}`, ts: index, cwd: "/private", cmd: "module missing",
      exitCode: 1, fingerprint: `busy-fp-${index}`, signature: Object.freeze(["module missing"]), excerpt: "private",
    }),
    score: 1,
  })) as RecallHit[]);
  assert.deepEqual(await port.run(input(moreThanFive), new AbortController().signal), {
    aiStatus: "busy", rankedCandidateIds: ["c1", "c2", "c3", "c4", "c5"],
  });
  resolveFirst?.({ aiStatus: "used", rankedCandidateIds: ["c1", "c2"] });
  assert.deepEqual(await first, { aiStatus: "used", rankedCandidateIds: ["c1", "c2"] });
});
