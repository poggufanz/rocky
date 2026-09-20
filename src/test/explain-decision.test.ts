import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeExplainDecision, formatDecisionLine, readDecisionSelection } from "../ai/explain-decision.js";
import { appendDecisionLog, decisionLogPath, hashDecisionInput } from "../ai/decision-log.js";
import { loadConfig } from "../core/config-read.js";

test("unconfigured explain analysis returns undefined: zero behavior change", async () => {
  const home = mkdtempSync(join(tmpdir(), "rocky-decision-home-"));
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  try {
    const trace = await analyzeExplainDecision({
      query: "q",
      candidates: [{ ref: "a", kind: "failure", snippet: "s" }],
    });
    assert.equal(trace, undefined);
    assert.deepEqual(readDecisionSelection(), { configured: false, useJev: false, jevProvider: "typesafe" });
  } finally {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
  }
});

test("configured heuristic analysis logs with evidence refs and status", async () => {
  const home = mkdtempSync(join(tmpdir(), "rocky-decision-home-"));
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  try {
    writeFileSync(join(home, "config.json"), JSON.stringify({ version: 1, ai: { enabled: false }, decision: { engine: "heuristic" } }));
    assert.deepEqual(readDecisionSelection(loadConfig), { configured: true, useJev: false, jevProvider: "typesafe" });
    const trace = await analyzeExplainDecision({
      query: "module missing",
      candidates: [{ ref: "r1", kind: "failure", snippet: "module missing" }],
    }, { outcome: "teach" });
    assert.ok(trace !== undefined);
    assert.equal(trace?.engine, "heuristic");
    assert.equal(trace?.status, "used");
    assert.equal(trace?.confidence, null);
    assert.deepEqual(trace?.evidenceRefs, ["r1"]);
    assert.ok(typeof trace?.latencyMs === "number");
    assert.ok(String(formatDecisionLine(trace as never)).includes("baseline kept"));
    const lines = readFileSync(decisionLogPath(), "utf8").trim().split("\n");
    const entry = JSON.parse(lines[lines.length - 1] as string) as {
      engine: unknown; status: unknown; evidenceRefs: unknown; outcome: unknown; input_hash: unknown;
    };
    assert.equal(entry.engine, "heuristic");
    assert.equal(entry.status, "used");
    assert.deepEqual(entry.evidenceRefs, ["r1"]);
    assert.equal(entry.outcome, "teach");
    assert.equal(typeof entry.input_hash, "string");
  } finally {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
  }
});

test("configured jev without a key downgrades to disabled with baseline", async () => {
  const home = mkdtempSync(join(tmpdir(), "rocky-decision-home-"));
  const previousHome = process.env.ROCKY_HOME;
  const previousKey = process.env.TYPESAFE_API_KEY;
  process.env.ROCKY_HOME = home;
  delete process.env.TYPESAFE_API_KEY;
  try {
    writeFileSync(join(home, "config.json"), JSON.stringify({ version: 1, ai: { enabled: false }, decision: { engine: "jev" } }));
    assert.deepEqual(readDecisionSelection(loadConfig), { configured: true, useJev: true, jevProvider: "typesafe" });
    const trace = await analyzeExplainDecision({
      query: "q",
      candidates: [{ ref: "a", kind: "failure", snippet: "s" }],
    }, { outcome: "ask" });
    assert.equal(trace?.engine, "jev");
    assert.equal(trace?.status, "disabled");
    assert.equal(trace?.confidence, null);
    assert.deepEqual(trace?.evidenceRefs, ["a"]);
  } finally {
    if (previousHome === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previousHome;
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previousKey;
  }
});

test("decision log hashes inputs and never throws", () => {
  assert.equal(hashDecisionInput("abc").length, 32);
  const home = mkdtempSync(join(tmpdir(), "rocky-decision-home-"));
  const entry = appendDecisionLog({
    engine: "heuristic",
    status: "used",
    input_hash: hashDecisionInput("q|r1"),
    answer: { order: ["r1"] },
    latency_ms: 3,
    outcome: "chat",
    evidenceRefs: ["r1"],
  }, join(home, "decisions.jsonl"));
  assert.equal(entry?.engine, "heuristic");
  assert.equal(entry?.outcome, "chat");
});
