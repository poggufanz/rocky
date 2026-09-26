import test from "node:test";
import assert from "node:assert/strict";
import { SetupUsageError, parseSetupArgs } from "../setup/parser.js";

function usageError(argv: string[]): string {
  assert.throws(() => parseSetupArgs(argv), (error: unknown) => {
    assert.ok(error instanceof SetupUsageError);
    return true;
  });
  try {
    parseSetupArgs(argv);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("unreachable");
}

test("harness selector dedups silently and defaults to MCP-only", () => {
  assert.deepEqual(parseSetupArgs(["--harness", "codex", "--harness", "codex"]).harnesses, ["codex"]);
  const defaults = parseSetupArgs([]);
  assert.deepEqual(defaults.harnesses, []);
  assert.equal(defaults.mcp, true);
  assert.equal(defaults.listening, false);
  assert.equal(defaults.rawTrace, false);
});

test("unknown harness id is a usage error", () => {
  assert.match(usageError(["--harness", "claude-desktop"]), /unknown harness/);
});

test("feature selectors scope to exactly what was given", () => {
  assert.deepEqual(parseSetupArgs(["--harness", "codex", "--listening"]).listening, true);
  const both = parseSetupArgs(["--harness", "codex", "--mcp", "--listening"]);
  assert.equal(both.mcp, true);
  assert.equal(both.listening, true);
});

test("raw-trace requires listening plus exactly one harness", () => {
  assert.match(usageError(["--harness", "codex", "--raw-trace", "--yes"]), /--raw-trace/);
  assert.match(
    usageError(["--harness", "codex", "--harness", "opencode", "--listening", "--raw-trace", "--yes"]),
    /--raw-trace/,
  );
  const ok = parseSetupArgs(["--harness", "codex", "--listening", "--raw-trace", "--yes"]);
  assert.equal(ok.rawTrace, true);
});

test("repo actions are standalone and need exactly one action", () => {
  assert.match(usageError(["--repo", "/r", "--allow-capture", "--harness", "codex"]), /--repo/);
  assert.match(usageError(["--repo", "/r"]), /--repo/);
  assert.match(
    usageError(["--repo", "/r", "--allow-capture", "--revoke-capture"]),
    /--repo/,
  );
  const check = parseSetupArgs(["--repo", "/r", "--check-capture"]);
  assert.equal(check.repoAction, "check-capture");
});

test("exclusive combos fail before any mutation", () => {
  assert.match(usageError(["--check", "--remove"]), /mutually exclusive/);
  assert.match(usageError(["--check", "--replace"]), /--replace/);
  assert.match(usageError(["--remove", "--replace"]), /--replace/);
  assert.match(
    usageError(["--harness", "codex", "--listening", "--replace"]),
    /--replace/,
  );
  assert.match(
    usageError(["--voice-skill", "--mcp"]),
    /voice-skill/,
  );
  assert.match(
    usageError(["--agent-hooks", "--listening"]),
    /agent hook/,
  );
  assert.match(usageError(["--status", "--mcp"]), /--status/);
  assert.match(
    usageError(["--harness", "codex", "--listening", "--mcp-exposure", "raw"]),
    /--mcp-exposure/,
  );
});
