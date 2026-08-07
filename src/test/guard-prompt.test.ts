import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Pinning test: the guard's y/n prompt must be printed via printf to stderr.
// A `read -p "..." ... 2>/dev/null` writes the prompt to stderr, which the
// line's own redirection discards — the pty smoke test cannot catch this
// because it answers the prompt blindly.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const hookSrc = readFileSync(join(repoRoot, "src", "shell", "rocky-hook.bash"), "utf8");

test("guard prompt is printed via printf to stderr", () => {
  assert.ok(
    hookSrc.includes("printf '[Rocky] you sure, question (y/n) ' >&2"),
    "hook must printf the y/n prompt to stderr",
  );
});

test("guard read does not hide its prompt behind 2>/dev/null", () => {
  assert.ok(
    !/read -r -p "\[Rocky\] you sure[^\n]*2>\/dev\/null/.test(hookSrc),
    "read -p with 2>/dev/null discards the prompt",
  );
});
