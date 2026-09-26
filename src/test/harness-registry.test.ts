import test from "node:test";
import assert from "node:assert/strict";
import {
  HARNESS_IDS,
  HARNESS_REGISTRY,
  isHarnessId,
  surfacesFor,
  type HarnessEvidence,
} from "../setup/harness-registry.js";

test("registry holds exactly the 11 locked IDs, no claude-desktop", () => {
  assert.deepEqual([...HARNESS_IDS].sort(), [
    "antigravity", "claude-code", "codex", "copilot-cli", "cursor",
    "devin", "dsh", "gemini-cli", "omp", "opencode", "vscode",
  ]);
  assert.equal(isHarnessId("claude-desktop"), false);
  assert.equal(isHarnessId("codex"), true);
});

test("one evidence row per (id, surface)", () => {
  for (const def of HARNESS_REGISTRY) {
    assert.deepEqual(surfacesFor(def.id), def.surfaces);
    assert.ok(def.surfaces.length >= 1);
  }
  assert.deepEqual(surfacesFor("antigravity"), ["cli", "ide"]);
  assert.deepEqual(surfacesFor("cursor"), ["cli", "ide"]);
  assert.deepEqual(surfacesFor("vscode"), ["local"]);
  assert.deepEqual(surfacesFor("dsh"), ["profile"]);
  assert.deepEqual(surfacesFor("codex"), ["cli"]);
});

test("evidence row carries discovery facts, mutation result is a separate type", () => {
  const row: HarnessEvidence = {
    id: "codex",
    surface: "cli",
    detectionStatus: "unknown",
    capabilities: { mcp: "unverified", listening: "unverified" },
    verificationMarkers: {},
  };
  assert.equal(row.detectionStatus, "unknown");
  assert.equal("outcome" in row, false);
});
