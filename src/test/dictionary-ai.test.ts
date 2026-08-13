import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createOllamaDictionaryRank, parseRankOutput } from "../ai/dictionary-ai.js";
import type { OllamaClient } from "../ai/ollama.js";
import type { DictionaryHit } from "../core/dictionary.js";

const hit = (id: string): DictionaryHit => ({
  triple: { kind: "triple", id, ts: 1, cwd: "/w", schemaV: 1, agent: "claude-code", origin: "agent-hook",
    intent: { text: id }, mechanism: { files: [{ path: "a.css", plusMinus: [1, 0], props: ["margin"] }], truncatedFiles: 0 } },
  score: 0.5,
});

test("parseRankOutput keeps only known ids, undefined on junk or empty", () => {
  assert.deepEqual(parseRankOutput({ ranked_ids: ["b", "zz", "a"] }, [hit("a"), hit("b")]), ["b", "a"]);
  assert.equal(parseRankOutput({ ranked_ids: [] }, [hit("a")]), undefined);
  assert.equal(parseRankOutput({ ranked: ["a"] }, [hit("a")]), undefined);
  assert.equal(parseRankOutput(null, [hit("a")]), undefined);
});

function fakeClient(response: unknown, fail = false): OllamaClient {
  return {
    async listInstalledModels() { return []; },
    async probeModel() { return { supported: true }; },
    async generateStructured() { if (fail) throw new Error("down"); return response; },
  };
}

test("createOllamaDictionaryRank returns ranked ids and survives failure", async () => {
  const port = createOllamaDictionaryRank(fakeClient({ ranked_ids: ["a"] }), "m");
  assert.deepEqual(await port.run("q", [hit("a")], AbortSignal.timeout(1000)), ["a"]);
  const broken = createOllamaDictionaryRank(fakeClient(undefined, true), "m");
  assert.equal(await broken.run("q", [hit("a")], AbortSignal.timeout(1000)), undefined);
});
