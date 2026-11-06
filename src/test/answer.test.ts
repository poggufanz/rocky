import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";

import { executeAnswer, snapshotOf } from "../ai/answer.js";
import { describeMemoryCoverage } from "../core/coverage.js";
import { MAX_SUPPORTED_MEMORY_RECORDS, type MemoryCoverage } from "../core/memory-read.js";
import { writeSettings } from "../gui/settings.js";
import { validateOutputLine } from "../ui/phrases.js";

function hermetic(): { home: string; root: string } {
  const home = mkdtempSync(join(tmpdir(), "rocky-ans-home-"));
  const root = mkdtempSync(join(tmpdir(), "rocky-ans-root-"));
  process.env.ROCKY_HOME = home;
  return { home, root };
}

test("executeAnswer in mode chat processes messages with fallback when no model is active", async () => {
  const { root } = hermetic();
  const outcome = await executeAnswer({
    mode: "chat",
    message: "why did the build fail?",
    root,
  });

  assert.equal(outcome.status, 200);
  assert.ok("text" in outcome.payload);
  assert.ok(Array.isArray(outcome.payload.evidenceCards));
  assert.ok(outcome.payload.decisionTrace !== undefined);
  assert.equal(outcome.payload.llm.active, false);
});

test("executeAnswer in mode explain gathers multi-hop reference trace and calls active BYOK model", async () => {
  const { root } = hermetic();
  mkdirSync(join(root, "src"), { recursive: true });

  // Mock file B and file A
  writeFileSync(
    join(root, "src", "engine.ts"),
    "export function executeCore() { return true; }\n",
  );
  writeFileSync(
    join(root, "src", "controller.ts"),
    'import { executeCore } from "./engine.js";\nexport function runController() {\n  return executeCore();\n}\n',
  );

  let seenPrompt = "";
  const provider: Server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    seenPrompt = JSON.parse(raw).messages[0].content;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "KODE\nwhy 1: controller delegates to executeCore in engine.ts" } }] }));
  });
  await new Promise<void>((up) => provider.listen(0, "127.0.0.1", () => up()));
  const providerPort = (provider.address() as { port: number }).port;

  try {
    writeSettings({
      provider: "openai",
      endpoint: `http://127.0.0.1:${providerPort}/v1/chat/completions`,
      model: "gpt-4o",
      key: "sk-test",
    });

    const outcome = await executeAnswer({
      mode: "explain",
      prompt: "Why is runController written this way?",
      codeContext: {
        path: "src/controller.ts",
        start: 2,
        end: 4,
      },
      root,
    });

    assert.equal(outcome.status, 200);
    assert.ok("text" in outcome.payload);
    assert.ok(outcome.payload.text.includes("controller delegates to executeCore"));
    assert.ok(outcome.payload.referenceTrace !== undefined);
    assert.ok(outcome.payload.referenceTrace.nodes.some((n) => n.symbol === "executeCore"));
    assert.ok(seenPrompt.includes("=== definition executeCore"));
  } finally {
    await new Promise<void>((down) => provider.close(() => down()));
  }
});

test("executeAnswer in mode explain refuses with 400 when no provider key is configured", async () => {
  const { root } = hermetic();
  writeSettings({
    provider: "openai",
    endpoint: "",
    model: "",
    key: "",
  });

  const outcome = await executeAnswer({
    mode: "explain",
    prompt: "explain this",
    codeContext: {
      path: "test.ts",
      start: 1,
      end: 1,
    },
    root,
  });

  assert.equal(outcome.status, 400);
});

test("executeAnswer in mode explain works with empty memory and passes code context cleanly", async () => {
  const { home, root } = hermetic();
  // Ensure empty memory
  writeFileSync(join(home, "memory.jsonl"), "");
  writeFileSync(join(root, "calc.ts"), "export function add(a: number, b: number) { return a + b; }\n");

  let receivedPrompt = "";
  const provider: Server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    receivedPrompt = JSON.parse(raw).messages[0].content;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "KODE\nwhy 1: pure addition helper\nstop" } }] }));
  });
  await new Promise<void>((up) => provider.listen(0, "127.0.0.1", () => up()));
  const providerPort = (provider.address() as { port: number }).port;

  try {
    writeSettings({
      provider: "openai",
      endpoint: `http://127.0.0.1:${providerPort}/v1/chat/completions`,
      model: "gpt-4o",
      key: "sk-test",
    });

    const outcome = await executeAnswer({
      mode: "explain",
      prompt: "Why does add function exist?",
      codeContext: {
        path: "calc.ts",
        start: 1,
        end: 1,
      },
      root,
    });

    assert.equal(outcome.status, 200);
    assert.ok("text" in outcome.payload);
    assert.ok(outcome.payload.text.includes("pure addition helper"));
    assert.ok(receivedPrompt.includes("=== selection calc.ts:1-1 ==="));
  } finally {
    await new Promise<void>((down) => provider.close(() => down()));
  }
});

function coverage(overrides: Partial<MemoryCoverage> = {}): MemoryCoverage {
  return { version: 1, scanned: 3, skipped: 0, truncated: 0, bytesScanned: 120, bytesTotal: 120, complete: true, ...overrides };
}

/** `disclosed`: the answer says the read was not whole. `hold`: the read stopped early, so no answer is given. */
const READS: readonly { name: string; coverage: MemoryCoverage; disclosed: boolean; hold: boolean }[] = [
  { name: "a whole read", coverage: coverage(), disclosed: false, hold: false },
  { name: "whitespace-only lines, scanned exceeds records, still whole", coverage: coverage({ scanned: 5 }), disclosed: false, hold: false },
  { name: "one skipped line", coverage: coverage({ skipped: 1, complete: false }), disclosed: true, hold: false },
  { name: "several skipped lines", coverage: coverage({ skipped: 4, complete: false }), disclosed: true, hold: false },
  { name: "the record cap", coverage: coverage({ truncated: 1, complete: false, reason: "record-cap" }), disclosed: true, hold: true },
  { name: "the file size cap", coverage: coverage({ truncated: 1, complete: false, reason: "file-size-cap" }), disclosed: true, hold: true },
  { name: "a read race", coverage: coverage({ scanned: 0, truncated: 1, complete: false, reason: "read-race" }), disclosed: true, hold: true },
  { name: "skipped lines plus the record cap", coverage: coverage({ skipped: 2, truncated: 1, complete: false, reason: "record-cap" }), disclosed: true, hold: true },
  { name: "incomplete with no reason and nothing skipped", coverage: coverage({ complete: false }), disclosed: true, hold: true },
  { name: "truncated with no reason and nothing skipped", coverage: coverage({ truncated: 2, complete: false }), disclosed: true, hold: true },
];

for (const read of READS) {
  test(`snapshotOf separates disclosing from holding for ${read.name}`, () => {
    const snapshot = snapshotOf({ records: [], coverage: read.coverage });
    assert.equal(snapshot.disclosure, describeMemoryCoverage(read.coverage, 0, { counts: false }));
    assert.equal(snapshot.disclosure !== undefined, read.disclosed);
    assert.equal(snapshot.hold, read.hold);
    // a held answer is always a disclosed one
    if (snapshot.hold) assert.ok(snapshot.disclosure !== undefined);
  });
}

test("executeAnswer holds the answer when the read stopped at the record cap, and says so in words", async () => {
  const { home, root } = hermetic();
  const lines = Array.from({ length: MAX_SUPPORTED_MEMORY_RECORDS + 1 }, (_, index) => JSON.stringify({
    kind: "failure", id: `r${index}`, ts: 1, cwd: "/words", cmd: "false", exitCode: 1,
    fingerprint: `r${index}`.padStart(16, "0"), signature: ["false"], excerpt: "false",
  }));
  writeFileSync(join(home, "memory.jsonl"), lines.map((line) => `${line}\n`).join(""));

  const outcome = await executeAnswer({ mode: "chat", message: "false", root });

  assert.equal(outcome.status, 200);
  assert.ok("text" in outcome.payload);
  const line = `memory coverage incomplete: first ${MAX_SUPPORTED_MEMORY_RECORDS} records heard, later lines not heard.`;
  assert.equal(outcome.payload.decisionTrace.status, "unavailable");
  assert.deepEqual(outcome.payload.evidenceCards, []);
  assert.equal(outcome.payload.coverage?.reason, line);
  assert.deepEqual(outcome.payload.trace, [line]);
  assert.equal(outcome.payload.text, "The memory read was incomplete, so the answer is held back.");
  assert.deepEqual(validateOutputLine(outcome.payload.text), []);
});

test("executeAnswer says in plain words when no memory record matches, in English and Indonesian", async () => {
  const { home, root } = hermetic();
  const asked = async (): Promise<string> => {
    const outcome = await executeAnswer({ mode: "chat", message: "something never recorded", root });
    assert.equal(outcome.status, 200);
    assert.ok("text" in outcome.payload);
    assert.equal(outcome.payload.decisionTrace.status, "low_confidence");
    return outcome.payload.text;
  };

  const english = await asked();
  assert.equal(english, "No memory record matched this question well enough to answer it.");
  assert.deepEqual(validateOutputLine(english), []);

  writeFileSync(join(home, "gui.json"), JSON.stringify({ lang: "id" }));
  const indonesian = await asked();
  assert.equal(indonesian, "Tidak ada catatan memori yang cukup cocok untuk menjawab pertanyaan ini.");
  assert.deepEqual(validateOutputLine(indonesian), []);
});

test("executeAnswer holds the answer in plain words when whole memory evidence does not fit the context", async () => {
  const { home, root } = hermetic();
  const lines = Array.from({ length: 80 }, (_, index) => JSON.stringify({
    kind: "failure", id: `big${index}`, ts: 1 + index, cwd: "/words", cmd: "npm run build", exitCode: 1,
    fingerprint: `b${index}`.padStart(16, "0"), signature: ["npm run build"], excerpt: "build failed ".repeat(40),
  }));
  writeFileSync(join(home, "memory.jsonl"), lines.map((line) => `${line}\n`).join(""));

  const outcome = await executeAnswer({ mode: "chat", message: "npm run build", root });

  assert.equal(outcome.status, 200);
  assert.ok("text" in outcome.payload);
  assert.equal(outcome.payload.decisionTrace.status, "unavailable");
  assert.equal(
    outcome.payload.text,
    "The whole memory evidence does not fit the context limit, so the answer is held back. Records are never cut to fit.",
  );
  assert.deepEqual(validateOutputLine(outcome.payload.text), []);
});

test("executeAnswer refuses an empty chat message with a plain sentence", async () => {
  const { root } = hermetic();
  const outcome = await executeAnswer({ mode: "chat", message: "   ", root });
  assert.equal(outcome.status, 400);
  assert.deepEqual(outcome.payload, { error: "A message is required." });
  assert.deepEqual(validateOutputLine("A message is required."), []);
});

test("executeAnswer in mode explain asks for model settings in a plain sentence when none are set", async () => {
  const { root } = hermetic();
  const outcome = await executeAnswer({ mode: "explain", prompt: "why does this exist", root });
  assert.equal(outcome.status, 400);
  assert.deepEqual(outcome.payload, { error: "Set an endpoint, key, and model in settings first." });
  assert.deepEqual(validateOutputLine("Set an endpoint, key, and model in settings first."), []);
});

test("executeAnswer respects unified OpenRouter key from environment", async () => {
  const { root } = hermetic();
  writeFileSync(join(root, "math.ts"), "export function double(x: number) { return x * 2; }\n");

  let receivedAuth = "";
  const provider: Server = createServer(async (req, res) => {
    receivedAuth = req.headers.authorization ?? "";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "KODE\nwhy 1: doubling utility" } }] }));
  });
  await new Promise<void>((up) => provider.listen(0, "127.0.0.1", () => up()));
  const providerPort = (provider.address() as { port: number }).port;

  try {
    writeSettings({
      provider: "openrouter",
      endpoint: `http://127.0.0.1:${providerPort}/v1/chat/completions`,
      model: "anthropic/claude-3.5-sonnet",
      key: "",
    });

    const customEnv = {
      ...process.env,
      OPENROUTER_API_KEY: "sk-or-env-secret-12345",
    };

    const outcome = await executeAnswer({
      mode: "explain",
      prompt: "explain double",
      codeContext: {
        path: "math.ts",
        start: 1,
        end: 1,
      },
      root,
      env: customEnv,
    });

    assert.equal(outcome.status, 200);
    assert.equal(receivedAuth, "Bearer sk-or-env-secret-12345");
  } finally {
    await new Promise<void>((down) => provider.close(() => down()));
  }
});

