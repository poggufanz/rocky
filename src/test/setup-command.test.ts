import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type {
  InspectionResult,
  McpRegistration,
  SetupClientAdapter,
  SetupClientId,
  SetupResult,
} from "../setup/clients.js";
import type {
  LegacyVoiceSkillResult,
  LegacyVoiceSkillTarget,
} from "../setup/legacy-voice-skill.js";
import type { ProcessRunner, ProcessSession } from "../setup/process.js";
import { createCodexAdapter } from "../setup/codex.js";
import { createPlatformServices } from "../setup/platform.js";
import {
  SKILL_TEXT,
  claudeTarget,
  codexTarget,
  expectedHash,
  writeManagedTarget,
} from "./legacy-voice-skill-fixture.js";
import {
  createProductionAdapters,
  createConfirmationPort,
  setup,
  type ConfirmationPort,
  type SetupDependencies,
  type LegacyVoiceSkillServices,
} from "../commands/setup.js";

const nodePath = process.execPath;
const entryPath = process.execPath;
const rockyHome = "/tmp/rocky-setup-command-home";

class FakeAdapter implements SetupClientAdapter {
  readonly calls: Array<{ method: "inspect" | "configure" | "check" | "remove"; registration: McpRegistration; replace?: boolean }> = [];

  constructor(
    readonly id: SetupClientId,
    private readonly results: {
      inspect?: InspectionResult | Error;
      configure?: SetupResult | Error;
      check?: SetupResult | Error;
      remove?: SetupResult | Error;
    },
  ) {}

  async inspect(registration: McpRegistration): Promise<InspectionResult> {
    this.calls.push({ method: "inspect", registration });
    if (this.results.inspect instanceof Error) throw this.results.inspect;
    return this.results.inspect ?? { state: "absent" };
  }

  async configure(registration: McpRegistration, replace: boolean): Promise<SetupResult> {
    this.calls.push({ method: "configure", registration, replace });
    if (this.results.configure instanceof Error) throw this.results.configure;
    return this.results.configure ?? { client: this.id, status: "configured" };
  }

  async check(registration: McpRegistration): Promise<SetupResult> {
    this.calls.push({ method: "check", registration });
    if (this.results.check instanceof Error) throw this.results.check;
    return this.results.check ?? { client: this.id, status: "not-configured" };
  }

  async remove(registration: McpRegistration): Promise<SetupResult> {
    this.calls.push({ method: "remove", registration });
    if (this.results.remove instanceof Error) throw this.results.remove;
    return this.results.remove ?? { client: this.id, status: "not-configured" };
  }
}

class HealthySession implements ProcessSession {
  private readonly lines: string[] = [];
  ended = false;
  killed = false;
  waited = false;

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
    } else {
      throw new Error(`unexpected probe method: ${message.method}`);
    }
  }

  async readLine(): Promise<string | undefined> { return this.lines.shift(); }
  end(): void { this.ended = true; }
  kill(): void { this.killed = true; }
  async wait() {
    this.waited = true;
    return { status: 0, stdout: "", stderr: "" };
  }
}

class HealthyRunner implements ProcessRunner {
  readonly registrations: Array<{ command: string; args: readonly string[]; env?: NodeJS.ProcessEnv }> = [];
  readonly sessions: HealthySession[] = [];

  async run(): Promise<never> { throw new Error("batch process runner must not be used"); }

  async openSession(command: string, args: readonly string[], options?: { env?: NodeJS.ProcessEnv }): Promise<ProcessSession> {
    this.registrations.push({ command, args: [...args], env: options?.env });
    const session = new HealthySession();
    this.sessions.push(session);
    return session;
  }
}

class RejectingWaitSession extends HealthySession {
  override async wait(): Promise<{ status: number; stdout: string; stderr: string }> {
    throw new Error("probe-secret-must-not-leak");
  }
}

class RejectingThenHealthyRunner implements ProcessRunner {
  private opens = 0;

  async run(): Promise<never> { throw new Error("batch process runner must not be used"); }

  async openSession(): Promise<ProcessSession> {
    this.opens += 1;
    return this.opens === 1 ? new RejectingWaitSession() : new HealthySession();
  }
}

class FakeConfirmation implements ConfirmationPort {
  readonly messages: string[] = [];
  constructor(private readonly answer: boolean) {}
  async confirm(message: string): Promise<boolean> {
    this.messages.push(message);
    return this.answer;
  }
}

class FakeLegacyVoiceSkillServices implements LegacyVoiceSkillServices {
  readonly calls: Array<{
    method: "resolve" | "check" | "remove";
    host?: LegacyVoiceSkillTarget["host"];
    home?: string;
    env?: NodeJS.ProcessEnv;
  }> = [];

  /**
   * `found` is what a check sees per host (absent unless named). `removed` is
   * what a remove returns for a host the check found installed.
   */
  constructor(
    private readonly found: Partial<Record<LegacyVoiceSkillTarget["host"], LegacyVoiceSkillResult["status"]>> = {},
    private readonly removed: Partial<Record<LegacyVoiceSkillTarget["host"], LegacyVoiceSkillResult["status"]>> = {},
    private readonly observe?: (method: "check" | "remove", target: LegacyVoiceSkillTarget) => void,
  ) {}

  resolveTargets(env: NodeJS.ProcessEnv, home: string): readonly LegacyVoiceSkillTarget[] {
    this.calls.push({ method: "resolve", env, home });
    return [codexTarget(home), claudeTarget(join(home, ".claude"))];
  }

  async check(target: LegacyVoiceSkillTarget): Promise<LegacyVoiceSkillResult> {
    this.observe?.("check", target);
    this.calls.push({ method: "check", host: target.host });
    const status = this.found[target.host] ?? "absent";
    return {
      host: target.host,
      status,
      detail: status === "installed" ? "rocky setup --remove removes it." : `${target.host} ${status} detail`,
    };
  }

  async remove(target: LegacyVoiceSkillTarget): Promise<LegacyVoiceSkillResult> {
    this.observe?.("remove", target);
    this.calls.push({ method: "remove", host: target.host });
    const status = this.removed[target.host] ?? "removed";
    return status === "removed"
      ? { host: target.host, status, detail: `backup: /backups/${target.host}`, backupPath: `/backups/${target.host}` }
      : { host: target.host, status, detail: `${target.host} ${status} detail` };
  }
}

function legacyCalls(legacy: FakeLegacyVoiceSkillServices): string[] {
  return legacy.calls.map(({ method, host }) => (host === undefined ? method : `${method}:${host}`));
}

function dependencies(
  adapters: readonly SetupClientAdapter[],
  options: {
    confirmation?: ConfirmationPort;
    runner?: ProcessRunner;
    shell?: string;
    bashHookInstalled?: boolean;
    home?: string;
    env?: NodeJS.ProcessEnv;
    legacyVoiceSkills?: LegacyVoiceSkillServices;
  } = {},
): SetupDependencies {
  const env = options.env ?? { PATH: "/tools", SHELL: options.shell ?? "/bin/zsh" };
  return {
    runner: options.runner ?? new HealthyRunner(),
    platform: createPlatformServices({
      platform: "linux",
      home: options.home ?? "/home/ada",
      env,
      isWsl: false,
      bashHookInstalled: options.bashHookInstalled,
      fileExists: (path) => path === nodePath || path === entryPath,
    }),
    adapters,
    confirmation: options.confirmation ?? new FakeConfirmation(true),
    nodePath,
    entryPath,
    rockyHome,
    env,
    // Hermetic by default: no test reads the real folders of the fake home.
    legacyVoiceSkills: options.legacyVoiceSkills ?? new FakeLegacyVoiceSkillServices(),
  };
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

test("configure exit table aggregates every host and prints every typed result", async (t) => {
  const cases: Array<{
    name: string;
    statuses: Array<[SetupClientId, SetupResult["status"]]>;
    exit: number;
  }> = [
    { name: "all skipped", statuses: [["codex", "skipped"], ["claude-code", "skipped"]], exit: 1 },
    { name: "configured plus skipped", statuses: [["codex", "configured"], ["claude-code", "skipped"]], exit: 0 },
    { name: "already configured plus skipped", statuses: [["codex", "already-configured"], ["claude-code", "skipped"]], exit: 0 },
    { name: "configured plus failed", statuses: [["codex", "configured"], ["claude-code", "failed"]], exit: 1 },
    { name: "configured plus requires confirmation", statuses: [["codex", "configured"], ["claude-code", "requires-confirmation"]], exit: 1 },
    { name: "configured plus policy block", statuses: [["codex", "configured"], ["claude-code", "blocked-by-policy"]], exit: 1 },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const adapters = entry.statuses.map(([client, status]) => new FakeAdapter(client, {
        configure: { client, status, detail: `${client} ${status} detail` },
      }));
      const output = await captureStderr(() => setup(["--yes"], dependencies(adapters)));

      assert.equal(output.code, entry.exit);
      assert.equal(output.stdout, "");
      for (const [client, status] of entry.statuses) {
        assert.match(output.stderr, new RegExp(`${client}: ${status}`));
        assert.match(output.stderr, new RegExp(`${client} ${status} detail`));
      }
      assert.deepEqual(adapters.map((adapter) => adapter.calls.map(({ method }) => method)),
        adapters.map(() => ["configure"]));
    });
  }
});

test("check dispatches read-only adapter checks and probes exact stored raw registration", async () => {
  const storedRaw: McpRegistration = {
    name: "rocky",
    command: "/opt/stored/node",
    args: ["/opt/stored/rocky.js", "mcp"],
    env: { ROCKY_MCP_EXPOSURE: "raw", ROCKY_HOME: rockyHome },
  };
  const adapter = new FakeAdapter("codex", {
    check: { client: "codex", status: "healthy", healthRegistration: storedRaw },
  });
  const runner = new HealthyRunner();
  const confirmation: ConfirmationPort = { async confirm() { throw new Error("check must not ask consent"); } };

  const output = await captureStderr(() => setup(["--check"], dependencies([adapter], { runner, confirmation })));

  assert.equal(output.code, 0);
  assert.deepEqual(adapter.calls.map(({ method }) => method), ["check"]);
  assert.equal(runner.registrations.length, 1);
  assert.equal(runner.registrations[0]?.command, storedRaw.command);
  assert.deepEqual(runner.registrations[0]?.args, storedRaw.args);
  assert.equal(runner.registrations[0]?.env?.ROCKY_MCP_EXPOSURE, "raw");
  assert.match(output.stderr, /codex: healthy/);
});

test("check exit table rejects missing unhealthy failed and zero testable targets", async (t) => {
  const cases: Array<{ name: string; results: SetupResult[]; exit: number }> = [
    { name: "all skipped", results: [{ client: "codex", status: "skipped" }], exit: 1 },
    { name: "not configured", results: [{ client: "codex", status: "not-configured" }], exit: 1 },
    { name: "failed", results: [{ client: "codex", status: "failed" }], exit: 1 },
    {
      name: "healthy plus skipped",
      results: [
        { client: "codex", status: "healthy", healthRegistration: {
          name: "rocky", command: nodePath, args: [entryPath, "mcp"],
          env: { ROCKY_MCP_EXPOSURE: "sanitized", ROCKY_HOME: rockyHome },
        } },
        { client: "claude-code", status: "skipped" },
      ],
      exit: 0,
    },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const adapters = entry.results.map((result) => new FakeAdapter(result.client, { check: result }));
      assert.equal(await setup(["--check"], dependencies(adapters)), entry.exit);
    });
  }
});

test("remove dispatch and exit table accepts safe idempotence but rejects unsafe results", async (t) => {
  const cases: Array<{ name: string; results: SetupResult[]; exit: number }> = [
    { name: "all skipped", results: [{ client: "codex", status: "skipped" }], exit: 0 },
    {
      name: "removed not configured skipped",
      results: [
        { client: "codex", status: "removed" },
        { client: "claude-code", status: "not-configured" },
        { client: "claude-desktop", status: "skipped" },
      ],
      exit: 0,
    },
    { name: "failed", results: [{ client: "codex", status: "failed" }], exit: 1 },
    { name: "confirmation", results: [{ client: "codex", status: "requires-confirmation" }], exit: 1 },
    { name: "policy", results: [{ client: "codex", status: "blocked-by-policy" }], exit: 1 },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const adapters = entry.results.map((result) => new FakeAdapter(result.client, { remove: result }));
      const code = await setup(["--remove", "--yes"], dependencies(adapters));
      assert.equal(code, entry.exit);
      assert.deepEqual(adapters.map((adapter) => adapter.calls.map(({ method }) => method)),
        adapters.map(() => ["remove"]));
    });
  }
});

test("configure and remove require ordinary consent with exact non-interactive rerun instruction", async (t) => {
  for (const mode of ["configure", "remove"] as const) {
    await t.test(mode, async () => {
      const confirmation = new FakeConfirmation(false);
      const adapter = new FakeAdapter("codex", { inspect: { state: "absent" } });
      const argv = mode === "configure" ? [] : ["--remove"];
      const output = await captureStderr(() => setup(argv, dependencies([adapter], { confirmation })));

      assert.equal(output.code, 1);
      assert.equal(confirmation.messages.length, 1);
      assert.deepEqual(adapter.calls.map(({ method }) => method), ["inspect"]);
      assert.match(output.stderr, /codex: requires-confirmation/);
      assert.match(output.stderr, mode === "configure" ? /rocky setup --yes/ : /rocky setup --remove --yes/);
    });
  }
});

test("ordinary Codex capability failure prints exact manual argv without mutation or consent", async () => {
  const confirmation: ConfirmationPort = {
    async confirm() { throw new Error("unreadable-only hosts must not ask for consent"); },
  };
  let versionCalls = 0;
  let mutationSessions = 0;
  const oldCodexRunner: ProcessRunner = {
    async run(_command, args) {
      versionCalls += 1;
      assert.deepEqual(args, ["--version"]);
      return { status: 0, stdout: "codex-cli 0.145.9\n", stderr: "" };
    },
    async openSession() {
      mutationSessions += 1;
      throw new Error("old Codex must not open app-server");
    },
  };
  const codex = createCodexAdapter({
    runner: oldCodexRunner,
    executable: "/tools/codex",
    env: { CODEX_HOME: "/home/ada/.codex" },
    home: "/home/ada",
  });
  const blocked = new FakeAdapter("claude-code", {
    inspect: { state: "blocked", detail: "Claude Code CLI is not installed" },
  });
  const output = await captureStderr(() => setup([], dependencies(
    [codex, blocked],
    { confirmation },
  )));
  const expectedArgv = [
    "mcp", "add",
    "--env", "ROCKY_MCP_EXPOSURE=sanitized",
    "--env", `ROCKY_HOME=${rockyHome}`,
    "rocky", "--", nodePath, entryPath, "mcp",
  ];

  assert.equal(output.code, 1);
  assert.match(output.stderr, /codex: failed/);
  assert.ok(output.stderr.includes(`codex manual argv: ${JSON.stringify(expectedArgv)}`));
  assert.equal(versionCalls, 1);
  assert.equal(mutationSessions, 0);
  assert.deepEqual(blocked.calls.map(({ method }) => method), ["inspect"]);
});

test("consent inspection rejection becomes a safe failure and later hosts still configure", async () => {
  const rejected = new FakeAdapter("codex", {
    inspect: new Error("inspection-secret-must-not-leak"),
  });
  const later = new FakeAdapter("claude-code", { inspect: { state: "absent" } });
  const output = await captureStderr(() => setup([], dependencies(
    [rejected, later],
    { confirmation: new FakeConfirmation(true) },
  )));

  assert.equal(output.code, 1);
  assert.match(output.stderr, /codex: failed/);
  assert.match(output.stderr, /claude-code: configured/);
  assert.doesNotMatch(output.stderr, /inspection-secret-must-not-leak/);
  assert.deepEqual(rejected.calls.map(({ method }) => method), ["inspect"]);
  assert.deepEqual(later.calls.map(({ method }) => method), ["inspect", "configure"]);
});

test("per-host execution rejection is isolated in configure remove and check modes", async (t) => {
  const cases = [
    {
      name: "configure",
      argv: ["--yes"],
      method: "configure" as const,
      rejected: () => new FakeAdapter("codex", { configure: new Error("configure-secret-must-not-leak") }),
      later: () => new FakeAdapter("claude-code", {
        configure: { client: "claude-code", status: "configured" },
      }),
      laterStatus: "configured",
      secret: "configure-secret-must-not-leak",
    },
    {
      name: "remove",
      argv: ["--remove", "--yes"],
      method: "remove" as const,
      rejected: () => new FakeAdapter("codex", { remove: new Error("remove-secret-must-not-leak") }),
      later: () => new FakeAdapter("claude-code", {
        remove: { client: "claude-code", status: "removed" },
      }),
      laterStatus: "removed",
      secret: "remove-secret-must-not-leak",
    },
    {
      name: "check",
      argv: ["--check"],
      method: "check" as const,
      rejected: () => new FakeAdapter("codex", { check: new Error("check-secret-must-not-leak") }),
      later: () => new FakeAdapter("claude-code", {
        check: { client: "claude-code", status: "not-configured" },
      }),
      laterStatus: "not-configured",
      secret: "check-secret-must-not-leak",
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const rejected = entry.rejected();
      const later = entry.later();
      const output = await captureStderr(() => setup(entry.argv, dependencies([rejected, later])));

      assert.equal(output.code, 1);
      assert.match(output.stderr, /codex: failed/);
      assert.match(output.stderr, new RegExp(`claude-code: ${entry.laterStatus}`));
      assert.doesNotMatch(output.stderr, new RegExp(entry.secret));
      assert.deepEqual(rejected.calls.map(({ method }) => method), [entry.method]);
      assert.deepEqual(later.calls.map(({ method }) => method), [entry.method]);
    });
  }
});

test("health probe rejection becomes a safe failure and later host is still probed and printed", async () => {
  const healthRegistration = (command: string): McpRegistration => ({
    name: "rocky",
    command,
    args: ["/opt/rocky/dist/index.js", "mcp"],
    env: { ROCKY_MCP_EXPOSURE: "sanitized", ROCKY_HOME: rockyHome },
  });
  const rejected = new FakeAdapter("codex", {
    check: { client: "codex", status: "healthy", healthRegistration: healthRegistration("/probe/rejected") },
  });
  const later = new FakeAdapter("claude-code", {
    check: { client: "claude-code", status: "healthy", healthRegistration: healthRegistration("/probe/healthy") },
  });
  const output = await captureStderr(() => setup(["--check"], dependencies(
    [rejected, later],
    { runner: new RejectingThenHealthyRunner() },
  )));

  assert.equal(output.code, 1);
  assert.match(output.stderr, /codex: failed/);
  assert.match(output.stderr, /claude-code: healthy/);
  assert.doesNotMatch(output.stderr, /probe-secret-must-not-leak/);
  assert.deepEqual(rejected.calls.map(({ method }) => method), ["check"]);
  assert.deepEqual(later.calls.map(({ method }) => method), ["check"]);
});

test("non-TTY confirmation port returns false without reading input", async () => {
  let reads = 0;
  const port = createConfirmationPort({
    isTTY: false,
    read() { reads += 1; throw new Error("non-TTY stdin must not be read"); },
  });

  assert.equal(await port.confirm("Configure hosts now?"), false);
  assert.equal(reads, 0);
});

test("yes bypasses ordinary prompt without inventing raw exposure", async () => {
  const confirmation: ConfirmationPort = { async confirm() { throw new Error("--yes must not prompt"); } };
  const adapter = new FakeAdapter("codex", {});

  assert.equal(await setup(["--yes"], dependencies([adapter], { confirmation })), 0);
  assert.equal(adapter.calls[0]?.registration.env.ROCKY_MCP_EXPOSURE, "sanitized");
});

/** A home with the private ~/.claude folder that `setup --status` expects to find. */
function statusHome(t: test.TestContext): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rocky-setup-status-home-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, ".claude"), { mode: 0o700 });
  return home;
}

function desiredRegistration(): McpRegistration {
  return {
    name: "rocky",
    command: nodePath,
    args: [entryPath, "mcp"],
    env: { ROCKY_MCP_EXPOSURE: "sanitized", ROCKY_HOME: rockyHome },
  };
}

const INSTALLED_CODEX_LINE = "legacy voice skill codex: installed; rocky setup --remove removes it.";
const REMOVED_CODEX_LINE = "legacy voice skill codex: removed; backup: /backups/codex";
const REMOVED_CLAUDE_LINE = "legacy voice skill claude-code: removed; backup: /backups/claude-code";

test("configure never looks at the legacy voice skill folders", async () => {
  const legacy = new FakeLegacyVoiceSkillServices({ codex: "installed", "claude-code": "installed" });
  const adapter = new FakeAdapter("codex", {});

  const output = await captureStderr(() => setup(["--yes"], dependencies([adapter], { legacyVoiceSkills: legacy })));

  assert.equal(output.code, 0);
  assert.deepEqual(legacy.calls, []);
  assert.doesNotMatch(output.stderr, /legacy voice skill/);
});

test("--voice-skill is an unknown option and exits 2 before any host or skill work", async (t) => {
  for (const argv of [
    ["--voice-skill"],
    ["--yes", "--voice-skill"],
    ["--check", "--voice-skill"],
    ["--remove", "--yes", "--voice-skill"],
  ]) {
    await t.test(argv.join(" "), async () => {
      const legacy = new FakeLegacyVoiceSkillServices({ codex: "installed" });
      const adapter = new FakeAdapter("codex", {});

      const output = await captureStderr(() => setup(argv, dependencies([adapter], { legacyVoiceSkills: legacy })));

      assert.equal(output.code, 2);
      assert.equal(
        output.stderr,
        "rocky: Unknown setup option: --voice-skill. Run rocky --help --all to list every option.\n",
      );
      assert.deepEqual(adapter.calls, []);
      assert.deepEqual(legacy.calls, []);
    });
  }
});

test("check prints one line per legacy voice skill, nothing for absent folders, and keeps the exit code", async (t) => {
  const cases = [
    { found: "installed" as const, line: INSTALLED_CODEX_LINE },
    { found: "modified" as const, line: "legacy voice skill codex: modified; codex modified detail" },
    { found: "refused" as const, line: "legacy voice skill codex: refused; codex refused detail" },
    { found: "failed" as const, line: "legacy voice skill codex: failed; codex failed detail" },
  ];

  for (const entry of cases) {
    await t.test(entry.found, async () => {
      const legacy = new FakeLegacyVoiceSkillServices({ codex: entry.found });
      const adapter = new FakeAdapter("codex", {
        check: { client: "codex", status: "healthy", healthRegistration: desiredRegistration() },
      });

      const output = await captureStderr(() => setup(["--check"], dependencies([adapter], { legacyVoiceSkills: legacy })));

      assert.equal(output.code, 0, output.stderr);
      assert.ok(output.stderr.split("\n").includes(entry.line), output.stderr);
      assert.doesNotMatch(output.stderr, /legacy voice skill claude-code/);
      assert.deepEqual(legacyCalls(legacy), ["resolve", "check:codex", "check:claude-code"]);
    });
  }
});

test("check, remove, and status stay silent about the legacy voice skill when none exists", async (t) => {
  const cases = [
    {
      name: "check",
      argv: ["--check"],
      adapter: () => new FakeAdapter("codex", {
        check: { client: "codex", status: "healthy", healthRegistration: desiredRegistration() },
      }),
    },
    {
      name: "remove",
      argv: ["--remove", "--yes"],
      adapter: () => new FakeAdapter("codex", { remove: { client: "codex", status: "removed" } }),
    },
    { name: "status", argv: ["--status"], adapter: () => new FakeAdapter("codex", {}) },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async (st) => {
      const legacy = new FakeLegacyVoiceSkillServices();

      const output = await captureStderr(() => setup(entry.argv, dependencies([entry.adapter()], {
        legacyVoiceSkills: legacy,
        home: entry.name === "status" ? statusHome(st) : undefined,
      })));

      assert.equal(output.code, 0, output.stderr);
      assert.doesNotMatch(output.stderr, /legacy voice skill/);
      assert.equal(legacy.calls.some(({ method }) => method === "remove"), false);
    });
  }
});

test("status reports the legacy voice skill read-only and keeps the exit code", async (t) => {
  const legacy = new FakeLegacyVoiceSkillServices({ codex: "installed" });

  const output = await captureStderr(() => setup(["--status"], dependencies([], {
    legacyVoiceSkills: legacy,
    home: statusHome(t),
  })));

  assert.equal(output.code, 0, output.stderr);
  assert.ok(output.stderr.split("\n").includes(INSTALLED_CODEX_LINE), output.stderr);
  assert.doesNotMatch(output.stderr, /legacy voice skill claude-code/);
  assert.deepEqual(legacyCalls(legacy), ["resolve", "check:codex", "check:claude-code"]);
});

test("remove --yes moves each managed legacy skill after the MCP removal and prints one line per skill", async () => {
  const adapter = new FakeAdapter("codex", { remove: { client: "codex", status: "removed" } });
  const legacy = new FakeLegacyVoiceSkillServices({ codex: "installed", "claude-code": "installed" }, {}, (method) => {
    if (method === "remove") assert.deepEqual(adapter.calls.map(({ method: call }) => call), ["remove"]);
  });

  const output = await captureStderr(() => setup(["--remove", "--yes"], dependencies([adapter], {
    legacyVoiceSkills: legacy,
  })));

  assert.equal(output.code, 0, output.stderr);
  assert.equal(output.stdout, "");
  assert.deepEqual(legacyCalls(legacy), [
    "resolve", "check:codex", "check:claude-code", "remove:codex", "remove:claude-code",
  ]);
  const lines = output.stderr.split("\n");
  assert.ok(lines.includes(REMOVED_CODEX_LINE), output.stderr);
  assert.ok(lines.includes(REMOVED_CLAUDE_LINE), output.stderr);
  assert.ok(lines.indexOf("rocky: Host setup results follow.") < lines.indexOf(REMOVED_CODEX_LINE));
});

test("remove moves only what the check found installed and reports the rest as the check saw it", async () => {
  const adapter = new FakeAdapter("codex", { remove: { client: "codex", status: "removed" } });
  const legacy = new FakeLegacyVoiceSkillServices({ codex: "installed", "claude-code": "modified" });

  const output = await captureStderr(() => setup(["--remove", "--yes"], dependencies([adapter], {
    legacyVoiceSkills: legacy,
  })));

  assert.equal(output.code, 0, output.stderr);
  assert.deepEqual(legacyCalls(legacy), ["resolve", "check:codex", "check:claude-code", "remove:codex"]);
  const lines = output.stderr.split("\n");
  assert.ok(lines.includes(REMOVED_CODEX_LINE), output.stderr);
  assert.ok(lines.includes("legacy voice skill claude-code: modified; claude-code modified detail"), output.stderr);
});

test("a refused or modified legacy removal keeps the exit code at zero and an unexpected failure makes it one", async (t) => {
  const cases = [
    { removed: "removed" as const, exit: 0 },
    { removed: "refused" as const, exit: 0 },
    { removed: "modified" as const, exit: 0 },
    { removed: "failed" as const, exit: 1 },
  ];

  for (const entry of cases) {
    await t.test(entry.removed, async () => {
      const adapter = new FakeAdapter("codex", { remove: { client: "codex", status: "removed" } });
      const legacy = new FakeLegacyVoiceSkillServices({ codex: "installed" }, { codex: entry.removed });

      const output = await captureStderr(() => setup(["--remove", "--yes"], dependencies([adapter], {
        legacyVoiceSkills: legacy,
      })));

      assert.equal(output.code, entry.exit, output.stderr);
      assert.match(output.stderr, new RegExp(`legacy voice skill codex: ${entry.removed}; `));
    });
  }
});

test("remove asks one question that names the legacy voice skill and a decline moves nothing", async () => {
  const confirmation = new FakeConfirmation(false);
  const adapter = new FakeAdapter("codex", { inspect: { state: "absent" } });
  const legacy = new FakeLegacyVoiceSkillServices({ codex: "installed" });

  const output = await captureStderr(() => setup(["--remove"], dependencies([adapter], {
    confirmation,
    legacyVoiceSkills: legacy,
  })));

  assert.equal(output.code, 1);
  assert.deepEqual(confirmation.messages, ["Remove rocky from MCP hosts and the legacy voice skill (codex) now?"]);
  assert.equal(legacy.calls.some(({ method }) => method === "remove"), false);
  assert.deepEqual(adapter.calls.map(({ method }) => method), ["inspect"]);
  assert.match(output.stderr, /codex: requires-confirmation/);
  assert.match(output.stderr, /rocky setup --remove --yes/);
  assert.ok(output.stderr.split("\n").includes(INSTALLED_CODEX_LINE), output.stderr);
});

test("a managed legacy skill alone still needs consent before it moves", async (t) => {
  const blocked = (): FakeAdapter => new FakeAdapter("codex", {
    inspect: { state: "blocked", detail: "codex is not installed" },
  });

  await t.test("declined", async () => {
    const confirmation = new FakeConfirmation(false);
    const legacy = new FakeLegacyVoiceSkillServices({ codex: "installed" });

    const output = await captureStderr(() => setup(["--remove"], dependencies([blocked()], {
      confirmation,
      legacyVoiceSkills: legacy,
    })));

    assert.equal(output.code, 1);
    assert.deepEqual(confirmation.messages, ["Remove the legacy voice skill (codex) now?"]);
    assert.equal(legacy.calls.some(({ method }) => method === "remove"), false);
    assert.ok(output.stderr.split("\n").includes(INSTALLED_CODEX_LINE), output.stderr);
  });

  await t.test("accepted", async () => {
    const confirmation = new FakeConfirmation(true);
    const legacy = new FakeLegacyVoiceSkillServices({ codex: "installed" });

    const output = await captureStderr(() => setup(["--remove"], dependencies([blocked()], {
      confirmation,
      legacyVoiceSkills: legacy,
    })));

    assert.equal(output.code, 0, output.stderr);
    assert.deepEqual(confirmation.messages, ["Remove the legacy voice skill (codex) now?"]);
    assert.deepEqual(legacyCalls(legacy), ["resolve", "check:codex", "check:claude-code", "remove:codex"]);
    assert.ok(output.stderr.split("\n").includes(REMOVED_CODEX_LINE), output.stderr);
  });
});

test("nothing is asked when no managed legacy skill exists and every MCP adapter is blocked", async () => {
  const confirmation: ConfirmationPort = { async confirm() { throw new Error("nothing to authorize must not prompt"); } };
  const adapter = new FakeAdapter("codex", { inspect: { state: "blocked", detail: "codex is not installed" } });
  const legacy = new FakeLegacyVoiceSkillServices({ codex: "modified" });

  const output = await captureStderr(() => setup(["--remove"], dependencies([adapter], {
    confirmation,
    legacyVoiceSkills: legacy,
  })));

  assert.equal(output.code, 0, output.stderr);
  assert.equal(legacy.calls.some(({ method }) => method === "remove"), false);
  assert.ok(output.stderr.split("\n").includes("legacy voice skill codex: modified; codex modified detail"), output.stderr);
});

test("explicit --harness targets limit the legacy skill lookup to the selected hosts", async (t) => {
  const cases = [
    { argv: ["--check", "--harness", "claude-code"], hosts: ["claude-code"] },
    { argv: ["--check", "--harness", "codex"], hosts: ["codex"] },
    { argv: ["--check", "--harness", "codex", "--harness", "claude-code"], hosts: ["codex", "claude-code"] },
    { argv: ["--check", "--harness", "opencode"], hosts: [] },
  ];

  for (const entry of cases) {
    await t.test(entry.argv.slice(1).join(" "), async () => {
      const legacy = new FakeLegacyVoiceSkillServices({ codex: "installed", "claude-code": "installed" });

      const output = await captureStderr(() => setup(entry.argv, dependencies([], { legacyVoiceSkills: legacy })));

      assert.deepEqual(
        legacy.calls.filter(({ method }) => method === "check").map(({ host }) => host),
        entry.hosts,
      );
      for (const host of ["codex", "claude-code"]) {
        assert.equal(output.stderr.includes(`legacy voice skill ${host}:`), entry.hosts.includes(host), host);
      }
    });
  }
});

test("setup --check and --remove find, report, and move a real managed legacy voice skill", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "rocky-setup-legacy-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const claudeRoot = join(home, "claude-config");
  const codex = codexTarget(home);
  const claude = claudeTarget(claudeRoot);
  const hash = await writeManagedTarget(codex);
  await writeManagedTarget(claude);
  await appendFile(join(claude.destination, "SKILL.md"), "user edit\n", "utf8");
  const real = (adapter: FakeAdapter): SetupDependencies => {
    const value = dependencies([adapter], { home, env: { PATH: "/tools", CLAUDE_CONFIG_DIR: claudeRoot } });
    delete value.legacyVoiceSkills;
    return value;
  };

  const checked = await captureStderr(() => setup(["--check"], real(new FakeAdapter("codex", {
    check: { client: "codex", status: "healthy", healthRegistration: desiredRegistration() },
  }))));
  assert.equal(checked.code, 0, checked.stderr);
  assert.ok(checked.stderr.split("\n").includes(INSTALLED_CODEX_LINE), checked.stderr);
  assert.match(checked.stderr, /^legacy voice skill claude-code: modified; the files changed after install/m);
  assert.equal(readFileSync(join(codex.destination, "SKILL.md"), "utf8"), SKILL_TEXT);

  const removed = await captureStderr(() => setup(["--remove", "--yes"], real(new FakeAdapter("codex", {
    remove: { client: "codex", status: "removed" },
  }))));
  assert.equal(removed.code, 0, removed.stderr);
  const backupLine = removed.stderr.split("\n").find((line) => line.startsWith("legacy voice skill codex: removed; backup: "));
  assert.ok(backupLine !== undefined, removed.stderr);
  const backupPath = backupLine.slice("legacy voice skill codex: removed; backup: ".length);
  assert.ok(backupPath.startsWith(codex.backupRoot), backupPath);
  assert.equal(existsSync(codex.destination), false);
  assert.equal(await expectedHash(backupPath), hash);
  assert.match(removed.stderr, /^legacy voice skill claude-code: modified; /m);
  assert.match(readFileSync(join(claude.destination, "SKILL.md"), "utf8"), /user edit/);
  assert.equal(existsSync(claude.backupRoot), false);

  const again = await captureStderr(() => setup(["--remove", "--yes"], real(new FakeAdapter("codex", {
    remove: { client: "codex", status: "not-configured" },
  }))));
  assert.equal(again.code, 0, again.stderr);
  assert.doesNotMatch(again.stderr, /legacy voice skill codex/);
});

test("declining the real remove prompt leaves a managed legacy voice skill in place", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "rocky-setup-legacy-decline-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const codex = codexTarget(home);
  await writeManagedTarget(codex);
  const confirmation = new FakeConfirmation(false);
  const deps = dependencies([new FakeAdapter("codex", { inspect: { state: "absent" } })], {
    confirmation,
    home,
    env: { PATH: "/tools" },
  });
  delete deps.legacyVoiceSkills;

  const output = await captureStderr(() => setup(["--remove"], deps));

  assert.equal(output.code, 1);
  assert.equal(confirmation.messages.length, 1);
  assert.match(confirmation.messages[0] ?? "", /legacy voice skill \(codex\)/);
  assert.equal(readFileSync(join(codex.destination, "SKILL.md"), "utf8"), SKILL_TEXT);
  assert.equal(existsSync(codex.backupRoot), false);
});

test("sanitized and raw configure print required projected-memory disclosures", async () => {
  const sanitized = new FakeAdapter("codex", {});
  const safeOutput = await captureStderr(() => setup(["--yes"], dependencies([sanitized])));
  assert.match(safeOutput.stderr, /A configured MCP host may forward selected projected memory\./);
  assert.doesNotMatch(safeOutput.stderr, /working director|stderr excerpt/i);

  const raw = new FakeAdapter("codex", {});
  const rawOutput = await captureStderr(() => setup(
    ["--yes", "--mcp-exposure", "raw"],
    dependencies([raw]),
  ));
  assert.match(rawOutput.stderr, /A configured MCP host may forward selected projected memory\./);
  assert.match(rawOutput.stderr, /Raw exposure includes working directories and stored stderr excerpts\./);
  assert.match(rawOutput.stderr, /A host that shares them exposes that data\./);
  assert.equal(raw.calls[0]?.registration.env.ROCKY_MCP_EXPOSURE, "raw");
});

test("manual registrations render as host-appropriate desired argv or config", async () => {
  const desired: McpRegistration = {
    name: "rocky",
    command: nodePath,
    args: [entryPath, "mcp"],
    env: { ROCKY_MCP_EXPOSURE: "sanitized", ROCKY_HOME: rockyHome },
  };
  const adapters = (["codex", "claude-code", "claude-desktop"] as const).map((client) =>
    new FakeAdapter(client, {
      configure: {
        client,
        status: "failed",
        detail: "manual setup required",
        manualRegistration: desired,
      },
    }));

  const output = await captureStderr(() => setup(["--yes"], dependencies(adapters)));

  assert.equal(output.code, 1);
  assert.match(output.stderr, /codex manual argv: \["mcp","add"/);
  assert.ok(output.stderr.includes(`claude-code manual argv: ${JSON.stringify([
    "mcp", "add", "--scope", "user", "--transport", "stdio", "rocky",
    "--env", "ROCKY_MCP_EXPOSURE=sanitized",
    "--env", `ROCKY_HOME=${rockyHome}`,
    "--", nodePath, entryPath, "mcp",
  ])}`));
  assert.match(output.stderr, /claude-desktop manual config: \{"mcpServers":\{"rocky":\{"type":"stdio"/);
  assert.match(output.stderr, new RegExp(rockyHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

// This test forces platform:"linux" below (posix path semantics), so its real
// fixture directories must be handed to the adapter as posix-shaped strings -
// see the fuller explanation on temporaryDirectory() in setup-claude-code.test.ts
// for why raw os.tmpdir()/mkdtemp output (symlinked ancestors on macOS,
// backslash+drive paths on win32) can't be used as-is.
function posixFixtureRoot(t: test.TestContext, prefix: string): string {
  const path = mkdtempSync(join(process.cwd(), prefix));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  const real = realpathSync(path);
  if (process.platform !== "win32") return real;
  const drive = win32.parse(real).root;
  return `/${real.slice(drive.length).replaceAll("\\", "/")}`;
}

test("production adapter wiring passes the captured setup environment to Claude path resolution", async (t) => {
  const root = posixFixtureRoot(t, "rocky-setup-claude-env-");
  // root is posix-shaped (see posixFixtureRoot above) - stay on posix.join here,
  // not the ambient join, or win32 would reintroduce backslashes into it.
  const home = posix.join(root, "home");
  const override = posix.join(root, "override");
  mkdirSync(home, { recursive: true });
  mkdirSync(override, { recursive: true });
  writeFileSync(posix.join(home, ".claude.json"), JSON.stringify({
    mcpServers: { rocky: { type: "stdio", command: "/foreign", args: [], env: {} } },
  }));
  writeFileSync(posix.join(override, ".claude.json"), JSON.stringify({
    mcpServers: { rocky: {
      type: "stdio",
      command: nodePath,
      args: [entryPath, "mcp"],
      env: { ROCKY_MCP_EXPOSURE: "sanitized", ROCKY_HOME: rockyHome },
    } },
  }));
  const env = { PATH: "/tools", CLAUDE_CONFIG_DIR: override };
  const platform = createPlatformServices({
    platform: "linux",
    home,
    env,
    isWsl: false,
    fileExists: (path) => path === "/tools/claude",
  });
  const adapters = await createProductionAdapters(
    platform,
    { async run() { throw new Error("read-only inspection must not run Claude"); } },
    {
      name: "rocky",
      command: nodePath,
      args: [entryPath, "mcp"],
      env: { ROCKY_MCP_EXPOSURE: "sanitized", ROCKY_HOME: rockyHome },
    },
    env,
  );
  const claude = adapters.find(({ id }) => id === "claude-code");
  assert.ok(claude !== undefined);

  assert.equal((await claude.inspect({
    name: "rocky",
    command: nodePath,
    args: [entryPath, "mcp"],
    env: { ROCKY_MCP_EXPOSURE: "sanitized", ROCKY_HOME: rockyHome },
  })).state, "identical");
});

test("remove and check never render manual instructions that add Rocky", async (t) => {
  const desired: McpRegistration = {
    name: "rocky",
    command: nodePath,
    args: [entryPath, "mcp"],
    env: { ROCKY_MCP_EXPOSURE: "sanitized", ROCKY_HOME: rockyHome },
  };
  const cases = [
    { name: "remove", argv: ["--remove", "--yes"], resultKey: "remove" },
    { name: "check", argv: ["--check"], resultKey: "check" },
  ] as const;

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const result: SetupResult = {
        client: "codex",
        status: "failed",
        detail: `${entry.name} requires manual action`,
        manualRegistration: desired,
      };
      const adapter = new FakeAdapter("codex", { [entry.resultKey]: result });

      const output = await captureStderr(() => setup(entry.argv, dependencies([adapter])));

      assert.equal(output.code, 1);
      assert.match(output.stderr, new RegExp(`${entry.name} requires manual action`, "i"));
      assert.doesNotMatch(output.stderr, /manual argv|manual config|\["mcp","add"|mcpServers/i);
    });
  }
});

test("manual renderer refuses noncanonical snapshots and never prints their secrets", async () => {
  const unsafe: McpRegistration = {
    name: "rocky",
    command: "/secret/prior-node",
    args: ["/secret/prior-server.js", "mcp"],
    env: {
      ROCKY_MCP_EXPOSURE: "sanitized",
      ROCKY_HOME: rockyHome,
      API_TOKEN: "prior-secret-token",
    },
  };
  const adapter = new FakeAdapter("codex", {
    configure: {
      client: "codex",
      status: "failed",
      detail: "manual recovery required",
      manualRegistration: unsafe,
    },
  });

  const output = await captureStderr(() => setup(["--yes"], dependencies([adapter])));

  assert.equal(output.code, 1);
  assert.match(output.stderr, /manual registration unavailable/i);
  assert.doesNotMatch(output.stderr, /prior-node|prior-server|API_TOKEN|prior-secret-token/);
});

test("Bash without installed ears prints next step but never installs hook", async () => {
  const adapter = new FakeAdapter("codex", {});
  const output = await captureStderr(() => setup(["--yes"], dependencies([adapter], {
    shell: "/bin/bash",
    bashHookInstalled: false,
  })));

  assert.equal(output.code, 0);
  assert.match(output.stderr, /rocky hook install/);
  assert.deepEqual(adapter.calls.map(({ method }) => method), ["configure"]);
});

test("setup honors process ROCKY_HOME when no explicit dependency override is supplied", async () => {
  const adapter = new FakeAdapter("codex", {});
  const deps = dependencies([adapter]);
  delete deps.rockyHome;
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = "relative-rocky-state";
  try {
    assert.equal(await setup(["--yes"], deps), 0);
  } finally {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
  }

  assert.equal(adapter.calls[0]?.registration.env.ROCKY_HOME, join(process.cwd(), "relative-rocky-state"));
});

test("usage remains two and ephemeral installs stop before adapters", async () => {
  const adapter = new FakeAdapter("codex", {});
  const usage = await captureStderr(() => setup(["--mcp-exposure", "RAW"], dependencies([adapter])));
  assert.equal(usage.code, 2);
  assert.match(usage.stderr, /^rocky: --mcp-exposure must be sanitized or raw\. Run rocky --help --all to list every option\.\n$/);
  assert.doesNotMatch(usage.stderr, /rocky setup --help/);
  assert.deepEqual(adapter.calls, []);

  const ephemeral = dependencies([adapter]);
  ephemeral.entryPath = "/tmp/_npx/rocky/dist/index.js";
  ephemeral.platform = createPlatformServices({
    platform: "linux",
    home: "/home/ada",
    env: { PATH: "", SHELL: "/bin/zsh" },
    isWsl: false,
    fileExists: () => true,
  });
  assert.equal(await setup(["--yes"], ephemeral), 1);
  assert.deepEqual(adapter.calls, []);
});

test("compiled CLI routes invalid uppercase exposure to setup usage without touching hosts", (t) => {
  const home = mkdtempSync(join(tmpdir(), "rocky-setup-cli-smoke-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const result = spawnSync(process.execPath, [
    join(packageRoot, "dist", "index.js"),
    "setup",
    "--mcp-exposure",
    "RAW",
  ], {
    env: { ...process.env, HOME: home, ROCKY_HOME: join(home, ".rocky") },
    encoding: "utf8",
  });

  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /--mcp-exposure must be sanitized or raw/);
  assert.doesNotMatch(result.stderr, /not command I know/);
});

test("CLI import and invalid setup usage perform no eager WSL host discovery", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rocky-setup-lazy-platform-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const marker = join(root, "wsl-host-accessed");
  const preload = join(root, "observe-wsl-access.cjs");
  writeFileSync(preload, [
    "const fs = require('node:fs');",
    "fs.readdirSync = (path) => {",
    "  if (path === '/mnt/c/Users') fs.writeFileSync(process.env.ROCKY_SETUP_ACCESS_MARKER, 'accessed');",
    "  return [];",
    "};",
    "require('node:module').syncBuiltinESMExports();",
  ].join("\n"), "utf8");
  const compiledEntry = join(dirname(fileURLToPath(import.meta.url)), "..", "index.js");
  const commonEnv = {
    ...process.env,
    NODE_OPTIONS: `--require=${preload}`,
    ROCKY_SETUP_ACCESS_MARKER: marker,
    WSL_DISTRO_NAME: "Ubuntu-24.04",
  };

  const unrelated = spawnSync(process.execPath, [compiledEntry, "--help"], {
    env: commonEnv,
    encoding: "utf8",
  });
  const invalid = spawnSync(process.execPath, [
    compiledEntry,
    "setup",
    "--mcp-exposure",
    "RAW",
  ], {
    env: commonEnv,
    encoding: "utf8",
  });

  assert.equal(unrelated.status, 0, unrelated.stderr);
  assert.equal(invalid.status, 2, invalid.stderr);
  assert.equal(existsSync(marker), false);
});
