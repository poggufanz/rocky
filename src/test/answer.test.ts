import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";

import { executeAnswer } from "../ai/answer.js";
import { writeSettings } from "../gui/settings.js";

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

