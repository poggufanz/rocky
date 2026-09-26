import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureRationales, LEGACY_RATIONALE_PULL_FROZEN_FOR_LISTENING } from "../agent/logs/capture.js";

test("legacy pull is unfrozen by default but freezable via env", () => {
  assert.equal(LEGACY_RATIONALE_PULL_FROZEN_FOR_LISTENING, false);
  process.env.ROCKY_FREEZE_LEGACY_PULL = "1";
  try {
    const out = captureRationales("/repo/cutover");
    assert.equal(out.written, 0);
    assert.ok(out.skipped.length > 0);
  } finally {
    delete process.env.ROCKY_FREEZE_LEGACY_PULL;
  }
});

test("no listening module imports the legacy capture lane", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "listening");
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".ts")) continue;
    const source = readFileSync(join(dir, name), "utf8");
    assert.ok(!source.includes("agent/logs/capture"), `${name} must not import legacy capture`);
  }
});

test("legacy capture documents hook_policy_reason separation", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "agent", "logs", "capture.ts"),
    "utf8",
  );
  assert.ok(source.includes("hook_policy_reason"));
  assert.ok(source.includes("ROCKY_FREEZE_LEGACY_PULL"));
});
