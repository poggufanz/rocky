import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  hasOwnedAgentHooks,
  hasOwnedGateGroup,
  mergeClaudeHooks,
  rockyGateHookCommand,
  rockyHookCommand,
  rockySessionStartHookCommand,
  rockyToolResultHookCommand,
} from "../setup/agent-hooks.js";
import {
  DESK_HOOK_ASYNC,
  deskHookCommand,
  hasOwnedDeskHooks,
  mergeDeskHooks,
} from "../setup/desk-hooks.js";
import {
  applyClaudeSettings,
  claudeSettingsSnippets,
  inspectClaudeSettings,
  removeClaudeSettings,
} from "../setup/auto/claude-settings.js";
import { inspectJsonTransaction } from "../setup/json-config.js";
import type { Paths } from "../setup/auto/types.js";

interface Fixture {
  root: string;
  settings: string;
  paths: Paths;
}

function fixture(t: test.TestContext): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rocky-auto-claude-settings-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    settings: join(root, "settings.json"),
    paths: { nodePath: process.execPath, entryPath: join(root, "src", "index.js") },
  };
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function events(path: string): Record<string, Array<{ matcher?: unknown; hooks: Array<{ command?: unknown }> }>> {
  return readJson(path).hooks as Record<string, Array<{ matcher?: unknown; hooks: Array<{ command?: unknown }> }>>;
}

function states(reports: ReadonlyArray<{ kind: string; state: string }>): Array<[string, string]> {
  return reports.map((report) => [report.kind, report.state]);
}

function hookBin(root: string): string {
  const bin = join(root, process.platform === "win32" ? "rocky-hook.exe" : "rocky-hook");
  writeFileSync(bin, "fixture");
  return bin;
}

test("auto claude settings: missing hooks are written without a new gate", (t) => {
  const value = fixture(t);
  const reports = applyClaudeSettings(value.settings, value.paths);
  assert.deepEqual(states(reports), [["agent-hooks", "written"]]);
  assert.equal(reports[0]?.harness, "claude-code");
  assert.equal(reports[0]?.path, value.settings);
  assert.equal(events(value.settings).PreToolUse, undefined);
  assert.equal(
    events(value.settings).UserPromptSubmit[0].hooks[0].command,
    rockyHookCommand("claude-code", value.paths.nodePath, value.paths.entryPath),
  );
});

test("auto claude settings: an existing gate is kept and its path refreshed", (t) => {
  const value = fixture(t);
  const oldNode = join(value.root, "old-node.exe");
  const oldEntry = join(value.root, "old-index.js");
  writeFileSync(
    value.settings,
    JSON.stringify(mergeClaudeHooks({}, {
      agent: rockyHookCommand("claude-code", oldNode, oldEntry),
      session: rockySessionStartHookCommand(oldNode, oldEntry),
      toolResult: rockyToolResultHookCommand(oldNode, oldEntry),
      gate: rockyGateHookCommand(oldNode, oldEntry),
    })),
  );
  const reports = applyClaudeSettings(value.settings, value.paths);
  assert.deepEqual(states(reports), [["agent-hooks", "written"]]);
  assert.equal(
    events(value.settings).PreToolUse[0].hooks[0].command,
    rockyGateHookCommand(value.paths.nodePath, value.paths.entryPath),
  );
  assert.equal(
    events(value.settings).UserPromptSubmit[0].hooks[0].command,
    rockyHookCommand("claude-code", value.paths.nodePath, value.paths.entryPath),
  );
  assert.equal(
    events(value.settings).SessionStart[0].hooks[0].command,
    rockySessionStartHookCommand(value.paths.nodePath, value.paths.entryPath),
  );
});

test("auto claude settings: owned hooks with an old node path inspect as stale", (t) => {
  const value = fixture(t);
  const oldNode = join(value.root, "old-node.exe");
  const oldEntry = join(value.root, "old-index.js");
  const oldCommand = rockyHookCommand("claude-code", oldNode, oldEntry);
  const oldSession = rockySessionStartHookCommand(oldNode, oldEntry);
  const oldToolResult = rockyToolResultHookCommand(oldNode, oldEntry);
  const original = Buffer.from(
    JSON.stringify(mergeClaudeHooks({}, {
      agent: oldCommand,
      session: oldSession,
      toolResult: oldToolResult,
      gate: undefined,
    })),
    "utf8",
  );
  writeFileSync(value.settings, original);
  const reports = inspectClaudeSettings(value.settings, value.paths);
  assert.deepEqual(states(reports), [["agent-hooks", "stale"]]);
  assert.deepEqual(readFileSync(value.settings), original, "inspect never writes");
});

test("auto claude settings: inspect reports missing before apply and ok after it", (t) => {
  const value = fixture(t);
  assert.deepEqual(states(inspectClaudeSettings(value.settings, value.paths)), [["agent-hooks", "missing"]]);
  assert.equal(existsSync(value.settings), false, "inspect never creates the file");
  applyClaudeSettings(value.settings, value.paths);
  assert.deepEqual(states(inspectClaudeSettings(value.settings, value.paths)), [["agent-hooks", "ok"]]);
});

test("auto claude settings: foreign hooks in the same event survive byte-equal in value", (t) => {
  const value = fixture(t);
  writeFileSync(
    value.settings,
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] }, theme: "x" }),
  );
  applyClaudeSettings(value.settings, value.paths);
  assert.deepEqual(events(value.settings).Stop[0], { hooks: [{ type: "command", command: "echo mine" }] });
  assert.equal(readJson(value.settings).theme, "x");
});

test("auto claude settings: missing parent dir is refused and nothing is created", (t) => {
  const value = fixture(t);
  const absent = join(value.root, "absent", "settings.json");
  const reports = applyClaudeSettings(absent, value.paths);
  assert.deepEqual(states(reports), [["agent-hooks", "refused"]]);
  assert.equal(existsSync(join(value.root, "absent")), false);
  assert.deepEqual(states(inspectClaudeSettings(absent, value.paths)), [["agent-hooks", "refused"]]);
  assert.equal(existsSync(join(value.root, "absent")), false);
});

test("auto claude settings: a pending transaction is recovered before writing", (t) => {
  const value = fixture(t);
  const transaction = join(value.root, `.${basename(value.settings)}.transaction-pending`);
  mkdirSync(transaction);
  writeFileSync(join(transaction, "manifest.json"), JSON.stringify({ version: 1, state: "prepared", target: value.settings }));
  const reports = applyClaudeSettings(value.settings, value.paths);
  assert.deepEqual(states(reports), [["agent-hooks", "written"]]);
  assert.deepEqual(inspectJsonTransaction(value.settings), { status: "clear" }, "no transaction is left pending");
  assert.deepEqual(states(applyClaudeSettings(value.settings, value.paths)), [["agent-hooks", "ok"]]);
  assert.notEqual(events(value.settings).UserPromptSubmit, undefined);
});

test("auto claude settings: remove recovers a pending transaction before removing hooks", (t) => {
  const value = fixture(t);
  writeFileSync(
    value.settings,
    JSON.stringify(mergeClaudeHooks({}, {
      agent: rockyHookCommand("claude-code", value.paths.nodePath, value.paths.entryPath),
      session: rockySessionStartHookCommand(value.paths.nodePath, value.paths.entryPath),
      toolResult: rockyToolResultHookCommand(value.paths.nodePath, value.paths.entryPath),
      gate: undefined,
    })),
  );
  const transaction = join(value.root, `.${basename(value.settings)}.transaction-pending`);
  mkdirSync(transaction);
  writeFileSync(join(transaction, "manifest.json"), JSON.stringify({ version: 1, state: "prepared", target: value.settings }));
  const reports = removeClaudeSettings(value.settings);
  assert.deepEqual(states(reports), [["agent-hooks", "written"], ["desk-hooks", "written"]]);
  assert.deepEqual(inspectJsonTransaction(value.settings), { status: "clear" });
  assert.equal(readJson(value.settings).hooks, undefined);
});

test("auto claude settings: concurrent write reports changed and keeps the other bytes", (t) => {
  const value = fixture(t);
  const reports = applyClaudeSettings(value.settings, value.paths, {
    beforeWrite: () => writeFileSync(value.settings, '{"theme":"other"}\n'),
  });
  assert.deepEqual(states(reports), [["agent-hooks", "changed"]]);
  assert.equal(readFileSync(value.settings, "utf8"), '{"theme":"other"}\n');
});

test("auto claude settings: BOM settings are refused untouched", (t) => {
  const value = fixture(t);
  const bytes = Buffer.from('\uFEFF{\r\n  "theme": "x"\r\n}\r\n', "utf8");
  writeFileSync(value.settings, bytes);
  const reports = applyClaudeSettings(value.settings, value.paths);
  assert.deepEqual(states(reports), [["agent-hooks", "refused"]]);
  assert.deepEqual(readFileSync(value.settings), bytes);
});

test("auto claude settings: CRLF settings keep foreign keys", (t) => {
  const value = fixture(t);
  writeFileSync(value.settings, '{\r\n  "theme": "x"\r\n}\r\n');
  const reports = applyClaudeSettings(value.settings, value.paths);
  assert.deepEqual(states(reports), [["agent-hooks", "written"]]);
  assert.equal(readJson(value.settings).theme, "x");
});

test("auto claude settings: unsafe hook path refuses desk hooks only", { skip: process.platform !== "win32" }, (t) => {
  const value = fixture(t);
  const pctDir = join(value.root, "has%pct");
  mkdirSync(pctDir);
  writeFileSync(join(pctDir, "rocky-hook.exe"), "fixture");
  const reports = applyClaudeSettings(value.settings, { ...value.paths, deskHookBin: join(pctDir, "rocky-hook.exe") });
  assert.deepEqual(states(reports), [["agent-hooks", "written"], ["desk-hooks", "refused"]]);
  assert.match(reports[1]?.detail ?? "", /unsafe/);
  assert.notEqual(events(value.settings).UserPromptSubmit, undefined);
  assert.equal(hasOwnedDeskHooks(readJson(value.settings)), false);
  assert.equal(events(value.settings).SessionEnd, undefined);
  assert.deepEqual(events(value.settings).SessionStart, [{
    hooks: [{
      type: "command",
      command: rockySessionStartHookCommand(value.paths.nodePath, value.paths.entryPath),
    }],
  }]);
});

test("auto claude settings: desk hooks land in the same write and inspect ok", (t) => {
  const value = fixture(t);
  const paths: Paths = { ...value.paths, deskHookBin: hookBin(value.root) };
  const reports = applyClaudeSettings(value.settings, paths);
  assert.deepEqual(states(reports), [["agent-hooks", "written"], ["desk-hooks", "written"]]);
  assert.notEqual(events(value.settings).SessionStart, undefined);
  assert.equal(hasOwnedAgentHooks(readJson(value.settings)), false);
  assert.equal(JSON.stringify(readJson(value.settings)).includes("hook agent-event claude-code"), false);
  assert.deepEqual(states(inspectClaudeSettings(value.settings, paths)), [["agent-hooks", "ok"], ["desk-hooks", "ok"]]);
  assert.deepEqual(claudeSettingsSnippets(paths, false), [
    JSON.stringify(rockySessionStartHookCommand(paths.nodePath, paths.entryPath)),
    JSON.stringify(rockyToolResultHookCommand(paths.nodePath, paths.entryPath)),
    JSON.stringify(deskHookCommand(paths.deskHookBin as string)),
  ]);
  assert.equal(claudeSettingsSnippets(paths, true).length, 4);
});

test("auto claude settings: desk hooks without a binary inspect as stale", (t) => {
  const value = fixture(t);
  const bin = hookBin(value.root);
  applyClaudeSettings(value.settings, { ...value.paths, deskHookBin: bin });
  const reports = inspectClaudeSettings(value.settings, value.paths);
  assert.deepEqual(states(reports), [["agent-hooks", "missing"], ["desk-hooks", "stale"]]);
});

test("auto claude settings: desk write retires agent-event hooks and refreshes a kept gate", (t) => {
  const value = fixture(t);
  const oldNode = join(value.root, "old-node.exe");
  const oldEntry = join(value.root, "old-index.js");
  writeFileSync(
    value.settings,
    JSON.stringify(mergeClaudeHooks({}, {
      agent: rockyHookCommand("claude-code", oldNode, oldEntry),
      session: rockySessionStartHookCommand(oldNode, oldEntry),
      toolResult: rockyToolResultHookCommand(oldNode, oldEntry),
      gate: rockyGateHookCommand(oldNode, oldEntry),
    })),
  );
  const paths: Paths = { ...value.paths, deskHookBin: hookBin(value.root) };
  const reports = applyClaudeSettings(value.settings, paths);
  assert.deepEqual(states(reports), [["agent-hooks", "written"], ["desk-hooks", "written"]]);
  assert.equal(hasOwnedAgentHooks(readJson(value.settings)), false);
  assert.equal(JSON.stringify(readJson(value.settings)).includes("hook agent-event claude-code"), false);
  const gateGroup = events(value.settings).PreToolUse.find((group) => group.matcher === "Edit|Write|MultiEdit");
  assert.equal(
    gateGroup?.hooks[0]?.command,
    rockyGateHookCommand(paths.nodePath, paths.entryPath),
  );
  assert.deepEqual(states(inspectClaudeSettings(value.settings, paths)), [["agent-hooks", "ok"], ["desk-hooks", "ok"]]);
});

test("auto claude settings: a missing desk binary brings agent-event hooks back", (t) => {
  const value = fixture(t);
  const bin = hookBin(value.root);
  applyClaudeSettings(value.settings, { ...value.paths, deskHookBin: bin });
  assert.equal(hasOwnedAgentHooks(readJson(value.settings)), false);
  assert.deepEqual(states(inspectClaudeSettings(value.settings, value.paths)), [["agent-hooks", "missing"], ["desk-hooks", "stale"]]);
  const restored = applyClaudeSettings(value.settings, value.paths);
  assert.deepEqual(states(restored), [["agent-hooks", "written"], ["desk-hooks", "stale"]]);
  const expectedCommand = rockyHookCommand("claude-code", value.paths.nodePath, value.paths.entryPath);
  assert.ok(
    events(value.settings).UserPromptSubmit.some((group) => group.hooks[0]?.command === expectedCommand),
    JSON.stringify(events(value.settings).UserPromptSubmit),
  );
});

test("auto claude settings: remove leaves foreign hooks and drops every owned one", (t) => {
  const value = fixture(t);
  const bin = hookBin(value.root);
  let merged = mergeClaudeHooks({ theme: "x" }, {
    agent: rockyHookCommand("claude-code", value.paths.nodePath, value.paths.entryPath),
    session: rockySessionStartHookCommand(value.paths.nodePath, value.paths.entryPath),
    toolResult: rockyToolResultHookCommand(value.paths.nodePath, value.paths.entryPath),
    gate: rockyGateHookCommand(value.paths.nodePath, value.paths.entryPath),
  });
  merged = mergeDeskHooks(merged, deskHookCommand(bin), DESK_HOOK_ASYNC);
  const hooks = merged.hooks as Record<string, unknown[]>;
  hooks.Stop = [{ hooks: [{ type: "command", command: "echo mine" }] }, ...hooks.Stop];
  writeFileSync(value.settings, `${JSON.stringify(merged, null, 2)}\n`);
  const reports = removeClaudeSettings(value.settings);
  assert.deepEqual(states(reports), [["agent-hooks", "written"], ["desk-hooks", "written"]]);
  assert.deepEqual(events(value.settings), { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] });
  assert.equal(readJson(value.settings).theme, "x");
});

test("auto claude settings: remove on a missing file is ok and creates nothing", (t) => {
  const value = fixture(t);
  assert.deepEqual(states(removeClaudeSettings(value.settings)), [["agent-hooks", "ok"], ["desk-hooks", "ok"]]);
  assert.equal(existsSync(value.settings), false);
});

test("auto claude settings: ownership predicates follow command markers, not paths", (t) => {
  const value = fixture(t);
  assert.equal(hasOwnedAgentHooks({}), false);
  assert.equal(hasOwnedAgentHooks({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] } }), false);
  const oldNode = join(value.root, "old-node.exe");
  const oldEntry = join(value.root, "old-index.js");
  const oldCommand = rockyHookCommand("claude-code", oldNode, oldEntry);
  const oldSession = rockySessionStartHookCommand(oldNode, oldEntry);
  const oldToolResult = rockyToolResultHookCommand(oldNode, oldEntry);
  assert.equal(
    hasOwnedAgentHooks(mergeClaudeHooks({}, {
      agent: oldCommand,
      session: oldSession,
      toolResult: oldToolResult,
      gate: undefined,
    })),
    true,
    "a stale node path is still owned",
  );
  const sessionCommand = rockySessionStartHookCommand(value.paths.nodePath, value.paths.entryPath);
  const toolResultCommand = rockyToolResultHookCommand(value.paths.nodePath, value.paths.entryPath);
  const current = mergeClaudeHooks({}, {
    agent: rockyHookCommand("claude-code", value.paths.nodePath, value.paths.entryPath),
    session: sessionCommand,
    toolResult: toolResultCommand,
    gate: undefined,
  });
  assert.equal(hasOwnedAgentHooks(current), true);
  assert.equal(hasOwnedGateGroup(current), false);
  const gated = mergeClaudeHooks({}, {
    agent: rockyHookCommand("claude-code", value.paths.nodePath, value.paths.entryPath),
    session: sessionCommand,
    toolResult: toolResultCommand,
    gate: rockyGateHookCommand(value.paths.nodePath, value.paths.entryPath),
  });
  assert.equal(hasOwnedGateGroup(gated), true);
  assert.equal(hasOwnedDeskHooks(gated), false);
  const desk = mergeDeskHooks({}, deskHookCommand(hookBin(value.root)), DESK_HOOK_ASYNC);
  assert.equal(hasOwnedDeskHooks(desk), true);
  assert.equal(hasOwnedAgentHooks(desk), false);
  assert.equal(hasOwnedAgentHooks({ hooks: { Stop: "not-an-array" } }), false);
});

test("auto claude settings: no timestamped backup files are created", (t) => {
  const value = fixture(t);
  applyClaudeSettings(value.settings, { ...value.paths, deskHookBin: hookBin(value.root) });
  assert.deepEqual(readdirSync(value.root).filter((name) => name.includes(".backup-")), []);
});

test("auto claude settings: desk apply retires agent-event hooks and keeps Rocky SessionStart beside desk SessionStart", (t) => {
  const value = fixture(t);
  const paths: Paths = { ...value.paths, deskHookBin: hookBin(value.root) };
  const expectedSession = rockySessionStartHookCommand(paths.nodePath, paths.entryPath);
  const expectedDesk = deskHookCommand(paths.deskHookBin as string);

  const reports = applyClaudeSettings(value.settings, paths);
  assert.deepEqual(states(reports), [["agent-hooks", "written"], ["desk-hooks", "written"]]);
  assert.equal(hasOwnedAgentHooks(readJson(value.settings)), false);

  const sessionGroups = events(value.settings).SessionStart;
  assert.equal(sessionGroups.length, 2, JSON.stringify(sessionGroups));
  assert.deepEqual(sessionGroups[0], { hooks: [{ type: "command", command: expectedSession }] });
  assert.deepEqual(sessionGroups[1], { hooks: [{ type: "command", command: expectedDesk, timeout: 5, async: true }] });
  assert.deepEqual(states(inspectClaudeSettings(value.settings, paths)), [["agent-hooks", "ok"], ["desk-hooks", "ok"]]);
});

test("auto claude settings: inspect reports an old three-event install without SessionStart as stale", (t) => {
  const value = fixture(t);
  const command = rockyHookCommand("claude-code", value.paths.nodePath, value.paths.entryPath);
  const oldThreeEvent = {
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: "command", command }] }],
      PostToolUse: [{ matcher: "Edit|Write|MultiEdit|NotebookEdit", hooks: [{ type: "command", command }] }],
      Stop: [{ hooks: [{ type: "command", command }] }],
    },
  };
  writeFileSync(value.settings, `${JSON.stringify(oldThreeEvent)}\n`);
  assert.deepEqual(states(inspectClaudeSettings(value.settings, value.paths)), [["agent-hooks", "stale"]]);
});

test("auto claude settings: remove drops both Rocky SessionStart and desk SessionStart while keeping foreign", (t) => {
  const value = fixture(t);
  const paths: Paths = { ...value.paths, deskHookBin: hookBin(value.root) };
  const foreign = { hooks: [{ type: "command", command: "echo foreign-session" }] };
  writeFileSync(value.settings, `${JSON.stringify({ hooks: { SessionStart: [foreign] } })}\n`);

  applyClaudeSettings(value.settings, paths);
  assert.equal(events(value.settings).SessionStart.length, 3);

  const removed = removeClaudeSettings(value.settings);
  assert.deepEqual(states(removed), [["agent-hooks", "written"], ["desk-hooks", "written"]]);
  assert.deepEqual(events(value.settings), { SessionStart: [foreign] });
});

test("auto claude settings: claudeSettingsSnippets includes SessionStart whether or not desk is ready", (t) => {
  const value = fixture(t);
  const expectedSession = JSON.stringify(
    rockySessionStartHookCommand(value.paths.nodePath, value.paths.entryPath),
  );
  const withoutDesk = claudeSettingsSnippets(value.paths, false);
  assert.ok(withoutDesk.includes(expectedSession), JSON.stringify(withoutDesk));

  const withDeskPaths: Paths = { ...value.paths, deskHookBin: hookBin(value.root) };
  const withDesk = claudeSettingsSnippets(withDeskPaths, false);
  assert.ok(withDesk.includes(expectedSession), JSON.stringify(withDesk));
  assert.ok(withDesk.includes(JSON.stringify(deskHookCommand(withDeskPaths.deskHookBin as string))), JSON.stringify(withDesk));
});

test("auto claude settings: an old install with agent hooks but no tool-result groups inspects as stale", (t) => {
  const value = fixture(t);
  const command = rockyHookCommand("claude-code", value.paths.nodePath, value.paths.entryPath);
  const session = rockySessionStartHookCommand(value.paths.nodePath, value.paths.entryPath);
  const oldInstall = {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: session }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command }] }],
      PostToolUse: [{ matcher: "Edit|Write|MultiEdit|NotebookEdit", hooks: [{ type: "command", command }] }],
      Stop: [{ hooks: [{ type: "command", command }] }],
    },
  };
  writeFileSync(value.settings, `${JSON.stringify(oldInstall)}\n`);
  assert.deepEqual(states(inspectClaudeSettings(value.settings, value.paths)), [["agent-hooks", "stale"]]);
});

test("auto claude settings: apply adds both tool-result groups with exactly one SessionStart group", (t) => {
  const value = fixture(t);
  const command = rockyHookCommand("claude-code", value.paths.nodePath, value.paths.entryPath);
  const session = rockySessionStartHookCommand(value.paths.nodePath, value.paths.entryPath);
  const toolResult = rockyToolResultHookCommand(value.paths.nodePath, value.paths.entryPath);
  const oldInstall = {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: session }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command }] }],
      PostToolUse: [{ matcher: "Edit|Write|MultiEdit|NotebookEdit", hooks: [{ type: "command", command }] }],
      Stop: [{ hooks: [{ type: "command", command }] }],
    },
  };
  writeFileSync(value.settings, `${JSON.stringify(oldInstall)}\n`);

  const reports = applyClaudeSettings(value.settings, value.paths);
  assert.deepEqual(states(reports), [["agent-hooks", "written"]]);

  const hooks = events(value.settings);
  assert.equal(hooks.SessionStart.length, 1);
  assert.deepEqual(hooks.SessionStart, [{ hooks: [{ type: "command", command: session }] }]);
  assert.deepEqual(hooks.PostToolUse, [
    { matcher: "Edit|Write|MultiEdit|NotebookEdit", hooks: [{ type: "command", command }] },
    { matcher: "Bash|PowerShell", hooks: [{ type: "command", command: toolResult, async: true }] },
  ]);
  assert.deepEqual(hooks.PostToolUseFailure, [
    { matcher: "Bash|PowerShell", hooks: [{ type: "command", command: toolResult, timeout: 5 }] },
  ]);
  assert.deepEqual(states(inspectClaudeSettings(value.settings, value.paths)), [["agent-hooks", "ok"]]);
});

test("auto claude settings: with a desk binary present, apply leaves no agent-event group and keeps SessionStart, both tool-result groups, and desk groups", (t) => {
  const value = fixture(t);
  const paths: Paths = { ...value.paths, deskHookBin: hookBin(value.root) };
  const expectedSession = rockySessionStartHookCommand(paths.nodePath, paths.entryPath);
  const expectedToolResult = rockyToolResultHookCommand(paths.nodePath, paths.entryPath);
  const expectedDesk = deskHookCommand(paths.deskHookBin as string);

  const reports = applyClaudeSettings(value.settings, paths);
  assert.deepEqual(states(reports), [["agent-hooks", "written"], ["desk-hooks", "written"]]);
  assert.equal(hasOwnedAgentHooks(readJson(value.settings)), false);
  assert.equal(JSON.stringify(readJson(value.settings)).includes("hook agent-event claude-code"), false);

  const hooks = events(value.settings);
  assert.deepEqual(hooks.SessionStart, [
    { hooks: [{ type: "command", command: expectedSession }] },
    { hooks: [{ type: "command", command: expectedDesk, timeout: 5, async: true }] },
  ]);
  assert.deepEqual(hooks.PostToolUse, [
    { matcher: "Bash|PowerShell", hooks: [{ type: "command", command: expectedToolResult, async: true }] },
    { matcher: "*", hooks: [{ type: "command", command: expectedDesk, timeout: 5, async: true }] },
  ]);
  assert.deepEqual(hooks.PostToolUseFailure, [
    { matcher: "Bash|PowerShell", hooks: [{ type: "command", command: expectedToolResult, timeout: 5 }] },
    { hooks: [{ type: "command", command: expectedDesk, timeout: 5, async: true }] },
  ]);
  assert.deepEqual(states(inspectClaudeSettings(value.settings, paths)), [["agent-hooks", "ok"], ["desk-hooks", "ok"]]);
});

test("auto claude settings: claudeSettingsSnippets includes the tool-result command", (t) => {
  const value = fixture(t);
  const expectedToolResult = JSON.stringify(
    rockyToolResultHookCommand(value.paths.nodePath, value.paths.entryPath),
  );
  const withoutDesk = claudeSettingsSnippets(value.paths, false);
  assert.ok(withoutDesk.includes(expectedToolResult), JSON.stringify(withoutDesk));

  const withDeskPaths: Paths = { ...value.paths, deskHookBin: hookBin(value.root) };
  const withDesk = claudeSettingsSnippets(withDeskPaths, false);
  assert.ok(withDesk.includes(expectedToolResult), JSON.stringify(withDesk));
});
