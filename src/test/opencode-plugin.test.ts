import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateOutputLine } from "../ui/phrases.js";

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

test("plugin template blocks a strict-mode edit with a plain rocky sentence that names the command to record the reason", () => {
  const text = readFileSync(template, "utf8");
  const prefix = /const BLOCK_PREFIX = "([^"]+)";/.exec(text)?.[1];
  assert.equal(prefix, "rocky: Edit blocked");
  assert.ok(
    text.includes('`${BLOCK_PREFIX} until the reason is recorded. Record it with: rocky hook agent-event generic --rationale "<why>" --files ${file}`'),
    "the thrown message keeps the prefix, the reason, and the exact command",
  );
  assert.ok(text.includes("error.message.startsWith(BLOCK_PREFIX)"), "only this block is rethrown; every other error still fails open");
  assert.deepEqual(validateOutputLine(`${prefix!.slice("rocky: ".length)} until the reason is recorded.`), []);
  assert.doesNotMatch(text, /Rocky Policy/);
});

test("plugin template has zero imports besides node:child_process", () => {
  const text = readFileSync(template, "utf8");
  const imports = [...text.matchAll(/from\s+["']([^"']+)["']/gu)].map((m) => m[1]);
  for (const spec of imports) {
    assert.ok(spec === "node:child_process", `unexpected dependency ${spec}`);
  }
});
