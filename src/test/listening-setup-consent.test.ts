import test from "node:test";
import assert from "node:assert/strict";
import { SetupUsageError, parseSetupArgs } from "../setup/parser.js";
import { HARNESS_IDS, isHarnessId } from "../setup/clients.js";

test("harness registry holds exactly 11 closed ids", () => {
  assert.equal(HARNESS_IDS.length, 11);
  assert.ok(isHarnessId("codex") && isHarnessId("gemini-cli") && isHarnessId("vscode"));
  assert.equal(isHarnessId("claude-desktop"), false);
  assert.equal(isHarnessId("nope"), false);
});

test("repo capture actions parse standalone", () => {
  assert.deepEqual(parseSetupArgs(["--repo", "/x", "--allow-capture"]).repoAction, "allow-capture");
  assert.deepEqual(parseSetupArgs(["--repo", "/x", "--revoke-capture"]).repoAction, "revoke-capture");
  assert.deepEqual(parseSetupArgs(["--repo", "/x", "--check-capture"]).repoAction, "check-capture");
  assert.equal(parseSetupArgs(["--repo", "/x", "--allow-capture"]).repo, "/x");
});

test("repo actions reject host and feature flags", () => {
  for (const argv of [
    ["--repo", "/x", "--allow-capture", "--harness", "codex"],
    ["--repo", "/x", "--allow-capture", "--mcp"],
    ["--repo", "/x", "--allow-capture", "--listening"],
    ["--repo", "/x", "--allow-capture", "--yes", "--voice-skill"],
    ["--repo", "/x", "--allow-capture", "--check"],
  ]) {
    assert.throws(() => parseSetupArgs(argv), SetupUsageError);
  }
  assert.throws(() => parseSetupArgs(["--allow-capture"]), SetupUsageError);
  assert.throws(() => parseSetupArgs(["--repo", "/x"]), SetupUsageError);
});

test("raw trace needs listening plus exactly one harness", () => {
  const ok = parseSetupArgs(["--harness", "codex", "--listening", "--raw-trace", "--yes"]);
  assert.equal(ok.rawTrace, true);
  assert.throws(() => parseSetupArgs(["--raw-trace", "--yes"]), SetupUsageError);
  assert.throws(
    () => parseSetupArgs(["--harness", "codex", "--harness", "opencode", "--listening", "--raw-trace", "--yes"]),
    SetupUsageError,
  );
  assert.throws(() => parseSetupArgs(["--harness", "codex", "--raw-trace", "--yes"]), SetupUsageError);
});

test("harness ids validate and dedupe", () => {
  assert.deepEqual(
    parseSetupArgs(["--harness", "codex", "--harness", "codex", "--yes"]).harness,
    ["codex"],
  );
  assert.throws(() => parseSetupArgs(["--harness", "nope", "--yes"]), SetupUsageError);
  assert.throws(() => parseSetupArgs(["--harness", "codex", "--listening", "--replace", "--yes"]), SetupUsageError);
});

test("old parser defaults stay byte-identical", () => {
  assert.deepEqual(parseSetupArgs([]), {
    mode: "configure",
    exposure: "sanitized",
    replace: false,
    yes: false,
    voiceSkill: false,
  });
});
