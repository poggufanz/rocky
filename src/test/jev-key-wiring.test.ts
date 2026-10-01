import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JEV_MODEL, JEV_OPENROUTER_MODEL, resolveJevKey } from "../ai/jev.js";
import { publicSettings, readSettings, writeSettings } from "../gui/settings.js";
import { startGui, type GuiHandle } from "../gui/server.js";

/**
 * Jev key wiring: env TYPESAFE_API_KEY wins, the Settings-stored jevKey
 * (gui.json, pasted in the GUI) is the fallback, and the value never
 * travels to the page — only hasJevKey. Every test is hermetic on
 * ROCKY_HOME, and key values are asserted on presence only.
 */
function hermetic(): { home: string; root: string } {
  const home = mkdtempSync(join(tmpdir(), "rocky-jevkey-home-"));
  const root = mkdtempSync(join(tmpdir(), "rocky-jevkey-root-"));
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

function readChatWire(parsed: unknown): { engine: string; status: string; evidenceRefs: string[]; text: string } {
  if (typeof parsed !== "object" || parsed === null) throw new Error("chat body shape");
  if (!("decisionTrace" in parsed) || !("text" in parsed)) throw new Error("chat body fields");
  const trace: unknown = parsed.decisionTrace;
  const text: unknown = parsed.text;
  if (typeof trace !== "object" || trace === null) throw new Error("chat trace shape");
  if (!("engine" in trace) || !("status" in trace) || !("evidenceRefs" in trace)) {
    throw new Error("chat trace fields");
  }
  const engine: unknown = trace.engine;
  const status: unknown = trace.status;
  const refs: unknown = trace.evidenceRefs;
  if (typeof engine !== "string") throw new Error("chat engine shape");
  if (typeof status !== "string") throw new Error("chat status shape");
  if (!Array.isArray(refs)) throw new Error("chat refs shape");
  if (typeof text !== "string") throw new Error("chat text shape");
  return { engine, status, evidenceRefs: refs.map((ref) => String(ref)), text };
}

function readSettingsWire(parsed: unknown): { hasJevKey: boolean; hasOpenRouterKey: boolean; raw: string } {
  if (typeof parsed !== "object" || parsed === null) throw new Error("settings body shape");
  if (!("hasJevKey" in parsed) || !("hasOpenRouterKey" in parsed)) throw new Error("settings key flag");
  const flag: unknown = parsed.hasJevKey;
  const orFlag: unknown = parsed.hasOpenRouterKey;
  if (typeof flag !== "boolean" || typeof orFlag !== "boolean") throw new Error("settings flag shape");
  return { hasJevKey: flag, hasOpenRouterKey: orFlag, raw: JSON.stringify(parsed) };
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

test("env key wins over the stored key; stored is the fallback; absent both is empty", () => {
  hermetic();
  assert.equal(resolveJevKey(envOf({ TYPESAFE_API_KEY: "env-present" }), "stored-present"), "env-present");
  assert.equal(resolveJevKey(envOf({}), "stored-present"), "stored-present");
  assert.equal(resolveJevKey(envOf({ TYPESAFE_API_KEY: "" }), "stored-present"), "stored-present");
  assert.equal(resolveJevKey(envOf({}), ""), "");
  assert.equal(resolveJevKey(envOf({ TYPESAFE_API_KEY: "env-present" }), "").length > 0, true);
  assert.equal(resolveJevKey(envOf({}), "stored-present").length > 0, true);
  assert.equal(resolveJevKey(envOf({}), "").length > 0, false);
});
test("a stored jev key survives other-field saves and erases on empty string", () => {
  hermetic();
  writeSettings({ jevKey: "stored-present" });
  writeSettings({ model: "other" });
  assert.equal(readSettings().jevKey.length > 0, true);
  assert.equal(publicSettings(readSettings()).hasJevKey, true);
  writeSettings({ jevKey: "" });
  assert.equal(publicSettings(readSettings()).hasJevKey, false);
});

test("a stored openrouter key survives other-field saves, erases on empty string, never leaks", () => {
  hermetic();
  writeSettings({ openRouterKey: "or-present" });
  writeSettings({ model: "other" });
  assert.equal(readSettings().openRouterKey.length > 0, true);
  assert.equal(publicSettings(readSettings()).hasOpenRouterKey, true);
  writeSettings({ openRouterKey: "" });
  assert.equal(publicSettings(readSettings()).hasOpenRouterKey, false);
  assert.equal(publicSettings(readSettings()).hasJevKey, false);
});

test("chat with jev:true and no key reports disabled plus baseline, disclosed", async () => {
  const { home, root } = hermetic();
  seedMemory(home, [failureRecord("persisted-failure-one-9d3f", "npm run build")]);
  const previous = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    await withGui(root, async (handle) => {
      const answer = await postChat(handle, { message: "code: npm run build", jev: true });
      assert.equal(answer.status, 200);
      const wire = readChatWire(answer.parsed);
      assert.equal(wire.engine, "jev");
      assert.equal(wire.status, "disabled");
      assert.ok(wire.text.includes("disabled"));
      assert.deepEqual(wire.evidenceRefs, ["persisted-failure-one-9d3f"]);
    });
  } finally {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
  }
});
test("chat on the openrouter path with no openrouter key reports disabled plus baseline", async () => {
  const { home, root } = hermetic();
  seedMemory(home, [failureRecord("persisted-failure-one-9d3f", "npm run build")]);
  writeFileSync(join(home, "config.json"), `${JSON.stringify({ version: 1, ai: { enabled: false }, decision: { engine: "jev", jevProvider: "openrouter" } })}\n`);
  const previousJev = process.env.TYPESAFE_API_KEY;
  const previousOr = process.env.OPENROUTER_API_KEY;
  // A Jev key alone must not arm the openrouter path: only its own slot counts.
  process.env.TYPESAFE_API_KEY = "jev-present";
  delete process.env.OPENROUTER_API_KEY;
  try {
    await withGui(root, async (handle) => {
      const answer = await postChat(handle, { message: "code: npm run build", jev: true });
      assert.equal(answer.status, 200);
      const wire = readChatWire(answer.parsed);
      assert.equal(wire.engine, "jev");
      assert.equal(wire.status, "disabled");
      assert.ok(wire.text.includes("disabled"));
      assert.deepEqual(wire.evidenceRefs, ["persisted-failure-one-9d3f"]);
    });
  } finally {
    if (previousJev === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previousJev;
    if (previousOr === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousOr;
  }
});

test("a stored-key write never leaks the value back through GET settings", async () => {
  const { root } = hermetic();
  await withGui(root, async (handle) => {
    const before = readSettingsWire((await callSettings(handle)).body);
    assert.equal(before.hasJevKey, false);
    assert.equal(before.hasOpenRouterKey, false);
    await callSettings(handle, { method: "POST", body: JSON.stringify({ jevKey: "stored-present" }) });
    const after = readSettingsWire((await callSettings(handle)).body);
    assert.equal(after.hasJevKey, true);
    assert.ok(!after.raw.includes("stored-present"), "the jev key must never travel to the page");
    await callSettings(handle, { method: "POST", body: JSON.stringify({ openRouterKey: "or-present" }) });
    const both = readSettingsWire((await callSettings(handle)).body);
    assert.equal(both.hasOpenRouterKey, true);
    assert.ok(!both.raw.includes("or-present"), "the openrouter key must never travel to the page");
  });
});

test("chat-models lists the pinned jev model only while a key is present", async () => {
  const { root } = hermetic();
  const previous = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    await withGui(root, async (handle) => {
      const modelsOf = async (): Promise<string[]> => {
        const response = await fetch(`http://127.0.0.1:${handle.port}/api/chat-models`, {
          headers: { "X-Rocky-Token": handle.token },
        });
        return readModelsWire(await response.json().catch(() => null));
      };
      assert.ok(!(await modelsOf()).includes(JEV_MODEL));
      await callSettings(handle, { method: "POST", body: JSON.stringify({ jevKey: "stored-present" }) });
      assert.ok((await modelsOf()).includes(JEV_MODEL));
    });
  } finally {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
  }
});

test("chat-models lists the openrouter model only on the openrouter path with its key", async () => {
  const { home, root } = hermetic();
  const previousJev = process.env.TYPESAFE_API_KEY;
  const previousOr = process.env.OPENROUTER_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    writeFileSync(join(home, "config.json"), `${JSON.stringify({ version: 1, ai: { enabled: false }, decision: { engine: "jev", jevProvider: "openrouter" } })}\n`);
    await withGui(root, async (handle) => {
      const modelsOf = async (): Promise<string[]> => {
        const response = await fetch(`http://127.0.0.1:${handle.port}/api/chat-models`, {
          headers: { "X-Rocky-Token": handle.token },
        });
        return readModelsWire(await response.json().catch(() => null));
      };
      // A Jev key alone is not enough on the openrouter path.
      await callSettings(handle, { method: "POST", body: JSON.stringify({ jevKey: "stored-present" }) });
      assert.ok(!(await modelsOf()).includes(JEV_OPENROUTER_MODEL));
      await callSettings(handle, { method: "POST", body: JSON.stringify({ openRouterKey: "or-present" }) });
      assert.ok((await modelsOf()).includes(JEV_OPENROUTER_MODEL));
    });
  } finally {
    if (previousJev === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previousJev;
    if (previousOr === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousOr;
  }
});
