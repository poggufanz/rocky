import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROCKY_HOOK_PROTOCOL_VERSION } from "../commands/hook.js";
import { addHookBlockBytes, removeHookBlockBytes } from "../core/hook-block.js";
import { hasOwnedAgentHooks, installClaudeAgentHooks, rockyHookCommand } from "../setup/agent-hooks.js";
import { runAutoCommand } from "../setup/auto/command.js";
import type { AutoContext } from "../setup/auto/engine.js";
import type { ShellHookPort } from "../setup/auto/shell.js";
import { consentFile, readConsentRecord, readExpected, writeConsentRecord } from "../setup/auto/state.js";
import { readRepoDecision } from "../listening/repo-consent-read.js";

interface Fixture {
  root: string;
  home: string;
  rh: string;
  ctx: AutoContext;
}

interface TargetJson {
  harness: string;
  kind: string;
  path: string;
  state: string;
  detail?: string;
}

interface AutoJson {
  v: number;
  action?: string;
  consent?: string;
  targets?: TargetJson[];
  notes?: string[];
  repo?: { key: string; main: string; decision: string };
  error?: string;
}

interface RunResult {
  code: number;
  json: AutoJson;
}

function fakeShellPort(home: string, rockyHome: string): ShellHookPort {
  const bashrc = join(home, ".bashrc");
  const script = (): void => {
    writeFileSync(
      join(rockyHome, "rocky-hook.bash"),
      `# fixture\nROCKY_HOOK_VERSION="${ROCKY_HOOK_PROTOCOL_VERSION}"\n`,
    );
    if (process.platform === "win32") {
      writeFileSync(
        join(rockyHome, "rocky-hook.ps1"),
        `# fixture\nROCKY_HOOK_VERSION="${ROCKY_HOOK_PROTOCOL_VERSION}"\n`,
      );
    }
  };
  return {
    install: () => {
      const current = existsSync(bashrc) ? readFileSync(bashrc) : Buffer.from("");
      writeFileSync(bashrc, addHookBlockBytes(current));
      script();
      return 0;
    },
    uninstall: () => {
      if (existsSync(bashrc)) writeFileSync(bashrc, removeHookBlockBytes(readFileSync(bashrc)));
      return 0;
    },
    bashrcPath: () => bashrc,
    powerShellProfiles: () => [],
    rockyHome: () => rockyHome,
  };
}

function fixture(t: test.TestContext): Fixture {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "rocky-auto-command-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const rh = join(root, "rocky-home");
  mkdirSync(home);
  mkdirSync(rh);
  return {
    root,
    home,
    rh,
    ctx: {
      rockyHome: rh,
      detect: { home, env: {}, platform: process.platform, fileExists: existsSync },
      paths: { nodePath: process.execPath, entryPath: join(root, "entry.js") },
      registration: {
        name: "rocky",
        command: process.execPath,
        args: [join(root, "entry.js"), "mcp"],
        env: { ROCKY_HOME: rh, ROCKY_MCP_EXPOSURE: "sanitized" },
      },
      shell: fakeShellPort(home, rh),
      now: () => 1_700_000_000_000,
    },
  };
}

function snapshotTree(dir: string): Record<string, string> {
  const lines: Record<string, string> = {};
  const walk = (current: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        lines[full.slice(dir.length + 1)] = createHash("sha256").update(readFileSync(full)).digest("hex");
      }
    }
  };
  walk(dir);
  return lines;
}

async function run(f: Fixture, argv: string[]): Promise<RunResult> {
  const chunks: string[] = [];
  const code = await runAutoCommand(argv, f.ctx, (value) => chunks.push(value));
  assert.equal(chunks.length, 1, "the command emits exactly one JSON document");
  return { code, json: JSON.parse(chunks[0] ?? "") as AutoJson };
}

function states(value: AutoJson): string[] {
  return (value.targets ?? []).map((target) => target.state);
}

function claudeSettings(f: Fixture): string {
  return join(f.home, ".claude", "settings.json");
}

test("auto command: apply without consent writes nothing", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.home, ".claude"));
  const beforeHome = snapshotTree(f.home);
  const beforeRocky = snapshotTree(f.rh);
  const res = await run(f, ["apply", "--json"]);
  assert.equal(res.code, 0);
  assert.equal(res.json.consent, "none");
  assert.ok((res.json.targets ?? []).length > 0);
  assert.ok(states(res.json).every((state) => state === "not_consented"));
  assert.deepEqual(snapshotTree(f.home), beforeHome);
  assert.deepEqual(snapshotTree(f.rh), beforeRocky);
  assert.equal(existsSync(consentFile(f.rh)), false);
});

test("auto command: corrupt consent record blocks apply and is left untouched", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.home, ".claude"));
  mkdirSync(join(f.rh, "setup"), { recursive: true });
  writeFileSync(consentFile(f.rh), "{nope");
  const beforeHome = snapshotTree(f.home);
  const res = await run(f, ["apply", "--json"]);
  assert.equal(res.code, 0);
  assert.equal(res.json.consent, "invalid");
  assert.ok(states(res.json).every((state) => state === "not_consented"));
  assert.equal(readFileSync(consentFile(f.rh), "utf8"), "{nope");
  assert.deepEqual(snapshotTree(f.home), beforeHome);
});

test("auto command: consent approve applies and a second apply writes nothing", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.home, ".claude"));
  const approved = await run(f, ["consent", "approve", "--json"]);
  assert.equal(approved.code, 0);
  assert.equal(approved.json.consent, "approved");
  assert.ok(states(approved.json).every((state) => state === "ok" || state === "written"));
  const before = snapshotTree(f.home);
  const res = await run(f, ["apply", "--json"]);
  assert.equal(res.json.consent, "approved");
  assert.ok((res.json.targets ?? []).length > 0);
  assert.ok(states(res.json).every((state) => state === "ok"));
  assert.deepEqual(snapshotTree(f.home), before);
});

test("auto command: expected.json lists only bytes present in each file", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.home, ".claude"));
  await run(f, ["consent", "approve", "--json"]);
  const expected = readExpected(f.rh);
  assert.ok(expected.files.length > 0);
  for (const file of expected.files) {
    const bytes = readFileSync(file.path, "utf8");
    for (const snippet of file.snippets) assert.ok(bytes.includes(snippet), `${file.path} misses a snippet`);
  }
  const claudeJson = join(f.home, ".claude.json");
  assert.equal(expected.history[claudeJson]?.length, 1);
});

test("auto command: harness off removes only that harness", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.home, ".claude"));
  mkdirSync(join(f.home, ".gemini"));
  await run(f, ["consent", "approve", "--json"]);
  const gemini = join(f.home, ".gemini", "settings.json");
  assert.ok(readFileSync(gemini, "utf8").includes("rocky"));
  const res = await run(f, ["harness", "gemini-cli", "off", "--json"]);
  assert.equal(res.code, 0);
  assert.equal(res.json.consent, "approved");
  assert.ok((res.json.targets ?? []).length > 0);
  const geminiValue = JSON.parse(readFileSync(gemini, "utf8")) as {
    mcpServers?: Record<string, unknown>;
  };
  assert.equal(geminiValue.mcpServers?.rocky, undefined);
  assert.ok(readFileSync(claudeSettings(f), "utf8").includes("hook agent-event"));
  assert.ok(readFileSync(join(f.home, ".claude.json"), "utf8").includes("rocky"));
  const record = readConsentRecord(f.rh);
  assert.ok(record.status === "valid");
  assert.deepEqual(record.record.harness_off, ["gemini-cli"]);
  assert.ok(!readExpected(f.rh).files.some((file) => file.path === gemini));
});

test("auto command: config-dir outside home is refused with a note", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.home, ".claude"));
  await run(f, ["consent", "approve", "--json"]);
  const outside = join(f.root, "outside", "settings.json");
  mkdirSync(dirname(outside), { recursive: true });
  writeFileSync(outside, "{}");
  const res = await run(f, ["config-dir", "gemini-cli", outside, "--json"]);
  assert.equal(res.code, 0);
  assert.ok((res.json.notes ?? []).includes("outside-home"));
  assert.equal(readFileSync(outside, "utf8"), "{}");
  const record = readConsentRecord(f.rh);
  assert.ok(record.status === "valid");
  assert.deepEqual(record.record.config_dirs, {});
});

test("auto command: remove from 'later' still clears CLI-installed entries and prunes retained copies", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.home, ".claude"));
  const installed = await installClaudeAgentHooks(
    { settingsPath: claudeSettings(f) },
    {
      command: rockyHookCommand("claude-code", f.ctx.paths.nodePath, f.ctx.paths.entryPath),
      confirmation: { confirm: async () => true },
      detail: () => {},
    },
  );
  assert.equal(installed.status, "written");
  await run(f, ["consent", "later", "--json"]);
  const res = await run(f, ["remove", "--json"]);
  assert.equal(res.code, 0);
  assert.equal(res.json.consent, "removed");
  assert.equal(hasOwnedAgentHooks(JSON.parse(readFileSync(claudeSettings(f), "utf8"))), false);
  const retained = readdirSync(join(f.home, ".claude"))
    .filter((name) => name.includes(".settings.json.transaction-"));
  assert.deepEqual(retained, []);
  const record = readConsentRecord(f.rh);
  assert.ok(record.status === "valid");
  assert.equal(record.record.state, "removed");
});

test("auto command: remove keeps values semantically equal to the pre-install file", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.home, ".claude"));
  const prior = {
    theme: "x",
    hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] },
  };
  writeFileSync(claudeSettings(f), JSON.stringify(prior));
  await run(f, ["consent", "approve", "--json"]);
  await run(f, ["remove", "--json"]);
  assert.deepEqual(JSON.parse(readFileSync(claudeSettings(f), "utf8")), prior);
});

test("auto command: repo decline on a worktree stores false on the main repo", async (t) => {
  const f = fixture(t);
  const main = join(f.root, "main");
  const worktree = join(f.root, "worktree");
  mkdirSync(main);
  mkdirSync(join(main, ".git"));
  mkdirSync(worktree);
  writeFileSync(join(worktree, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt")}\n`);
  const res = await run(f, ["repo", "decline", worktree, "--json"]);
  assert.equal(res.code, 0);
  assert.equal(res.json.repo?.decision, "declined");
  const mainDecision = readRepoDecision(main, f.rh);
  assert.equal(mainDecision.decision, "declined");
  assert.equal(res.json.repo?.key, mainDecision.key);
  assert.equal(res.json.repo?.main, mainDecision.main);
});

test("auto command: consent approve keeps a valid record's scope fields", async (t) => {
  const f = fixture(t);
  writeConsentRecord(f.rh, {
    v: 1,
    scope: 1,
    state: "later",
    at: 1,
    harness_off: ["gemini-cli"],
    shell_hook: false,
    config_dirs: {},
  });
  const res = await run(f, ["consent", "approve", "--json"]);
  assert.equal(res.json.consent, "approved");
  const record = readConsentRecord(f.rh);
  assert.ok(record.status === "valid");
  assert.equal(record.record.state, "approved");
  assert.deepEqual(record.record.harness_off, ["gemini-cli"]);
  assert.equal(record.record.shell_hook, false);
  assert.deepEqual(record.record.config_dirs, {});
});

test("auto command: remove over an invalid record writes removed with the defaults", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.rh, "setup"), { recursive: true });
  writeFileSync(consentFile(f.rh), "{nope");
  const res = await run(f, ["remove", "--json"]);
  assert.equal(res.code, 0);
  assert.equal(res.json.consent, "removed");
  const record = readConsentRecord(f.rh);
  assert.ok(record.status === "valid");
  assert.equal(record.record.state, "removed");
  assert.deepEqual(record.record.harness_off, []);
  assert.equal(record.record.shell_hook, true);
  assert.deepEqual(record.record.config_dirs, {});
});

test("auto command: malformed argv exits 2 with a usage error object", async (t) => {
  const f = fixture(t);
  const missingJson = await run(f, ["apply"]);
  assert.equal(missingJson.code, 2);
  assert.deepEqual(missingJson.json, { v: 1, error: "usage" });
  const unknown = await run(f, ["nonsense", "--json"]);
  assert.equal(unknown.code, 2);
  assert.deepEqual(unknown.json, { v: 1, error: "usage" });
});

test("auto command: plan reports targets without writing", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.home, ".claude"));
  const before = snapshotTree(f.home);
  const res = await run(f, ["plan", "--json"]);
  assert.equal(res.code, 0);
  assert.equal(res.json.action, "plan");
  assert.equal(res.json.consent, "none");
  const kinds = (res.json.targets ?? []).map((target) => `${target.harness}/${target.kind}`);
  assert.ok(kinds.includes("claude-code/agent-hooks"));
  assert.ok(kinds.includes("claude-code/mcp"));
  assert.ok(kinds.includes("shell/shell-hook"));
  assert.deepEqual(snapshotTree(f.home), before);
  assert.equal(existsSync(consentFile(f.rh)), false);
});

test("auto command: the built CLI prints exactly one JSON object on stdout", (t) => {
  const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "index.js");
  assert.ok(existsSync(entry), `the build must produce ${entry} before this test`);
  const f = fixture(t);
  mkdirSync(join(f.home, ".claude"));
  const result = spawnSync(process.execPath, [entry, "setup", "--auto", "plan", "--json"], {
    cwd: f.root,
    encoding: "utf8",
    env: {
      ...process.env,
      ROCKY_HOME: f.rh,
      HOME: f.home,
      USERPROFILE: f.home,
      APPDATA: join(f.root, "appdata"),
      CLAUDE_CONFIG_DIR: undefined,
      PATH: join(f.root, "empty-path"),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 1, "stdout carries one JSON document and nothing else");
  const parsed = JSON.parse(lines[0] ?? "") as { v: number; action: string };
  assert.equal(parsed.v, 1);
  assert.equal(parsed.action, "plan");
});
