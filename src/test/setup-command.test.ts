import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  VoiceSkillOperationResult,
  VoiceSkillTarget,
} from "../setup/voice-skill.js";
import type { ProcessRunner, ProcessSession } from "../setup/process.js";
import { createCodexAdapter } from "../setup/codex.js";
import { createPlatformServices } from "../setup/platform.js";
import {
  createProductionAdapters,
  createConfirmationPort,
  setup,
  type ConfirmationPort,
  type SetupDependencies,
  type VoiceSkillServices,
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
        result: { tools: ["recall", "recent_failures", "stats", "recall_with_ai"].map((name) => ({ name })) },
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

class FakeVoiceSkillServices implements VoiceSkillServices {
  readonly calls: Array<{
    method: "resolve" | "install" | "check" | "remove";
    host?: VoiceSkillTarget["host"];
    replace?: boolean;
    home?: string;
    env?: NodeJS.ProcessEnv;
  }> = [];

  constructor(
    private readonly statuses: Partial<Record<
      "install" | "check" | "remove",
      Partial<Record<VoiceSkillTarget["host"], VoiceSkillOperationResult["status"]>>
    >> = {},
    private readonly observe?: (
      method: "install" | "check" | "remove",
      target: VoiceSkillTarget,
    ) => void,
    private readonly targets?: readonly VoiceSkillTarget[],
  ) {}

  resolveTargets(env: NodeJS.ProcessEnv, home: string): readonly VoiceSkillTarget[] {
    this.calls.push({ method: "resolve", env, home });
    return this.targets ?? [
      {
        host: "codex",
        destination: join(home, ".agents", "skills", "rocky-voice"),
        backupRoot: join(home, ".agents", ".rocky", "backups", "voice-skills"),
      },
      {
        host: "claude-code",
        destination: join(home, ".claude", "skills", "rocky-voice"),
        backupRoot: join(home, ".claude", ".rocky", "backups", "voice-skills"),
      },
    ];
  }

  private result(
    method: "install" | "check" | "remove",
    target: VoiceSkillTarget,
  ): VoiceSkillOperationResult {
    const fallback = method === "install" ? "installed" : method === "check" ? "unchanged" : "removed";
    return {
      host: target.host,
      status: this.statuses[method]?.[target.host] ?? fallback,
      detail: `${target.host} ${method} detail`,
    };
  }

  async install(target: VoiceSkillTarget, replace: boolean): Promise<VoiceSkillOperationResult> {
    this.observe?.("install", target);
    this.calls.push({ method: "install", host: target.host, replace });
    return this.result("install", target);
  }

  async check(target: VoiceSkillTarget): Promise<VoiceSkillOperationResult> {
    this.observe?.("check", target);
    this.calls.push({ method: "check", host: target.host });
    return this.result("check", target);
  }

  async remove(target: VoiceSkillTarget): Promise<VoiceSkillOperationResult> {
    this.observe?.("remove", target);
    this.calls.push({ method: "remove", host: target.host });
    return this.result("remove", target);
  }
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
    detected?: readonly ("codex" | "claude-code")[];
    voiceSkills?: VoiceSkillServices;
  } = {},
): SetupDependencies {
  const detected = new Set(options.detected ?? []);
  const env = options.env ?? { PATH: "/tools", SHELL: options.shell ?? "/bin/zsh" };
  return {
    runner: options.runner ?? new HealthyRunner(),
    platform: createPlatformServices({
      platform: "linux",
      home: options.home ?? "/home/ada",
      env,
      isWsl: false,
      bashHookInstalled: options.bashHookInstalled,
      fileExists: (path) => path === nodePath
        || path === entryPath
        || (path === "/tools/codex" && detected.has("codex"))
        || (path === "/tools/claude" && detected.has("claude-code")),
    }),
    adapters,
    confirmation: options.confirmation ?? new FakeConfirmation(true),
    nodePath,
    entryPath,
    rockyHome,
    env,
    voiceSkills: options.voiceSkills,
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

  assert.equal(await port.confirm("configure hosts, question"), false);
  assert.equal(reads, 0);
});

test("yes bypasses ordinary prompt without inventing raw exposure", async () => {
  const confirmation: ConfirmationPort = { async confirm() { throw new Error("--yes must not prompt"); } };
  const adapter = new FakeAdapter("codex", {});

  assert.equal(await setup(["--yes"], dependencies([adapter], { confirmation })), 0);
  assert.equal(adapter.calls[0]?.registration.env.ROCKY_MCP_EXPOSURE, "sanitized");
});

test("yes without voice flag never plans or mutates skill targets", async () => {
  const voiceSkills = new FakeVoiceSkillServices();
  const adapter = new FakeAdapter("codex", {});

  assert.equal(await setup(["--yes"], dependencies([adapter], {
    detected: ["codex"],
    voiceSkills,
  })), 0);

  assert.deepEqual(voiceSkills.calls, []);
});

test("voice flag dispatches after MCP to detected Codex and Claude Code but never Desktop", async (t) => {
  const desired: McpRegistration = {
    name: "rocky",
    command: nodePath,
    args: [entryPath, "mcp"],
    env: { ROCKY_MCP_EXPOSURE: "sanitized", ROCKY_HOME: rockyHome },
  };
  const cases = [
    { mode: "configure" as const, argv: ["--yes", "--replace", "--voice-skill"], method: "install" as const },
    { mode: "check" as const, argv: ["--check", "--voice-skill"], method: "check" as const },
    { mode: "remove" as const, argv: ["--remove", "--yes", "--voice-skill"], method: "remove" as const },
  ];

  for (const entry of cases) {
    await t.test(entry.mode, async () => {
      const adapters = (["codex", "claude-code", "claude-desktop"] as const).map((client) =>
        new FakeAdapter(client, entry.mode === "configure"
          ? { configure: { client, status: "configured" } }
          : entry.mode === "check"
            ? { check: { client, status: "healthy", healthRegistration: desired } }
            : { remove: { client, status: "removed" } }));
      const voiceSkills = new FakeVoiceSkillServices({}, (method) => {
        assert.equal(method, entry.method);
        assert.deepEqual(adapters.map((adapter) => adapter.calls.map(({ method: call }) => call)),
          adapters.map(() => [entry.mode === "configure" ? "configure" : entry.mode]));
      });

      const output = await captureStderr(() => setup(entry.argv, dependencies(adapters, {
        detected: ["codex", "claude-code"],
        voiceSkills,
        env: { PATH: "/tools", CLAUDE_CONFIG_DIR: "/tmp/test-claude-config" },
      })));

      assert.equal(output.code, 0, output.stderr);
      assert.deepEqual(voiceSkills.calls.map(({ method, host, replace }) => ({ method, host, replace })), [
        { method: "resolve", host: undefined, replace: undefined },
        { method: entry.method, host: "codex", replace: entry.method === "install" ? true : undefined },
        { method: entry.method, host: "claude-code", replace: entry.method === "install" ? true : undefined },
      ]);
      assert.match(output.stderr, new RegExp(`voice-skill codex: ${entry.method === "install" ? "installed" : entry.method === "check" ? "unchanged" : "removed"}`));
      assert.match(output.stderr, new RegExp(`voice-skill claude-code: ${entry.method === "install" ? "installed" : entry.method === "check" ? "unchanged" : "removed"}`));
      assert.doesNotMatch(output.stderr, /voice-skill claude-desktop/);
      assert.equal(output.stdout, "");
    });
  }
});

test("voice skill refusal is isolated per host and contributes partial-failure exit one", async () => {
  const adapters = [
    new FakeAdapter("codex", { configure: { client: "codex", status: "configured" } }),
    new FakeAdapter("claude-code", { configure: { client: "claude-code", status: "configured" } }),
  ];
  const voiceSkills = new FakeVoiceSkillServices({
    install: { codex: "refused", "claude-code": "installed" },
  });

  const output = await captureStderr(() => setup(
    ["--yes", "--voice-skill"],
    dependencies(adapters, {
      detected: ["codex", "claude-code"],
      voiceSkills,
    }),
  ));

  assert.equal(output.code, 1);
  assert.match(output.stderr, /codex: configured/);
  assert.match(output.stderr, /claude-code: configured/);
  assert.match(output.stderr, /voice-skill codex: refused/);
  assert.match(output.stderr, /voice-skill claude-code: installed/);
  assert.deepEqual(voiceSkills.calls.filter(({ method }) => method === "install").map(({ host }) => host), [
    "codex", "claude-code",
  ]);
});

test("declined combined consent performs no voice skill operation", async () => {
  const confirmation = new FakeConfirmation(false);
  const voiceSkills = new FakeVoiceSkillServices();
  const adapter = new FakeAdapter("codex", { inspect: { state: "absent" } });

  const output = await captureStderr(() => setup(
    ["--voice-skill"],
    dependencies([adapter], {
      confirmation,
      detected: ["codex"],
      voiceSkills,
    }),
  ));

  assert.equal(output.code, 1);
  assert.equal(confirmation.messages.length, 1);
  assert.match(confirmation.messages[0] ?? "", /voice skill/i);
  assert.doesNotMatch(output.stderr, /voice-skill: unavailable/);
  assert.deepEqual(voiceSkills.calls, []);
  assert.deepEqual(adapter.calls.map(({ method }) => method), ["inspect"]);
});

test("declined voice consent performs no voice operation and never claims unavailable", async (t) => {
  // A real decline answers a question that was actually asked. Rocky never learned
  // whether any voice-skill target would have been eligible, so it must not report
  // "unavailable" - that would claim knowledge the decline never let it gather.
  const cases: Array<{
    name: string;
    argv: readonly string[];
    inspection: InspectionResult;
    exit: number;
  }> = [
    {
      name: "declined consent, configure",
      argv: ["--voice-skill"],
      inspection: { state: "absent" },
      exit: 1,
    },
    {
      name: "declined consent, remove",
      argv: ["--remove", "--voice-skill"],
      inspection: { state: "absent" },
      exit: 1,
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const confirmation = new FakeConfirmation(false);
      const adapter = new FakeAdapter("codex", { inspect: entry.inspection });
      const voiceSkills = new FakeVoiceSkillServices();

      const output = await captureStderr(() => setup(entry.argv, dependencies([adapter], {
        confirmation,
        voiceSkills,
      })));

      assert.equal(output.code, entry.exit);
      assert.doesNotMatch(output.stderr, /voice-skill: unavailable/);
      assert.deepEqual(voiceSkills.calls, []);
      assert.equal(confirmation.messages.length, 1);
    });
  }
});

test("missing consent because no host needed authorization still reports zero-eligible voice unavailable", async (t) => {
  // No adapter required a prompt at all (every one is blocked/unreadable), so
  // consent was never withheld - there was nothing to withhold. This is a
  // different state than a decline: an explicit --voice-skill request is still
  // authorized, and with zero eligible hosts it must report the same
  // `voice-skill: unavailable` result an authorized `--yes` run would, in both
  // configure and remove mode.
  const cases: Array<{ name: string; argv: readonly string[]; exit: number }> = [
    { name: "configure, all hosts blocked (no prompt)", argv: ["--voice-skill"], exit: 1 },
    { name: "remove, all hosts blocked (no prompt)", argv: ["--remove", "--voice-skill"], exit: 1 },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const confirmation: ConfirmationPort = { async confirm() { throw new Error("blocked hosts must not prompt"); } };
      const adapter = new FakeAdapter("codex", { inspect: { state: "blocked", detail: "codex is not installed" } });
      const voiceSkills = new FakeVoiceSkillServices();

      const output = await captureStderr(() => setup(entry.argv, dependencies([adapter], {
        confirmation,
        voiceSkills,
      })));

      assert.equal(output.code, entry.exit);
      assert.ok(output.stderr.split("\n").includes("voice-skill: unavailable"));
      assert.deepEqual(voiceSkills.calls, []);
      assert.deepEqual(adapter.calls.map(({ method }) => method), ["inspect"]);
    });
  }
});

test("a detected voice-skill host forces real authorization before any mutation even when every MCP adapter is blocked", async (t) => {
  // This is the exact state that hid the round-3 consent bypass: every MCP
  // adapter is blocked/unreadable (so MCP work alone never needed a prompt),
  // but a Codex/Claude Code executable IS detected on PATH, so there is real
  // voice-skill work pending. Unlike the zero-detected-host test above,
  // `detected` is non-empty here on purpose - omitting it is precisely how
  // round 3's own regression sat in the one state where the bug was
  // invisible. `confirm()` throwing on any call proves an invocation is a
  // genuine prompt attempt, never a silent bypass: for a mutating mode
  // (configure/remove) the outcome must be either a real prompt attempt or
  // zero voice-skill calls - an unprompted mutation must never pass. `check`
  // never mutates (see setup.ts's check-mode consent skip), so it is
  // deliberately never gated behind a prompt; asserting it here documents
  // that choice rather than treating it as a gap.
  const cases: Array<{ name: string; argv: readonly string[]; mutates: boolean }> = [
    { name: "configure", argv: ["--voice-skill"], mutates: true },
    { name: "check", argv: ["--check", "--voice-skill"], mutates: false },
    { name: "remove", argv: ["--remove", "--voice-skill"], mutates: true },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const confirmation: ConfirmationPort = {
        async confirm() { throw new Error("prompt attempted"); },
      };
      const adapter = new FakeAdapter("codex", { inspect: { state: "blocked", detail: "codex is not installed" } });
      const voiceSkills = new FakeVoiceSkillServices();

      let promptAttempted = false;
      try {
        await captureStderr(() => setup(entry.argv, dependencies([adapter], {
          confirmation,
          voiceSkills,
          detected: ["codex"],
        })));
      } catch (error) {
        assert.equal(error instanceof Error ? error.message : error, "prompt attempted");
        promptAttempted = true;
      }

      if (entry.mutates) {
        assert.ok(promptAttempted || voiceSkills.calls.length === 0,
          `${entry.name}: voice skill mutated without ever being authorized`);
      } else {
        assert.equal(promptAttempted, false, "check must never require a consent prompt");
      }
    });
  }
});

test("explicit voice skill with no detected host reports unavailable while an independent Desktop MCP result still succeeds", async (t) => {
  const desired: McpRegistration = {
    name: "rocky",
    command: nodePath,
    args: [entryPath, "mcp"],
    env: { ROCKY_MCP_EXPOSURE: "sanitized", ROCKY_HOME: rockyHome },
  };
  const cases = [
    { mode: "configure" as const, argv: ["--yes", "--voice-skill"], resultKey: "configure" as const, status: "configured" as const },
    { mode: "check" as const, argv: ["--check", "--voice-skill"], resultKey: "check" as const, status: "healthy" as const },
    { mode: "remove" as const, argv: ["--remove", "--yes", "--voice-skill"], resultKey: "remove" as const, status: "removed" as const },
  ];

  for (const entry of cases) {
    await t.test(entry.mode, async () => {
      const desktopResult: SetupResult = entry.mode === "check"
        ? { client: "claude-desktop", status: "healthy", healthRegistration: desired }
        : { client: "claude-desktop", status: entry.status };
      const desktop = new FakeAdapter("claude-desktop", { [entry.resultKey]: desktopResult });
      const voiceSkills = new FakeVoiceSkillServices();

      const output = await captureStderr(() => setup(entry.argv, dependencies([desktop], {
        voiceSkills,
      })));

      assert.equal(output.code, 1);
      assert.equal(output.stdout, "");
      assert.ok(output.stderr.split("\n").includes("voice-skill: unavailable"));
      assert.match(output.stderr, new RegExp(`claude-desktop: ${entry.status}`));
      assert.deepEqual(desktop.calls.map(({ method }) => method), [entry.mode === "configure" ? "configure" : entry.mode]);
      assert.deepEqual(voiceSkills.calls, []);
      assert.doesNotMatch(output.stderr, /voice-skill claude-desktop/);
    });
  }
});

test("detected host with no matching resolved target reports unavailable and performs zero host operations", async () => {
  const codex = new FakeAdapter("codex", { configure: { client: "codex", status: "configured" } });
  const voiceSkills = new FakeVoiceSkillServices({}, undefined, [
    {
      host: "claude-code",
      destination: "/home/ada/.claude/skills/rocky-voice",
      backupRoot: "/home/ada/.claude/.rocky/backups/voice-skills",
    },
  ]);

  const output = await captureStderr(() => setup(
    ["--yes", "--voice-skill"],
    dependencies([codex], { detected: ["codex"], voiceSkills }),
  ));

  assert.equal(output.code, 1);
  assert.equal(output.stdout, "");
  assert.ok(output.stderr.split("\n").includes("voice-skill: unavailable"));
  assert.match(output.stderr, /codex: configured/);
  assert.deepEqual(voiceSkills.calls.map(({ method }) => method), ["resolve"]);
});

test("sanitized and raw configure print required projected-memory disclosures", async () => {
  const sanitized = new FakeAdapter("codex", {});
  const safeOutput = await captureStderr(() => setup(["--yes"], dependencies([sanitized])));
  assert.match(safeOutput.stderr, /configured MCP host may forward selected projected memory/i);
  assert.doesNotMatch(safeOutput.stderr, /working director|stderr excerpt/i);

  const raw = new FakeAdapter("codex", {});
  const rawOutput = await captureStderr(() => setup(
    ["--yes", "--mcp-exposure", "raw"],
    dependencies([raw]),
  ));
  assert.match(rawOutput.stderr, /configured MCP host may forward selected projected memory/i);
  assert.match(rawOutput.stderr, /raw exposure/i);
  assert.match(rawOutput.stderr, /working directories/i);
  assert.match(rawOutput.stderr, /stderr excerpts/i);
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

test("production adapter wiring passes the captured setup environment to Claude path resolution", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rocky-setup-claude-env-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const override = join(root, "override");
  mkdirSync(home, { recursive: true });
  mkdirSync(override, { recursive: true });
  writeFileSync(join(home, ".claude.json"), JSON.stringify({
    mcpServers: { rocky: { type: "stdio", command: "/foreign", args: [], env: {} } },
  }));
  writeFileSync(join(override, ".claude.json"), JSON.stringify({
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
  assert.match(usage.stderr, /run rocky --help/);
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
