import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  DESK_EVENTS,
  DESK_HOOK_ASYNC,
  buildDeskHookEntries,
  deskHookCommand,
  installDeskHooks,
  mergeDeskHooks,
  removeDeskHooks,
  uninstallDeskHooks,
} from "../setup/desk-hooks.js";
import {
  agentHooksStatus,
  installClaudeAgentHooks,
  mergeClaudeHooks,
  removeClaudeHooks,
  rockyGateHookCommand,
  rockyHookCommand,
  uninstallClaudeAgentHooks,
} from "../setup/agent-hooks.js";
import { SetupUsageError, parseSetupArgs } from "../setup/parser.js";
import { createPlatformServices } from "../setup/platform.js";
import { setup, type SetupDependencies } from "../commands/setup.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const DESK_COMMAND = process.platform === "win32"
  ? '"C:\\tools\\rocky-hook.exe" desk-hook claude-code'
  : '"/opt/rocky/rocky-hook" desk-hook claude-code';

const EXPECTED_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "StopFailure",
  "SessionEnd",
];

function hookBinFixture(t: test.TestContext, name = "rocky-hook"): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rocky-desk-hook-bin-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hookBin = join(root, process.platform === "win32" ? `${name}.exe` : name);
  writeFileSync(hookBin, "fixture");
  return hookBin;
}

function settingsFixture(t: test.TestContext): { root: string; settings: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rocky-desk-hooks-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, settings: join(root, "nested", "claude-settings.json") };
}

test("desk install writes 12 events with matcher * on tool events and timeout 5", () => {
  assert.deepEqual(DESK_EVENTS, EXPECTED_EVENTS);
  assert.equal(DESK_HOOK_ASYNC, true, "claude-code 2.1.319 capture proved async hooks");
  const entries = buildDeskHookEntries(DESK_COMMAND, false);
  assert.deepEqual(Object.keys(entries).sort(), [...EXPECTED_EVENTS].sort());
  for (const [event, groups] of Object.entries(entries)) {
    assert.ok(Array.isArray(groups), `${event} must be an array`);
    assert.equal(groups.length, 1, `${event} must carry exactly one group`);
    const group = groups[0] as { matcher?: unknown; hooks: unknown[] };
    if (event === "PreToolUse" || event === "PostToolUse") {
      assert.equal(group.matcher, "*");
    } else {
      assert.equal(group.matcher, undefined);
    }
    assert.deepEqual(group.hooks, [{ type: "command", command: DESK_COMMAND, timeout: 5 }]);
  }
  const asyncEntries = buildDeskHookEntries(DESK_COMMAND, true);
  for (const [event, groups] of Object.entries(asyncEntries)) {
    const group = (groups as Array<{ hooks: unknown[] }>)[0];
    assert.deepEqual(group.hooks, [{ type: "command", command: DESK_COMMAND, timeout: 5, async: true }], event);
  }
});

test("desk install keeps foreign hooks and mixed groups in order", () => {
  const foreign = {
    hooks: {
      Stop: [
        { name: "first", hooks: [{ type: "command", command: "other-before" }] },
        {
          name: "mixed",
          hooks: [
            { type: "command", command: "foreign-tool" },
            { type: "command", command: DESK_COMMAND },
          ],
        },
      ],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "other-tool" }] }],
    },
  };
  const merged = mergeDeskHooks(structuredClone(foreign), DESK_COMMAND, DESK_HOOK_ASYNC);
  const hooks = merged.hooks as Record<string, unknown[]>;
  assert.equal(hooks.Stop?.length, 3);
  assert.deepEqual(hooks.Stop?.[0], foreign.hooks.Stop[0]);
  assert.deepEqual(hooks.Stop?.[1], {
    name: "mixed",
    hooks: [{ type: "command", command: "foreign-tool" }],
  });
  assert.deepEqual((hooks.UserPromptSubmit as unknown[])?.[0], foreign.hooks.UserPromptSubmit[0]);
  const twice = mergeDeskHooks(structuredClone(merged), DESK_COMMAND, DESK_HOOK_ASYNC);
  assert.deepEqual(twice, merged);
});

test("agent uninstall leaves desk hooks; desk uninstall leaves agent and gate hooks", () => {
  const command = rockyHookCommand("claude-code", process.execPath, process.execPath);
  const gateCommand = rockyGateHookCommand(process.execPath, process.execPath);
  const both = mergeDeskHooks(mergeClaudeHooks({}, command, gateCommand), DESK_COMMAND, DESK_HOOK_ASYNC);
  assert.deepEqual(removeClaudeHooks(structuredClone(both)), mergeDeskHooks({}, DESK_COMMAND, DESK_HOOK_ASYNC));
  assert.deepEqual(removeDeskHooks(structuredClone(both)), mergeClaudeHooks({}, command, gateCommand));
});

test("desk reinstall is idempotent (status unchanged)", async (t) => {
  const value = settingsFixture(t);
  const hookBin = hookBinFixture(t);
  mkdirSync(dirname(value.settings), { recursive: true, mode: 0o700 });
  const confirmation = { async confirm(): Promise<boolean> { return true; } };
  const options = {
    hookBin,
    confirmation,
    detail: () => undefined,
    fileExists: (path: string) => path === hookBin,
  };
  const first = await installDeskHooks({ settingsPath: value.settings }, options);
  assert.equal(first.status, "written");
  const bytes = readFileSync(value.settings);
  const second = await installDeskHooks({ settingsPath: value.settings }, options);
  assert.equal(second.status, "unchanged");
  assert.deepEqual(readFileSync(value.settings), bytes);
});

test("desk hook path with spaces is quoted; path with % or ! is rejected", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rocky-desk spaced-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const spaced = join(root, process.platform === "win32" ? "rocky-hook.exe" : "rocky-hook");
  writeFileSync(spaced, "fixture");
  const command = deskHookCommand(spaced, () => true);
  assert.ok(command.endsWith(" desk-hook claude-code"), command);
  assert.ok(command.startsWith('"'), command);
  const binName = process.platform === "win32" ? "rocky-hook.exe" : "rocky-hook";
  for (const bad of [join(root, `%${binName}`), join(root, `!${binName}`)]) {
    writeFileSync(bad, "fixture");
    assert.throws(() => deskHookCommand(bad, () => true), /unsafe/, bad);
  }
});

test("desk hook path must be absolute, exist, and be named rocky-hook(.exe)", (t) => {
  const hookBin = hookBinFixture(t);
  assert.throws(() => deskHookCommand("relative/rocky-hook", () => true), /absolute/);
  assert.throws(
    () => deskHookCommand(join(dirname(hookBin), "missing-hook"), () => false),
    /exist/,
  );
  const wrongName = join(dirname(hookBin), process.platform === "win32" ? "other.exe" : "other");
  writeFileSync(wrongName, "fixture");
  assert.throws(() => deskHookCommand(wrongName, () => true), /rocky-hook/);
  assert.doesNotThrow(() => deskHookCommand(hookBin, () => true));
});

test("parser: --desk-hooks needs a value and excludes --agent-hooks", () => {
  const hookBin = process.platform === "win32" ? "C:\\tools\\rocky-hook.exe" : "/opt/rocky/rocky-hook";
  assert.deepEqual(parseSetupArgs(["--desk-hooks", hookBin]), {
    mode: "configure",
    exposure: "sanitized",
    replace: false,
    yes: false,
    deskHooksAction: "install",
    deskHookBin: hookBin,
    harnesses: [],
    mcp: false,
    listening: false,
    rawTrace: false,
  });
  assert.equal(parseSetupArgs(["--uninstall-desk-hooks"]).deskHooksAction, "uninstall");
  for (const argv of [
    ["--desk-hooks"],
    ["--desk-hooks", "--yes"],
    ["--desk-hooks", hookBin, "--uninstall-desk-hooks"],
    ["--desk-hooks", hookBin, "--agent-hooks"],
    ["--uninstall-desk-hooks", "--uninstall-agent-hooks"],
    ["--uninstall-desk-hooks", "--check"],
  ]) {
    assert.throws(() => parseSetupArgs(argv), (error: unknown) =>
      error instanceof SetupUsageError && error.exitCode === 2, argv.join(" "));
  }
});

test("desk hooks are not listed in rocky --help", () => {
  for (const args of [["--help"], ["--help", "--all"]] as const) {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [join(packageRoot, "dist", "index.js"), ...args], {
      encoding: "utf8",
      env,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /--desk-hooks/, args.join(" "));
    assert.doesNotMatch(result.stdout, /--uninstall-desk-hooks/, args.join(" "));
  }
});

test("agent hook status stays installed when desk hooks are also present", async (t) => {
  const value = settingsFixture(t);
  const command = rockyHookCommand("claude-code", process.execPath, process.execPath);
  mkdirSync(dirname(value.settings), { recursive: true, mode: 0o700 });
  writeFileSync(
    value.settings,
    `${JSON.stringify(mergeDeskHooks(mergeClaudeHooks({}, command), DESK_COMMAND, DESK_HOOK_ASYNC))}\n`,
  );
  const options = { command, confirmation: { async confirm(): Promise<boolean> { return true; } } };
  assert.deepEqual(agentHooksStatus({ settingsPath: value.settings }, options), { claudeCode: "installed" });
  const removed = await uninstallClaudeAgentHooks({ settingsPath: value.settings }, options);
  assert.equal(removed.status, "written");
  assert.deepEqual(
    JSON.parse(readFileSync(value.settings, "utf8")) as Record<string, unknown>,
    mergeDeskHooks({}, DESK_COMMAND, DESK_HOOK_ASYNC),
  );
  const deskRemoved = await uninstallDeskHooks({ settingsPath: value.settings }, options);
  assert.equal(deskRemoved.status, "written");
  const agentReinstalled = await installClaudeAgentHooks({ settingsPath: value.settings }, options);
  assert.equal(agentReinstalled.status, "written");
  assert.deepEqual(agentHooksStatus({ settingsPath: value.settings }, options), { claudeCode: "installed" });
});

// --- CLI level: which settings file `rocky setup` writes ------------------
//
// Each run builds its own env from scratch, so the owner's real
// CLAUDE_CONFIG_DIR can never reach these tests. `home` always carries an
// existing `.claude` directory, so a run that ignores the variable would
// succeed against the fallback and fail the assertions below.

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

function commandFixture(t: test.TestContext): { root: string; home: string; fallback: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rocky-desk-command-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(join(home, ".claude"), { recursive: true, mode: 0o700 });
  return { root, home, fallback: join(home, ".claude", "settings.json") };
}

function commandDependencies(home: string, env: NodeJS.ProcessEnv, hookBin?: string): SetupDependencies {
  return {
    runner: {
      async run() { throw new Error("MCP runner must not run"); },
      async openSession() { throw new Error("MCP session must not open"); },
    },
    platform: createPlatformServices({
      platform: "linux",
      home,
      env: { PATH: "/tools" },
      isWsl: false,
      fileExists: (path) => path === process.execPath || path === hookBin,
    }),
    adapters: [],
    confirmation: { async confirm() { return true; } },
    nodePath: process.execPath,
    entryPath: process.execPath,
    env,
  };
}

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

test("desk hooks: install writes under CLAUDE_CONFIG_DIR and prints that settings path", async (t) => {
  const { home, root, fallback } = commandFixture(t);
  const cfg = join(root, "profile");
  mkdirSync(cfg, { mode: 0o700 });
  const hookBin = hookBinFixture(t);
  const settingsPath = join(cfg, "settings.json");

  const output = await captureStderr(() =>
    setup(["--desk-hooks", hookBin], commandDependencies(home, { CLAUDE_CONFIG_DIR: cfg }, hookBin)));

  assert.equal(output.code, 0, output.stderr);
  assert.ok(output.stderr.includes(`claude-code settings: ${settingsPath}`), output.stderr);
  assert.deepEqual(
    JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>,
    mergeDeskHooks({}, deskHookCommand(realpathSync(hookBin), () => true), DESK_HOOK_ASYNC),
  );
  assert.equal(existsSync(fallback), false);
});

test("desk hooks: empty CLAUDE_CONFIG_DIR refuses and writes nothing", async (t) => {
  const { home, root, fallback } = commandFixture(t);
  const hookBin = hookBinFixture(t);

  const output = await captureStderr(() =>
    setup(["--desk-hooks", hookBin], commandDependencies(home, { CLAUDE_CONFIG_DIR: "" }, hookBin)));

  assert.equal(output.code, 1, output.stderr);
  assert.ok(output.stderr.includes("CLAUDE_CONFIG_DIR is set but empty"), output.stderr);
  assert.equal(existsSync(fallback), false);
  assert.deepEqual(filesUnder(root), []);
});

test("desk hooks: trailing-separator CLAUDE_CONFIG_DIR refuses with the variable named", async (t) => {
  const { home, root } = commandFixture(t);
  const cfg = join(root, "profile");
  mkdirSync(cfg, { mode: 0o700 });
  const hookBin = hookBinFixture(t);

  const output = await captureStderr(() =>
    setup(["--desk-hooks", hookBin], commandDependencies(home, { CLAUDE_CONFIG_DIR: `${cfg}${sep}` }, hookBin)));

  assert.equal(output.code, 1, output.stderr);
  assert.ok(
    output.stderr.includes(
      "Setup stopped: CLAUDE_CONFIG_DIR must be a normalized absolute directory path "
        + "(no trailing separator, no . or .. segments, native path separators).",
    ),
    output.stderr,
  );
  assert.deepEqual(filesUnder(root), []);
});

test("desk hooks: CLAUDE_CONFIG_DIR naming a missing directory fails closed", async (t) => {
  const { home, root, fallback } = commandFixture(t);
  const cfg = join(root, "absent");
  const hookBin = hookBinFixture(t);

  const output = await captureStderr(() =>
    setup(["--desk-hooks", hookBin], commandDependencies(home, { CLAUDE_CONFIG_DIR: cfg }, hookBin)));

  assert.equal(output.code, 1, output.stderr);
  assert.equal(existsSync(cfg), false);
  assert.equal(existsSync(fallback), false);
});

test("agent hooks: install, status, uninstall each print the resolved settings path", async (t) => {
  const { home, root, fallback } = commandFixture(t);
  const cfg = join(root, "profile");
  mkdirSync(cfg, { mode: 0o700 });
  const dependencies = commandDependencies(home, { CLAUDE_CONFIG_DIR: cfg });
  const line = `claude-code settings: ${join(cfg, "settings.json")}`;

  for (const argv of [["--agent-hooks"], ["--status"], ["--uninstall-agent-hooks"]]) {
    const output = await captureStderr(() => setup(argv, dependencies));
    assert.equal(output.code, 0, `${argv.join(" ")}\n${output.stderr}`);
    assert.ok(output.stderr.includes(line), `${argv.join(" ")}\n${output.stderr}`);
  }
  assert.equal(existsSync(fallback), false);
});
