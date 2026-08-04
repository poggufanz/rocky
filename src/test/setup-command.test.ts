import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import type { ProcessRunner, ProcessSession } from "../setup/process.js";
import { createPlatformServices } from "../setup/platform.js";
import {
  createConfirmationPort,
  setup,
  type ConfirmationPort,
  type SetupDependencies,
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

function dependencies(
  adapters: readonly SetupClientAdapter[],
  options: {
    confirmation?: ConfirmationPort;
    runner?: ProcessRunner;
    shell?: string;
    bashHookInstalled?: boolean;
  } = {},
): SetupDependencies {
  return {
    runner: options.runner ?? new HealthyRunner(),
    platform: createPlatformServices({
      platform: "linux",
      home: "/home/ada",
      env: { PATH: "", SHELL: options.shell ?? "/bin/zsh" },
      isWsl: false,
      bashHookInstalled: options.bashHookInstalled,
      fileExists: (path) => path === nodePath || path === entryPath,
    }),
    adapters,
    confirmation: options.confirmation ?? new FakeConfirmation(true),
    nodePath,
    entryPath,
    rockyHome,
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
  assert.match(output.stderr, /claude-code manual argv: \["mcp","add","--scope","user","--transport","stdio"/);
  assert.match(output.stderr, /claude-desktop manual config: \{"mcpServers":\{"rocky":\{"type":"stdio"/);
  assert.match(output.stderr, new RegExp(rockyHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
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
