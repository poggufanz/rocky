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
  statSync,
  symlinkSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROCKY_HOOK_PROTOCOL_VERSION } from "../commands/hook.js";
import { addHookBlockBytes, removeHookBlockBytes } from "../core/hook-block.js";
import { hasOwnedAgentHooks, installClaudeAgentHooks, rockyHookCommand } from "../setup/agent-hooks.js";
import { deskHookBinFor, runAutoCommand, runAutoSetup } from "../setup/auto/command.js";
import type { AutoContext } from "../setup/auto/engine.js";
import { mcpTargets } from "../setup/auto/mcp.js";
import type { ShellHookPort } from "../setup/auto/shell.js";
import { consentFile, hookBinPath, readConsentRecord, readExpected, writeConsentRecord } from "../setup/auto/state.js";
import { claudeCodeMcpConfigPath } from "../setup/harness-claude-code.js";
import { isRepoCaptureAllowed, normalizeRepoRoot, readRepoDecision } from "../listening/repo-consent-read.js";
import { consentsPath } from "../listening/store-paths.js";

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

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
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
      detect: { home, env: {}, platform: process.platform, fileExists: existsSync, isFile },
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

/** A worktree whose `.git` file names a gitdir under a fake main repo. */
function fakeWorktree(f: Fixture): { main: string; worktree: string } {
  const main = join(f.root, "main");
  const worktree = join(f.root, "worktree");
  mkdirSync(main);
  mkdirSync(join(main, ".git"));
  mkdirSync(worktree);
  writeFileSync(join(worktree, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt")}\n`);
  return { main, worktree };
}

function seedConsents(f: Fixture, values: Record<string, boolean>): void {
  mkdirSync(join(f.rh, "listening"), { recursive: true });
  writeFileSync(consentsPath(f.rh), JSON.stringify(values));
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

test("auto command: remove records consent before it removes anything", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.home, ".claude"));
  const approved = await run(f, ["consent", "approve", "--json"]);
  assert.equal(approved.json.consent, "approved");
  assert.equal(hasOwnedAgentHooks(JSON.parse(readFileSync(claudeSettings(f), "utf8"))), true);

  // Observe the stored consent state at the first read of the home directory,
  // which happens before any settings file is touched, and again when the
  // shell hook is removed, which is the last removal step.
  const seen: string[] = [];
  const observe = (): void => {
    const read = readConsentRecord(f.rh);
    seen.push(read.status === "valid" ? read.record.state : read.status);
  };
  const { home } = f.ctx.detect;
  f.ctx.detect = {
    ...f.ctx.detect,
    get home(): string {
      observe();
      return home;
    },
  };
  const uninstall = f.ctx.shell.uninstall;
  f.ctx.shell = {
    ...f.ctx.shell,
    uninstall: () => {
      observe();
      return uninstall();
    },
  };

  const res = await run(f, ["remove", "--json"]);
  assert.equal(res.code, 0);
  assert.ok(seen.length >= 2, "both observation points ran");
  assert.deepEqual([...new Set(seen)], ["removed"], "no removal step ran while consent was still approved");
  assert.equal(hasOwnedAgentHooks(JSON.parse(readFileSync(claudeSettings(f), "utf8"))), false);
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

test("auto command: repo status honors a worktree's own grant and revoke clears it", async (t) => {
  const f = fixture(t);
  const { main, worktree } = fakeWorktree(f);
  seedConsents(f, { [normalizeRepoRoot(worktree)]: true });
  const status = await run(f, ["repo", "status", worktree, "--json"]);
  assert.equal(status.code, 0);
  assert.equal(status.json.repo?.decision, "allowed");
  assert.equal(status.json.repo?.key, normalizeRepoRoot(main));
  assert.equal(isRepoCaptureAllowed(worktree, f.rh), true);

  const revoked = await run(f, ["repo", "revoke", worktree, "--json"]);
  assert.equal(revoked.code, 0);
  assert.notEqual(revoked.json.repo?.decision, "allowed");
  assert.equal(isRepoCaptureAllowed(worktree, f.rh), false);
});

test("auto command: repo decline at a worktree stores false on the main key", async (t) => {
  const f = fixture(t);
  const { main, worktree } = fakeWorktree(f);
  seedConsents(f, { [normalizeRepoRoot(worktree)]: true });
  const declined = await run(f, ["repo", "decline", worktree, "--json"]);
  assert.equal(declined.code, 0);
  assert.equal(declined.json.repo?.decision, "declined");
  assert.equal(readRepoDecision(main, f.rh).decision, "declined");
  assert.equal(isRepoCaptureAllowed(worktree, f.rh), false);
});

test("auto command: config-dir claude-code registers the profile MCP config", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.home, ".claude"));
  const profile = join(f.home, "profile");
  mkdirSync(profile);
  writeFileSync(join(profile, "settings.json"), "{}");
  await run(f, ["consent", "approve", "--json"]);
  const recorded = await run(f, ["config-dir", "claude-code", profile, "--json"]);
  assert.equal(recorded.code, 0);
  assert.deepEqual(recorded.json.notes, []);

  const mcpPath = join(profile, ".claude.json");
  const mcpValue = JSON.parse(readFileSync(mcpPath, "utf8")) as { mcpServers?: Record<string, unknown> };
  assert.ok(mcpValue.mcpServers?.rocky);
  const plan = await run(f, ["plan", "--json"]);
  assert.ok((plan.json.targets ?? []).some((target) => target.path === mcpPath && target.kind === "mcp"));

  const [defaultTarget] = mcpTargets("claude-code", f.ctx.detect, []);
  assert.equal(defaultTarget?.path, claudeCodeMcpConfigPath(f.ctx.detect.env, f.home));

  const removed = await run(f, ["remove", "--json"]);
  assert.equal(removed.code, 0);
  const after = JSON.parse(readFileSync(mcpPath, "utf8")) as { mcpServers?: Record<string, unknown> };
  assert.equal(after.mcpServers?.rocky, undefined);
});

test("auto command: config-dir for an undetected harness adds a note", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.home, ".claude"));
  await run(f, ["consent", "approve", "--json"]);
  const codexHome = join(f.home, "codex-home");
  mkdirSync(codexHome);
  writeFileSync(join(codexHome, "config.toml"), "");
  const res = await run(f, ["config-dir", "codex", codexHome, "--json"]);
  assert.equal(res.code, 0);
  assert.ok((res.json.notes ?? []).includes("harness not detected: codex"), JSON.stringify(res.json.notes));
});

test("auto command: a recorded location replaced by a symlink is refused on apply", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.home, ".claude"));
  const profile = join(f.home, "profile");
  mkdirSync(profile);
  writeFileSync(join(profile, "settings.json"), "{}");
  await run(f, ["consent", "approve", "--json"]);
  await run(f, ["config-dir", "claude-code", profile, "--json"]);

  const outside = join(f.root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "settings.json"), "{}");
  rmSync(profile, { recursive: true, force: true });
  try {
    symlinkSync(outside, profile, "junction");
  } catch {
    t.skip("the platform cannot create a directory symlink");
    return;
  }

  const res = await run(f, ["apply", "--json"]);
  const recorded = (res.json.targets ?? []).filter((target) => target.path.startsWith(profile));
  assert.ok(recorded.length >= 2, JSON.stringify(recorded));
  assert.ok(recorded.every((target) => target.state === "refused"), JSON.stringify(recorded));
  assert.equal(readFileSync(join(outside, "settings.json"), "utf8"), "{}");
  assert.equal(existsSync(join(outside, ".claude.json")), false);
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

test("auto command: an unusable default Claude settings path is reported as refused", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.home, ".claude"));
  f.ctx.detect = { ...f.ctx.detect, env: { CLAUDE_CONFIG_DIR: "" } };
  const res = await run(f, ["plan", "--json"]);
  assert.equal(res.code, 0);
  const hooks = (res.json.targets ?? []).filter(
    (target) => target.harness === "claude-code" && target.kind === "agent-hooks",
  );
  assert.ok(hooks.length >= 1, JSON.stringify(res.json.targets));
  assert.ok(hooks.every((target) => target.state === "refused" && target.detail === "empty"));
});

test("auto command: remove reports ok for absent targets instead of refusals", async (t) => {
  const f = fixture(t);
  const res = await run(f, ["remove", "--json"]);
  assert.equal(res.code, 0);
  const mcp = (res.json.targets ?? []).filter((target) => target.kind === "mcp");
  // Targets whose config folder does not exist are left out, so only the
  // ones under existing folders report, and each of those reports ok.
  assert.ok(mcp.length >= 1, JSON.stringify(mcp));
  assert.ok(mcp.every((target) => target.state === "ok"), JSON.stringify(mcp));
  const settings = (res.json.targets ?? []).filter(
    (target) => target.harness === "claude-code" && target.kind !== "mcp",
  );
  assert.deepEqual(settings.map((target) => target.state), ["ok", "ok"]);
  assert.equal(existsSync(join(f.home, ".claude")), false);
  assert.equal(existsSync(join(f.home, ".codex")), false);
});

test("auto setup: a context-build failure still emits one result object", async () => {
  const chunks: string[] = [];
  const code = await runAutoSetup(
    ["apply", "--json"],
    () => {
      throw new Error("boom");
    },
    (value) => chunks.push(value),
  );
  assert.equal(code, 1);
  assert.equal(chunks.length, 1);
  const json = JSON.parse(chunks[0] ?? "") as AutoJson;
  assert.equal(json.v, 1);
  assert.equal(json.action, "apply");
  assert.equal(json.consent, "none");
  assert.deepEqual(json.targets, []);
  assert.deepEqual(json.notes, ["internal error: boom"]);
});

test("auto command: the desk hook binary is used only when it is a regular file", (t) => {
  const f = fixture(t);
  const bin = hookBinPath(f.rh, process.platform);
  mkdirSync(bin, { recursive: true });
  assert.equal(deskHookBinFor(f.rh, process.platform), undefined);
  rmSync(bin, { recursive: true, force: true });
  writeFileSync(bin, "");
  assert.equal(deskHookBinFor(f.rh, process.platform), bin);
  const real = join(f.rh, "bin", "rocky-hook-real");
  writeFileSync(real, "");
  try {
    symlinkSync(real, bin);
  } catch {
    t.skip("the platform cannot create a file symlink");
    return;
  }
  assert.equal(deskHookBinFor(f.rh, process.platform), undefined);
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

test("auto command: remove prunes retained copies beside PowerShell profiles", async (t) => {
  const f = fixture(t);
  const profile = join(f.home, "profile.ps1");
  writeFileSync(profile, "# profile\n");
  f.ctx.shell.powerShellProfiles = () => [profile];
  const retained = join(f.home, `.${basename(profile)}.transaction-1234-abcd`);
  mkdirSync(retained);
  writeFileSync(
    join(retained, "manifest.json"),
    JSON.stringify({ version: 1, state: "committed", target: profile }),
  );
  const res = await run(f, ["remove", "--json"]);
  assert.equal(res.code, 0);
  assert.equal(existsSync(retained), false);
  assert.equal(existsSync(profile), true);
});

test("auto command: an internal write failure still prints one result object", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.rh, "setup"), "not a directory");
  const res = await run(f, ["consent", "approve", "--json"]);
  assert.equal(res.code, 1);
  assert.equal(res.json.v, 1);
  assert.equal(res.json.action, "consent approve");
  assert.ok((res.json.notes ?? []).some((note) => note.startsWith("internal error:")));
  assert.deepEqual(res.json.targets, []);
});

test("auto command: an unsafe desk hook path stays refused and still prints one result", async (t) => {
  if (process.platform !== "win32") {
    t.skip("the desk hook fixture uses a Windows binary name");
    return;
  }
  const f = fixture(t);
  mkdirSync(join(f.home, ".claude"));
  f.ctx.paths = { ...f.ctx.paths, deskHookBin: join(f.root, "100%", "rocky-hook.exe") };
  const res = await run(f, ["consent", "approve", "--json"]);
  assert.equal(res.code, 0);
  assert.ok((res.json.targets ?? []).some((target) => target.kind === "desk-hooks" && target.state === "refused"));
  assert.ok(!readFileSync(claudeSettings(f), "utf8").includes("desk-hook"));
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

test("auto command: every result carries harness_off and shell_hook", async (t) => {
  const f = fixture(t);
  const bare = await run(f, ["status", "--json"]) as RunResult & { json: AutoJson & { harness_off?: string[]; shell_hook?: boolean } };
  assert.deepEqual(bare.json.harness_off, []);
  assert.equal(bare.json.shell_hook, true);

  writeConsentRecord(f.rh, {
    v: 1,
    scope: 1,
    state: "approved",
    at: 1,
    harness_off: ["codex"],
    shell_hook: false,
    config_dirs: {},
  });
  const set = await run(f, ["status", "--json"]) as RunResult & { json: AutoJson & { harness_off?: string[]; shell_hook?: boolean } };
  assert.deepEqual(set.json.harness_off, ["codex"]);
  assert.equal(set.json.shell_hook, false);
});

test("auto command: shell off removes only the shell block in any consent state", async (t) => {
  for (const state of [undefined, "later", "approved", "removed"] as const) {
    const f = fixture(t);
    mkdirSync(join(f.home, ".claude"));
    const bashrc = join(f.home, ".bashrc");
    writeFileSync(bashrc, addHookBlockBytes(Buffer.from("export KEEP=1\n")));
    writeFileSync(claudeSettings(f), "{\"keep\":true}\n");
    const mcp = claudeCodeMcpConfigPath(f.ctx.detect.env, f.home);
    writeFileSync(mcp, "{\"mcpServers\":{}}\n");
    if (state !== undefined) {
      writeConsentRecord(f.rh, { v: 1, scope: 1, state, at: 1, harness_off: [], shell_hook: true, config_dirs: {} });
    }
    const settingsBefore = readFileSync(claudeSettings(f));
    const mcpBefore = readFileSync(mcp);

    const res = await run(f, ["shell", "off", "--json"]);
    assert.equal(res.code, 0);
    const text = readFileSync(bashrc, "utf8");
    assert.ok(text.includes("export KEEP=1"), String(state));
    assert.ok(!text.includes("ROCKY"), String(state));
    assert.deepEqual(readFileSync(claudeSettings(f)), settingsBefore);
    assert.deepEqual(readFileSync(mcp), mcpBefore);
    assert.equal((res.json as { shell_hook?: boolean }).shell_hook, state === undefined ? true : false);
    assert.ok((res.json.targets ?? []).every((target) => target.kind === "shell-hook" || target.kind === "shell"));
  }
});

test("auto command: shell on writes nothing without approved consent", async (t) => {
  for (const state of [undefined, "later", "removed"] as const) {
    const f = fixture(t);
    if (state !== undefined) {
      writeConsentRecord(f.rh, { v: 1, scope: 1, state, at: 1, harness_off: [], shell_hook: false, config_dirs: {} });
    }
    const beforeHome = snapshotTree(f.home);
    const beforeRocky = snapshotTree(f.rh);
    const res = await run(f, ["shell", "on", "--json"]);
    assert.equal(res.code, 0);
    assert.ok(states(res.json).every((value) => value === "not_consented"), JSON.stringify(res.json.targets));
    assert.deepEqual(snapshotTree(f.home), beforeHome);
    assert.deepEqual(snapshotTree(f.rh), beforeRocky);
  }
});

test("auto command: shell on under approved consent installs only the shell block", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.home, ".claude"));
  writeConsentRecord(f.rh, { v: 1, scope: 1, state: "approved", at: 1, harness_off: [], shell_hook: false, config_dirs: {} });
  const res = await run(f, ["shell", "on", "--json"]);
  assert.equal(res.code, 0);
  assert.ok(readFileSync(join(f.home, ".bashrc"), "utf8").includes("ROCKY"));
  assert.equal(existsSync(claudeSettings(f)), false);
  const record = readConsentRecord(f.rh);
  assert.ok(record.status === "valid");
  assert.equal(record.record.shell_hook, true);
  assert.equal((res.json as { shell_hook?: boolean }).shell_hook, true);
});

test("auto command: remove deletes change cards and spool files", async (t) => {
  const f = fixture(t);
  const cardsDir = join(f.rh, "desk", "cards");
  const spoolDir = join(f.rh, "desk", "spool");
  const badDir = join(spoolDir, "bad");
  mkdirSync(join(cardsDir, "nested"), { recursive: true });
  mkdirSync(badDir, { recursive: true });
  writeFileSync(join(cardsDir, "repo-one.jsonl"), "{\"v\":1}\n");
  writeFileSync(join(cardsDir, "nested", "extra.jsonl"), "{\"v\":1}\n");
  writeFileSync(join(spoolDir, "1700000000000-1.json"), "{}\n");
  writeFileSync(join(spoolDir, "1700000000001-2.json"), "{}\n");
  writeFileSync(join(badDir, "corrupt.json"), "not json");

  const res = await run(f, ["remove", "--json"]);

  assert.equal(res.code, 0);
  assert.equal(res.json.consent, "removed");
  assert.deepEqual(res.json.notes, []);
  assert.equal(existsSync(cardsDir), false);
  assert.equal(existsSync(join(spoolDir, "1700000000000-1.json")), false);
  assert.equal(existsSync(join(spoolDir, "1700000000001-2.json")), false);
  assert.equal(existsSync(badDir), false);
});

test("auto command: remove keeps settings, history and markers", async (t) => {
  const f = fixture(t);
  const deskDir = join(f.rh, "desk");
  const cardsDir = join(deskDir, "cards");
  const spoolDir = join(deskDir, "spool");
  const badDir = join(spoolDir, "bad");
  const historyDir = join(deskDir, "history");
  const listeningDir = join(f.rh, "listening");
  mkdirSync(cardsDir, { recursive: true });
  mkdirSync(badDir, { recursive: true });
  mkdirSync(historyDir, { recursive: true });
  mkdirSync(listeningDir, { recursive: true });

  writeFileSync(join(cardsDir, "repo.jsonl"), "{\"v\":1}\n");
  writeFileSync(join(spoolDir, "1700000000000-1.json"), "{}\n");
  writeFileSync(join(badDir, "bad.json"), "bad\n");

  const keepFiles: Array<[string, string]> = [
    [join(deskDir, "settings.json"), "{\"cards\":true}\n"],
    [join(deskDir, "rockyd.log"), "started\n"],
    [join(deskDir, "notified.json"), "[]\n"],
    [join(historyDir, "2026-11-14.jsonl"), "{\"v\":1}\n"],
    [join(deskDir, "cards-off"), ""],
    [join(deskDir, "tool-text-off"), ""],
    [join(spoolDir, "1700000000000-1.json.tmp"), "partial"],
    [join(f.rh, "memory.jsonl"), "{\"kind\":\"note\"}\n"],
    [join(listeningDir, "repo-consents.json"), "{}\n"],
  ];
  for (const [path, body] of keepFiles) writeFileSync(path, body);

  const res = await run(f, ["remove", "--json"]);

  assert.equal(res.code, 0);
  assert.deepEqual(res.json.notes, []);
  assert.equal(existsSync(cardsDir), false);
  assert.equal(existsSync(join(spoolDir, "1700000000000-1.json")), false);
  assert.equal(existsSync(badDir), false);
  for (const [path, body] of keepFiles) {
    assert.equal(existsSync(path), true, `${path} must remain`);
    assert.equal(readFileSync(path, "utf8"), body);
  }
});

test("auto command: remove reports card data it could not delete", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.home, ".claude"));
  const approved = await run(f, ["consent", "approve", "--json"]);
  assert.equal(approved.code, 0);
  assert.equal(hasOwnedAgentHooks(JSON.parse(readFileSync(claudeSettings(f), "utf8"))), true);

  const cardsDir = join(f.rh, "desk", "cards");
  const spoolDir = join(f.rh, "desk", "spool");
  const badDir = join(spoolDir, "bad");
  const dirEntry = join(spoolDir, "blocked.json");
  mkdirSync(cardsDir, { recursive: true });
  mkdirSync(badDir, { recursive: true });
  mkdirSync(dirEntry, { recursive: true });
  writeFileSync(join(cardsDir, "repo.jsonl"), "{\"v\":1}\n");
  writeFileSync(join(spoolDir, "1700000000000-1.json"), "{}\n");
  writeFileSync(join(badDir, "bad.json"), "bad\n");
  writeFileSync(join(dirEntry, "keep.txt"), "non-empty");

  const res = await run(f, ["remove", "--json"]);

  assert.equal(res.code, 0);
  assert.equal(res.json.consent, "removed");
  assert.equal(hasOwnedAgentHooks(JSON.parse(readFileSync(claudeSettings(f), "utf8"))), false);
  assert.equal(existsSync(cardsDir), false);
  assert.equal(existsSync(join(spoolDir, "1700000000000-1.json")), false);
  assert.equal(existsSync(badDir), false);
  assert.equal(existsSync(dirEntry), true);
  assert.ok(
    (res.json.notes ?? []).some((note) => note.includes("1") && /card data/i.test(note)),
    JSON.stringify(res.json.notes),
  );
});
