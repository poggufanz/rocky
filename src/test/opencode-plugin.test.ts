import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const template = join(here, "..", "shell", "opencode-rocky-plugin.ts");

test("plugin template exposes exactly the three supported hooks and nothing blocking by default", () => {
  const text = readFileSync(template, "utf8");
  assert.match(text, /RockyPlugin/);
  assert.match(text, /shell\.env/);
  assert.match(text, /tool\.execute\.before/);
  assert.match(text, /tool\.execute\.after/);
  assert.match(text, /ROCKY_GATE_MODE/);
  assert.doesNotMatch(text, /require\(/);
});

test("plugin template has zero imports besides node:child_process", () => {
  const text = readFileSync(template, "utf8");
  const imports = [...text.matchAll(/from\s+["']([^"']+)["']/gu)].map((m) => m[1]);
  for (const spec of imports) {
    assert.ok(spec === "node:child_process", `unexpected dependency ${spec}`);
  }
});
