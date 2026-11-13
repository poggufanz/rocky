import test from "node:test";
import assert from "node:assert/strict";
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
import {
  setup,
  type ConfirmationPort,
  type LegacyVoiceSkillServices,
  type SetupDependencies,
} from "../commands/setup.js";
import { hasOwnedAgentHooks, mergeClaudeHooks, rockyHookCommand } from "../setup/agent-hooks.js";
import {
  consentApproved,
  consentFile,
  readConsentRecord,
  writeConsentRecord,
  type ConsentRecord,
  type ConsentState,
} from "../setup/auto/state.js";
import type {
  InspectionResult,
  McpRegistration,
  SetupClientAdapter,
  SetupClientId,
  SetupResult,
} from "../setup/clients.js";
import { DESK_HOOK_ASYNC, deskHookCommand, hasOwnedDeskHooks, mergeDeskHooks } from "../setup/desk-hooks.js";
import { codexRockyBlock } from "../setup/harness-codex.js";
import type { LegacyVoiceSkillResult, LegacyVoiceSkillTarget } from "../setup/legacy-voice-skill.js";
import { createPlatformServices } from "../setup/platform.js";
import type { ProcessRunner, ProcessSession } from "../setup/process.js";
import { claudeTarget, codexTarget } from "./legacy-voice-skill-fixture.js";

function record(state: ConsentState): ConsentRecord {
  return {
    v: 1,
    scope: 1,
    state,
    at: 1,
    harness_off: [],
    shell_hook: true,
    config_dirs: {},
  };
}

function seedConsent(rh: string, state: ConsentState | "invalid" | "absent"): void {
  if (state === "absent") return;
  if (state === "invalid") {
    const file = consentFile(rh);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "{", "utf8");
    assert.equal(readConsentRecord(rh).status, "invalid");
    return;
  }
  writeConsentRecord(rh, record(state));
  assert.equal(readConsentRecord(rh).status, "valid");
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

async function captureStderr(run: () => Promise<number>): Promise<{ code: number; stderr: string; stdout: string }> {
  const originalStderr = process.stderr.write;
  const originalStdout = process.stdout.write;
  let stderr = "";
  let stdout = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    return { code: await run(), stderr, stdout };
  } finally {
    process.stderr.write = originalStderr;
    process.stdout.write = originalStdout;
  }
}

class HealthySession implements ProcessSession {
  private readonly lines: string[] = [];

  async writeLine(line: string): Promise<void> {
    const message = JSON.parse(line) as { id?: string; method: string };
    if (message.method === "server/discover") {
      this.lines.push(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: { supportedVersions: ["2026-07-28"], capabilities: { tools: {} } },
      }));
    } else if (message.method === "tools/list") {
      this.lines.push(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [
            "recall", "recent_failures", "stats", "recall_with_ai",
            "search_knowledge", "fetch_record", "why_file", "teach_lookup",
            "activity_recent", "activity_for_file", "bundles_list", "bundle_get", "session_timeline",
          ].map((name) => ({ name })),
        },
      }));
    }
  }

  async readLine(): Promise<string | undefined> { return this.lines.shift(); }
  end(): void {}
  kill(): void {}
  async wait() { return { status: 0, stdout: "", stderr: "" }; }
}

class SpyAdapter implements SetupClientAdapter {
  constructor(
    readonly id: SetupClientId,
    private readonly mutationCalls: string[],
    private readonly readCalls: string[],
    private readonly registration: McpRegistration,
  ) {}

  async inspect(): Promise<InspectionResult> {
    this.readCalls.push("adapter:inspect");
    return { state: "identical" };
  }

  async configure(): Promise<SetupResult> {
    this.mutationCalls.push("adapter:configure");
    return { client: this.id, status: "configured" };
  }

  async check(): Promise<SetupResult> {
    this.readCalls.push("adapter:check");
    return { client: this.id, status: "healthy", healthRegistration: this.registration };
  }

  async remove(): Promise<SetupResult> {
    this.mutationCalls.push("adapter:remove");
    return { client: this.id, status: "removed" };
  }
}

class SpyLegacyVoiceSkillServices implements LegacyVoiceSkillServices {
  constructor(
    private readonly home: string,
    private readonly claudeDir: string,
    private readonly mutationCalls: string[],
    private readonly readCalls: string[],
  ) {}

  resolveTargets(): readonly LegacyVoiceSkillTarget[] {
    return [codexTarget(this.home), claudeTarget(this.claudeDir)];
  }

  async check(target: LegacyVoiceSkillTarget): Promise<LegacyVoiceSkillResult> {
    this.readCalls.push(`legacy:check:${target.host}`);
    return target.host === "codex"
      ? { host: target.host, status: "installed", detail: "rocky setup --remove removes it." }
      : { host: target.host, status: "absent", detail: "absent" };
  }

  async remove(target: LegacyVoiceSkillTarget): Promise<LegacyVoiceSkillResult> {
    this.mutationCalls.push(`legacy:remove:${target.host}`);
    return { host: target.host, status: "removed", detail: `backup: /backups/${target.host}` };
  }
}

interface Fixture {
  root: string;
  rh: string;
  claudeDir: string;
  settingsPath: string;
  codexConfigPath: string;
  mutationCalls: string[];
  readCalls: string[];
  deps: SetupDependencies;
}

function makeFixture(t: test.TestContext): Fixture {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "rocky-legacy-removal-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const rh = join(root, "rocky-home");
  const home = join(root, "home");
  const claudeDir = join(root, "claude-config");
  const codexHome = join(root, "codex-home");
  const toolsDir = join(root, "tools");
  mkdirSync(rh, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(claudeDir, { recursive: true, mode: 0o700 });
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(toolsDir, { recursive: true });

  const codexBin = join(toolsDir, process.platform === "win32" ? "codex.exe" : "codex");
  const hookBin = join(toolsDir, process.platform === "win32" ? "rocky-hook.exe" : "rocky-hook");
  writeFileSync(codexBin, "fixture", "utf8");
  writeFileSync(hookBin, "fixture", "utf8");

  const registration: McpRegistration = {
    name: "rocky",
    command: process.execPath,
    args: [process.execPath, "mcp"],
    env: { ROCKY_MCP_EXPOSURE: "sanitized", ROCKY_HOME: rh },
  };
  const codexConfigPath = join(codexHome, "config.toml");
  writeFileSync(codexConfigPath, `${codexRockyBlock(registration).join("\n")}\n`, "utf8");

  const settingsPath = join(claudeDir, "settings.json");
  const withAgentHooks = mergeClaudeHooks({}, rockyHookCommand("claude-code", process.execPath, process.execPath));
  const withBothHooks = mergeDeskHooks(withAgentHooks, deskHookCommand(hookBin, existsSync), DESK_HOOK_ASYNC);
  writeFileSync(settingsPath, `${JSON.stringify(withBothHooks, null, 2)}\n`, "utf8");

  const mutationCalls: string[] = [];
  const readCalls: string[] = [];
  const env: NodeJS.ProcessEnv = {
    PATH: toolsDir,
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: claudeDir,
  };
  const runner: ProcessRunner = {
    async run(_command, args) {
      readCalls.push(`runner:run:${args.join(" ")}`);
      if (args[0] === "--version") return { status: 0, stdout: "codex-cli 0.146.0\n", stderr: "" };
      return { status: 0, stdout: "rocky\n", stderr: "" };
    },
    async openSession() {
      readCalls.push("runner:openSession");
      return new HealthySession();
    },
  };
  const confirmation: ConfirmationPort = {
    async confirm() {
      mutationCalls.push("confirm");
      return true;
    },
  };

  const deps: SetupDependencies = {
    runner,
    platform: createPlatformServices({
      platform: process.platform,
      home,
      env,
      isWsl: false,
      fileExists: (path) => existsSync(path),
    }),
    adapters: [new SpyAdapter("codex", mutationCalls, readCalls, registration)],
    confirmation,
    nodePath: process.execPath,
    entryPath: process.execPath,
    rockyHome: rh,
    env,
    legacyVoiceSkills: new SpyLegacyVoiceSkillServices(home, claudeDir, mutationCalls, readCalls),
  };

  return {
    root,
    rh,
    claudeDir,
    settingsPath,
    codexConfigPath,
    mutationCalls,
    readCalls,
    deps,
  };
}

for (const argv of [
  ["--remove", "--harness", "codex", "--yes"],
  ["--uninstall-agent-hooks", "--yes"],
  ["--uninstall-desk-hooks", "--yes"],
]) {
  test(`setup ${argv[0]} refuses and writes nothing while consent is approved`, async (t) => {
    const f = makeFixture(t);
    seedConsent(f.rh, "approved");
    const beforeRh = snapshotTree(f.rh);
    const beforeRoot = snapshotTree(f.root);

    const output = await captureStderr(() => setup(argv, f.deps));

    assert.equal(output.code, 1, output.stderr);
    assert.equal(f.mutationCalls.length, 0);
    assert.equal(f.readCalls.length, 0);
    assert.deepEqual(snapshotTree(f.rh), beforeRh);
    assert.deepEqual(snapshotTree(f.root), beforeRoot);
    assert.match(output.stderr, /Rocky manages these entries from the desk app\./);
    assert.match(output.stderr, /Turn the harness off in Settings, or remove everything with Remove Rocky\./);
  });
}

for (const state of ["later", "removed", "invalid", "absent"] as const) {
  test(`setup --uninstall-agent-hooks keeps the old path when consent is ${state}`, async (t) => {
    const f = makeFixture(t);
    seedConsent(f.rh, state);
    const consentPath = consentFile(f.rh);
    const beforeConsent = existsSync(consentPath) ? readFileSync(consentPath) : undefined;
    assert.equal(hasOwnedAgentHooks(JSON.parse(readFileSync(f.settingsPath, "utf8")) as Record<string, unknown>), true);

    const output = await captureStderr(() => setup(["--uninstall-agent-hooks", "--yes"], f.deps));

    assert.equal(output.code, 0, output.stderr);
    assert.doesNotMatch(output.stderr, /Rocky manages these entries/);
    assert.match(output.stderr, /claude-code agent hooks: written/);
    const afterSettings = JSON.parse(readFileSync(f.settingsPath, "utf8")) as Record<string, unknown>;
    assert.equal(hasOwnedAgentHooks(afterSettings), false);
    assert.equal(hasOwnedDeskHooks(afterSettings), true);
    if (beforeConsent === undefined) assert.equal(existsSync(consentPath), false);
    else assert.deepEqual(readFileSync(consentPath), beforeConsent);
  });
}

test("setup --status, --check and --agent-hooks are not refused under approved consent", async (t) => {
  await t.test("--status", async (st) => {
    const f = makeFixture(st);
    seedConsent(f.rh, "approved");

    const output = await captureStderr(() => setup(["--status"], f.deps));

    assert.equal(output.code, 0, output.stderr);
    assert.doesNotMatch(output.stderr, /Rocky manages these entries/);
    assert.match(output.stderr, /claude-code agent hooks: installed/);
    assert.ok(f.readCalls.includes("legacy:check:codex"));
  });

  await t.test("--check", async (st) => {
    const f = makeFixture(st);
    seedConsent(f.rh, "approved");

    const output = await captureStderr(() => setup(["--check"], f.deps));

    assert.equal(output.code, 0, output.stderr);
    assert.doesNotMatch(output.stderr, /Rocky manages these entries/);
    assert.match(output.stderr, /codex: healthy/);
    assert.ok(f.readCalls.includes("adapter:check"));
    assert.ok(f.readCalls.includes("runner:openSession"));
  });

  await t.test("--agent-hooks", async (st) => {
    const f = makeFixture(st);
    seedConsent(f.rh, "approved");
    writeFileSync(f.settingsPath, "{}\n", "utf8");

    const output = await captureStderr(() => setup(["--agent-hooks"], f.deps));

    assert.equal(output.code, 0, output.stderr);
    assert.doesNotMatch(output.stderr, /Rocky manages these entries/);
    assert.match(output.stderr, /claude-code agent hooks: written/);
    assert.ok(f.mutationCalls.includes("confirm"));
    assert.equal(hasOwnedAgentHooks(JSON.parse(readFileSync(f.settingsPath, "utf8")) as Record<string, unknown>), true);
  });
});

test("a usage error exits 2 before consent is read", async (t) => {
  const f = makeFixture(t);
  seedConsent(f.rh, "approved");
  const beforeRoot = snapshotTree(f.root);

  const output = await captureStderr(() => setup(["--remove", "--check"], f.deps));

  assert.equal(output.code, 2, output.stderr);
  assert.doesNotMatch(output.stderr, /Rocky manages these entries/);
  assert.equal(f.mutationCalls.length, 0);
  assert.equal(f.readCalls.length, 0);
  assert.deepEqual(snapshotTree(f.root), beforeRoot);
});

test("setup refuses using resolveRockyPaths().home when deps.rockyHome is omitted", async (t) => {
  const f = makeFixture(t);
  seedConsent(f.rh, "approved");
  delete f.deps.rockyHome;
  const beforeRoot = snapshotTree(f.root);
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = f.rh;
  try {
    const output = await captureStderr(() => setup(["--uninstall-agent-hooks", "--yes"], f.deps));

    assert.equal(output.code, 1, output.stderr);
    assert.deepEqual(snapshotTree(f.root), beforeRoot);
    assert.match(output.stderr, /Rocky manages these entries from the desk app\./);
    assert.match(output.stderr, /Turn the harness off in Settings, or remove everything with Remove Rocky\./);
  } finally {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
  }
});

test("consentApproved is true only for valid approved records", (t) => {
  const f = makeFixture(t);
  assert.equal(consentApproved(f.rh), false);
  for (const state of ["later", "removed", "invalid"] as const) {
    seedConsent(f.rh, state);
    assert.equal(consentApproved(f.rh), false, state);
  }
  seedConsent(f.rh, "approved");
  assert.equal(consentApproved(f.rh), true);
});

test("when deps.rockyHome and ROCKY_HOME are unset, consent lookup stays under platform.home", async (t) => {
  const f = makeFixture(t);
  delete f.deps.rockyHome;
  const previous = process.env.ROCKY_HOME;
  delete process.env.ROCKY_HOME;
  try {
    seedConsent(join(f.deps.platform.home, ".rocky"), "approved");
    const beforeRoot = snapshotTree(f.root);
    const refused = await captureStderr(() => setup(["--uninstall-agent-hooks", "--yes"], f.deps));
    assert.equal(refused.code, 1, refused.stderr);
    assert.deepEqual(snapshotTree(f.root), beforeRoot);

    rmSync(join(f.deps.platform.home, ".rocky"), { recursive: true, force: true });
    const allowed = await captureStderr(() => setup(["--uninstall-agent-hooks", "--yes"], f.deps));
    assert.equal(allowed.code, 0, allowed.stderr);
    assert.doesNotMatch(allowed.stderr, /Rocky manages these entries/);
  } finally {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
  }
});
