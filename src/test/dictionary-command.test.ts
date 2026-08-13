import { strict as assert } from "node:assert";
import { test } from "node:test";
import { how, what } from "../commands/dictionary.js";
import type { MemoryRecord, TripleRecord } from "../core/memory-read.js";

export function seeded(): MemoryRecord[] {
  const triple: TripleRecord = {
    kind: "triple", id: "t1", ts: Date.now() - 60_000, cwd: "/w", schemaV: 1, agent: "claude-code", origin: "agent-hook",
    intent: { text: "naikin dikit buttonnya" },
    rationale: { text: "margin adds space", tags: ["spacing"], source: "transcript" },
    mechanism: { files: [{ path: "src/app.css", plusMinus: [3, 1], props: ["margin-top"] }], truncatedFiles: 0 },
  };
  return [triple];
}

export function sinks() {
  const lines: string[] = [];
  return { lines, deps: { say: (l: string) => lines.push(l), out: (l: string) => lines.push(l) } };
}

test("what speaks tentative mapping and evidence for a hit", () => {
  const { lines, deps } = sinks();
  assert.equal(what(["naikin"], { load: seeded, ...deps }), 0);
  const joined = lines.join("\n");
  assert.ok(joined.includes('you say "naikin". it is margin-top. I think. check, question'));
  assert.ok(joined.includes("src/app.css"));
  assert.ok(!joined.includes("?"));
});

test("what with no memory stays in voice and returns 0", () => {
  const { lines, deps } = sinks();
  assert.equal(what(["gibberish-zz"], { load: () => [], ...deps }), 0);
  assert.ok(lines.join("\n").includes("I not hear this before"));
});

test("how reminds vocabulary without writing a prompt", () => {
  const { lines, deps } = sinks();
  assert.equal(how(["naikin"], { load: seeded, ...deps }), 0);
  const joined = lines.join("\n");
  assert.ok(joined.includes('last time you say "naikin", it become margin-top'));
  assert.ok(joined.includes("maybe you mean margin-top, question"));
});

test("missing query argument returns 2", () => {
  assert.equal(what([], { load: () => [], ...sinks().deps }), 2);
  assert.equal(how([], { load: () => [], ...sinks().deps }), 2);
});
