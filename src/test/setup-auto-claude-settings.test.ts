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
    JSON.stringify(mergeClaudeHooks({}, rockyHookCommand("claude-code", oldNode, oldEntry), rockyGateHookCommand(oldNode, oldEntry))),
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
});

test("auto claude settings: owned hooks with an old node path inspect as stale", (t) => {
  const value = fixture(t);
  const oldCommand = rockyHookCommand("claude-code", join(value.root, "old-node.exe"), join(value.root, "old-index.js"));
  const original = Buffer.from(JSON.stringify(mergeClaudeHooks({}, oldCommand)), "utf8");
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
  assert.equal(events(value.settings).SessionStart, undefined);
});

test("auto claude settings: desk hooks land in the same write and inspect ok", (t) => {
  const value = fixture(t);
  const paths: Paths = { ...value.paths, deskHookBin: hookBin(value.root) };
  const reports = applyClaudeSettings(value.settings, paths);
  assert.deepEqual(states(reports), [["agent-hooks", "written"], ["desk-hooks", "written"]]);
  assert.notEqual(events(value.settings).SessionStart, undefined);
  assert.deepEqual(states(inspectClaudeSettings(value.settings, paths)), [["agent-hooks", "ok"], ["desk-hooks", "ok"]]);
  assert.deepEqual(claudeSettingsSnippets(paths, false), [
    JSON.stringify(rockyHookCommand("claude-code", paths.nodePath, paths.entryPath)),
    JSON.stringify(deskHookCommand(paths.deskHookBin as string)),
  ]);
  assert.equal(claudeSettingsSnippets(paths, true).length, 3);
});

test("auto claude settings: desk hooks without a binary inspect as stale", (t) => {
  const value = fixture(t);
  const bin = hookBin(value.root);
  applyClaudeSettings(value.settings, { ...value.paths, deskHookBin: bin });
  const reports = inspectClaudeSettings(value.settings, value.paths);
  assert.deepEqual(states(reports), [["agent-hooks", "ok"], ["desk-hooks", "stale"]]);
});

test("auto claude settings: remove leaves foreign hooks and drops every owned one", (t) => {
  const value = fixture(t);
  const bin = hookBin(value.root);
  let merged = mergeClaudeHooks(
    { theme: "x" },
    rockyHookCommand("claude-code", value.paths.nodePath, value.paths.entryPath),
    rockyGateHookCommand(value.paths.nodePath, value.paths.entryPath),
  );
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
  const oldCommand = rockyHookCommand("claude-code", join(value.root, "old-node.exe"), join(value.root, "old-index.js"));
  assert.equal(hasOwnedAgentHooks(mergeClaudeHooks({}, oldCommand)), true, "a stale node path is still owned");
  const current = mergeClaudeHooks({}, rockyHookCommand("claude-code", value.paths.nodePath, value.paths.entryPath));
  assert.equal(hasOwnedAgentHooks(current), true);
  assert.equal(hasOwnedGateGroup(current), false);
  const gated = mergeClaudeHooks(
    {},
    rockyHookCommand("claude-code", value.paths.nodePath, value.paths.entryPath),
    rockyGateHookCommand(value.paths.nodePath, value.paths.entryPath),
  );
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
