import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGui, type GuiHandle } from "../gui/server.js";
import {
  __clearChatLlmTestDoubles,
  __setChatLlmTestDoubles,
  inactiveToStageStatus,
  isLlmActive,
  resolveChatLlmSelection,
} from "../ai/chat-llm.js";
import { validateChatStructure } from "../ai/chat-structure.js";
import { validateRenderedClaims } from "../ai/chat-render.js";

function storedOf(patch: Partial<{ provider: string; endpoint: string; model: string; key: string }>): {
  provider: string; endpoint: string; model: string; key: string;
} {
  return {
    provider: patch.provider ?? "openai",
    endpoint: patch.endpoint ?? "",
    model: patch.model ?? "",
    key: patch.key ?? "",
  };
}

function envOf(value: Record<string, string>): NodeJS.ProcessEnv {
  const fabricated: unknown = value;
  return fabricated as NodeJS.ProcessEnv;
}

test("llm-active predicate: ollama installed = active, offline = unavailable", () => {
  const stored = storedOf({ model: "llama3.1" });
  assert.equal(isLlmActive(resolveChatLlmSelection({
    requestedModel: "llama3.1", stored, installed: ["llama3.1", "mistral"],
  })), true);
  const offline = resolveChatLlmSelection({ requestedModel: "llama3.1", stored, installed: undefined });
  assert.equal(isLlmActive(offline), false);
  assert.equal(offline.reason, "unavailable");
});

test("llm-active predicate: empty selection is no-model", () => {
  const selection = resolveChatLlmSelection({
    requestedModel: undefined, stored: storedOf({}), installed: ["llama3.1"],
  });
  assert.equal(isLlmActive(selection), false);
  assert.equal(selection.reason, "no-model");
  assert.deepEqual(inactiveToStageStatus("no-model"), { structurer: "disabled", renderer: "disabled" });
});

test("llm-active predicate: byok needs endpoint + model + key", () => {
  const keyed = storedOf({ endpoint: "https://api.openai.com/v1/chat/completions", model: "gpt-4o-mini", key: "present" });
  assert.equal(isLlmActive(resolveChatLlmSelection({
    requestedModel: undefined, stored: keyed, installed: [], env: envOf({}),
  })), true);
  const missing = resolveChatLlmSelection({
    requestedModel: undefined, stored: storedOf({ endpoint: keyed.endpoint, model: keyed.model, key: "" }), installed: [], env: envOf({}),
  });
  assert.equal(isLlmActive(missing), false);
  assert.equal(missing.reason, "missing-key");
  const unknown = resolveChatLlmSelection({
    requestedModel: "ghost-model", stored: keyed, installed: ["llama3.1"], env: envOf({}),
  });
  assert.equal(isLlmActive(unknown), false);
  assert.equal(unknown.reason, "invalid_model");
  assert.deepEqual(inactiveToStageStatus("invalid_model"), { structurer: "invalid_model", renderer: "invalid_model" });
});

test("llm-active predicate: unified openrouter shares the main key", () => {
  const stored = storedOf({
    provider: "openrouter",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    model: "meta-llama/llama-3.1-8b",
    key: "",
  });
  assert.equal(isLlmActive(resolveChatLlmSelection({
    requestedModel: undefined, stored, installed: [], env: envOf({ OPENROUTER_API_KEY: "env-present" }),
  })), true);
  const absent = resolveChatLlmSelection({ requestedModel: undefined, stored, installed: [], env: envOf({}) });
  assert.equal(isLlmActive(absent), false);
  assert.equal(absent.reason, "missing-key");
});

test("structurer allowlist rejects invented refs (no-new-claims gate)", () => {
  assert.equal(validateChatStructure({
    query: "npm run build",
    candidates: [{ ref: "failure-zzz", kind: "failure", snippet: "invented" }],
  }, ["failure-aaa"]), false);
});

test("renderer strips uncited extras and counts them", () => {
  const check = validateRenderedClaims(
    "rocky heard 1 thing.\nThe cache bug is definitely stale DNS.",
    ["failure-aaa"],
  );
  assert.ok(check.dropped > 0);
  assert.ok(!check.stripped.includes("stale DNS"));
});

function hermetic(): { home: string; root: string } {
  const home = mkdtempSync(join(tmpdir(), "rocky-chatllm-home-"));
  const root = mkdtempSync(join(tmpdir(), "rocky-chatllm-root-"));
  process.env.ROCKY_HOME = home;
  return { home, root };
}

function seedMemory(home: string, records: unknown[]): void {
  writeFileSync(join(home, "memory.jsonl"), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

function seedConfig(home: string, config: unknown): void {
  writeFileSync(join(home, "config.json"), `${JSON.stringify(config)}\n`);
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

async function postChat(handle: GuiHandle, body: unknown): Promise<{ status: number; parsed: unknown }> {
  const response = await fetch(`http://127.0.0.1:${handle.port}/api/chat`, {
    method: "POST",
    headers: { "X-Rocky-Token": handle.token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, parsed: await response.json().catch(() => null) };
}

function readLlmWire(parsed: unknown): { active: boolean; model: string; structurer: string; renderer: string; stripped: number; engine: string; status: string; renderOrder: unknown } {
  if (typeof parsed !== "object" || parsed === null) throw new Error("chat body shape");
  const payload = parsed as Record<string, unknown>;
  const llm = payload.llm as Record<string, unknown>;
  const trace = payload.decisionTrace as Record<string, unknown>;
  if (typeof llm !== "object" || llm === null || typeof trace !== "object" || trace === null) {
    throw new Error("chat llm/trace shape");
  }
  const inner = trace.llm as Record<string, unknown>;
  if (typeof llm.active !== "boolean" || typeof llm.model !== "string" ||
    typeof llm.structurerStatus !== "string" || typeof llm.rendererStatus !== "string" ||
    typeof llm.stripped !== "number" || typeof trace.engine !== "string" || typeof trace.status !== "string") {
    throw new Error("chat llm fields");
  }
  if (typeof inner !== "object" || inner === null || inner.active !== llm.active) {
    throw new Error("decisionTrace.llm must mirror the top-level llm trace");
  }
  return {
    active: llm.active,
    model: llm.model,
    structurer: llm.structurerStatus,
    renderer: llm.rendererStatus,
    stripped: llm.stripped,
    engine: trace.engine,
    status: trace.status,
    renderOrder: payload.renderOrder,
  };
}

test("active model: /api/chat provably calls structurer AND renderer (stub counts), decision flows through", async () => {
  const { home, root } = hermetic();
  seedMemory(home, [
    failureRecord("persisted-failure-one-9d3f", "npm run build"),
    failureRecord("persisted-failure-two-41ab", "npm run build"),
  ]);
  const previous = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  let structurerCalls = 0;
  let rendererCalls = 0;
  __setChatLlmTestDoubles({
    listInstalledModels: async () => ["stub-chat-model"],
    ollamaStructured: async (model: string, prompt: string, schema: Record<string, unknown>) => {
      if (String(schema.required ?? "").includes("candidates") || "candidates" in (schema.properties as Record<string, unknown>)) {
        structurerCalls += 1;
        assert.equal(model, "stub-chat-model");
        return {
          query: "npm run build",
          candidates: [
            { ref: "persisted-failure-two-41ab", kind: "failure", snippet: "anything" },
            { ref: "persisted-failure-one-9d3f", kind: "failure", snippet: "anything" },
          ],
        };
      }
      rendererCalls += 1;
      assert.equal(model, "stub-chat-model");
      assert.ok(prompt.includes("ONLY"), "renderer must be bound to the fact object");
      return { text: "top: persisted-failure-two-41ab (failure). remembered, not proven.\nA secret extra with no citation." };
    },
  });
  try {
    const handle = await startGui({ port: 0, root });
    try {
      const answer = await postChat(handle, { message: "npm run build", model: "stub-chat-model" });
      assert.equal(answer.status, 200);
      const wire = readLlmWire(answer.parsed);
      assert.equal(structurerCalls, 1);
      assert.equal(rendererCalls, 1);
      assert.equal(wire.active, true);
      assert.equal(wire.model, "stub-chat-model");
      assert.equal(wire.structurer, "used");
      assert.equal(wire.renderer, "used");
      assert.ok(wire.stripped > 0, "uncited renderer line must be stripped and counted");
      assert.ok(!(JSON.stringify(answer.parsed) as string).includes("secret extra"));
      assert.deepEqual(wire.renderOrder, ["evidenceCards", "text", "decisionTrace"]);
      assert.equal(wire.engine, "heuristic");
      assert.equal(wire.status, "used");
    } finally {
      await handle.close();
    }
  } finally {
    __clearChatLlmTestDoubles();
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
  }
});

test("unknown model id: disclosed fallback, never mocked", async () => {
  const { home, root } = hermetic();
  seedMemory(home, [failureRecord("persisted-failure-one-9d3f", "npm run build")]);
  __setChatLlmTestDoubles({ listInstalledModels: async () => ["stub-chat-model"] });
  try {
    const handle = await startGui({ port: 0, root });
    try {
      const answer = await postChat(handle, { message: "npm run build", model: "ghost-model" });
      assert.equal(answer.status, 200);
      const wire = readLlmWire(answer.parsed);
      assert.equal(wire.active, false);
      assert.equal(wire.structurer, "invalid_model");
      assert.equal(wire.renderer, "invalid_model");
      assert.equal(wire.engine, "heuristic");
    } finally {
      await handle.close();
    }
  } finally {
    __clearChatLlmTestDoubles();
  }
});

test("missing key: BYOK selection disabled with baseline, never mocked", async () => {
  const { home, root } = hermetic();
  seedMemory(home, [failureRecord("persisted-failure-one-9d3f", "npm run build")]);
  seedConfig(home, { version: 1, ai: { enabled: false } });
  writeFileSync(join(home, "gui.json"), `${JSON.stringify({ provider: "openai", endpoint: "https://api.openai.com/v1/chat/completions", model: "gpt-4o-mini", key: "", jevKey: "", openRouterKey: "", lang: "id" })}\n`);
  const previousOr = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  let llmCalls = 0;
  __setChatLlmTestDoubles({
    listInstalledModels: async () => { llmCalls += 1; return []; },
    ollamaStructured: async () => { llmCalls += 1; throw new Error("must not be called"); },
    byokText: async () => { llmCalls += 1; throw new Error("must not be called"); },
    byokStructured: async () => { llmCalls += 1; throw new Error("must not be called"); },
  });
  try {
    const handle = await startGui({ port: 0, root });
    try {
      const answer = await postChat(handle, { message: "npm run build", model: "gpt-4o-mini" });
      assert.equal(answer.status, 200);
      const wire = readLlmWire(answer.parsed);
      assert.equal(wire.active, false);
      assert.equal(wire.structurer, "disabled");
      assert.equal(wire.renderer, "disabled");
      assert.equal(llmCalls, 1, "only the installed-list probe may run; no LLM call without a key");
    } finally {
      await handle.close();
    }
  } finally {
    __clearChatLlmTestDoubles();
    if (previousOr === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousOr;
  }
});

test("invalid structurer JSON falls back deterministically with disclosed status", async () => {
  const { home, root } = hermetic();
  seedMemory(home, [failureRecord("persisted-failure-one-9d3f", "npm run build")]);
  __setChatLlmTestDoubles({
    listInstalledModels: async () => ["stub-chat-model"],
    ollamaStructured: async (_model: string, _prompt: string, schema: Record<string, unknown>) => {
      if ("candidates" in (schema.properties as Record<string, unknown>)) {
        return { query: "npm run build", candidates: [{ ref: "invented-zzz", kind: "failure", snippet: "x" }] };
      }
      return { text: "" };
    },
  });
  try {
    const handle = await startGui({ port: 0, root });
    try {
      const answer = await postChat(handle, { message: "npm run build", model: "stub-chat-model" });
      assert.equal(answer.status, 200);
      const wire = readLlmWire(answer.parsed);
      assert.equal(wire.structurer, "structurer-fallback");
      assert.equal(wire.renderer, "template");
      assert.ok(!(JSON.stringify(answer.parsed) as string).includes("invented-zzz"));
    } finally {
      await handle.close();
    }
  } finally {
    __clearChatLlmTestDoubles();
  }
});

test("jev decision stays the decider: llm order cannot promote evidence", async () => {
  const { home, root } = hermetic();
  seedMemory(home, [
    failureRecord("persisted-failure-one-9d3f", "npm run build"),
    failureRecord("persisted-failure-two-41ab", "npm run build"),
  ]);
  __setChatLlmTestDoubles({
    listInstalledModels: async () => ["stub-chat-model"],
    ollamaStructured: async (_model: string, _prompt: string, schema: Record<string, unknown>) => {
      if ("candidates" in (schema.properties as Record<string, unknown>)) {
        return {
          query: "npm run build",
          candidates: [{ ref: "persisted-failure-one-9d3f", kind: "failure", snippet: "s" }],
        };
      }
      return { text: "top: persisted-failure-one-9d3f (failure). remembered, not proven." };
    },
  });
  try {
    const handle = await startGui({ port: 0, root });
    try {
      const answer = await postChat(handle, { message: "npm run build", model: "stub-chat-model" });
      assert.equal(answer.status, 200);
      const wire = readLlmWire(answer.parsed);
      assert.equal(wire.engine, "heuristic");
      assert.equal(wire.status, "used");
      const payload = answer.parsed as { evidenceCards: { ref: string }[]; decisionTrace: { evidenceRefs: string[] } };
      assert.deepEqual(payload.decisionTrace.evidenceRefs, payload.evidenceCards.map((card) => card.ref));
    } finally {
      await handle.close();
    }
  } finally {
    __clearChatLlmTestDoubles();
  }
});

test("served text discloses renderer use with the model name (not 'no model text')", async () => {
  const { home, root } = hermetic();
  seedMemory(home, [failureRecord("persisted-failure-one-9d3f", "npm run build")]);
  __setChatLlmTestDoubles({
    listInstalledModels: async () => ["stub-chat-model"],
    ollamaStructured: async (_model: string, _prompt: string, schema: Record<string, unknown>) => {
      if ("candidates" in (schema.properties as Record<string, unknown>)) {
        return {
          query: "npm run build",
          candidates: [{ ref: "persisted-failure-one-9d3f", kind: "failure", snippet: "s" }],
        };
      }
      return { text: "top: persisted-failure-one-9d3f (failure). remembered, not proven." };
    },
  });
  try {
    const handle = await startGui({ port: 0, root });
    try {
      const answer = await postChat(handle, { message: "npm run build", model: "stub-chat-model" });
      assert.equal(answer.status, 200);
      const wire = readLlmWire(answer.parsed);
      assert.equal(wire.active, true);
      assert.equal(wire.renderer, "used");
      const payload = answer.parsed as { text: string };
      assert.ok(payload.text.includes("renderer: used (stub-chat-model)."), "active renderer must name itself in the served text");
      assert.ok(!payload.text.includes("no model text"), "active path must not claim no model text");
    } finally {
      await handle.close();
    }
  } finally {
    __clearChatLlmTestDoubles();
  }
});

test("inactive path discloses the renderer status in the served text, never mocked", async () => {
  const { home, root } = hermetic();
  seedMemory(home, [failureRecord("persisted-failure-one-9d3f", "npm run build")]);
  __setChatLlmTestDoubles({ listInstalledModels: async () => ["stub-chat-model"] });
  try {
    const handle = await startGui({ port: 0, root });
    try {
      const answer = await postChat(handle, { message: "npm run build", model: "ghost-model" });
      assert.equal(answer.status, 200);
      const wire = readLlmWire(answer.parsed);
      assert.equal(wire.active, false);
      const payload = answer.parsed as { text: string };
      assert.ok(payload.text.includes("renderer: invalid_model (ghost-model)."), "inactive renderer must disclose its status server-side");
    } finally {
      await handle.close();
    }
  } finally {
    __clearChatLlmTestDoubles();
  }
});

test("user project query: LLM structures via TypeSafe rules and renders human-friendly synthesis", async () => {
  const { home, root } = hermetic();
  seedMemory(home, [
    failureRecord("fail-build-001", "npm run build:extt"),
    {
      kind: "fix",
      id: "fix-build-002",
      ts: Date.now() - 500,
      cwd: "/repo",
      cmd: "npm --prefix rocky run build",
      resolvedFailures: ["fail-build-001"],
    },
  ]);

  let structuredReceivedQuery = "";
  let rendererReceivedPrompt = "";

  __setChatLlmTestDoubles({
    listInstalledModels: async () => ["gpt-5.6-luna"],
    ollamaStructured: async (model: string, prompt: string, schema: Record<string, unknown>) => {
      if (String(schema.required ?? "").includes("candidates") || "candidates" in (schema.properties as Record<string, unknown>)) {
        structuredReceivedQuery = prompt;
        return {
          query: "kenapa build script sempat error?",
          candidates: [
            { ref: "fail-build-001", kind: "failure", snippet: "npm run build:extt error" },
            { ref: "fix-build-002", kind: "fix", snippet: "npm --prefix rocky run build resolved" },
          ],
        };
      }
      rendererReceivedPrompt = prompt;
      return {
        text: [
          "Berdasarkan rekaman memori Rocky dan evaluasi Jev:",
          "1. Build script sempat mengalami kegagalan pada perintah `npm run build:extt` [fail-build-001].",
          "2. Masalah ini berhasil diselesaikan dengan menjalankan `npm --prefix rocky run build` [fix-build-002].",
          "",
          "Ringkasan: Error terjadi karena target script yang keliru, dan sudah tercatat perbaikan yang sukses.",
        ].join("\n"),
      };
    },
  });

  try {
    const handle = await startGui({ port: 0, root });
    try {
      const answer = await postChat(handle, {
        message: "kenapa build script sempat error?",
        model: "gpt-5.6-luna",
      });
      assert.equal(answer.status, 200);
      const wire = readLlmWire(answer.parsed);
      assert.equal(wire.active, true);
      assert.equal(wire.model, "gpt-5.6-luna");
      assert.equal(wire.structurer, "used");
      assert.equal(wire.renderer, "used");
      assert.equal(wire.stripped, 0);

      const payload = answer.parsed as { text: string; evidenceCards: unknown[] };
      assert.ok(payload.text.includes("Berdasarkan rekaman memori Rocky"));
      assert.ok(payload.text.includes("npm run build:extt"));
      assert.ok(payload.text.includes("npm --prefix rocky run build"));
      assert.ok(payload.text.includes("renderer: used (gpt-5.6-luna)."));
      assert.ok(Array.isArray(payload.evidenceCards));
      assert.ok(payload.evidenceCards.length >= 1);
    } finally {
      await handle.close();
    }
  } finally {
    __clearChatLlmTestDoubles();
  }
});
