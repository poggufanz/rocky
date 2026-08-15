import { strict as assert } from "node:assert";
import { Buffer } from "node:buffer";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ambiguityCommand,
  checkAmbiguity,
  parseAmbiguityOutput,
  referentPlaces,
  AMBIGUITY_SCHEMA,
} from "../agent/ambiguity.js";
import type { OllamaClient } from "../ai/ollama.js";
import type { ConfigLoadResult } from "../core/config-read.js";
import type { MemoryRecord, TripleRecord } from "../core/memory-read.js";
import { resolveRockyPaths, type RockyPaths } from "../core/state-paths.js";

function fakePaths(): RockyPaths {
  return resolveRockyPaths({ ROCKY_HOME: "/tmp/rocky-ambiguity-test" });
}

function enabledConfig(path = "/tmp/ambiguity-config.json"): ConfigLoadResult {
  return {
    status: "valid",
    path,
    config: {
      version: 1,
      ai: { enabled: true, provider: "ollama", model: "ambiguity-test", exposure: "sanitized" },
    },
  };
}

function disabledConfig(path = "/tmp/ambiguity-config.json"): ConfigLoadResult {
  return {
    status: "valid",
    path,
    config: { version: 1, ai: { enabled: false } },
  };
}

function triple(id: string, path: string, props: string[] = ["button"]): TripleRecord {
  return {
    kind: "triple",
    id,
    ts: 1,
    cwd: "/workspace/hidden-from-prompt",
    schemaV: 1,
    agent: "claude-code",
    origin: "agent-hook",
    intent: { text: "make the button bigger" },
    rationale: { text: "must never enter ambiguity evidence", tags: ["spacing"], source: "transcript" },
    mechanism: {
      head: "must-never-be-prompt-evidence",
      files: [{ path, plusMinus: [1, 1], props }],
      truncatedFiles: 0,
    },
  };
}

function twoButtonTriples(): MemoryRecord[] {
  return [triple("one", "a/button.tsx"), triple("two", "b/button.tsx")];
}

function oneButtonTriple(): MemoryRecord[] {
  return [triple("one", "a/button.tsx")];
}

interface GenerateCapture {
  model?: string;
  prompt?: string;
  schema?: Record<string, unknown>;
  signal?: AbortSignal;
}

function fakeClient(response: unknown, capture: GenerateCapture = {}, failure = false): OllamaClient {
  return {
    async listInstalledModels() { return []; },
    async probeModel() { return { supported: true }; },
    async generateStructured(model, prompt, schema, signal) {
      capture.model = model;
      capture.prompt = prompt;
      capture.schema = schema;
      capture.signal = signal;
      if (failure) throw new Error("offline");
      return response;
    },
  };
}

function fakeClientCounting(response: unknown, calls: { n: number }): OllamaClient {
  return fakeClient(response, {}, false) && {
    async listInstalledModels() { return []; },
    async probeModel() { return { supported: true }; },
    async generateStructured(...args) {
      calls.n += 1;
      return fakeClient(response).generateStructured(...args);
    },
  };
}

test("ambiguous verdict with >=2 heard places queues spec-voiced question", async () => {
  const records = twoButtonTriples();
  const queued: string[] = [];
  const question = await checkAmbiguity("make the button bigger", {
    load: () => records,
    config: enabledConfig(),
    client: fakeClient({ ambiguous: true, referent: "button" }),
    queueLabel: (line: string) => { queued.push(line); },
    paths: fakePaths(),
  });
  assert.equal(question, 'you say "button". I hear 2 button before. which one, question');
  assert.deepEqual(queued, [question]);
  assert.ok(!question.includes("?"));
});

test("not ambiguous, single place, client failure, disabled config: all silent", async () => {
  const calls = { n: 0 };
  const countingClient = fakeClientCounting({ ambiguous: false, referent: "" }, calls);
  assert.equal(await checkAmbiguity("x", {
    load: () => [], config: enabledConfig(), client: countingClient,
    queueLabel: () => { throw new Error("must not queue"); }, paths: fakePaths(),
  }), undefined);
  assert.equal(await checkAmbiguity("button", {
    load: () => oneButtonTriple(), config: enabledConfig(),
    client: fakeClient({ ambiguous: true, referent: "button" }),
    queueLabel: () => { throw new Error("must not queue"); }, paths: fakePaths(),
  }), undefined);
  assert.equal(await checkAmbiguity("x", {
    load: () => [], config: enabledConfig(), client: fakeClient(undefined, {}, true),
    queueLabel: () => {}, paths: fakePaths(),
  }), undefined);
  assert.equal(await checkAmbiguity("x", {
    load: () => [], config: disabledConfig(), client: countingClient,
    queueLabel: () => {}, paths: fakePaths(),
  }), undefined);
  assert.equal(calls.n, 1);
});

test("qualifying ambiguity with queue failure stays silent", async () => {
  const question = await checkAmbiguity("make the button bigger", {
    load: () => twoButtonTriples(),
    config: enabledConfig(),
    client: fakeClient({ ambiguous: true, referent: "button" }),
    queueLabel: () => { throw new Error("queue is unavailable"); },
    paths: fakePaths(),
  });
  assert.equal(question, undefined);
});

test("invalid and timeout-style model results stay silent", async () => {
  for (const output of [
    null,
    [],
    { ambiguous: "yes", referent: "button" },
    { ambiguous: true, referent: "" },
    { ambiguous: true, referent: "button", extra: true },
  ]) {
    const question = await checkAmbiguity("make the button bigger", {
      load: () => twoButtonTriples(),
      config: enabledConfig(),
      client: fakeClient(output),
      queueLabel: () => { throw new Error("must not queue"); },
      paths: fakePaths(),
    });
    assert.equal(question, undefined);
  }
  const timeout = await checkAmbiguity("make the button bigger", {
    load: () => twoButtonTriples(),
    config: enabledConfig(),
    client: fakeClient(undefined, {}, true),
    queueLabel: () => { throw new Error("must not queue"); },
    paths: fakePaths(),
  });
  assert.equal(timeout, undefined);
});

test("parseAmbiguityOutput rejects junk and caps referent", () => {
  assert.equal(parseAmbiguityOutput(null), undefined);
  assert.equal(parseAmbiguityOutput({ ambiguous: "yes", referent: "x" }), undefined);
  assert.equal(parseAmbiguityOutput({ ambiguous: true, referent: "r".repeat(100) })?.referent.length, 60);
});

test("ambiguity schema is exact and evidence count uses distinct paths", () => {
  assert.deepEqual(AMBIGUITY_SCHEMA, {
    type: "object",
    additionalProperties: false,
    properties: {
      ambiguous: { type: "boolean" },
      referent: { type: "string" },
    },
    required: ["ambiguous", "referent"],
  });
  const records = [
    triple("one", "a/button.tsx"),
    triple("duplicate", "a/button.tsx"),
    triple("two", "b/button.tsx"),
  ];
  assert.equal(referentPlaces(records, "button"), 2);
  assert.equal(referentPlaces(records, "unknown"), 0);
});

test("ambiguity prompt forwards model/schema/ten-second signal and excludes forbidden fields", async () => {
  const capture: GenerateCapture = {};
  const question = await checkAmbiguity("make the button bigger", {
    load: () => twoButtonTriples(),
    config: enabledConfig(),
    client: fakeClient({ ambiguous: true, referent: "button" }, capture),
    queueLabel: () => {},
    paths: fakePaths(),
  });
  assert.equal(question, 'you say "button". I hear 2 button before. which one, question');
  assert.equal(capture.model, "ambiguity-test");
  assert.equal(capture.schema, AMBIGUITY_SCHEMA);
  assert.ok(capture.signal);
  assert.equal(capture.signal?.aborted, false);
  assert.match(capture.prompt ?? "", /make the button bigger/u);
  assert.match(capture.prompt ?? "", /known things I hear before:/u);
  assert.match(capture.prompt ?? "", /mark ambiguous ONLY when one short referent/u);
  assert.match(capture.prompt ?? "", /never guess what user means/u);
  assert.match(capture.prompt ?? "", /referent = the ambiguous words only/u);
  assert.match(capture.prompt ?? "", /a\/button\.tsx/u);
  assert.match(capture.prompt ?? "", /b\/button\.tsx/u);
  assert.doesNotMatch(capture.prompt ?? "", /hidden-from-prompt|must-never-be-prompt-evidence|spacing|rationale/u);
  assert.doesNotMatch(capture.prompt ?? "", /cwd|head|plusMinus|truncatedFiles|commands?/iu);
});

test("candidate selection is token-intersected, deduplicated, and capped at twenty", async () => {
  const candidates = Array.from({ length: 30 }, (_, index) => triple(
    `id-${index}`,
    `src/button-${index}.tsx`,
    ["other"],
  ));
  const capture: GenerateCapture = {};
  await checkAmbiguity("button", {
    load: () => candidates,
    config: enabledConfig(),
    client: fakeClient({ ambiguous: false, referent: "" }, capture),
    queueLabel: () => {},
    paths: fakePaths(),
  });
  const prompt = capture.prompt ?? "";
  const buttonPaths = [...prompt.matchAll(/src\/button-\d+\.tsx/gu)].map((match) => match[0]);
  assert.equal(buttonPaths.length, 20);
  assert.equal(new Set(buttonPaths).size, 20);
  assert.ok(buttonPaths.every((path) => path.includes("button")));
  assert.doesNotMatch(prompt, /src\/button-20\.tsx/u);
});

test("hostile referent is bounded to one safe Rocky line and queue is called once", async () => {
  const queued: string[] = [];
  const hostile = "  button\u001b[31m\n?\u0000";
  const question = await checkAmbiguity("button", {
    load: () => twoButtonTriples(),
    config: enabledConfig(),
    client: fakeClient({ ambiguous: true, referent: hostile }),
    queueLabel: (line: string) => queued.push(line),
    paths: fakePaths(),
  });
  assert.equal(question, undefined);
  assert.deepEqual(queued, []);
  assert.equal(Buffer.byteLength(question ?? "", "utf8") <= 512, true);
});

test("disabled or invalid config stays inert before load and client", async () => {
  let loaded = 0;
  let called = 0;
  const client = fakeClient({ ambiguous: true, referent: "button" });
  const counting: OllamaClient = {
    ...client,
    async generateStructured(...args) {
      called += 1;
      return client.generateStructured(...args);
    },
  };
  for (const config of [
    disabledConfig(),
    { status: "missing", path: "/tmp/missing", config: { version: 1, ai: { enabled: false } } } as ConfigLoadResult,
    { status: "invalid", path: "/tmp/invalid", error: "bad" } as ConfigLoadResult,
  ]) {
    assert.equal(await checkAmbiguity("button", {
      config,
      load: () => { loaded += 1; throw new Error("must not load"); },
      client: counting,
      queueLabel: () => { throw new Error("must not queue"); },
      paths: fakePaths(),
    }), undefined);
  }
  assert.equal(loaded, 0);
  assert.equal(called, 0);
});

test("ambiguity payload command rejects malformed, empty, and non-UTF8 payloads without side effects", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "rocky-ambiguity-command-"));
  const previousHome = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });
  const paths = resolveRockyPaths({ ROCKY_HOME: home });
  writeFileSync(paths.config, JSON.stringify({
    version: 1,
    ai: { enabled: true, provider: "ollama", model: "ambiguity-test", exposure: "sanitized" },
  }), { encoding: "utf8", mode: 0o600 });
  const malformed = ["%", "not base64url", "a=b", "\u0000"];
  const empty = ["", Buffer.from("", "utf8").toString("base64url")];
  const nonUtf8 = Buffer.from([0xff, 0xfe, 0xfd]).toString("base64url");
  for (const payload of [...malformed, ...empty, nonUtf8]) {
    assert.equal(await ambiguityCommand(payload), 0, JSON.stringify(payload));
  }
  assert.equal(existsSync(paths.labels), false);
});
