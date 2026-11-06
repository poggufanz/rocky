import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_RULES } from "../core/guard-rules.js";
import { validateOutputLine } from "../ui/phrases.js";

// Pinning test: the guard's y/n prompt must be printed via printf to stderr.
// A `read -p "..." ... 2>/dev/null` writes the prompt to stderr, which the
// line's own redirection discards — the pty smoke test cannot catch this
// because it answers the prompt without reading it.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const hookSrc = readFileSync(join(repoRoot, "src", "shell", "rocky-hook.bash"), "utf8");

test("guard prompt is printed via printf to stderr", () => {
  assert.ok(
    hookSrc.includes("printf 'rocky: Run it anyway? [y/N] ' >&2"),
    "hook must printf the y/N prompt to stderr",
  );
});

test("guard read does not hide its prompt behind 2>/dev/null", () => {
  assert.ok(
    !/read -r -p "rocky: Run it anyway[^\n]*2>\/dev\/null/.test(hookSrc),
    "read -p with 2>/dev/null discards the prompt",
  );
});

test("guard prompt and cancel line follow the output rules and keep the accepted answers", () => {
  const prompt = /printf 'rocky: (Run it anyway\? \[y\/N\]) ' >&2/.exec(hookSrc)?.[1];
  const cancel = /printf 'rocky: (Command not run\.)\\n' >&2/.exec(hookSrc)?.[1];
  assert.equal(prompt, "Run it anyway? [y/N]");
  assert.equal(cancel, "Command not run.");
  assert.deepEqual(validateOutputLine(prompt!), []);
  assert.deepEqual(validateOutputLine(cancel!), []);
  // The prompt only names y and N; the script must still accept exactly y/Y
  // as consent and treat every other answer as a cancel.
  assert.ok(hookSrc.includes('if [[ "$ans" == "y" || "$ans" == "Y" ]]; then'));
});

test("guard default rule messages are plain sentences", () => {
  for (const rule of DEFAULT_RULES) {
    assert.deepEqual(validateOutputLine(rule.message), [], rule.message);
    assert.match(rule.message, /^[A-Z].*\.$/, `sentence case with a period: ${rule.message}`);
  }
  const fallback = /\$\{msg:-([^}]+)\}/.exec(hookSrc)?.[1];
  assert.equal(fallback, "This command matches a guard rule.");
  assert.deepEqual(validateOutputLine(fallback!), []);
});
