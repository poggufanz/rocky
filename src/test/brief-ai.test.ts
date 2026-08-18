import test from "node:test";
import assert from "node:assert/strict";
import type { OllamaClient } from "../ai/ollama.js";
import { polishBriefLines } from "../ai/brief-ai.js";

function clientReturning(value: unknown, shouldThrow = false): OllamaClient {
  return {
    listInstalledModels: async () => [],
    probeModel: async () => ({ supported: true }),
    generateStructured: async () => {
      if (shouldThrow) throw new Error("ollama down");
      return value;
    },
  };
}

const LINES = [
  "brief window: 24h",
  "1 commit, 2 files. areas: src",
  "changes by area:",
  "  src:",
  "    src/payment/retry.ts — fix: retry once",
  "failures and fixes in window:",
  "  none remembered",
  "explain-ready:",
  "  why src change, question",
];

test("polishBriefLines swaps only polishable lines on valid model output", async () => {
  const polished = await polishBriefLines(LINES, clientReturning({
    lines: ["    src/payment/retry.ts — retry now happens once, not twice"],
    questions: ["  why src change, question"],
  }), "test-model");
  assert.equal(polished[0], "brief window: 24h");
  assert.equal(polished[1], "1 commit, 2 files. areas: src");
  assert.ok(polished.includes("    src/payment/retry.ts — retry now happens once, not twice"));
});

test("polishBriefLines falls back to input on error", async () => {
  const polished = await polishBriefLines(LINES, clientReturning({}, true), "test-model");
  assert.deepEqual(polished, LINES);
});

test("polishBriefLines falls back to input on malformed output", async () => {
  for (const bad of [null, "text", { lines: "not array" }, { lines: [42], questions: [] }]) {
    assert.deepEqual(await polishBriefLines(LINES, clientReturning(bad), "test-model"), LINES);
  }
});
