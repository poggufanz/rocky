import test from "node:test";
import assert from "node:assert/strict";
import { SetupUsageError, parseSetupArgs } from "../setup/parser.js";

test("setup parser applies safe defaults", () => {
  assert.deepEqual(parseSetupArgs([]), {
    mode: "configure",
    exposure: "sanitized",
    replace: false,
    yes: false,
    voiceSkill: false,
  });
});

test("setup parser selects check mode without changing safe defaults", () => {
  assert.deepEqual(parseSetupArgs(["--check"]), {
    mode: "check",
    exposure: "sanitized",
    replace: false,
    yes: false,
    voiceSkill: false,
  });
});

test("setup parser selects remove mode and accepts ordinary confirmation bypass", () => {
  assert.deepEqual(parseSetupArgs(["--remove", "--yes"]), {
    mode: "remove",
    exposure: "sanitized",
    replace: false,
    yes: true,
    voiceSkill: false,
  });
});

test("setup parser accepts configure-only options in any order", () => {
  assert.deepEqual(parseSetupArgs(["--yes", "--replace", "--mcp-exposure", "raw"]), {
    mode: "configure",
    exposure: "raw",
    replace: true,
    yes: true,
    voiceSkill: false,
  });
});

test("setup parser selects voice skill work explicitly in every mode", () => {
  assert.deepEqual(parseSetupArgs(["--voice-skill", "--yes"]), {
    mode: "configure",
    exposure: "sanitized",
    replace: false,
    yes: true,
    voiceSkill: true,
  });
  assert.deepEqual(parseSetupArgs(["--check", "--voice-skill"]), {
    mode: "check",
    exposure: "sanitized",
    replace: false,
    yes: false,
    voiceSkill: true,
  });
  assert.deepEqual(parseSetupArgs(["--voice-skill", "--remove", "--yes"]), {
    mode: "remove",
    exposure: "sanitized",
    replace: false,
    yes: true,
    voiceSkill: true,
  });
});

test("yes alone never selects voice skill work", () => {
  assert.equal(parseSetupArgs(["--yes"]).voiceSkill, false);
});

test("setup parser selects dedicated Claude agent-hook actions", () => {
  assert.deepEqual(parseSetupArgs(["--agent-hooks"]), {
    mode: "configure",
    exposure: "sanitized",
    replace: false,
    yes: false,
    voiceSkill: false,
    agentHooksAction: "install",
  });
  assert.equal(parseSetupArgs(["--uninstall-agent-hooks"]).agentHooksAction, "uninstall");
  assert.equal(parseSetupArgs(["--status"]).agentHooksAction, "status");
  assert.equal(parseSetupArgs(["--agent-hooks", "--yes"]).agentHooksAction, "install");
});

test("dedicated agent-hook actions reject ordinary setup flags and each other", () => {
  for (const argv of [
    ["--agent-hooks", "--uninstall-agent-hooks"],
    ["--agent-hooks", "--check"],
    ["--agent-hooks", "--remove"],
    ["--agent-hooks", "--replace"],
    ["--agent-hooks", "--mcp-exposure", "raw"],
    ["--agent-hooks", "--voice-skill"],
    ["--status", "--check"],
  ]) {
    assert.throws(() => parseSetupArgs(argv), (error: unknown) =>
      error instanceof SetupUsageError && error.exitCode === 2);
  }
});

test("setup parser rejects mutually exclusive modes", () => {
  assert.throws(
    () => parseSetupArgs(["--check", "--remove"]),
    (error: unknown) => error instanceof SetupUsageError
      && error.exitCode === 2
      && /mutually exclusive/.test(error.message),
  );
});

test("setup parser rejects configure-only options in check and remove modes", () => {
  assert.throws(() => parseSetupArgs(["--check", "--replace"]), /configure mode/);
  assert.throws(() => parseSetupArgs(["--mcp-exposure", "raw", "--remove"]), /configure mode/);
});

test("setup parser requires an explicit lowercase exposure", () => {
  assert.throws(() => parseSetupArgs(["--mcp-exposure"]), /requires a value/);
  assert.throws(() => parseSetupArgs(["--mcp-exposure", "--yes"]), /requires a value/);
  assert.throws(() => parseSetupArgs(["--mcp-exposure", "RAW"]), /sanitized or raw/);
  assert.throws(() => parseSetupArgs(["--mcp-exposure", "other"]), /sanitized or raw/);
});

test("setup parser rejects unknown options and positional input", () => {
  assert.throws(() => parseSetupArgs(["--voice"]), /unknown setup option/);
  assert.throws(() => parseSetupArgs(["project"]), /does not accept positional/);
  assert.throws(() => parseSetupArgs(["--", "project"]), /does not accept positional/);
});
