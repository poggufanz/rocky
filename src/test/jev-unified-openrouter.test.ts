import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JEV_OPENROUTER_ENDPOINT,
  JEV_OPENROUTER_MODEL,
  isUnifiedOpenRouterMode,
  resolveUnifiedOpenRouterKey,
} from "../ai/jev.js";
import { readSettings, writeSettings } from "../gui/settings.js";
import { startGui, type GuiHandle } from "../gui/server.js";
import { decisionLogPath } from "../ai/decision-log.js";

/**
 * Unified OpenRouter mode: when the MAIN provider is OpenRouter, one shared
 * credential (env OPENROUTER_API_KEY wins, stored main key falls back) drives
 * BOTH the LLM path and the Jev path — no Jev key, no second OpenRouter key,
 * no jevProvider selection. Every test is hermetic on ROCKY_HOME, key values
 * are asserted on presence only, and only the Jev HTTP hop is stubbed: the
 * dash itself rides the real loopback server.
 */
function hermetic(): { home: string; root: string } {
  const home = mkdtempSync(join(tmpdir(), "rocky-unified-home-"));
  const root = mkdtempSync(join(tmpdir(), "rocky-unified-root-"));
  process.env.ROCKY_HOME = home;
  return { home, root };
}

function seedMemory(home: string, records: unknown[]): void {
  writeFileSync(join(home, "memory.jsonl"), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

const failureRecord = (id: string, cmd: string): unknown => ({
  kind: "failure",
  id,
  ts: Date.now() - 1000,
  cwd: "/private/one",
  cmd,
  exitCode: 1,
  fingerprint: "a1b2c3d4e5f60718",
  signature: [cmd],
  excerpt: "plain excerpt",
});

async function withGui(root: string, run: (handle: GuiHandle) => Promise<void>): Promise<void> {
  const handle = await startGui({ port: 0, root });
  try {
    await run(handle);
  } finally {
    await handle.close();
  }
}

async function postChat(handle: GuiHandle, body: unknown): Promise<{ status: number; parsed: unknown }> {
  const response = await fetch(`http://127.0.0.1:${handle.port}/api/chat`, {
    method: "POST",
    headers: { "X-Rocky-Token": handle.token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, parsed: await response.json().catch(() => null) };
}

async function callSettings(handle: GuiHandle, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${handle.port}/api/settings`, {
    ...init,
    headers: { "X-Rocky-Token": handle.token, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

function envOf(value: Record<string, string>): NodeJS.ProcessEnv {
  // Test-only env fabrication: in-process value the compiler lost track of.
  const fabricated: unknown = value;
  return fabricated as NodeJS.ProcessEnv;
}

function readChatWire(parsed: unknown): {
  engine: string; status: string; confidence: number | null; evidenceRefs: string[]; text: string;
} {
  if (typeof parsed !== "object" || parsed === null) throw new Error("chat body shape");
  if (!("decisionTrace" in parsed) || !("text" in parsed)) throw new Error("chat body fields");
  const trace: unknown = parsed.decisionTrace;
  const text: unknown = parsed.text;
  if (typeof trace !== "object" || trace === null) throw new Error("chat trace shape");
  if (!("engine" in trace) || !("status" in trace) || !("evidenceRefs" in trace) || !("confidence" in trace)) {
    throw new Error("chat trace fields");
  }
  const engine: unknown = trace.engine;
  const status: unknown = trace.status;
  const refs: unknown = trace.evidenceRefs;
  const confidence: unknown = trace.confidence;
  if (typeof engine !== "string") throw new Error("chat engine shape");
  if (typeof status !== "string") throw new Error("chat status shape");
  if (!Array.isArray(refs)) throw new Error("chat refs shape");
  if (confidence !== null && typeof confidence !== "number") throw new Error("chat confidence shape");
  if (typeof text !== "string") throw new Error("chat text shape");
  return { engine, status, confidence, evidenceRefs: refs.map((ref) => String(ref)), text };
}

/**
 * Stubs only the Jev hop: the pinned OpenRouter endpoint answers a fixed
 * Noul score with a cost, while every other URL (loopback dash, Ollama probe)
 * rides the real fetch. Restored afterwards, so sibling tests see no trace.
 */
async function withUnifiedStub(questionId: string, run: () => Promise<void>): Promise<void> {
  const originalFetch = globalThis.fetch;
  const stub: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === JEV_OPENROUTER_ENDPOINT) {
      return new Response(JSON.stringify({
        model: JEV_OPENROUTER_MODEL,
        answers: { [questionId]: { type: "noul", noul: 0.9 } },
        usage: { cost: 0.000042 },
      }), { status: 200 });
    }
    return originalFetch(input, init);
  };
  globalThis.fetch = stub;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}
function readModelsWire(parsed: unknown): string[] {
  if (typeof parsed !== "object" || parsed === null) throw new Error("models body shape");
  if (!("models" in parsed)) throw new Error("models field");
  const models: unknown = parsed.models;
  if (!Array.isArray(models)) throw new Error("models list shape");
  const ids: string[] = [];
  for (const model of models) {
    if (typeof model !== "object" || model === null) throw new Error("model entry shape");
    if (!("id" in model)) throw new Error("model id field");
    const id: unknown = model.id;
    if (typeof id !== "string") throw new Error("model id shape");
    ids.push(id);
  }
  return ids;
}


async function chatUsedViaSharedKey(root: string, ref: string): Promise<void> {
  await withUnifiedStub(`q_${ref}`, async () => {
    await withGui(root, async (handle) => {
      const answer = await postChat(handle, { message: "npm run build", jev: true });
      assert.equal(answer.status, 200);
      const wire = readChatWire(answer.parsed);
      assert.equal(wire.engine, "jev");
      assert.equal(wire.status, "used");
      assert.equal(wire.confidence, 0.9);
      assert.deepEqual(wire.evidenceRefs, [ref]);
      assert.ok(wire.text.includes("jev used"));
    });
  });
}

test("unified detection: main provider flag or an openrouter endpoint", () => {
  hermetic();
  assert.equal(isUnifiedOpenRouterMode("openrouter", ""), true);
  assert.equal(isUnifiedOpenRouterMode("openrouter", "https://example.test/v1/chat/completions"), true);
  assert.equal(isUnifiedOpenRouterMode("openai", "https://openrouter.ai/api/v1/chat/completions"), true);
  assert.equal(isUnifiedOpenRouterMode("openai", "https://OPENROUTER.AI/api/v1"), true);
  assert.equal(isUnifiedOpenRouterMode("openai", "https://api.openai.com/v1/chat/completions"), false);
  assert.equal(isUnifiedOpenRouterMode("anthropic", ""), false);
});

test("shared credential precedence: env wins, stored main key falls back", () => {
  hermetic();
  assert.equal(resolveUnifiedOpenRouterKey(envOf({ OPENROUTER_API_KEY: "env-present" }), "stored-present"), "env-present");
  assert.equal(resolveUnifiedOpenRouterKey(envOf({}), "stored-present"), "stored-present");
  assert.equal(resolveUnifiedOpenRouterKey(envOf({ OPENROUTER_API_KEY: "" }), "stored-present"), "stored-present");
  assert.equal(resolveUnifiedOpenRouterKey(envOf({}), ""), "");
});

test("unified mode drives Jev from the shared main key with no Jev key at all", async () => {
  const { home, root } = hermetic();
  const ref = "persisted-failure-one-9d3f";
  seedMemory(home, [failureRecord(ref, "npm run build")]);
  const previousJev = process.env.TYPESAFE_API_KEY;
  const previousOr = process.env.OPENROUTER_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    writeSettings({
      provider: "openrouter",
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      model: "m",
      key: "shared-present",
    });
    // The Jev slots stay empty: unified mode never reads them.
    assert.equal(readSettings().jevKey, "");
    assert.equal(readSettings().openRouterKey, "");
    await chatUsedViaSharedKey(root, ref);
    const lines = readFileSync(decisionLogPath(), "utf8").trim().split("\n");
    const last = lines[lines.length - 1];
    assert.ok(typeof last === "string" && last.length > 0);
    const entry = JSON.parse(last) as { engine?: unknown; status?: unknown; cost?: unknown; outcome?: unknown };
    assert.equal(entry.engine, "jev");
    assert.equal(entry.status, "used");
    assert.equal(entry.cost, 0.000042);
    assert.equal(entry.outcome, "chat");
  } finally {
    if (previousJev === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previousJev;
    if (previousOr === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousOr;
  }
});

test("unified mode also triggers on an openrouter endpoint with the shared key", async () => {
  const { home, root } = hermetic();
  const ref = "persisted-failure-one-9d3f";
  seedMemory(home, [failureRecord(ref, "npm run build")]);
  const previousJev = process.env.TYPESAFE_API_KEY;
  const previousOr = process.env.OPENROUTER_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    writeSettings({
      provider: "openai",
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      model: "m",
      key: "shared-present",
    });
    assert.equal(readSettings().jevKey, "");
    assert.equal(readSettings().openRouterKey, "");
    await chatUsedViaSharedKey(root, ref);
  } finally {
    if (previousJev === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previousJev;
    if (previousOr === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousOr;
  }
});

test("unified mode without any credential reports disabled plus baseline", async () => {
  const { home, root } = hermetic();
  const ref = "persisted-failure-one-9d3f";
  seedMemory(home, [failureRecord(ref, "npm run build")]);
  const previousJev = process.env.TYPESAFE_API_KEY;
  const previousOr = process.env.OPENROUTER_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    writeSettings({
      provider: "openrouter",
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      model: "m",
    });
    await withGui(root, async (handle) => {
      const answer = await postChat(handle, { message: "npm run build", jev: true });
      assert.equal(answer.status, 200);
      const wire = readChatWire(answer.parsed);
      assert.equal(wire.engine, "jev");
      assert.equal(wire.status, "disabled");
      assert.ok(wire.text.includes("disabled"));
      assert.deepEqual(wire.evidenceRefs, [ref]);
    });
  } finally {
    if (previousJev === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previousJev;
    if (previousOr === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousOr;
  }
});

test("native path unchanged: an openrouter env key never arms typesafe Jev", async () => {
  const { home, root } = hermetic();
  const ref = "persisted-failure-one-9d3f";
  seedMemory(home, [failureRecord(ref, "npm run build")]);
  const previousJev = process.env.TYPESAFE_API_KEY;
  const previousOr = process.env.OPENROUTER_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  process.env.OPENROUTER_API_KEY = "or-present";
  try {
    // Default settings: main provider openai with no endpoint — not unified —
    // so the native slot stays the only reader and stays empty.
    await withGui(root, async (handle) => {
      const answer = await postChat(handle, { message: "npm run build", jev: true });
      assert.equal(answer.status, 200);
      const wire = readChatWire(answer.parsed);
      assert.equal(wire.engine, "jev");
      assert.equal(wire.status, "disabled");
      assert.ok(wire.text.includes("disabled"));
      assert.deepEqual(wire.evidenceRefs, [ref]);
    });
  } finally {
    if (previousJev === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previousJev;
    if (previousOr === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousOr;
  }
});

test("unified settings round-trip exposes booleans only", async () => {
  const { root } = hermetic();
  const previousJev = process.env.TYPESAFE_API_KEY;
  const previousOr = process.env.OPENROUTER_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    await withGui(root, async (handle) => {
      const saved = await callSettings(handle, {
        method: "POST",
        body: JSON.stringify({
          provider: "openrouter",
          endpoint: "https://openrouter.ai/api/v1/chat/completions",
          model: "m",
          key: "shared-present",
        }),
      });
      assert.equal(saved.status, 200);
      const fetched = await callSettings(handle);
      assert.equal(fetched.status, 200);
      const body = fetched.body;
      if (typeof body !== "object" || body === null) throw new Error("settings body shape");
      if (!("provider" in body) || !("hasKey" in body)) throw new Error("settings body fields");
      assert.equal(body.provider, "openrouter");
      assert.equal(body.hasKey, true);
      assert.ok(!("key" in body) && !("jevKey" in body) && !("openRouterKey" in body));
      assert.ok(!JSON.stringify(body).includes("shared-present"), "the shared key must never travel to the page");
    });
  } finally {
    if (previousJev === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previousJev;
    if (previousOr === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousOr;
  }
});

test("chat-models lists the openrouter Jev model on the shared credential only", async () => {
  const { root } = hermetic();
  const previousJev = process.env.TYPESAFE_API_KEY;
  const previousOr = process.env.OPENROUTER_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    writeSettings({
      provider: "openrouter",
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      model: "m",
      key: "shared-present",
    });
    await withGui(root, async (handle) => {
      const modelsOf = async (): Promise<string[]> => {
        const response = await fetch(`http://127.0.0.1:${handle.port}/api/chat-models`, {
          headers: { "X-Rocky-Token": handle.token },
        });
        return readModelsWire(await response.json().catch(() => null));
      };
      assert.ok((await modelsOf()).includes(JEV_OPENROUTER_MODEL));
      writeSettings({ key: "" });
      assert.ok(!(await modelsOf()).includes(JEV_OPENROUTER_MODEL));
    });
  } finally {
    if (previousJev === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previousJev;
    if (previousOr === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousOr;
  }
});
