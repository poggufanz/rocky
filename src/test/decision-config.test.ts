import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../core/config-read.js";

test("parseConfig accepts an explicit decision engine", () => {
  assert.deepEqual(
    parseConfig({ version: 1, ai: { enabled: false }, decision: { engine: "jev" } }),
    { version: 1, ai: { enabled: false }, decision: { engine: "jev" } },
  );
  assert.deepEqual(
    parseConfig({ version: 1, ai: { enabled: false }, decision: { engine: "heuristic" } }),
    { version: 1, ai: { enabled: false }, decision: { engine: "heuristic" } },
  );
});

test("parseConfig accepts jevProvider and round-trips it; absent stays absent", () => {
  assert.deepEqual(
    parseConfig({ version: 1, ai: { enabled: false }, decision: { engine: "jev", jevProvider: "openrouter" } }),
    { version: 1, ai: { enabled: false }, decision: { engine: "jev", jevProvider: "openrouter" } },
  );
  assert.deepEqual(
    parseConfig({ version: 1, ai: { enabled: false }, decision: { engine: "jev", jevProvider: "typesafe" } }),
    { version: 1, ai: { enabled: false }, decision: { engine: "jev", jevProvider: "typesafe" } },
  );
  const bare = parseConfig({ version: 1, ai: { enabled: false }, decision: { engine: "jev" } });
  assert.ok(bare?.decision !== undefined && bare.decision.jevProvider === undefined);
});

test("absent decision stays absent: current behavior unchanged", () => {
  const config = parseConfig({ version: 1, ai: { enabled: false } });
  assert.ok(config);
  assert.ok(config && config.decision === undefined);
});

test("malformed decision shapes are refused", () => {
  const cases = [
    { version: 1, ai: { enabled: false }, decision: {} },
    { version: 1, ai: { enabled: false }, decision: { engine: "gpt" } },
    { version: 1, ai: { enabled: false }, decision: { engine: "jev", extra: 1 } },
    { version: 1, ai: { enabled: false }, decision: { engine: "jev", jevProvider: "azure" } },
    { version: 1, ai: { enabled: false }, decision: { engine: "jev", jevProvider: 1 } },
    { version: 1, ai: { enabled: false }, decision: null },
    { version: 1, ai: { enabled: false }, decision: [] },
    { version: 1, ai: { enabled: false }, decision: "jev" },
  ];
  for (const value of cases) {
    assert.equal(parseConfig(value), undefined, JSON.stringify(value));
  }
});
