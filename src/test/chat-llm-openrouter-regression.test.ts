import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGui, type GuiHandle } from "../gui/server.js";
import {
  __clearChatLlmTestDoubles,
  __setChatLlmTestDoubles,
  chatByokKeyPresent,
  isLlmActive,
  resolveChatLlmSelection,
} from "../ai/chat-llm.js";

const SCREENSHOT_MODEL = "meta/muse-spark-1.3-contributor";
const SCREENSHOT_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

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

function hermetic(): { home: string; root: string } {
  const home = mkdtempSync(join(tmpdir(), "rocky-chatreg-home-"));
  const root = mkdtempSync(join(tmpdir(), "rocky-chatreg-root-"));
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

async function postChat(handle: GuiHandle, body: unknown): Promise<{ status: number; parsed: unknown }> {
  const response = await fetch(`http://127.0.0.1:${handle.port}/api/chat`, {
    method: "POST",
    headers: { "X-Rocky-Token": handle.token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, parsed: await response.json().catch(() => null) };
}

function readLlmWire(parsed: unknown): { active: boolean; model: string; structurer: string; renderer: string; stripped: number } {
  if (typeof parsed !== "object" || parsed === null) throw new Error("chat body shape");
  if (!("llm" in parsed)) throw new Error("chat llm/trace shape");
  const llm: unknown = parsed.llm;
  if (typeof llm !== "object" || llm === null) throw new Error("chat llm fields");
  if (!("active" in llm) || !("model" in llm) || !("structurerStatus" in llm) || !("rendererStatus" in llm) || !("stripped" in llm)) {
    throw new Error("chat llm fields");
  }
  const { active, model, structurerStatus, rendererStatus, stripped } = llm;
  if (typeof active !== "boolean" || typeof model !== "string" ||
    typeof structurerStatus !== "string" || typeof rendererStatus !== "string" || typeof stripped !== "number") {
    throw new Error("chat llm fields");
  }
  return { active, model, structurer: structurerStatus, renderer: rendererStatus, stripped };
}

function readServedText(parsed: unknown): string {
  if (typeof parsed === "object" && parsed !== null && "text" in parsed && typeof parsed.text === "string") {
    return parsed.text;
  }
  throw new Error("chat text shape");
}

function seedGui(home: string, patch: Record<string, string>): void {
  writeFileSync(join(home, "gui.json"), `${JSON.stringify({
    provider: "openai",
    endpoint: "",
    model: "",
    key: "",
    jevKey: "",
    openRouterKey: "",
    lang: "id",
    ...patch,
  })}\n`);
}

test("screenshot regression: selected openrouter id + main-slot key => active, structurer AND renderer called", async () => {
  const { home, root } = hermetic();
  seedMemory(home, [
    failureRecord("persisted-failure-one-9d3f", "npm run build"),
    failureRecord("persisted-failure-two-41ab", "npm run build"),
  ]);
  // Stale `provider: openai` on purpose: the Settings page never rewrites the
  // provider slot, so unified mode must come from the endpoint text alone.
  seedGui(home, { endpoint: SCREENSHOT_ENDPOINT, model: SCREENSHOT_MODEL, key: "main-slot-key" });
  const previousOr = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  let structurerCalls = 0;
  let rendererCalls = 0;
  __setChatLlmTestDoubles({
    listInstalledModels: async (): Promise<readonly string[]> => {
      throw new Error("ollama offline");
    },
    ollamaStructured: async () => {
      throw new Error("ollama must not be called for a BYOK id");
    },
    byokStructured: async () => {
      structurerCalls += 1;
      return {
        query: "npm run build",
        candidates: [{ ref: "persisted-failure-two-41ab", kind: "failure", snippet: "stub" }],
      };
    },
    byokText: async () => {
      rendererCalls += 1;
      return "top: persisted-failure-two-41ab (failure). remembered, not proven.\nA secret extra with no citation.";
    },
  });
  try {
    const handle = await startGui({ port: 0, root });
    try {
      const answer = await postChat(handle, { message: "npm run build", model: SCREENSHOT_MODEL });
      assert.equal(answer.status, 200);
      const wire = readLlmWire(answer.parsed);
      assert.equal(wire.active, true);
      assert.equal(wire.model, SCREENSHOT_MODEL);
      assert.equal(structurerCalls, 1);
      assert.equal(rendererCalls, 1);
      assert.equal(wire.structurer, "used");
      assert.equal(wire.renderer, "used");
      const text = readServedText(answer.parsed);
      assert.ok(text.includes(`renderer: used (${SCREENSHOT_MODEL}).`), "served text must disclose the renderer use with the model id");
      assert.ok(!text.includes("secret extra"), "uncited renderer line must be stripped");
      assert.ok(wire.stripped > 0, "stripped extras must be counted");
    } finally {
      await handle.close();
    }
  } finally {
    __clearChatLlmTestDoubles();
    if (previousOr === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousOr;
  }
});

test("wrong-slot key: jev slots never arm the chat llm => disclosed missing-key, no llm call", async () => {
  const { home, root } = hermetic();
  seedMemory(home, [failureRecord("persisted-failure-one-9d3f", "npm run build")]);
  seedGui(home, { endpoint: SCREENSHOT_ENDPOINT, model: SCREENSHOT_MODEL, jevKey: "jev-slot-key", openRouterKey: "or-slot-key" });
  const previousOr = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  let llmCalls = 0;
  __setChatLlmTestDoubles({
    listInstalledModels: async (): Promise<readonly string[]> => {
      throw new Error("ollama offline");
    },
    ollamaStructured: async () => {
      llmCalls += 1;
      throw new Error("must not be called");
    },
    byokStructured: async () => {
      llmCalls += 1;
      throw new Error("must not be called");
    },
    byokText: async () => {
      llmCalls += 1;
      throw new Error("must not be called");
    },
  });
  try {
    const handle = await startGui({ port: 0, root });
    try {
      const answer = await postChat(handle, { message: "npm run build", model: SCREENSHOT_MODEL });
      assert.equal(answer.status, 200);
      const wire = readLlmWire(answer.parsed);
      assert.equal(wire.active, false);
      assert.equal(wire.structurer, "disabled");
      assert.equal(wire.renderer, "disabled");
      assert.equal(llmCalls, 0, "no llm transport may run without the main-slot key");
      const text = readServedText(answer.parsed);
      assert.ok(text.includes(`renderer: disabled (${SCREENSHOT_MODEL}).`));
    } finally {
      await handle.close();
    }
  } finally {
    __clearChatLlmTestDoubles();
    if (previousOr === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousOr;
  }
});

test("unknown id while offline is invalid_model, never unavailable (no outage mask)", async () => {
  const { home, root } = hermetic();
  seedMemory(home, [failureRecord("persisted-failure-one-9d3f", "npm run build")]);
  seedGui(home, { endpoint: SCREENSHOT_ENDPOINT, model: SCREENSHOT_MODEL, key: "main-slot-key" });
  const previousOr = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  __setChatLlmTestDoubles({
    listInstalledModels: async (): Promise<readonly string[]> => {
      throw new Error("ollama offline");
    },
  });
  try {
    const handle = await startGui({ port: 0, root });
    try {
      const answer = await postChat(handle, { message: "npm run build", model: "ghost-or-model" });
      assert.equal(answer.status, 200);
      const wire = readLlmWire(answer.parsed);
      assert.equal(wire.active, false);
      assert.equal(wire.structurer, "invalid_model");
      assert.equal(wire.renderer, "invalid_model");
    } finally {
      await handle.close();
    }
  } finally {
    __clearChatLlmTestDoubles();
    if (previousOr === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousOr;
  }
});

test("pure ollama id while offline stays unavailable (nothing keyed to judge it)", async () => {
  const { home, root } = hermetic();
  seedMemory(home, [failureRecord("persisted-failure-one-9d3f", "npm run build")]);
  __setChatLlmTestDoubles({
    listInstalledModels: async (): Promise<readonly string[]> => {
      throw new Error("ollama offline");
    },
  });
  try {
    const handle = await startGui({ port: 0, root });
    try {
      const answer = await postChat(handle, { message: "npm run build", model: "llama3.1" });
      assert.equal(answer.status, 200);
      const wire = readLlmWire(answer.parsed);
      assert.equal(wire.active, false);
      assert.equal(wire.structurer, "unavailable");
      assert.equal(wire.renderer, "unavailable");
    } finally {
      await handle.close();
    }
  } finally {
    __clearChatLlmTestDoubles();
  }
});

test("predicate unit: keyed byok wins before and without the installed list", () => {
  const stored = storedOf({ provider: "openai", endpoint: SCREENSHOT_ENDPOINT, model: SCREENSHOT_MODEL, key: "k" });
  const offline = resolveChatLlmSelection({
    requestedModel: SCREENSHOT_MODEL, stored, installed: undefined, env: envOf({}),
  });
  assert.equal(isLlmActive(offline), true);
  assert.equal(offline.kind, "byok");
  const shadowed = resolveChatLlmSelection({
    requestedModel: SCREENSHOT_MODEL, stored, installed: ["other-model"], env: envOf({}),
  });
  assert.equal(isLlmActive(shadowed), true);
  assert.equal(shadowed.kind, "byok");
  assert.equal(chatByokKeyPresent("openai", SCREENSHOT_ENDPOINT, "k", envOf({})), true);
  assert.equal(chatByokKeyPresent("openai", SCREENSHOT_ENDPOINT, "", envOf({})), false);
  assert.equal(chatByokKeyPresent("openai", SCREENSHOT_ENDPOINT, "", envOf({ OPENROUTER_API_KEY: "env" })), true);
});
