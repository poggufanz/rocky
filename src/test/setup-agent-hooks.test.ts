import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  codexConfigSnippet,
  installClaudeAgentHooks,
  mergeClaudeHooks,
  removeClaudeHooks,
  rockyHookCommand,
  uninstallClaudeAgentHooks,
} from "../setup/agent-hooks.js";
import { createPlatformServices } from "../setup/platform.js";
import { setup, type SetupDependencies } from "../commands/setup.js";

const LEGACY_CLAUDE_HOOK_COMMAND = "rocky hook agent-event claude-code";

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
    '"/opt/Rocky CLI/bin/node!" "/opt/Rocky CLI/\\$dist/rocky\\"cli/index.js" hook agent-event claude-code',
  );
});

test("POSIX hook command round-trips metacharacters through sh", () => {
  if (process.platform === "win32") return;
  const nodePath = "/tmp/Rocky CLI/node!bin";
  const scriptPath = "/tmp/Rocky CLI/$dist/rocky`cli/quo\"te\\bin/index.js";
  const command = rockyHookCommand("codex", nodePath, scriptPath);
  const result = spawnSync(
    "sh",
    ["-c", `set -- ${command}; printf '%s\\n' "$1" "$2"`],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.split("\n").slice(0, 2), [nodePath, scriptPath]);
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
  const once = mergeClaudeHooks(structuredClone(foreign), LEGACY_CLAUDE_HOOK_COMMAND);
  const twice = mergeClaudeHooks(structuredClone(once), LEGACY_CLAUDE_HOOK_COMMAND);
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
          { type: "command", command: LEGACY_CLAUDE_HOOK_COMMAND },
          { type: "command", command: "other-tool" },
        ],
      }],
    },
  };
  const merged = mergeClaudeHooks(existing, LEGACY_CLAUDE_HOOK_COMMAND);
  assert.deepEqual((merged.hooks as Record<string, unknown[]>).Stop?.[0], {
    name: "foreign-group",
    hooks: [{ type: "command", command: "other-tool" }],
  });
  assert.notStrictEqual(merged, existing);
  assert.deepEqual(existing.hooks.Stop[0].hooks, [
    { type: "command", command: LEGACY_CLAUDE_HOOK_COMMAND },
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
  const merged = mergeClaudeHooks(structuredClone(foreign), LEGACY_CLAUDE_HOOK_COMMAND);
  assert.deepEqual(removeClaudeHooks(merged), foreign);
  assert.deepEqual(removeClaudeHooks(mergeClaudeHooks({}, LEGACY_CLAUDE_HOOK_COMMAND)), {});
});

test("removeClaudeHooks preserves a foreign command that embeds Rocky marker as an argument", () => {
  const foreign = {
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "foreign-tool --label 'hook agent-event claude-code'" }] }],
    },
  };
  assert.deepEqual(removeClaudeHooks(foreign), foreign);
});

test("removeClaudeHooks preserves parsed but noncanonical or unsafe Windows commands", () => {
  const commands = [
    '"C:\\Program Files\\%PATH%\\node.exe" "C:\\Rocky\\dist\\index.js" hook agent-event claude-code',
    '"C:\\Program Files\\!\\node.exe" "C:\\Rocky\\dist\\index.js" hook agent-event claude-code',
    String.raw`"C:\Program Files\\\"evil\node.exe" "C:\Rocky\dist\index.js" hook agent-event claude-code`,
  ];
  for (const command of commands) {
    const foreign = { hooks: { Stop: [{ hooks: [{ type: "command", command }] }] } };
    assert.deepEqual(removeClaudeHooks(foreign), foreign, command);
  }
});

test("removeClaudeHooks still strips the exact pre-canonical POSIX bang spelling", () => {
  const command = '"/opt/Rocky\\! CLI/node" "/opt/Rocky\\! CLI/index.js" hook agent-event claude-code';
  const existing = { hooks: { Stop: [{ hooks: [{ type: "command", command }] }] } };
  assert.deepEqual(removeClaudeHooks(existing), {});
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

test("missing parent fails before consent or proposed JSON and never mutates filesystem", async (t) => {
  const value = fixture(t);
  const details: string[] = [];
  let prompted = false;
  const result = await installClaudeAgentHooks({ settingsPath: value.settings }, {
    command: value.command,
    detail: (message) => details.push(message),
    confirmation: {
      async confirm() {
        prompted = true;
        return true;
      },
    },
  });
  assert.equal(result.status, "error");
  assert.equal(prompted, false);
  assert.equal(details.length, 0);
  assert.match(result.detail ?? "", /rerun setup/i);
  assert.match(result.detail ?? "", /private directory/i);
  assert.doesNotMatch(result.detail ?? "", /UserPromptSubmit|PostToolUse|Stop/);
  assert.equal(existsSync(dirname(value.settings)), false);
  assert.equal(existsSync(value.settings), false);
});

test("install preserves foreign settings and is unchanged on repeat", async (t) => {
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
  mkdirSync(dirname(value.settings), { recursive: true, mode: 0o700 });
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

test("authorized install creates missing settings in an existing parent and CAS refuses a late write race", async (t) => {
  const value = fixture(t);
  mkdirSync(dirname(value.settings), { recursive: true, mode: 0o700 });
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
  mkdirSync(join(value.root, ".claude"), { mode: 0o700 });
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

test("agent-hook capability notice precedes consent and remains visible in status", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rocky-agent-hook-capability-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".claude"), { recursive: true, mode: 0o700 });
  const timeline: string[] = [];
  let output = "";
  const originalStderr = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    output += text;
    if (text.includes("Claude Code capture requires hook payload field `prompt_id`")) timeline.push("capability");
    return true;
  }) as typeof process.stderr.write;
  const dependencies: SetupDependencies = {
    runner: { async run() { throw new Error("MCP runner must not run"); }, async openSession() { throw new Error("MCP session must not open"); } },
    platform: createPlatformServices({
      platform: "linux",
      home: root,
      env: { PATH: "/tools" },
      isWsl: false,
      fileExists: (path) => path === process.execPath,
    }),
    adapters: [],
    confirmation: {
      async confirm() {
        timeline.push("consent");
        return true;
      },
    },
    nodePath: process.execPath,
    entryPath: process.execPath,
  };
  try {
    assert.equal(await setup(["--agent-hooks"], dependencies), 0);
    assert.ok(timeline.includes("capability"));
    assert.ok(timeline.includes("consent"));
    assert.ok(timeline.indexOf("capability") < timeline.indexOf("consent"));

    output = "";
    assert.equal(await setup(["--status"], dependencies), 0);
    assert.match(output, /Claude Code capture requires hook payload field `prompt_id`/);
    assert.match(output, /claude-code agent hooks: installed/);
    assert.match(output, /codex agent hooks: manual/);
  } finally {
    process.stderr.write = originalStderr;
  }
});

test("dedicated --yes agent-hook install still requires explicit consent", async (t) => {
  const value = fixture(t);
  let prompts = 0;
  const originalStderr = process.stderr.write;
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
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
  let code: number;
  try {
    code = await setup(["--agent-hooks", "--yes"], dependencies);
  } finally {
    process.stderr.write = originalStderr;
  }
  assert.equal(code, 1);
  assert.equal(prompts, 0);
  assert.match(stderr, /private directory/i);
  assert.match(stderr, /rerun setup/i);
  assert.equal(existsSync(join(value.root, ".claude")), false);
});

test("codexConfigSnippet emits verified notify and lifecycle TOML", () => {
  const command = rockyHookCommand("codex", "/usr/bin/node", "/opt/Rocky CLI/dist/index.js");
  const snippet = codexConfigSnippet(command);
  assert.ok(snippet.includes(
    'notify = ["/usr/bin/node", "/opt/Rocky CLI/dist/index.js", "hook", "agent-event", "codex"]',
  ));
  for (const event of ["UserPromptSubmit", "PostToolUse", "Stop"]) {
    assert.ok(snippet.includes(`[[hooks.${event}]]`));
    assert.ok(snippet.includes(`[[hooks.${event}.hooks]]`));
  }
  assert.ok(snippet.includes('matcher = "^apply_patch$"'));
  assert.ok(snippet.includes(
    `command = '\"/usr/bin/node\" \"/opt/Rocky CLI/dist/index.js\" hook agent-event codex'`,
  ));
  assert.doesNotMatch(snippet, /TODO|TBD|placeholder/i);
  assert.doesNotMatch(snippet, /(?:^|\s)rocky(?:\s|$)/i);
});

test("codexConfigSnippet keeps Windows paths and spaces TOML-safe", () => {
  const command = rockyHookCommand(
    "codex",
    "C:\\Program Files\\node.exe",
    "C:\\Rocky CLI\\dist\\index.js",
  );
  const snippet = codexConfigSnippet(command);
  assert.ok(snippet.includes(
    'notify = ["C:\\\\Program Files\\\\node.exe", "C:\\\\Rocky CLI\\\\dist\\\\index.js", "hook", "agent-event", "codex"]',
  ));
  assert.ok(snippet.includes('command = \'"C:\\Program Files\\node.exe" "C:\\Rocky CLI\\dist\\index.js" hook agent-event codex\''));
});

test("codexConfigSnippet preserves Windows drive and UNC paths exactly", () => {
  const nodePath = "C:\\Program Files\\$cache\\node`bin.exe";
  const scriptPath = "\\\\server\\share\\Rocky CLI\\dist\\index.js\\";
  const command = rockyHookCommand("codex", nodePath, scriptPath);
  const snippet = codexConfigSnippet(command);
  const expectedNotify = `notify = [${JSON.stringify(nodePath)}, ${JSON.stringify(scriptPath)}, "hook", "agent-event", "codex"]`;
  assert.ok(snippet.includes(expectedNotify));
  assert.equal((snippet.match(/command = /g) ?? []).length, 3);
  for (const event of ["UserPromptSubmit", "PostToolUse", "Stop"]) {
    assert.ok(snippet.includes(`[[hooks.${event}]]`));
  }
  assert.ok(snippet.includes(command));
});

test("codexConfigSnippet accepts canonical special paths and preserves notify argv", () => {
  const nodePath = "/opt/Rocky $cache/node`bin\\!\"tool";
  const scriptPath = "/opt/Rocky's CLI/dist/rocky\\!\"index.js";
  const command = rockyHookCommand("codex", nodePath, scriptPath);
  const snippet = codexConfigSnippet(command);
  const expectedNotify = `notify = [${JSON.stringify(nodePath)}, ${JSON.stringify(scriptPath)}, "hook", "agent-event", "codex"]`;
  assert.ok(snippet.includes(expectedNotify));
  assert.equal(snippet.split(`command = ${JSON.stringify(command)}`).length - 1, 3);
});

test("codexConfigSnippet rejects direct noncanonical and unsafe path spellings", () => {
  const directCommands = [
    '"/usr/bin/node" "/opt/$cache/index.js" hook agent-event codex',
    '"/usr/bin/node" "/opt/`cache/index.js" hook agent-event codex',
    '"/usr/bin/node" "/opt/rocky\\!bin/index.js" hook agent-event codex',
    '"C:\\Program Files\\%PATH%\\node.exe" "C:\\Rocky\\dist\\index.js" hook agent-event codex',
    '"C:\\Program Files\\!\\node.exe" "C:\\Rocky\\dist\\index.js" hook agent-event codex',
    '"C:\\Program Files\\\\\"evil\\node.exe" "C:\\Rocky\\dist\\index.js" hook agent-event codex',
  ];
  for (const command of directCommands) assert.throws(() => codexConfigSnippet(command));
});

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

test("setup agent-hooks prints Codex manual TOML and never touches Codex config", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rocky-agent-hooks-codex-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".claude"), { mode: 0o700 });
  const codexHome = join(root, ".codex");
  mkdirSync(codexHome, { mode: 0o700 });
  const configPath = join(codexHome, "config.toml");
  const before = "# user config\nnotify = [\"other\"]\n";
  writeFileSync(configPath, before);

  const output = await captureStderr(() => setup(["--agent-hooks"], setupDependenciesFor(root)));
  assert.equal(output.code, 0);
  assert.match(output.stderr, /notify = \[\"/);
  assert.match(output.stderr, /\[\[hooks\.UserPromptSubmit\]\]/);
  assert.match(output.stderr, /matcher = \"\^apply_patch\$\"/);
  assert.match(output.stderr, /codex config is toml/i);
  assert.match(output.stderr, /\/hooks/);
  assert.equal(readFileSync(configPath, "utf8"), before);
  assert.equal(existsSync(join(root, ".claude", "settings.json")), true);
});

test("setup agent-hooks prints Codex guidance but preserves Claude error exit", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rocky-agent-hooks-codex-error-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = await captureStderr(() => setup(["--agent-hooks"], setupDependenciesFor(root, false)));
  assert.equal(output.code, 1);
  assert.match(output.stderr, /notify = \[\"/);
  assert.match(output.stderr, /codex config is toml/i);
  assert.equal(existsSync(join(root, ".codex", "config.toml")), false);
});

test("setup status reports Codex manual and uninstall leaves TOML untouched", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rocky-agent-hooks-codex-status-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".claude"), { mode: 0o700 });
  const codexHome = join(root, ".codex");
  mkdirSync(codexHome, { mode: 0o700 });
  const configPath = join(codexHome, "config.toml");
  const before = "notify = [\"keep\"]\n";
  writeFileSync(configPath, before);
  const dependencies = setupDependenciesFor(root);
  assert.equal((await setup(["--agent-hooks"], dependencies)), 0);

  const status = await captureStderr(() => setup(["--status"], dependencies));
  assert.equal(status.code, 0);
  assert.match(status.stderr, /codex agent hooks: manual/);

  const uninstall = await captureStderr(() => setup(["--uninstall-agent-hooks"], dependencies));
  assert.equal(uninstall.code, 0);
  assert.match(uninstall.stderr, /codex agent hooks: manual/);
  assert.equal(readFileSync(configPath, "utf8"), before);
});
