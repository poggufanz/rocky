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
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { McpRegistration } from "../setup/clients.js";
import { claudeCodeMcpConfigPath, toClaudeEntry } from "../setup/harness-claude-code.js";
import { codexRockyBlock } from "../setup/harness-codex.js";
import { toCopilotEntry } from "../setup/harness-copilot-cli.js";
import { toGeminiEntry } from "../setup/harness-gemini-cli.js";
import { stripJsonComments } from "../setup/json-config.js";
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

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function fixture(t: TestContext): Fixture {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "rocky-auto-mcp-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(home);
  return {
    root,
    home,
    d: { home, env: {}, platform: process.platform, fileExists: existsSync, isFile },
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

test("auto mcp: a stale codex block keeps its raw exposure", (t) => {
  const f = fixture(t);
  const codex = targetOf(f, "codex");
  mkdirSync(dirname(codex.path));
  const stale: McpRegistration = {
    ...f.reg,
    command: "/old/node",
    args: [join(f.root, "old", "index.js"), "mcp"],
    env: { ...f.reg.env, ROCKY_MCP_EXPOSURE: "raw" },
  };
  const staleBlock = codexRockyBlock(stale).join("\n");
  writeFileSync(codex.path, `${staleBlock}\n`);
  const effective: McpRegistration = { ...f.reg, env: { ...f.reg.env, ROCKY_MCP_EXPOSURE: "raw" } };

  const out = applyMcp(codex, f.reg, [staleBlock]);
  assert.equal(out.report.state, "written");
  assert.equal(out.wroteKey, codexRockyBlock(effective).join("\n"));
  const text = readFileSync(codex.path, "utf8");
  assert.match(text, /env_ROCKY_MCP_EXPOSURE = "raw"/);
  assert.ok(text.includes(`command = ${JSON.stringify(f.reg.command)}`));
  assert.equal(inspectMcp(codex, effective, []).state, "ok");
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
  const profile = join(f.home, "profile");
  mkdirSync(profile);
  writeJson(join(profile, "settings.json"), {});
  writeJson(join(profile, "claude.json"), { mcpServers: { rocky: toClaudeEntry(f.reg) }, keep: 1 });
  const d: DetectEnv = { ...f.d, env: { CLAUDE_CONFIG_DIR: profile } };
  const legacy = mcpTargets("claude-code", d, [profile]).find((target) => target.legacy === true);
  assert.ok(legacy);

  assert.equal(applyMcp(legacy, f.reg, []).report.detail, "moved to .claude.json");
  assert.deepEqual(readJson(join(profile, "claude.json")), { mcpServers: {}, keep: 1 });
  assert.equal(inspectMcp(legacy, f.reg, []).state, "ok");
});

test("auto mcp: a legacy claude.json without rocky reports ok without the moved detail", (t) => {
  const f = fixture(t);
  const profile = join(f.home, "profile");
  mkdirSync(profile);
  writeJson(join(profile, "settings.json"), {});
  writeJson(join(profile, "claude.json"), { mcpServers: {}, keep: 1 });
  const d: DetectEnv = { ...f.d, env: { CLAUDE_CONFIG_DIR: profile } };
  const legacy = mcpTargets("claude-code", d, [profile]).find((target) => target.legacy === true);
  assert.ok(legacy);

  const report = inspectMcp(legacy, f.reg, []);
  assert.equal(report.state, "ok");
  assert.equal(report.detail, undefined);
});

test("auto mcp: missing parent dir is refused for writes and ok for removal", (t) => {
  const f = fixture(t);
  const opencode = targetOf(f, "opencode");

  assert.equal(inspectMcp(opencode, f.reg, []).state, "refused");
  assert.equal(applyMcp(opencode, f.reg, []).report.state, "refused");
  assert.equal(removeMcp(opencode, f.reg, []).state, "ok");
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
  const profile = join(f.home, "profile");
  mkdirSync(profile);
  writeJson(join(profile, "settings.json"), {});
  writeJson(join(profile, "claude.json"), { mcpServers: {} });
  const d: DetectEnv = { ...f.d, env: { CLAUDE_CONFIG_DIR: profile } };

  const targets = mcpTargets("claude-code", d, [profile, profile]);
  assert.deepEqual(
    targets.map((target) => [target.path, target.legacy === true]),
    [[join(profile, ".claude.json"), false], [join(profile, "claude.json"), true]],
  );
});

test("auto mcp: the claude-code default target is the adapter's config path", (t) => {
  const f = fixture(t);
  const d: DetectEnv = { ...f.d, env: { CLAUDE_CONFIG_DIR: join(f.home, "cfg") } };
  assert.equal(mcpTargets("claude-code", d, [])[0]?.path, claudeCodeMcpConfigPath(d.env, f.home));
  assert.equal(mcpTargets("claude-code", f.d, [])[0]?.path, claudeCodeMcpConfigPath(f.d.env, f.home));
});

test("auto mcp: a recorded claude-code location gets its own .claude.json target", (t) => {
  const f = fixture(t);
  const profile = join(f.home, "profile");
  mkdirSync(profile);
  writeFileSync(join(profile, "settings.json"), "{}");

  const targets = mcpTargets("claude-code", f.d, [profile]);
  assert.deepEqual(
    targets.map((target) => target.path),
    [join(f.home, ".claude.json"), join(profile, ".claude.json")],
  );
  const target = targets[1];
  assert.ok(target);
  assert.equal(applyMcp(target, f.reg, []).report.state, "written");
  assert.deepEqual(container(readJson(join(profile, ".claude.json")), "mcpServers"), { rocky: toClaudeEntry(f.reg) });
  assert.equal(removeMcp(target, f.reg, []).state, "written");
  assert.equal(container(readJson(join(profile, ".claude.json")), "mcpServers").rocky, undefined);
});

test("auto mcp: a relative CODEX_HOME is refused and nothing is written", (t) => {
  const f = fixture(t);
  const relative = `relative-codex-${basename(f.root)}`;
  const d: DetectEnv = { ...f.d, env: { CODEX_HOME: relative } };
  const [target] = mcpTargets("codex", d, []);
  assert.ok(target);
  assert.equal(target.path, join(relative, "config.toml"));

  for (const report of [
    inspectMcp(target, f.reg, []),
    applyMcp(target, f.reg, []).report,
    removeMcp(target, f.reg, []),
  ]) {
    assert.equal(report.state, "refused");
    assert.equal(report.detail, "not-canonical");
  }
  assert.equal(existsSync(join(process.cwd(), relative)), false);
});

test("auto mcp: a symlinked env config directory is refused", (t) => {
  const f = fixture(t);
  const real = join(f.home, "codex-real");
  mkdirSync(real);
  writeFileSync(join(real, "config.toml"), "");
  const link = join(f.home, "codex-link");
  try {
    symlinkSync(real, link, "junction");
  } catch {
    t.skip("the platform cannot create a directory symlink");
    return;
  }
  const d: DetectEnv = { ...f.d, env: { CODEX_HOME: link } };
  const [target] = mcpTargets("codex", d, []);
  assert.ok(target);
  const report = applyMcp(target, f.reg, []).report;
  assert.equal(report.state, "refused");
  assert.equal(report.detail, "symlink");
  assert.equal(readFileSync(join(real, "config.toml"), "utf8"), "");
});

test("auto mcp: a symlinked default parent is refused", (t) => {
  const f = fixture(t);
  const outside = join(f.root, "outside-gemini");
  mkdirSync(outside);
  try {
    symlinkSync(outside, join(f.home, ".gemini"), "junction");
  } catch {
    t.skip("the platform cannot create a directory symlink");
    return;
  }
  const gemini = targetOf(f, "gemini-cli");
  const report = applyMcp(gemini, f.reg, []).report;
  assert.equal(report.state, "refused");
  assert.equal(report.detail, "symlink");
  assert.equal(existsSync(join(outside, "settings.json")), false);
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

test("json comments are stripped outside strings only", () => {
  const text = '// head\n{ "a": "x//y", /* note */ "b": "q\\"//r", "c": 1 // tail\n}\n';
  assert.deepEqual(JSON.parse(stripJsonComments(text)), { a: "x//y", b: "q\"//r", c: 1 });
  assert.equal(stripJsonComments('{ "a": 1 /* open'), '{ "a": 1 /* open');
});

test("auto mcp: a JSON config with comments is rewritten as plain JSON with the rocky entry", (t) => {
  const f = fixture(t);
  const copilot = targetOf(f, "copilot-cli");
  mkdirSync(dirname(copilot.path), { recursive: true });
  writeFileSync(copilot.path, '// User settings\n{\n  "theme": "dark", // kept\n  "url": "http://x//y"\n}\n');

  assert.equal(inspectMcp(copilot, f.reg, []).state, "missing");
  const out = applyMcp(copilot, f.reg, []);

  assert.equal(out.report.state, "written");
  const written = readJson(copilot.path);
  assert.equal(written.theme, "dark");
  assert.equal(written.url, "http://x//y");
  assert.deepEqual(container(written, "mcpServers"), { rocky: toCopilotEntry(f.reg) });
});
