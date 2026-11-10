import test, { type TestContext } from "node:test";
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
import { basename, dirname, join } from "node:path";
import type { McpRegistration } from "../setup/clients.js";
import { toClaudeEntry } from "../setup/harness-claude-code.js";
import { toCopilotEntry } from "../setup/harness-copilot-cli.js";
import { toGeminiEntry } from "../setup/harness-gemini-cli.js";
import { toOpencodeEntry } from "../setup/harness-opencode.js";
import { registrationKey } from "../setup/registration.js";
import type { DetectEnv } from "../setup/auto/detect.js";
import {
  applyMcp,
  inspectMcp,
  mcpSnippets,
  mcpTargets,
  removeMcp,
  type McpTarget,
} from "../setup/auto/mcp.js";

interface Fixture {
  root: string;
  home: string;
  d: DetectEnv;
  reg: McpRegistration;
}

function fixture(t: TestContext): Fixture {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "rocky-auto-mcp-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(home);
  return {
    root,
    home,
    d: { home, env: {}, platform: process.platform, fileExists: existsSync },
    reg: {
      name: "rocky",
      command: process.execPath,
      args: [join(root, "src", "index.js"), "mcp"],
      env: { ROCKY_HOME: join(root, ".rocky"), ROCKY_MCP_EXPOSURE: "sanitized" },
    },
  };
}

function targetOf(f: Fixture, harness: McpTarget["harness"]): McpTarget {
  const target = mcpTargets(harness, f.d, [])[0];
  assert.ok(target);
  return target;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function container(value: Record<string, unknown>, key: string): Record<string, unknown> {
  return value[key] as Record<string, unknown>;
}

test("auto mcp: missing JSON entry is written without a timestamped backup", (t) => {
  const f = fixture(t);
  const gemini = targetOf(f, "gemini-cli");
  mkdirSync(dirname(gemini.path));

  const out = applyMcp(gemini, f.reg, []);
  assert.equal(out.report.state, "written");
  assert.equal(out.report.kind, "mcp");
  assert.equal(out.report.path, gemini.path);
  assert.equal(readdirSync(dirname(gemini.path)).some((name) => name.includes(".backup-")), false);
  assert.deepEqual(container(readJson(gemini.path), "mcpServers"), { rocky: toGeminiEntry(f.reg) });
  assert.equal(inspectMcp(gemini, f.reg, []).state, "ok");
});

test("auto mcp: a stale entry from history is replaced and keeps raw exposure", (t) => {
  const f = fixture(t);
  const copilot = targetOf(f, "copilot-cli");
  const stale: McpRegistration = {
    ...f.reg,
    args: [join(f.root, "old", "index.js"), "mcp"],
    env: { ...f.reg.env, ROCKY_MCP_EXPOSURE: "raw" },
  };
  writeJson(copilot.path, { mcpServers: { rocky: toCopilotEntry(stale) } });

  const out = applyMcp(copilot, f.reg, [registrationKey(stale)]);
  assert.equal(out.report.state, "written");
  const effective: McpRegistration = { ...f.reg, env: { ...f.reg.env, ROCKY_MCP_EXPOSURE: "raw" } };
  assert.equal(out.wroteKey, registrationKey(effective));
  const entry = container(readJson(copilot.path), "mcpServers").rocky as Record<string, unknown>;
  assert.equal((entry.env as Record<string, string>).ROCKY_MCP_EXPOSURE, "raw");
  assert.equal(entry.command, f.reg.command);
  assert.deepEqual(entry.args, [...f.reg.args]);
});

test("auto mcp: a rocky entry outside history is foreign and untouched by apply and remove", (t) => {
  const f = fixture(t);
  const claude = targetOf(f, "claude-code");
  writeJson(claude.path, { mcpServers: { rocky: { type: "stdio", command: "/x/other", args: [], env: {} } } });
  const before = readFileSync(claude.path);

  assert.equal(inspectMcp(claude, f.reg, []).state, "foreign");
  assert.equal(applyMcp(claude, f.reg, []).report.state, "foreign");
  assert.equal(removeMcp(claude, f.reg, []).state, "foreign");
  assert.deepEqual(readFileSync(claude.path), before);
});

test("auto mcp: codex block is written, recognized, and removed", (t) => {
  const f = fixture(t);
  const codex = targetOf(f, "codex");
  assert.equal(codex.format, "toml");
  mkdirSync(dirname(codex.path));
  writeFileSync(codex.path, 'model = "gpt-5"\n');
  assert.equal(inspectMcp(codex, f.reg, []).state, "missing");

  const out = applyMcp(codex, f.reg, []);
  assert.equal(out.report.state, "written");
  assert.equal(inspectMcp(codex, f.reg, []).state, "ok");
  assert.match(readFileSync(codex.path, "utf8"), /\[mcp_servers\.rocky\]/);

  assert.equal(removeMcp(codex, f.reg, []).state, "written");
  const after = readFileSync(codex.path, "utf8");
  assert.doesNotMatch(after, /\[mcp_servers\.rocky\]/);
  assert.match(after, /model = "gpt-5"/);
  assert.equal(inspectMcp(codex, f.reg, []).state, "missing");
});

test("auto mcp: leftover claude.json entry is removed and the file kept", (t) => {
  const f = fixture(t);
  const profile = join(f.root, "profile");
  mkdirSync(profile);
  writeJson(join(profile, "claude.json"), { mcpServers: { rocky: toClaudeEntry(f.reg) }, keep: 1 });
  const d: DetectEnv = { ...f.d, env: { CLAUDE_CONFIG_DIR: profile } };
  const legacy = mcpTargets("claude-code", d, [profile]).find((target) => target.legacy === true);
  assert.ok(legacy);

  assert.equal(applyMcp(legacy, f.reg, []).report.detail, "moved to .claude.json");
  assert.deepEqual(readJson(join(profile, "claude.json")), { mcpServers: {}, keep: 1 });
  assert.equal(existsSync(join(profile, ".claude.json")), false);
});

test("auto mcp: missing parent dir is refused", (t) => {
  const f = fixture(t);
  const opencode = targetOf(f, "opencode");

  assert.equal(inspectMcp(opencode, f.reg, []).state, "refused");
  assert.equal(applyMcp(opencode, f.reg, []).report.state, "refused");
  assert.equal(removeMcp(opencode, f.reg, []).state, "refused");
  assert.equal(existsSync(dirname(opencode.path)), false);
});

test("auto mcp: non-canonical CLAUDE_CONFIG_DIR refuses instead of falling back to home", (t) => {
  const f = fixture(t);
  const relative = `relative-config-${basename(f.root)}`;
  const d: DetectEnv = { ...f.d, env: { CLAUDE_CONFIG_DIR: relative } };
  const [target] = mcpTargets("claude-code", d, []);
  assert.ok(target);
  assert.equal(target.path, join(relative, ".claude.json"));

  for (const report of [
    inspectMcp(target, f.reg, []),
    applyMcp(target, f.reg, []).report,
    removeMcp(target, f.reg, []),
  ]) {
    assert.equal(report.state, "refused");
    assert.equal(report.detail, "not-canonical");
  }
  assert.equal(existsSync(join(process.cwd(), relative)), false);
  assert.equal(existsSync(join(f.home, ".claude.json")), false);
});

test("auto mcp: a target path that is a directory is an error and nothing is written", (t) => {
  const f = fixture(t);
  const gemini = targetOf(f, "gemini-cli");
  mkdirSync(gemini.path, { recursive: true });

  assert.equal(inspectMcp(gemini, f.reg, []).state, "error");
  assert.equal(applyMcp(gemini, f.reg, []).report.state, "error");
  assert.equal(removeMcp(gemini, f.reg, []).state, "error");
  assert.deepEqual(readdirSync(dirname(gemini.path)), ["settings.json"]);
});

test("auto mcp: removal deletes only the owned entry and keeps the file", (t) => {
  const f = fixture(t);
  const gemini = targetOf(f, "gemini-cli");
  writeJson(gemini.path, {
    mcpServers: { rocky: toGeminiEntry(f.reg), other: { command: "x", args: [] } },
  });

  assert.equal(removeMcp(gemini, f.reg, []).state, "written");
  assert.deepEqual(readJson(gemini.path), { mcpServers: { other: { command: "x", args: [] } } });

  writeJson(gemini.path, { mcpServers: { rocky: toGeminiEntry(f.reg) } });
  assert.equal(removeMcp(gemini, f.reg, []).state, "written");
  assert.deepEqual(readJson(gemini.path), { mcpServers: {} });
  assert.equal(existsSync(gemini.path), true);
});

test("auto mcp: opencode entries are owned only by the shared rule or history", (t) => {
  const f = fixture(t);
  const opencode = targetOf(f, "opencode");
  const old: McpRegistration = {
    ...f.reg,
    command: "/old/node",
    args: [join(f.root, "old", "index.js"), "mcp"],
  };
  writeJson(opencode.path, { mcp: { rocky: toOpencodeEntry(old) } });

  assert.equal(applyMcp(opencode, f.reg, []).report.state, "foreign");
  assert.deepEqual(readJson(opencode.path).mcp, { rocky: toOpencodeEntry(old) });

  const out = applyMcp(opencode, f.reg, [registrationKey(old)]);
  assert.equal(out.report.state, "written");
  assert.deepEqual(container(readJson(opencode.path), "mcp"), { rocky: toOpencodeEntry(f.reg) });
  assert.equal(inspectMcp(opencode, f.reg, []).state, "ok");

  assert.equal(removeMcp(opencode, f.reg, []).state, "written");
  assert.deepEqual(readJson(opencode.path), { mcp: {} });
});

test("auto mcp: claude-code targets deduplicate a location equal to CLAUDE_CONFIG_DIR", (t) => {
  const f = fixture(t);
  const profile = join(f.root, "profile");
  mkdirSync(profile);
  writeJson(join(profile, "claude.json"), { mcpServers: {} });
  const d: DetectEnv = { ...f.d, env: { CLAUDE_CONFIG_DIR: profile } };

  const targets = mcpTargets("claude-code", d, [profile, profile]);
  assert.deepEqual(
    targets.map((target) => [target.path, target.legacy === true]),
    [[join(profile, ".claude.json"), false], [join(profile, "claude.json"), true]],
  );
});

test("auto mcp: snippets carry the command and first argument", (t) => {
  const f = fixture(t);
  assert.deepEqual(mcpSnippets(targetOf(f, "gemini-cli"), f.reg), [
    JSON.stringify(f.reg.command),
    JSON.stringify(f.reg.args[0]),
  ]);
  assert.deepEqual(mcpSnippets(targetOf(f, "codex"), f.reg), [
    `command = ${JSON.stringify(f.reg.command)}`,
  ]);
});
