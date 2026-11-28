import assert from "node:assert/strict";
import test from "node:test";
import { HARNESS_IDS as SETUP_IDS, getHarnessDefinition } from "../../setup/harness-registry.js";
import { HARNESS_IDS as LISTENING_IDS } from "../../listening/types.js";

test("listening/types re-exports the exact HARNESS_IDS reference from setup/harness-registry", () => {
  assert.equal(LISTENING_IDS, SETUP_IDS);
  assert.equal(SETUP_IDS.length, 11);
});

test("every harness declares 3-dimension capability metadata with verified facts", () => {
  for (const id of SETUP_IDS) {
    const def = getHarnessDefinition(id);
    assert.ok(def.matrix.vendorDocumented.length > 0, `${id} missing vendorDocumented`);
    assert.ok(def.matrix.versionSurface.length > 0, `${id} missing versionSurface`);
    assert.ok(["verified", "probe-required", "documented", "unverified"].includes(def.matrix.rockyStatus));
  }
  assert.equal(getHarnessDefinition("claude-code").matrix.rockyStatus, "verified");
  assert.equal(getHarnessDefinition("codex").matrix.rockyStatus, "probe-required");
  assert.equal(getHarnessDefinition("opencode").matrix.rockyStatus, "unverified");
});
