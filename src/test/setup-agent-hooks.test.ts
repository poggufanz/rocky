import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildClaudeHookEntries,
  agentHooksStatus,
  installClaudeAgentHooks,
  mergeClaudeHooks,
  removeClaudeHooks,
  rockyHookCommand,
  uninstallClaudeAgentHooks,
} from "../setup/agent-hooks.js";
import { createPlatformServices } from "../setup/platform.js";
import { setup, type SetupDependencies } from "../commands/setup.js";

test("rockyHookCommand is absolute, quoted, and never bare rocky", () => {
  const command = rockyHookCommand("claude-code", "/usr/bin/node", "/opt/rocky/dist/index.js");
  assert.equal(command, '"/usr/bin/node" "/opt/rocky/dist/index.js" hook agent-event claude-code');
});

test("rockyHookCommand escapes POSIX metacharacters without changing the suffix", () => {
  const command = rockyHookCommand(
    "claude-code",
    "/opt/Rocky CLI/bin/node!",
    '/opt/Rocky CLI/$dist/rocky"cli/index.js',
  );
  assert.equal(
    command,
    '"/opt/Rocky CLI/bin/node\\!" "/opt/Rocky CLI/\\$dist/rocky\\"cli/index.js" hook agent-event claude-code',
  );
});

test("rockyHookCommand rejects relative, control, and ephemeral paths", () => {
  assert.throws(() => rockyHookCommand("claude-code", "node", "/opt/rocky/index.js"), /absolute/);
  assert.throws(() => rockyHookCommand("claude-code", "/usr/bin/node\n", "/opt/rocky/index.js"), /unsafe/);
  assert.throws(() => rockyHookCommand("claude-code", "/usr/bin/node", "/home/a/.npm/_npx/a/index.js"), /ephemeral/);
});

test("buildClaudeHookEntries emits exact three-event shape", () => {
  assert.deepEqual(buildClaudeHookEntries("CMD"), {
    UserPromptSubmit: [{ hooks: [{ type: "command", command: "CMD" }] }],
    PostToolUse: [{
      matcher: "Edit|Write|MultiEdit|NotebookEdit",
      hooks: [{ type: "command", command: "CMD" }],
    }],
    Stop: [{ hooks: [{ type: "command", command: "CMD" }] }],
  });
});

test("mergeClaudeHooks is idempotent and preserves foreign hooks", () => {
  const foreign = {
    keep: { answer: 42 },
    hooks: {
      PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "other-tool" }] }],
    },
  };
  const once = mergeClaudeHooks(structuredClone(foreign), "X hook agent-event claude-code");
  const twice = mergeClaudeHooks(structuredClone(once), "X hook agent-event claude-code");
  assert.deepEqual(twice, once);
  assert.deepEqual((once.hooks as Record<string, unknown[]>).PostToolUse?.[0], foreign.hooks.PostToolUse[0]);
  assert.deepEqual(mergeClaudeHooks({}, "X"), {
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "X" }] }],
      PostToolUse: [{ matcher: "Edit|Write|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: "X" }] }],
      Stop: [{ hooks: [{ type: "command", command: "X" }] }],
    },
  });
});

test("mergeClaudeHooks keeps foreign nested hooks in mixed groups", () => {
  const existing = {
    hooks: {
      Stop: [{
        name: "foreign-group",
        hooks: [
          { type: "command", command: "X hook agent-event claude-code" },
          { type: "command", command: "other-tool" },
        ],
      }],
    },
  };
  const merged = mergeClaudeHooks(existing, "X hook agent-event claude-code");
  assert.deepEqual((merged.hooks as Record<string, unknown[]>).Stop?.[0], {
    name: "foreign-group",
    hooks: [{ type: "command", command: "other-tool" }],
  });
  assert.notStrictEqual(merged, existing);
  assert.deepEqual(existing.hooks.Stop[0].hooks, [
    { type: "command", command: "X hook agent-event claude-code" },
    { type: "command", command: "other-tool" },
  ]);
});

test("merge and remove reject malformed hook containers", () => {
  assert.throws(() => mergeClaudeHooks({ hooks: [] }, "X"), /hooks/);
  assert.throws(() => mergeClaudeHooks({ hooks: { Stop: {} } }, "X"), /array/);
  assert.throws(() => mergeClaudeHooks({ hooks: { Stop: [{ hooks: "bad" }] } }, "X"), /array/);
  assert.throws(() => removeClaudeHooks({ hooks: { Stop: null } }), /array/);
});

test("removeClaudeHooks strips only Rocky entries and drops empty containers", () => {
  const foreign = {
    root: true,
    hooks: {
      PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "other-tool" }] }],
    },
  };
  const merged = mergeClaudeHooks(structuredClone(foreign), "X hook agent-event claude-code");
  assert.deepEqual(removeClaudeHooks(merged), foreign);
  assert.deepEqual(removeClaudeHooks(mergeClaudeHooks({}, "X hook agent-event claude-code")), {});
});

function fixture(t: test.TestContext): { root: string; settings: string; command: string } {
  const root = mkdtempSync(join(tmpdir(), "rocky-agent-hooks-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    settings: join(root, "nested", "claude-settings.json"),
    command: rockyHookCommand("claude-code", process.execPath, process.execPath),
  };
}

test("install decline never creates parent or writes settings", async (t) => {
  const value = fixture(t);
  const details: string[] = [];
  const prompts: string[] = [];
  const result = await installClaudeAgentHooks({ settingsPath: value.settings }, {
    command: value.command,
    detail: (message) => details.push(message),
    confirmation: {
      async confirm(message) {
        prompts.push(message);
        return false;
      },
    },
  });
  assert.equal(result.status, "declined");
  assert.deepEqual(prompts, ["install ears for claude code, question"]);
  assert.equal(details.length, 1);
  assert.equal(existsSync(dirname(value.settings)), false);
  assert.equal(existsSync(value.settings), false);
});

test("install creates private custom parent, preserves foreign settings, and is unchanged on repeat", async (t) => {
  const value = fixture(t);
  const existing = {
    custom: { keep: true },
    hooks: { OtherEvent: [{ matcher: "foreign", hooks: [{ type: "command", command: "foreign" }] }] },
  };
  mkdirSync(dirname(value.settings), { recursive: true, mode: 0o700 });
  writeFileSync(value.settings, `${JSON.stringify(existing)}\n`);
  const details: string[] = [];
  const confirmation = { async confirm(): Promise<boolean> { return true; } };
  const options = { command: value.command, confirmation, detail: (message: string) => details.push(message) };
  const first = await installClaudeAgentHooks({ settingsPath: value.settings }, options);
  assert.equal(first.status, "written");
  const bytes = readFileSync(value.settings);
  assert.deepEqual(JSON.parse(details[0] ?? "null"), buildClaudeHookEntries(value.command));
  const parsed = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  assert.deepEqual(parsed.custom, existing.custom);
  assert.deepEqual((parsed.hooks as Record<string, unknown>).OtherEvent, existing.hooks.OtherEvent);
  assert.deepEqual(agentHooksStatus({ settingsPath: value.settings }, options), { claudeCode: "installed" });
  assert.equal(statSync(dirname(value.settings)).mode & 0o777, 0o700);

  const second = await installClaudeAgentHooks({ settingsPath: value.settings }, options);
  assert.equal(second.status, "unchanged");
  assert.deepEqual(readFileSync(value.settings), bytes);
  assert.equal(details.length, 2);
});

test("uninstall removes only owned groups, is idempotent, and leaves foreign root values", async (t) => {
  const value = fixture(t);
  mkdirSync(dirname(value.settings), { recursive: true });
  const foreign = { custom: "keep", hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "foreign" }] }] } };
  writeFileSync(value.settings, `${JSON.stringify(mergeClaudeHooks(structuredClone(foreign), value.command))}\n`);
  const first = await uninstallClaudeAgentHooks({ settingsPath: value.settings }, { command: value.command });
  assert.equal(first.status, "written");
  assert.deepEqual(JSON.parse(readFileSync(value.settings, "utf8")), foreign);
  const bytes = readFileSync(value.settings);
  const second = await uninstallClaudeAgentHooks({ settingsPath: value.settings }, { command: value.command });
  assert.equal(second.status, "unchanged");
  assert.deepEqual(readFileSync(value.settings), bytes);
});

test("malformed settings are unreadable before consent and never overwritten", async (t) => {
  const value = fixture(t);
  mkdirSync(dirname(value.settings), { recursive: true });
  writeFileSync(value.settings, JSON.stringify({ hooks: { Stop: {} }, secret: "must-stay" }));
  let prompted = false;
  const result = await installClaudeAgentHooks({ settingsPath: value.settings }, {
    command: value.command,
    confirmation: { async confirm(): Promise<boolean> { prompted = true; return true; } },
  });
  assert.equal(result.status, "error");
  assert.equal(prompted, false);
  assert.match(result.detail ?? "", /cannot complete/);
  assert.match(readFileSync(value.settings, "utf8"), /must-stay/);
  assert.deepEqual(agentHooksStatus({ settingsPath: value.settings }, { command: value.command }), { claudeCode: "unreadable" });
});

test("consent re-read preserves a config change made while prompt is open", async (t) => {
  const value = fixture(t);
  const lateForeign = { whilePrompt: true };
  const result = await installClaudeAgentHooks({ settingsPath: value.settings }, {
    command: value.command,
    confirmation: {
      async confirm(): Promise<boolean> {
        mkdirSync(dirname(value.settings), { recursive: true });
        writeFileSync(value.settings, `${JSON.stringify(lateForeign)}\n`);
        return true;
      },
    },
  });
  assert.equal(result.status, "written");
  assert.deepEqual((JSON.parse(readFileSync(value.settings, "utf8")) as Record<string, unknown>).whilePrompt, true);
});

test("authorized install creates a missing custom parent and CAS refuses a late write race", async (t) => {
  const value = fixture(t);
  const result = await installClaudeAgentHooks({ settingsPath: value.settings }, {
    command: value.command,
    confirmation: { async confirm(): Promise<boolean> { return true; } },
  });
  assert.equal(result.status, "written");
  assert.equal(existsSync(dirname(value.settings)), true);
  if (process.platform !== "win32") {
    assert.equal(statSync(dirname(value.settings)).mode & 0o777, 0o700);
  }

  const before = readFileSync(value.settings);
  const race = await installClaudeAgentHooks({ settingsPath: value.settings }, {
    command: `${value.command} changed`,
    confirmation: { async confirm(): Promise<boolean> { return true; } },
    beforeWrite: () => writeFileSync(value.settings, `${JSON.stringify({ concurrent: true })}\n`),
  });
  assert.equal(race.status, "error");
  assert.notDeepEqual(readFileSync(value.settings), before);
  assert.deepEqual(JSON.parse(readFileSync(value.settings, "utf8")), { concurrent: true });
});

test("ancestor rebind immediately before recursive parent creation fails closed", async (t) => {
  const value = fixture(t);
  const settings = join(value.root, "nested", "deep", "custom.json");
  const attacker = join(value.root, "attacker");
  mkdirSync(attacker);
  let callbackCalled = false;
  const result = await installClaudeAgentHooks({ settingsPath: settings }, {
    command: value.command,
    confirmation: { async confirm(): Promise<boolean> { return true; } },
    beforeCreateParent: () => {
      callbackCalled = true;
      symlinkSync(attacker, join(value.root, "nested"));
    },
  });
  assert.equal(callbackCalled, true);
  assert.equal(result.status, "error");
  assert.equal(existsSync(join(attacker, "deep", "custom.json")), false);
  assert.equal(existsSync(settings), false);
});

test("same-byte same-mode inode replacement is a CAS change, not a successful write", async (t) => {
  const value = fixture(t);
  mkdirSync(dirname(value.settings), { recursive: true });
  const originalBytes = Buffer.from('{"foreign":true}\n', "utf8");
  writeFileSync(value.settings, originalBytes, { mode: 0o640 });
  chmodSync(value.settings, 0o640);
  const replacement = join(value.root, "replacement.json");
  const result = await installClaudeAgentHooks({ settingsPath: value.settings }, {
    command: `${value.command} replacement`,
    confirmation: { async confirm(): Promise<boolean> { return true; } },
    beforeWrite: () => {
      writeFileSync(replacement, originalBytes, { mode: 0o640 });
      chmodSync(replacement, 0o640);
      renameSync(replacement, value.settings);
    },
  });
  assert.equal(result.status, "error");
  assert.deepEqual(readFileSync(value.settings), originalBytes);
  assert.equal(lstatSync(value.settings).mode & 0o777, 0o640);
});

test("Windows hook paths double a trailing backslash before closing quote", () => {
  const command = rockyHookCommand(
    "claude-code",
    "C:\\Program Files\\node.exe",
    "C:\\Rocky CLI\\",
  );
  assert.equal(
    command,
    '"C:\\Program Files\\node.exe" "C:\\Rocky CLI\\\\" hook agent-event claude-code',
  );
});

test("pending transactions, symlink targets, and symlink parents fail closed", async (t) => {
  const value = fixture(t);
  mkdirSync(dirname(value.settings), { recursive: true });
  const transaction = join(dirname(value.settings), `.${value.settings.split("/").pop()}.transaction-test`);
  mkdirSync(transaction);
  writeFileSync(join(transaction, "manifest.json"), JSON.stringify({ version: 1, state: "prepared", target: value.settings }));
  const pending = await uninstallClaudeAgentHooks({ settingsPath: value.settings }, { command: value.command });
  assert.equal(pending.status, "error");
  rmSync(transaction, { recursive: true, force: true });

  const target = join(value.root, "target.json");
  writeFileSync(target, "{}");
  const link = join(value.root, "link.json");
  symlinkSync(target, link);
  assert.equal((await uninstallClaudeAgentHooks({ settingsPath: link }, { command: value.command })).status, "error");

  const realParent = join(value.root, "real-parent");
  mkdirSync(realParent);
  const parentLink = join(value.root, "parent-link");
  symlinkSync(realParent, parentLink);
  assert.equal((await uninstallClaudeAgentHooks({ settingsPath: join(parentLink, "settings.json") }, { command: value.command })).status, "error");
  assert.equal(lstatSync(link).isSymbolicLink(), true);
});

test("non-regular targets and parent components fail closed", async (t) => {
  const value = fixture(t);
  mkdirSync(dirname(value.settings), { recursive: true });
  mkdirSync(value.settings);
  assert.equal(
    (await installClaudeAgentHooks({ settingsPath: value.settings }, {
      command: value.command,
      confirmation: { async confirm(): Promise<boolean> { return true; } },
    })).status,
    "error",
  );
  rmSync(value.settings, { recursive: true, force: true });

  const parentFile = join(value.root, "parent-file");
  writeFileSync(parentFile, "not a directory");
  const child = join(parentFile, "settings.json");
  assert.equal(
    (await installClaudeAgentHooks({ settingsPath: child }, {
      command: value.command,
      confirmation: { async confirm(): Promise<boolean> { return true; } },
    })).status,
    "error",
  );
  assert.equal(existsSync(child), false);
});

test("status is absent for partial, stale, duplicate, or unknown owned markers", (t) => {
  const value = fixture(t);
  mkdirSync(dirname(value.settings), { recursive: true });
  const write = (config: Record<string, unknown>) => writeFileSync(value.settings, `${JSON.stringify(config)}\n`);
  const command = value.command;
  const complete = mergeClaudeHooks({}, command);
  write(complete);
  assert.deepEqual(agentHooksStatus({ settingsPath: value.settings }, { command }), { claudeCode: "installed" });
  const hooks = complete.hooks as Record<string, unknown[]>;
  hooks.Stop = [...hooks.Stop, ...hooks.Stop];
  write(complete);
  assert.deepEqual(agentHooksStatus({ settingsPath: value.settings }, { command }), { claudeCode: "absent" });
  const stale = mergeClaudeHooks({}, command);
  (stale.hooks as Record<string, unknown[]>).Stop = [{ hooks: [{ type: "command", command: "old hook agent-event claude-code" }] }];
  write(stale);
  assert.deepEqual(agentHooksStatus({ settingsPath: value.settings }, { command }), { claudeCode: "absent" });
  const unknown = mergeClaudeHooks({}, command);
  (unknown.hooks as Record<string, unknown[]>).OtherEvent = [{ hooks: [{ type: "command", command }] }];
  write(unknown);
  assert.deepEqual(agentHooksStatus({ settingsPath: value.settings }, { command }), { claudeCode: "absent" });
  t.after(() => rmSync(value.root, { recursive: true, force: true }));
});

test("dedicated setup branch installs only Claude hooks and never invokes MCP adapters", async (t) => {
  const value = fixture(t);
  const calls: string[] = [];
  const dependencies: SetupDependencies = {
    runner: { async run() { throw new Error("MCP runner must not run"); }, async openSession() { throw new Error("MCP session must not open"); } },
    platform: createPlatformServices({
      platform: "linux",
      home: value.root,
      env: { PATH: "/tools" },
      isWsl: false,
      fileExists: (path) => path === process.execPath,
    }),
    adapters: [{
      id: "codex",
      async inspect() { calls.push("inspect"); throw new Error("MCP adapter must not inspect"); },
      async configure() { calls.push("configure"); throw new Error("MCP adapter must not configure"); },
      async remove() { calls.push("remove"); throw new Error("MCP adapter must not remove"); },
      async check() { calls.push("check"); throw new Error("MCP adapter must not check"); },
    }],
    confirmation: { async confirm() { return true; } },
    nodePath: process.execPath,
    entryPath: process.execPath,
  };
  assert.equal(await setup(["--agent-hooks"], dependencies), 0);
  assert.deepEqual(calls, []);
  assert.equal(existsSync(join(value.root, ".claude", "settings.json")), true);
  assert.equal(await setup(["--status"], dependencies), 0);
  assert.equal(await setup(["--uninstall-agent-hooks"], dependencies), 0);
  assert.deepEqual(calls, []);
});

test("dedicated --yes agent-hook install still requires explicit consent", async (t) => {
  const value = fixture(t);
  let prompts = 0;
  const dependencies: SetupDependencies = {
    runner: { async run() { throw new Error("MCP runner must not run"); }, async openSession() { throw new Error("MCP session must not open"); } },
    platform: createPlatformServices({
      platform: "linux",
      home: value.root,
      env: { PATH: "/tools" },
      isWsl: false,
      fileExists: (path) => path === process.execPath,
    }),
    adapters: [],
    confirmation: {
      async confirm() {
        prompts += 1;
        return false;
      },
    },
    nodePath: process.execPath,
    entryPath: process.execPath,
  };
  assert.equal(await setup(["--agent-hooks", "--yes"], dependencies), 1);
  assert.equal(prompts, 1);
  assert.equal(existsSync(join(value.root, ".claude")), false);
});
