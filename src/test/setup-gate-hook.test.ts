import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  agentHooksStatus,
  installClaudeAgentHooks,
  mergeClaudeHooks,
  removeClaudeHooks,
  rockyGateHookCommand,
  rockyHookCommand,
  uninstallClaudeAgentHooks,
} from "../setup/agent-hooks.js";
import { createPlatformServices } from "../setup/platform.js";
import { setup, type SetupDependencies } from "../commands/setup.js";
import { SetupUsageError, parseSetupArgs } from "../setup/parser.js";

const GATE_MATCHER = "Edit|Write|MultiEdit";

function fixture(t: test.TestContext): { root: string; settings: string; command: string; gateCommand: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rocky-gate-hook-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    settings: join(root, "nested", "claude-settings.json"),
    command: rockyHookCommand("claude-code", process.execPath, process.execPath),
    gateCommand: rockyGateHookCommand(process.execPath, process.execPath),
  };
}

function setupDependenciesFor(root: string, confirmation = true): SetupDependencies {
  return {
    runner: {
      async run() { throw new Error("MCP runner must not run"); },
      async openSession() { throw new Error("MCP session must not open"); },
    },
    platform: createPlatformServices({
      platform: "linux",
      home: root,
      env: { PATH: "/tools" },
      isWsl: false,
      fileExists: (path) => path === process.execPath,
    }),
    adapters: [],
    confirmation: { async confirm() { return confirmation; } },
    nodePath: process.execPath,
    entryPath: process.execPath,
  };
}

function readSettings(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function captureStderr(run: () => Promise<number>): Promise<{ code: number; stderr: string }> {
  let stderr = "";
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  return run().then((code) => ({ code, stderr })).finally(() => {
    process.stderr.write = original;
  });
}

// --- rockyGateHookCommand -----------------------------------------------

test("rockyGateHookCommand is absolute, quoted, and targets gate-event claude-code", () => {
  const command = rockyGateHookCommand("/usr/bin/node", "/opt/rocky/dist/index.js");
  assert.equal(command, '"/usr/bin/node" "/opt/rocky/dist/index.js" hook gate-event claude-code');
});

// --- mergeClaudeHooks / removeClaudeHooks (unit level) -------------------

test("mergeClaudeHooks adds PreToolUse gate entry only when a gate command is given", () => {
  const withGate = mergeClaudeHooks({}, "CMD", "GATE-CMD");
  const hooks = withGate.hooks as Record<string, unknown[]>;
  assert.deepEqual(hooks.PreToolUse, [{ matcher: GATE_MATCHER, hooks: [{ type: "command", command: "GATE-CMD" }] }]);

  const withoutGate = mergeClaudeHooks({}, "CMD");
  assert.equal((withoutGate.hooks as Record<string, unknown>).PreToolUse, undefined);
});

test("mergeClaudeHooks strips a stale owned PreToolUse entry when gate is toggled off on rerun", () => {
  const command = rockyHookCommand("claude-code", process.execPath, process.execPath);
  const gateCommand = rockyGateHookCommand(process.execPath, process.execPath);
  const installed = mergeClaudeHooks({}, command, gateCommand);
  const toggledOff = mergeClaudeHooks(installed, command);
  assert.equal((toggledOff.hooks as Record<string, unknown>).PreToolUse, undefined);
});

test("mergeClaudeHooks preserves foreign PreToolUse hooks alongside the gate entry", () => {
  const foreign = {
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "other-tool" }] }],
    },
  };
  const merged = mergeClaudeHooks(structuredClone(foreign), "CMD", "GATE-CMD");
  const preToolUse = (merged.hooks as Record<string, unknown[]>).PreToolUse;
  assert.equal(preToolUse.length, 2);
  assert.deepEqual(preToolUse[0], foreign.hooks.PreToolUse[0]);
  assert.deepEqual(preToolUse[1], { matcher: GATE_MATCHER, hooks: [{ type: "command", command: "GATE-CMD" }] });
});

test("removeClaudeHooks strips the owned PreToolUse gate entry and leaves foreign PreToolUse hooks", () => {
  const foreign = {
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "other-tool" }] }],
    },
  };
  const command = rockyHookCommand("claude-code", process.execPath, process.execPath);
  const gateCommand = rockyGateHookCommand(process.execPath, process.execPath);
  const merged = mergeClaudeHooks(structuredClone(foreign), command, gateCommand);
  assert.deepEqual(removeClaudeHooks(merged), foreign);
});

// --- installClaudeAgentHooks / uninstallClaudeAgentHooks (library level) -

test("installClaudeAgentHooks writes the PreToolUse gate entry when a gate command is supplied", async (t) => {
  const value = fixture(t);
  mkdirSync(dirname(value.settings), { recursive: true });
  const result = await installClaudeAgentHooks({ settingsPath: value.settings }, {
    command: value.command,
    gateCommand: value.gateCommand,
    confirmation: { async confirm() { return true; } },
  });
  assert.equal(result.status, "written");
  const written = readSettings(value.settings);
  const preToolUse = (written.hooks as Record<string, unknown[]>).PreToolUse;
  assert.equal(preToolUse.length, 1);
  assert.equal((preToolUse[0] as { matcher: string }).matcher, GATE_MATCHER);
  const hooks = (preToolUse[0] as { hooks: Array<{ command: string }> }).hooks;
  assert.equal(hooks.length, 1);
  assert.ok(hooks[0].command.endsWith("hook gate-event claude-code"));
});

test("installClaudeAgentHooks omits the PreToolUse gate entry by default (no gate command)", async (t) => {
  const value = fixture(t);
  mkdirSync(dirname(value.settings), { recursive: true });
  const result = await installClaudeAgentHooks({ settingsPath: value.settings }, {
    command: value.command,
    confirmation: { async confirm() { return true; } },
  });
  assert.equal(result.status, "written");
  const written = readSettings(value.settings);
  assert.equal((written.hooks as Record<string, unknown>).PreToolUse, undefined);
});

test("uninstallClaudeAgentHooks removes the PreToolUse entry it owns and leaves a foreign one", async (t) => {
  const value = fixture(t);
  mkdirSync(dirname(value.settings), { recursive: true });
  const foreign = {
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "other-tool" }] }],
    },
  };
  const withGate = mergeClaudeHooks(structuredClone(foreign), value.command, value.gateCommand);
  writeFileSync(value.settings, `${JSON.stringify(withGate)}\n`);

  const result = await uninstallClaudeAgentHooks({ settingsPath: value.settings }, { command: value.command });
  assert.equal(result.status, "written");
  assert.deepEqual(readSettings(value.settings), foreign);
});

// --- agentHooksStatus: both install shapes must report "installed" -------

test("agentHooksStatus reports installed when the gate entry is present and canonical", async (t) => {
  const value = fixture(t);
  mkdirSync(dirname(value.settings), { recursive: true });
  const withGate = mergeClaudeHooks({}, value.command, value.gateCommand);
  writeFileSync(value.settings, `${JSON.stringify(withGate)}\n`);
  assert.deepEqual(
    agentHooksStatus({ settingsPath: value.settings }, { command: value.command, gateCommand: value.gateCommand }),
    { claudeCode: "installed" },
  );
});

test("agentHooksStatus reports installed when the gate entry is absent (rationale gate opted out)", async (t) => {
  const value = fixture(t);
  mkdirSync(dirname(value.settings), { recursive: true });
  const withoutGate = mergeClaudeHooks({}, value.command);
  writeFileSync(value.settings, `${JSON.stringify(withoutGate)}\n`);
  assert.deepEqual(
    agentHooksStatus({ settingsPath: value.settings }, { command: value.command, gateCommand: value.gateCommand }),
    { claudeCode: "installed" },
  );
});

test("agentHooksStatus reports absent when the owned PreToolUse group is duplicated or stale", async (t) => {
  const value = fixture(t);
  mkdirSync(dirname(value.settings), { recursive: true });
  const withGate = mergeClaudeHooks({}, value.command, value.gateCommand);
  const duplicated = {
    ...withGate,
    hooks: {
      ...(withGate.hooks as Record<string, unknown[]>),
      PreToolUse: [
        ...(withGate.hooks as Record<string, unknown[]>).PreToolUse,
        ...(withGate.hooks as Record<string, unknown[]>).PreToolUse,
      ],
    },
  };
  writeFileSync(value.settings, `${JSON.stringify(duplicated)}\n`);
  assert.deepEqual(
    agentHooksStatus({ settingsPath: value.settings }, { command: value.command, gateCommand: value.gateCommand }),
    { claudeCode: "absent" },
  );

  // A recognized-but-different gate command (built from other paths) - not
  // noise, a genuinely stale canonical entry that no longer matches.
  const staleGateCommand = rockyGateHookCommand("/usr/bin/node-old", "/opt/old-rocky/index.js");
  const stale = {
    ...withGate,
    hooks: {
      ...(withGate.hooks as Record<string, unknown[]>),
      PreToolUse: [{ matcher: GATE_MATCHER, hooks: [{ type: "command", command: staleGateCommand }] }],
    },
  };
  writeFileSync(value.settings, `${JSON.stringify(stale)}\n`);
  assert.deepEqual(
    agentHooksStatus({ settingsPath: value.settings }, { command: value.command, gateCommand: value.gateCommand }),
    { claudeCode: "absent" },
  );
});

// --- CLI level: rocky setup --agent-hooks [--no-rationale-gate] ----------

test("setup --agent-hooks installs the PreToolUse gate entry by default", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rocky-gate-cli-install-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".claude"), { mode: 0o700 });
  const dependencies = setupDependenciesFor(root);
  assert.equal(await setup(["--agent-hooks"], dependencies), 0);
  const settingsPath = join(root, ".claude", "settings.json");
  const written = readSettings(settingsPath);
  const preToolUse = (written.hooks as Record<string, unknown[]>).PreToolUse as Array<{ matcher: string; hooks: Array<{ command: string }> }>;
  assert.equal(preToolUse.length, 1);
  assert.equal(preToolUse[0].matcher, GATE_MATCHER);
  assert.ok(preToolUse[0].hooks[0].command.endsWith("hook gate-event claude-code"));
});

test("setup --agent-hooks --no-rationale-gate omits the PreToolUse gate entry", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rocky-gate-cli-opt-out-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".claude"), { mode: 0o700 });
  const dependencies = setupDependenciesFor(root);
  assert.equal(await setup(["--agent-hooks", "--no-rationale-gate"], dependencies), 0);
  const settingsPath = join(root, ".claude", "settings.json");
  const written = readSettings(settingsPath);
  assert.equal((written.hooks as Record<string, unknown>).PreToolUse, undefined);
});

test("setup --uninstall-agent-hooks removes the PreToolUse entry it owns", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rocky-gate-cli-uninstall-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".claude"), { mode: 0o700 });
  const dependencies = setupDependenciesFor(root);
  assert.equal(await setup(["--agent-hooks"], dependencies), 0);
  const settingsPath = join(root, ".claude", "settings.json");
  assert.ok((readSettings(settingsPath).hooks as Record<string, unknown>).PreToolUse !== undefined);

  assert.equal(await setup(["--uninstall-agent-hooks"], dependencies), 0);
  const afterUninstall = readSettings(settingsPath);
  assert.equal(existsSync(settingsPath), true);
  assert.equal((afterUninstall.hooks as Record<string, unknown> | undefined)?.PreToolUse, undefined);
});

test("setup --status reports installed for both a with-gate and a without-gate install", async (t) => {
  const withGateRoot = realpathSync(mkdtempSync(join(tmpdir(), "rocky-gate-cli-status-on-")));
  t.after(() => rmSync(withGateRoot, { recursive: true, force: true }));
  mkdirSync(join(withGateRoot, ".claude"), { mode: 0o700 });
  const withGateDeps = setupDependenciesFor(withGateRoot);
  assert.equal(await setup(["--agent-hooks"], withGateDeps), 0);
  const withGateStatus = await captureStderr(() => setup(["--status"], withGateDeps));
  assert.equal(withGateStatus.code, 0);
  assert.match(withGateStatus.stderr, /claude-code agent hooks: installed/);

  const withoutGateRoot = realpathSync(mkdtempSync(join(tmpdir(), "rocky-gate-cli-status-off-")));
  t.after(() => rmSync(withoutGateRoot, { recursive: true, force: true }));
  mkdirSync(join(withoutGateRoot, ".claude"), { mode: 0o700 });
  const withoutGateDeps = setupDependenciesFor(withoutGateRoot);
  assert.equal(await setup(["--agent-hooks", "--no-rationale-gate"], withoutGateDeps), 0);
  const withoutGateStatus = await captureStderr(() => setup(["--status"], withoutGateDeps));
  assert.equal(withoutGateStatus.code, 0);
  assert.match(withoutGateStatus.stderr, /claude-code agent hooks: installed/);
});

// --- parser: --no-rationale-gate -----------------------------------------

test("parseSetupArgs defaults rationaleGate to true for --agent-hooks", () => {
  assert.equal(parseSetupArgs(["--agent-hooks"]).rationaleGate, true);
});

test("parseSetupArgs sets rationaleGate false for --no-rationale-gate", () => {
  assert.equal(parseSetupArgs(["--agent-hooks", "--no-rationale-gate"]).rationaleGate, false);
});

test("parseSetupArgs rejects --no-rationale-gate without --agent-hooks or with uninstall/status", () => {
  for (const argv of [
    ["--no-rationale-gate"],
    ["--uninstall-agent-hooks", "--no-rationale-gate"],
    ["--status", "--no-rationale-gate"],
  ]) {
    assert.throws(() => parseSetupArgs(argv), (error: unknown) =>
      error instanceof SetupUsageError && error.exitCode === 2);
  }
});
