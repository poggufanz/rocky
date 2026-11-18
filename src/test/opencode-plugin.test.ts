import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const template = join(here, "..", "shell", "opencode-rocky-plugin.ts");

test("plugin template exposes only shell.env and tool.execute.after, with no blocking hook", () => {
  const text = readFileSync(template, "utf8");
  assert.match(text, /RockyPlugin/);
  assert.match(text, /shell\.env/);
  assert.match(text, /tool\.execute\.after/);
  assert.doesNotMatch(text, /tool\.execute\.before/);
  assert.doesNotMatch(text, /BLOCK_PREFIX/);
  assert.doesNotMatch(text, /ROCKY_GATE_MODE/);
  assert.doesNotMatch(text, /require\(/);
});

test("plugin template header states manual copy and zero dependencies", () => {
  const text = readFileSync(template, "utf8");
  const lines = text.split(/\r?\n/);
  assert.equal(lines[1], "// Copy to ~/.config/opencode/plugins/rocky.ts by hand. Zero dependencies.");
  assert.doesNotMatch(text, /Rocky Policy/);
});

test("plugin template has zero imports besides node:child_process", () => {
  const text = readFileSync(template, "utf8");
  const imports = [...text.matchAll(/from\s+["']([^"']+)["']/gu)].map((m) => m[1]);
  for (const spec of imports) {
    assert.ok(spec === "node:child_process", `unexpected dependency ${spec}`);
  }
});
