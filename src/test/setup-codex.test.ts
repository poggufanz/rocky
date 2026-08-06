import test from "node:test";
import assert from "node:assert/strict";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  AppServerRequestError,
  createAppServerSessionFactory,
  isConfigVersionConflict,
  type AppServerSession,
  type AppServerSessionFactory,
} from "../setup/codex-app-server.js";
import { createCodexAdapter } from "../setup/codex.js";
import type { McpRegistration } from "../setup/clients.js";
import type {
  ProcessResult,
  ProcessRunOptions,
  ProcessRunner,
  ProcessSession,
  ProcessSessionOptions,
} from "../setup/process.js";

class FakeProcessSession implements ProcessSession {
  readonly written: string[] = [];
  readonly kills: Array<NodeJS.Signals | number | undefined> = [];
  endCount = 0;
  waitCount = 0;

  constructor(
    private readonly lines: Array<string | undefined | Promise<string | undefined>>,
    private readonly waitResult: Promise<ProcessResult> = Promise.resolve({
      status: 0,
      stdout: "",
      stderr: "",
    }),
    private readonly endError?: Error,
  ) {}

  async writeLine(line: string): Promise<void> {
    this.written.push(line);
  }

  async readLine(): Promise<string | undefined> {
    const line = this.lines.shift();
    return line instanceof Promise ? line : line;
  }

  end(): void {
    this.endCount += 1;
    if (this.endError !== undefined) throw this.endError;
  }

  kill(signal?: NodeJS.Signals | number): void {
    this.kills.push(signal);
  }

  wait(): Promise<ProcessResult> {
    this.waitCount += 1;
    return this.waitResult;
  }
}

interface OpenCall {
  command: string;
  args: string[];
  options?: ProcessSessionOptions;
}

class SessionRunner implements ProcessRunner {
  readonly calls: OpenCall[] = [];

  constructor(private readonly session: ProcessSession) {}

  async run(
    _command: string,
    _args: readonly string[],
    _options?: ProcessRunOptions,
  ): Promise<ProcessResult> {
    throw new Error("unexpected one-shot process call");
  }

  async openSession(
    command: string,
    args: readonly string[],
    options?: ProcessSessionOptions,
  ): Promise<ProcessSession> {
    const call: OpenCall = { command, args: [...args] };
    if (options !== undefined) call.options = options;
    this.calls.push(call);
    return this.session;
  }
}

interface RunCall {
  command: string;
  args: string[];
  options?: ProcessRunOptions;
}

class VersionRunner implements ProcessRunner {
  readonly calls: RunCall[] = [];

  constructor(private readonly results: ProcessResult[]) {}

  async run(
    command: string,
    args: readonly string[],
    options?: ProcessRunOptions,
  ): Promise<ProcessResult> {
    const call: RunCall = { command, args: [...args] };
    if (options !== undefined) call.options = options;
    this.calls.push(call);
    const result = this.results.shift();
    assert.ok(result, `unexpected process call: ${command} ${args.join(" ")}`);
    return result;
  }
}

type SessionStep = unknown | Error | ((method: string, params: Record<string, unknown>) => unknown);

class FakeAppServerSession implements AppServerSession {
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  closeCount = 0;

  constructor(
    readonly codexHome: string,
    private readonly steps: SessionStep[],
    private readonly closeError?: Error,
    private readonly closeHook?: () => void,
  ) {}

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.requests.push({ method, params });
    const step = this.steps.shift();
    assert.notEqual(step, undefined, `unexpected app-server request: ${method}`);
    if (step instanceof Error) throw step;
    return typeof step === "function" ? step(method, params) : step;
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.closeHook?.();
    if (this.closeError !== undefined) throw this.closeError;
  }
}

class FakeAppServerSessionFactory implements AppServerSessionFactory {
  readonly calls: Array<{ executable: string; codexHome: string }> = [];

  constructor(private readonly sessions: Array<AppServerSession | Error>) {}

  async open(executable: string, codexHome: string): Promise<AppServerSession> {
    this.calls.push({ executable, codexHome });
    const session = this.sessions.shift();
    if (session === undefined) throw new Error("unexpected app-server session");
    if (session instanceof Error) throw session;
    return session;
  }
}

const registration: McpRegistration = {
  name: "rocky",
  command: "/opt/node",
  args: ["/opt/rocky/dist/index.js", "mcp"],
  env: {
    ROCKY_MCP_EXPOSURE: "sanitized",
    ROCKY_HOME: "/home/ada/.rocky",
  },
};

const codexHome = "/home/ada/.codex";
const configPath = `${codexHome}/config.toml`;

function versionResult(version = "0.146.1"): ProcessResult {
  return { status: 0, stdout: `codex-cli ${version}\n`, stderr: "" };
}

function entryFor(value: McpRegistration = registration): Record<string, unknown> {
  return {
    command: value.command,
    args: [...value.args],
    env: { ...value.env },
  };
}

function baseSource(path = configPath, profile: string | null = null): Record<string, unknown> {
  return { type: "user", file: path, profile };
}

function origin(source: Record<string, unknown>, version = "sha256:one"): Record<string, unknown> {
  return { name: source, version };
}

function addOrigins(
  value: unknown,
  path: string,
  origins: Record<string, unknown>,
  source: Record<string, unknown>,
  version: string,
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => addOrigins(
      entry,
      `${path}.${index}`,
      origins,
      source,
      version,
    ));
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      addOrigins(entry, `${path}.${key}`, origins, source, version);
    }
    return;
  }
  origins[path] = origin(path === "mcp_servers.rocky.command" ? source : baseSource(), version);
}

function readResult(
  entry: Record<string, unknown> | undefined,
  source: Record<string, unknown> = baseSource(),
  version = "sha256:one",
): Record<string, unknown> {
  const origins: Record<string, unknown> = {};
  if (entry !== undefined) {
    addOrigins(entry, "mcp_servers.rocky", origins, source, version);
  }
  return {
    config: { mcp_servers: entry === undefined ? {} : { rocky: entry } },
    origins,
    layers: [{
      name: baseSource(),
      version,
      config: { mcp_servers: entry === undefined ? {} : { rocky: entry } },
    }],
  };
}

function readProjection(
  effectiveEntry: unknown,
  baseEntry: unknown,
  origins: Record<string, unknown>,
  version = "sha256:one",
  source: Record<string, unknown> = baseSource(),
): Record<string, unknown> {
  return {
    config: { mcp_servers: effectiveEntry === undefined ? {} : { rocky: effectiveEntry } },
    origins,
    layers: [{
      name: source,
      version,
      config: { mcp_servers: baseEntry === undefined ? {} : { rocky: baseEntry } },
    }],
  };
}

function writeResult(version = "sha256:two"): Record<string, unknown> {
  return {
    status: "ok",
    version,
    filePath: configPath,
    overriddenMetadata: null,
  };
}

function versionConflict(): AppServerRequestError {
  return new AppServerRequestError(
    -32600,
    { config_write_error_code: "configVersionConflict" },
  );
}

function temporaryRegistration(t: test.TestContext): McpRegistration {
  const root = mkdtempSync(join(tmpdir(), "rocky-codex-cas-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    ...registration,
    env: { ...registration.env, ROCKY_HOME: join(root, ".rocky") },
  };
}

function recoveryPath(detail: string | undefined): string {
  const match = /manual recovery:\s+([^;\n]+)/i.exec(detail ?? "");
  assert.ok(match?.[1], "result must report private recovery authority");
  return match[1];
}

function corruptRecoveryInPlace(
  desired: McpRegistration,
  mode: "equal-length" | "truncate",
): string {
  const directory = join(dirname(desired.env.ROCKY_HOME!), ".rocky-setup-recovery");
  const [name] = readdirSync(directory);
  assert.ok(name, "recovery artifact must exist before destructive request");
  const path = join(directory, name);
  const inode = lstatSync(path).ino;
  const original = readFileSync(path);
  const corrupted = mode === "truncate"
    ? original.subarray(0, Math.max(0, original.length - 1))
    : Buffer.from(original);
  if (mode === "equal-length" && corrupted.length > 0) corrupted[0] = corrupted[0]! ^ 0xff;
  writeFileSync(path, corrupted);
  assert.equal(lstatSync(path).ino, inode);
  return path;
}

function adapterWith(
  runner: ProcessRunner,
  sessionFactory: AppServerSessionFactory,
) {
  return createCodexAdapter({
    runner,
    executable: "/opt/codex",
    sessionFactory,
    env: { CODEX_HOME: codexHome },
    home: "/home/ada",
    cwd: "/work/project",
  });
}

const initializeResult = JSON.stringify({
  id: 1,
  result: {
    userAgent: "rocky/0.146.1",
    codexHome: "/tmp/disposable-codex",
    platformFamily: "unix",
    platformOs: "linux",
  },
});

const timeouts = {
  startupTimeoutMs: 25,
  requestTimeoutMs: 25,
  shutdownTimeoutMs: 25,
};

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

test("app-server performs handshake, config JSONL requests, and clean shutdown", async () => {
  const readResult = {
    config: { mcp_servers: {} },
    origins: {},
    layers: [{
      name: { type: "user", file: "/tmp/disposable-codex/config.toml", profile: null },
      version: "sha256:before",
      config: {},
    }],
  };
  const writeResult = {
    status: "ok",
    version: "sha256:after",
    filePath: "/tmp/disposable-codex/config.toml",
    overriddenMetadata: null,
  };
  const processSession = new FakeProcessSession([
    initializeResult,
    JSON.stringify({ id: 2, result: readResult }),
    JSON.stringify({ id: 3, result: writeResult }),
  ]);
  const runner = new SessionRunner(processSession);
  const factory = createAppServerSessionFactory(runner, timeouts);

  const session = await factory.open("/opt/codex", "/tmp/disposable-codex");
  assert.equal(session.codexHome, "/tmp/disposable-codex");
  assert.deepEqual(await session.request("config/read", { includeLayers: true }), readResult);
  assert.deepEqual(await session.request("config/value/write", {
    filePath: "/tmp/disposable-codex/config.toml",
    keyPath: "mcp_servers.rocky",
    value: { command: "/opt/node", args: ["/opt/rocky.js", "mcp"] },
    mergeStrategy: "upsert",
    expectedVersion: "sha256:before",
  }), writeResult);
  await session.close();

  assert.deepEqual(runner.calls, [{
    command: "/opt/codex",
    args: ["app-server", "--listen", "stdio://"],
    options: { env: { CODEX_HOME: "/tmp/disposable-codex" } },
  }]);
  assert.deepEqual(processSession.written.map((line) => JSON.parse(line)), [
    {
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "rocky", version: "0.2.1" },
        capabilities: { experimentalApi: true },
      },
    },
    { method: "initialized" },
    { id: 2, method: "config/read", params: { includeLayers: true } },
    {
      id: 3,
      method: "config/value/write",
      params: {
        filePath: "/tmp/disposable-codex/config.toml",
        keyPath: "mcp_servers.rocky",
        value: { command: "/opt/node", args: ["/opt/rocky.js", "mcp"] },
        mergeStrategy: "upsert",
        expectedVersion: "sha256:before",
      },
    },
  ]);
  assert.equal(processSession.endCount, 1);
  assert.equal(processSession.waitCount, 1);
  assert.deepEqual(processSession.kills, []);
});

test("app-server exposes configVersionConflict without echoing server text", async () => {
  const processSession = new FakeProcessSession([
    initializeResult,
    JSON.stringify({
      id: 2,
      error: {
        code: -32600,
        message: "Configuration changed: SECRET_SERVER_TEXT",
        data: { config_write_error_code: "configVersionConflict" },
      },
    }),
  ]);
  const factory = createAppServerSessionFactory(new SessionRunner(processSession), timeouts);
  const session = await factory.open("/opt/codex", "/tmp/disposable-codex");

  await assert.rejects(
    session.request("config/value/write", {
      keyPath: "mcp_servers.rocky",
      value: null,
      mergeStrategy: "replace",
      expectedVersion: "sha256:stale",
    }),
    (error: unknown) => {
      assert.equal(isConfigVersionConflict(error), true);
      assert.doesNotMatch(error instanceof Error ? error.message : String(error), /SECRET_SERVER_TEXT/);
      return true;
    },
  );
  await session.close();
});

test("malformed JSONL fails generically and session can still be shut down", async () => {
  const processSession = new FakeProcessSession([initializeResult, "{SECRET_BAD_JSON"]);
  const factory = createAppServerSessionFactory(new SessionRunner(processSession), timeouts);
  const session = await factory.open("/opt/codex", "/tmp/disposable-codex");

  await assert.rejects(
    session.request("config/read", { includeLayers: true }),
    (error: unknown) => {
      assert.match(error instanceof Error ? error.message : String(error), /protocol/i);
      assert.doesNotMatch(error instanceof Error ? error.message : String(error), /SECRET_BAD_JSON/);
      return true;
    },
  );
  await session.close();
  assert.equal(processSession.endCount, 1);
});

test("request timeout is bounded and does not prevent session shutdown", async () => {
  const never = new Promise<string | undefined>(() => {});
  const processSession = new FakeProcessSession([initializeResult, never]);
  const factory = createAppServerSessionFactory(new SessionRunner(processSession), {
    ...timeouts,
    requestTimeoutMs: 5,
  });
  const session = await factory.open("/opt/codex", "/tmp/disposable-codex");

  await assert.rejects(
    session.request("config/read", { includeLayers: true }),
    /timed out/i,
  );
  await session.close();
  assert.equal(processSession.endCount, 1);
  assert.equal(processSession.waitCount, 1);
});

test("shutdown timeout escalates from EOF to TERM and KILL", async () => {
  const neverExit = new Promise<ProcessResult>(() => {});
  const processSession = new FakeProcessSession([initializeResult], neverExit);
  const factory = createAppServerSessionFactory(new SessionRunner(processSession), {
    ...timeouts,
    shutdownTimeoutMs: 5,
  });
  const session = await factory.open("/opt/codex", "/tmp/disposable-codex");

  await assert.rejects(session.close(), /shutdown/i);
  assert.equal(processSession.endCount, 1);
  assert.deepEqual(processSession.kills, ["SIGTERM", "SIGKILL"]);
  assert.equal(processSession.waitCount, 3);
});

test("late app-server acquisition is cleaned up after startup timeout", async () => {
  const processSession = new FakeProcessSession([initializeResult]);
  class LateRunner implements ProcessRunner {
    async run(): Promise<never> { throw new Error("unexpected run"); }
    async openSession(): Promise<ProcessSession> {
      await delay(20);
      return processSession;
    }
  }
  const factory = createAppServerSessionFactory(new LateRunner(), {
    ...timeouts,
    startupTimeoutMs: 5,
  });

  await assert.rejects(factory.open("/opt/codex", "/tmp/disposable-codex"), /timed out/i);
  await delay(30);

  assert.equal(processSession.endCount, 1);
  assert.equal(processSession.waitCount, 1);
});

test("throwing EOF still escalates through TERM and KILL", async () => {
  const neverExit = new Promise<ProcessResult>(() => {});
  const processSession = new FakeProcessSession(
    [initializeResult],
    neverExit,
    new Error("SECRET_EOF_FAILURE"),
  );
  const factory = createAppServerSessionFactory(new SessionRunner(processSession), {
    ...timeouts,
    shutdownTimeoutMs: 5,
  });
  const session = await factory.open("/opt/codex", "/tmp/disposable-codex");

  await assert.rejects(session.close(), /shutdown/i);
  assert.equal(processSession.endCount, 1);
  assert.deepEqual(processSession.kills, ["SIGTERM", "SIGKILL"]);
});

test("rejected process wait still escalates through TERM and KILL", async () => {
  const processSession = new FakeProcessSession(
    [initializeResult],
    Promise.reject(new Error("SECRET_WAIT_REJECTION")),
  );
  const session = await createAppServerSessionFactory(
    new SessionRunner(processSession),
    timeouts,
  ).open("/opt/codex", "/tmp/disposable-codex");

  await assert.rejects(session.close(), (error: unknown) => {
    assert.doesNotMatch(
      error instanceof Error ? error.message : String(error),
      /SECRET_WAIT_REJECTION/,
    );
    return true;
  });
  assert.deepEqual(processSession.kills, ["SIGTERM", "SIGKILL"]);
});

test("nonzero or errored app-server exit is never classified as clean", async (t) => {
  const cases: ProcessResult[] = [
    { status: 1, stdout: "", stderr: "SECRET_DIRTY_EXIT" },
    { status: 0, stdout: "", stderr: "", error: new Error("SECRET_WAIT_ERROR") },
  ];
  for (const result of cases) {
    await t.test(result.error === undefined ? "nonzero" : "error", async () => {
      const processSession = new FakeProcessSession([initializeResult], Promise.resolve(result));
      const session = await createAppServerSessionFactory(
        new SessionRunner(processSession),
        timeouts,
      ).open("/opt/codex", "/tmp/disposable-codex");
      await assert.rejects(session.close(), (error: unknown) => {
        assert.doesNotMatch(
          error instanceof Error ? error.message : String(error),
          /SECRET_DIRTY_EXIT|SECRET_WAIT_ERROR/,
        );
        return true;
      });
    });
  }
});

test("one absolute request deadline covers write and response without reset", async () => {
  class SlowSession extends FakeProcessSession {
    private requestWritten = false;
    override async writeLine(line: string): Promise<void> {
      const message = JSON.parse(line) as { id?: number };
      if (message.id === 2) {
        await delay(20);
        this.requestWritten = true;
      }
      return super.writeLine(line);
    }
    override async readLine(): Promise<string | undefined> {
      if (this.requestWritten) await delay(20);
      return super.readLine();
    }
  }
  const processSession = new SlowSession([
    initializeResult,
    JSON.stringify({ id: 2, result: { ok: true } }),
  ]);
  const session = await createAppServerSessionFactory(new SessionRunner(processSession), {
    ...timeouts,
    requestTimeoutMs: 30,
  }).open("/opt/codex", "/tmp/disposable-codex");

  await assert.rejects(session.request("config/read", { includeLayers: true }), /timed out/i);
  await session.close();
});

test("one absolute startup deadline covers acquisition and initialization without reset", async () => {
  class SlowStartupSession extends FakeProcessSession {
    override async readLine(): Promise<string | undefined> {
      await delay(15);
      return super.readLine();
    }
  }
  const processSession = new SlowStartupSession([initializeResult]);
  class SlowStartupRunner implements ProcessRunner {
    async run(): Promise<never> { throw new Error("unexpected run"); }
    async openSession(): Promise<ProcessSession> {
      await delay(15);
      return processSession;
    }
  }

  await assert.rejects(
    createAppServerSessionFactory(new SlowStartupRunner(), {
      ...timeouts,
      startupTimeoutMs: 25,
    }).open("/opt/codex", "/tmp/disposable-codex"),
    /timed out/i,
  );
  assert.equal(processSession.endCount, 1);
});

test("notifications are bounded and malformed notification envelopes fail closed", async (t) => {
  const cases = [
    {
      name: "count bound",
      messages: [
        ...Array.from({ length: 65 }, (_, index) => JSON.stringify({
          method: "config/changed",
          params: { index },
        })),
        JSON.stringify({ id: 2, result: { tooLate: true } }),
      ],
    },
    {
      name: "malformed envelope",
      messages: [JSON.stringify({ method: "config/changed", result: { secret: "SECRET" } })],
    },
    {
      name: "wrong response id",
      messages: [JSON.stringify({ id: 99, result: { secret: "SECRET_WRONG_ID" } })],
    },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const processSession = new FakeProcessSession([initializeResult, ...entry.messages]);
      const session = await createAppServerSessionFactory(
        new SessionRunner(processSession),
        { ...timeouts, requestTimeoutMs: 1_000 },
      ).open("/opt/codex", "/tmp/disposable-codex");
      await assert.rejects(session.request("config/read", { includeLayers: true }), /protocol|timed out/i);
      await session.close();
    });
  }
});

test("initialized Codex home must be absolute and exactly requested", async (t) => {
  const cases = ["relative-codex", "/tmp/disposable-codex/../disposable-codex"];
  for (const initializedHome of cases) {
    await t.test(initializedHome, async () => {
      const processSession = new FakeProcessSession([JSON.stringify({
        id: 1,
        result: { userAgent: "codex-cli/0.146.1", codexHome: initializedHome },
      })]);
      await assert.rejects(
        createAppServerSessionFactory(new SessionRunner(processSession), timeouts)
          .open("/opt/codex", "/tmp/disposable-codex"),
        /protocol/i,
      );
      assert.equal(processSession.endCount, 1);
    });
  }
});

test("base user provenance at resolved CODEX_HOME is accepted and drives health", async () => {
  const storedRaw: McpRegistration = {
    ...registration,
    env: { ...registration.env, ROCKY_MCP_EXPOSURE: "raw" },
  };
  const inspectSession = new FakeAppServerSession(codexHome, [readResult(entryFor(registration))]);
  const checkSession = new FakeAppServerSession(codexHome, [readResult(entryFor(storedRaw))]);
  const runner = new VersionRunner([versionResult(), versionResult()]);
  const factory = new FakeAppServerSessionFactory([inspectSession, checkSession]);
  const adapter = adapterWith(runner, factory);

  const inspection = await adapter.inspect(registration);
  const checked = await adapter.check(registration);

  assert.equal(inspection.state, "identical");
  assert.notEqual(inspection.snapshot, undefined);
  assert.deepEqual(checked, {
    client: "codex",
    status: "healthy",
    healthRegistration: storedRaw,
  });
  assert.deepEqual(inspectSession.requests, [{
    method: "config/read",
    params: { includeLayers: true },
  }]);
  assert.deepEqual(checkSession.requests, inspectSession.requests);
  assert.equal(inspectSession.closeCount, 1);
  assert.equal(checkSession.closeCount, 1);
  assert.deepEqual(factory.calls, [
    { executable: "/opt/codex", codexHome },
    { executable: "/opt/codex", codexHome },
  ]);
  assert.equal(runner.calls.every((call) => call.args.join(" ") === "--version"), true);
  assert.equal(runner.calls.every((call) => (call.options?.timeoutMs ?? 0) > 0), true);
});

test("non-base provenance classes and wrong user config path are rejected", async (t) => {
  const cases: Array<{ name: string; source: Record<string, unknown> }> = [
    { name: "project", source: { type: "project", dotCodexFolder: "/work/.codex" } },
    { name: "profile", source: baseSource(configPath, "work") },
    { name: "session", source: { type: "sessionFlags" } },
    { name: "system", source: { type: "system", file: "/etc/codex/config.toml" } },
    { name: "MDM", source: { type: "mdm", domain: "example", key: "managed" } },
    {
      name: "enterprise",
      source: { type: "enterpriseManaged", id: "policy", name: "Managed policy" },
    },
    {
      name: "legacy",
      source: { type: "legacyManagedConfigTomlFromFile", file: "/etc/codex/managed.toml" },
    },
    { name: "unknown", source: { type: "futurePolicy", secret: "SECRET_ORIGIN" } },
    { name: "wrong config path", source: baseSource("/home/ada/other/config.toml") },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const session = new FakeAppServerSession(codexHome, [
        readResult(entryFor(registration), entry.source),
      ]);
      const adapter = adapterWith(
        new VersionRunner([versionResult()]),
        new FakeAppServerSessionFactory([session]),
      );

      const inspection = await adapter.inspect(registration);

      assert.equal(inspection.state, "conflict");
      assert.match(inspection.detail ?? "", /provenance/i);
      assert.doesNotMatch(inspection.detail ?? "", /SECRET_ORIGIN|Managed policy|other\/config/);
      assert.equal(session.closeCount, 1);
    });
  }
});

test("missing layers, origins, or matching base-user version is unreadable", async (t) => {
  const valid = readResult(entryFor(registration));
  const cases: Array<{ name: string; mutate(value: Record<string, unknown>): void }> = [
    { name: "layers", mutate(value) { delete value.layers; } },
    { name: "origins", mutate(value) { delete value.origins; } },
    {
      name: "base layer",
      mutate(value) {
        value.layers = [{
          name: { type: "system", file: "/etc/codex/config.toml" },
          version: "sha256:system",
          config: {},
        }];
      },
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const malformed = structuredClone(valid);
      entry.mutate(malformed);
      const session = new FakeAppServerSession(codexHome, [malformed]);
      const adapter = adapterWith(
        new VersionRunner([versionResult()]),
        new FakeAppServerSessionFactory([session]),
      );

      const inspection = await adapter.inspect(registration);

      assert.equal(inspection.state, "unreadable");
      assert.doesNotMatch(inspection.detail ?? "", /mcp_servers|sha256|etc\/codex/);
      assert.equal(session.closeCount, 1);
    });
  }
});

test("effective Rocky state that disagrees with base layer is never authorized", async () => {
  const inconsistent = readResult(entryFor(registration));
  (inconsistent.config as Record<string, unknown>).mcp_servers = {
    rocky: "SECRET_MALFORMED_EFFECTIVE_STATE",
  };
  const session = new FakeAppServerSession(codexHome, [inconsistent]);
  const adapter = adapterWith(
    new VersionRunner([versionResult()]),
    new FakeAppServerSessionFactory([session]),
  );

  const inspection = await adapter.inspect(registration);

  assert.notEqual(inspection.state, "identical");
  assert.doesNotMatch(inspection.detail ?? "", /SECRET_MALFORMED_EFFECTIVE_STATE/);
});

test("effective registration fields must agree with the base layer before any operation is authorized", async () => {
  const base = entryFor(registration);
  const effective = { ...base, command: "/foreign/effective", enabled: false };
  const response = readResult(base);
  (response.config as Record<string, unknown>).mcp_servers = { rocky: effective };
  const sessions = [
    new FakeAppServerSession(codexHome, [structuredClone(response)]),
    new FakeAppServerSession(codexHome, [structuredClone(response)]),
    new FakeAppServerSession(codexHome, [structuredClone(response)]),
  ];
  const adapter = adapterWith(
    new VersionRunner([versionResult(), versionResult(), versionResult()]),
    new FakeAppServerSessionFactory([...sessions]),
  );

  assert.notEqual((await adapter.inspect(registration)).state, "identical");
  assert.equal((await adapter.check(registration)).status, "failed");
  assert.equal((await adapter.remove(registration)).status, "failed");
  assert.deepEqual(sessions.map((session) => session.requests.map(({ method }) => method)), [
    ["config/read"],
    ["config/read"],
    ["config/read"],
  ]);
});

test("effective-only unknown, empty-container, null, and tombstone state fails closed", async (t) => {
  const base = entryFor(registration);
  const baseResponse = readResult(base);
  const baseOrigins = structuredClone(baseResponse.origins as Record<string, unknown>);
  const cases: Array<{ name: string; effective: unknown; base: unknown; origins?: Record<string, unknown> }> = [
    { name: "unknown scalar", effective: { ...base, future_setting: "foreign" }, base },
    { name: "empty object", effective: { ...base, future_setting: {} }, base: { ...base, future_setting: {} } },
    { name: "empty array", effective: { ...base, future_setting: [] }, base: { ...base, future_setting: [] } },
    { name: "null", effective: { ...base, future_setting: null }, base: { ...base, future_setting: null } },
    { name: "root tombstone", effective: null, base: null },
    {
      name: "foreign origin without values",
      effective: undefined,
      base: undefined,
      origins: {
        "mcp_servers.rocky.command": origin({ type: "project", dotCodexFolder: "/work/.codex" }),
      },
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const session = new FakeAppServerSession(codexHome, [
        readProjection(entry.effective, entry.base, entry.origins ?? structuredClone(baseOrigins)),
      ]);
      const adapter = adapterWith(
        new VersionRunner([versionResult()]),
        new FakeAppServerSessionFactory([session]),
      );

      const configured = await adapter.configure(registration, false);

      assert.notEqual(configured.status, "configured");
      assert.deepEqual(session.requests.map(({ method }) => method), ["config/read"]);
    });
  }
});

test("only explicit benign effective defaults may be absent from the raw base layer", async (t) => {
  const base = entryFor(registration);
  const response = readResult(base);
  const origins = response.origins as Record<string, unknown>;
  const cases = [
    { name: "known defaults", effective: { ...base, enabled: true, required: false }, expected: "identical" },
    { name: "disabled", effective: { ...base, enabled: false }, expected: "conflict" },
    { name: "required", effective: { ...base, required: true }, expected: "conflict" },
  ] as const;

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const session = new FakeAppServerSession(codexHome, [
        readProjection(entry.effective, base, structuredClone(origins)),
      ]);
      const inspection = await adapterWith(
        new VersionRunner([versionResult()]),
        new FakeAppServerSessionFactory([session]),
      ).inspect(registration);
      assert.equal(inspection.state, entry.expected);
    });
  }
});

test("check rejects owned core registrations carrying disabled, execution, policy, OAuth, or unknown metadata", async (t) => {
  const cases: Array<{ name: string; field: string; value: unknown }> = [
    { name: "disabled", field: "enabled", value: false },
    { name: "cwd", field: "cwd", value: "/secret/work" },
    { name: "startup timeout", field: "startup_timeout_sec", value: 15 },
    { name: "tool timeout", field: "tool_timeout_sec", value: 45 },
    { name: "approval", field: "default_tools_approval_mode", value: "prompt" },
    { name: "tool policy", field: "disabled_tools", value: ["secret_tool"] },
    { name: "OAuth", field: "oauth", value: { access_token: "secret-token" } },
    { name: "unknown", field: "future_metadata", value: { secret: "future-secret" } },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const stored = { ...entryFor(registration), [entry.field]: entry.value };
      const session = new FakeAppServerSession(codexHome, [readResult(stored)]);
      const checked = await adapterWith(
        new VersionRunner([versionResult()]),
        new FakeAppServerSessionFactory([session]),
      ).check(registration);

      assert.equal(checked.status, "failed");
      assert.equal(checked.healthRegistration, undefined);
      assert.doesNotMatch(checked.detail ?? "", /secret|future_metadata|disabled_tools/);
    });
  }
});

test("official config paths and versions must be absolute, exact, and nonempty", async (t) => {
  const aliasedPath = `${codexHome}/../.codex/config.toml`;
  const relativePath = relative(process.cwd(), configPath);
  const responseWithLayerPath = (path: string): Record<string, unknown> => {
    const response = readResult(entryFor(registration));
    (response.layers as Array<Record<string, unknown>>)[0]!.name = baseSource(path);
    return response;
  };
  const cases: Array<{ name: string; response: Record<string, unknown> }> = [
    { name: "normalized alias", response: responseWithLayerPath(aliasedPath) },
    { name: "relative source", response: responseWithLayerPath(relativePath) },
    { name: "empty layer version", response: readResult(entryFor(registration), baseSource(), "") },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const session = new FakeAppServerSession(codexHome, [entry.response]);
      const inspection = await adapterWith(
        new VersionRunner([versionResult()]),
        new FakeAppServerSessionFactory([session]),
      ).inspect(registration);
      assert.equal(inspection.state, "unreadable");
    });
  }
});

test("absent registration is added with expectedVersion CAS and exact post-state verification", async () => {
  const session = new FakeAppServerSession(codexHome, [
    readResult(undefined),
    writeResult(),
    readResult(entryFor(registration), baseSource(), "sha256:two"),
  ]);
  const adapter = adapterWith(
    new VersionRunner([versionResult()]),
    new FakeAppServerSessionFactory([session]),
  );

  const configured = await adapter.configure(registration, false);

  assert.deepEqual(configured, { client: "codex", status: "configured" });
  assert.deepEqual(session.requests, [
    { method: "config/read", params: { includeLayers: true } },
    {
      method: "config/value/write",
      params: {
        filePath: configPath,
        keyPath: "mcp_servers.rocky",
        value: entryFor(registration),
        mergeStrategy: "upsert",
        expectedVersion: "sha256:one",
      },
    },
    { method: "config/read", params: { includeLayers: true } },
  ]);
  assert.equal(session.closeCount, 1);
});

test("successful writes require exact absolute response paths and a nonempty advanced bound version", async (t) => {
  const malformedPath = writeResult();
  malformedPath.filePath = `${codexHome}/../.codex/config.toml`;
  const cases: Array<{ name: string; written: unknown; postVersion: string }> = [
    { name: "aliased write path", written: malformedPath, postVersion: "sha256:two" },
    { name: "empty write version", written: writeResult(""), postVersion: "" },
    { name: "post-read mismatch", written: writeResult("sha256:two"), postVersion: "sha256:three" },
    { name: "no version advance", written: writeResult("sha256:one"), postVersion: "sha256:one" },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const session = new FakeAppServerSession(codexHome, [
        readResult(undefined),
        entry.written,
        readResult(entryFor(registration), baseSource(), entry.postVersion),
      ]);
      const configured = await adapterWith(
        new VersionRunner([versionResult()]),
        new FakeAppServerSessionFactory([session]),
      ).configure(registration, false);

      assert.equal(configured.status, "failed");
      assert.deepEqual(configured.manualRegistration, registration);
    });
  }
});

test("concurrent appearance causes CAS conflict and leaves foreign entry untouched", async () => {
  const foreign = entryFor({ ...registration, command: "/opt/foreign-node" });
  let currentEntry: Record<string, unknown> | undefined;
  const session = new FakeAppServerSession(codexHome, [
    readResult(undefined),
    () => {
      currentEntry = foreign;
      throw versionConflict();
    },
  ]);
  const adapter = adapterWith(
    new VersionRunner([versionResult()]),
    new FakeAppServerSessionFactory([session]),
  );

  const configured = await adapter.configure(registration, false);

  assert.equal(configured.status, "failed");
  assert.deepEqual(configured.manualRegistration, registration);
  assert.match(configured.detail ?? "", /changed|conflict/i);
  assert.deepEqual(currentEntry, foreign);
  assert.deepEqual(session.requests.map(({ method }) => method), [
    "config/read",
    "config/value/write",
  ]);
});

test("identical registration is a no-op", async () => {
  const session = new FakeAppServerSession(codexHome, [readResult(entryFor(registration))]);
  const adapter = adapterWith(
    new VersionRunner([versionResult()]),
    new FakeAppServerSessionFactory([session]),
  );

  assert.deepEqual(await adapter.configure(registration, false), {
    client: "codex",
    status: "already-configured",
  });
  assert.deepEqual(session.requests.map(({ method }) => method), ["config/read"]);
});

test("different base-user entry needs confirmation, while foreign provenance refuses replacement", async () => {
  const prior = entryFor({ ...registration, command: "/opt/prior-node" });
  const confirmationSession = new FakeAppServerSession(codexHome, [readResult(prior)]);
  const foreignSession = new FakeAppServerSession(codexHome, [
    readResult(prior, { type: "project", dotCodexFolder: "/work/.codex" }),
  ]);
  const adapter = adapterWith(
    new VersionRunner([versionResult(), versionResult()]),
    new FakeAppServerSessionFactory([confirmationSession, foreignSession]),
  );

  assert.deepEqual(await adapter.configure(registration, false), {
    client: "codex",
    status: "requires-confirmation",
    detail: "Codex already has a different rocky registration",
    manualRegistration: registration,
  });
  const refused = await adapter.configure(registration, true);
  assert.equal(refused.status, "failed");
  assert.deepEqual(refused.manualRegistration, registration);
  assert.match(refused.detail ?? "", /provenance|manual/i);
  assert.deepEqual(foreignSession.requests.map(({ method }) => method), ["config/read"]);
});

test("replacement uses one CAS batch and removes recovery artifact only after exact verification", async (t) => {
  const desired = temporaryRegistration(t);
  const prior = entryFor({
    ...desired,
    command: "/opt/prior-node",
    env: { ...desired.env, PRIOR_TOKEN: "secret-prior" },
  });
  const session = new FakeAppServerSession(codexHome, [
    readResult(prior),
    writeResult(),
    readResult(entryFor(desired), baseSource(), "sha256:two"),
  ]);
  const adapter = adapterWith(
    new VersionRunner([versionResult()]),
    new FakeAppServerSessionFactory([session]),
  );

  const configured = await adapter.configure(desired, true);

  assert.deepEqual(configured, { client: "codex", status: "configured" });
  assert.deepEqual(session.requests[1], {
    method: "config/batchWrite",
    params: {
      filePath: configPath,
      expectedVersion: "sha256:one",
      edits: [
        { keyPath: "mcp_servers.rocky", value: null, mergeStrategy: "replace" },
        {
          keyPath: "mcp_servers.rocky",
          value: entryFor(desired),
          mergeStrategy: "upsert",
        },
      ],
    },
  });
  const recoveryDirectory = join(dirname(desired.env.ROCKY_HOME!), ".rocky-setup-recovery");
  assert.deepEqual(readdirSync(recoveryDirectory), []);
  assert.equal(lstatSync(recoveryDirectory).mode & 0o077, 0);
});

test("replacement race preserves foreign state and retains private recovery authority", async (t) => {
  const desired = temporaryRegistration(t);
  const prior = entryFor({ ...desired, command: "/opt/prior-node" });
  const foreign = entryFor({ ...desired, command: "/opt/foreign-node" });
  let currentEntry = prior;
  const session = new FakeAppServerSession(codexHome, [
    readResult(prior),
    () => {
      currentEntry = foreign;
      throw versionConflict();
    },
  ]);
  const adapter = adapterWith(
    new VersionRunner([versionResult()]),
    new FakeAppServerSessionFactory([session]),
  );

  const configured = await adapter.configure(desired, true);

  assert.equal(configured.status, "failed");
  assert.deepEqual(configured.manualRegistration, desired);
  assert.deepEqual(currentEntry, foreign);
  const artifact = recoveryPath(configured.detail);
  assert.deepEqual(JSON.parse(readFileSync(artifact, "utf8")), prior);
  assert.equal(lstatSync(artifact).mode & 0o077, 0);
  assert.deepEqual(session.requests.map(({ method }) => method), [
    "config/read",
    "config/batchWrite",
  ]);
});

test("replacement conflict never reports same-inode overwritten recovery bytes as authority", async (t) => {
  const desired = temporaryRegistration(t);
  const prior = entryFor({ ...desired, command: "/opt/prior-node" });
  let artifact = "";
  const session = new FakeAppServerSession(codexHome, [
    readResult(prior),
    () => {
      artifact = corruptRecoveryInPlace(desired, "equal-length");
      throw versionConflict();
    },
  ]);

  const configured = await adapterWith(
    new VersionRunner([versionResult()]),
    new FakeAppServerSessionFactory([session]),
  ).configure(desired, true);

  assert.equal(configured.status, "failed");
  assert.match(configured.detail ?? "", /recovery artifact is unavailable/i);
  assert.doesNotMatch(configured.detail ?? "", /manual recovery:/i);
  assert.equal(lstatSync(artifact).isFile(), true);
});

test("replacement conflict revalidates retained recovery authority after clean session close", async (t) => {
  const desired = temporaryRegistration(t);
  const prior = entryFor({ ...desired, command: "/opt/prior-node" });
  let artifact = "";
  const session = new FakeAppServerSession(
    codexHome,
    [readResult(prior), versionConflict()],
    undefined,
    () => {
      artifact = corruptRecoveryInPlace(desired, "equal-length");
    },
  );

  const configured = await adapterWith(
    new VersionRunner([versionResult()]),
    new FakeAppServerSessionFactory([session]),
  ).configure(desired, true);

  assert.equal(configured.status, "failed");
  assert.match(configured.detail ?? "", /recovery artifact is unavailable/i);
  assert.doesNotMatch(configured.detail ?? "", /manual recovery:/i);
  assert.equal(lstatSync(artifact).isFile(), true);
  assert.equal(session.closeCount, 1);
});

test("replacement post-state mismatch is failure with retained recovery authority", async (t) => {
  const desired = temporaryRegistration(t);
  const prior = entryFor({ ...desired, command: "/opt/prior-node" });
  const mismatched = entryFor({ ...desired, command: "/opt/unexpected-node" });
  const session = new FakeAppServerSession(codexHome, [
    readResult(prior),
    writeResult(),
    readResult(mismatched, baseSource(), "sha256:two"),
  ]);
  const adapter = adapterWith(
    new VersionRunner([versionResult()]),
    new FakeAppServerSessionFactory([session]),
  );

  const configured = await adapter.configure(desired, true);

  assert.equal(configured.status, "failed");
  assert.match(configured.detail ?? "", /verif/i);
  assert.deepEqual(JSON.parse(readFileSync(recoveryPath(configured.detail), "utf8")), prior);
});

test("replacement verification is bound to the exact advanced write version", async (t) => {
  const desired = temporaryRegistration(t);
  const prior = entryFor({ ...desired, command: "/opt/prior-node" });
  const session = new FakeAppServerSession(codexHome, [
    readResult(prior),
    writeResult("sha256:two"),
    readResult(entryFor(desired), baseSource(), "sha256:three"),
  ]);

  const configured = await adapterWith(
    new VersionRunner([versionResult()]),
    new FakeAppServerSessionFactory([session]),
  ).configure(desired, true);

  assert.equal(configured.status, "failed");
  assert.deepEqual(JSON.parse(readFileSync(recoveryPath(configured.detail), "utf8")), prior);
});

test("replacement cleanup refuses to delete a same-inode truncated recovery artifact", async (t) => {
  const desired = temporaryRegistration(t);
  const prior = entryFor({ ...desired, command: "/opt/prior-node" });
  let artifact = "";
  const session = new FakeAppServerSession(codexHome, [
    readResult(prior),
    writeResult(),
    () => {
      artifact = corruptRecoveryInPlace(desired, "truncate");
      return readResult(entryFor(desired), baseSource(), "sha256:two");
    },
  ]);

  const configured = await adapterWith(
    new VersionRunner([versionResult()]),
    new FakeAppServerSessionFactory([session]),
  ).configure(desired, true);

  assert.equal(configured.status, "failed");
  assert.match(configured.detail ?? "", /recovery artifact is unavailable/i);
  assert.equal(lstatSync(artifact).isFile(), true);
});

test("owned removal uses CAS delete, verifies absence, and retains recovery artifact", async (t) => {
  const desired = temporaryRegistration(t);
  const storedRaw: McpRegistration = {
    ...desired,
    env: { ...desired.env, ROCKY_MCP_EXPOSURE: "raw" },
  };
  const prior = entryFor(storedRaw);
  const session = new FakeAppServerSession(codexHome, [
    readResult(prior),
    writeResult(),
    readResult(undefined, baseSource(), "sha256:two"),
  ]);
  const adapter = adapterWith(
    new VersionRunner([versionResult()]),
    new FakeAppServerSessionFactory([session]),
  );

  const removed = await adapter.remove(desired);

  assert.equal(removed.status, "removed");
  assert.equal(removed.manualRegistration, undefined);
  assert.deepEqual(session.requests, [
    { method: "config/read", params: { includeLayers: true } },
    {
      method: "config/value/write",
      params: {
        filePath: configPath,
        keyPath: "mcp_servers.rocky",
        value: null,
        mergeStrategy: "replace",
        expectedVersion: "sha256:one",
      },
    },
    { method: "config/read", params: { includeLayers: true } },
  ]);
  const artifact = recoveryPath(removed.detail);
  assert.deepEqual(JSON.parse(readFileSync(artifact, "utf8")), prior);
  assert.equal(lstatSync(artifact).mode & 0o077, 0);
});

test("remove race leaves foreign replacement untouched and retains recovery authority", async (t) => {
  const desired = temporaryRegistration(t);
  const prior = entryFor(desired);
  const foreign = entryFor({ ...desired, command: "/opt/foreign-node" });
  let currentEntry = prior;
  const session = new FakeAppServerSession(codexHome, [
    readResult(prior),
    () => {
      currentEntry = foreign;
      throw versionConflict();
    },
  ]);
  const adapter = adapterWith(
    new VersionRunner([versionResult()]),
    new FakeAppServerSessionFactory([session]),
  );

  const removed = await adapter.remove(desired);

  assert.equal(removed.status, "failed");
  assert.deepEqual(currentEntry, foreign);
  assert.deepEqual(JSON.parse(readFileSync(recoveryPath(removed.detail), "utf8")), prior);
  assert.deepEqual(session.requests.map(({ method }) => method), [
    "config/read",
    "config/value/write",
  ]);
});

test("remove conflict never reports same-inode truncated recovery bytes as authority", async (t) => {
  const desired = temporaryRegistration(t);
  const prior = entryFor(desired);
  let artifact = "";
  const session = new FakeAppServerSession(codexHome, [
    readResult(prior),
    () => {
      artifact = corruptRecoveryInPlace(desired, "truncate");
      throw versionConflict();
    },
  ]);

  const removed = await adapterWith(
    new VersionRunner([versionResult()]),
    new FakeAppServerSessionFactory([session]),
  ).remove(desired);

  assert.equal(removed.status, "failed");
  assert.match(removed.detail ?? "", /recovery artifact is unavailable/i);
  assert.doesNotMatch(removed.detail ?? "", /manual recovery:/i);
  assert.equal(lstatSync(artifact).isFile(), true);
});

test("successful removal fails closed when retained recovery bytes were overwritten in place", async (t) => {
  const desired = temporaryRegistration(t);
  const prior = entryFor(desired);
  let artifact = "";
  const session = new FakeAppServerSession(codexHome, [
    readResult(prior),
    () => {
      artifact = corruptRecoveryInPlace(desired, "equal-length");
      return writeResult();
    },
    readResult(undefined, baseSource(), "sha256:two"),
  ]);

  const removed = await adapterWith(
    new VersionRunner([versionResult()]),
    new FakeAppServerSessionFactory([session]),
  ).remove(desired);

  assert.equal(removed.status, "failed");
  assert.match(removed.detail ?? "", /recovery artifact is unavailable/i);
  assert.doesNotMatch(removed.detail ?? "", /manual recovery:/i);
  assert.equal(lstatSync(artifact).isFile(), true);
});

test("successful removal revalidates retained recovery authority after clean session close", async (t) => {
  const desired = temporaryRegistration(t);
  const prior = entryFor(desired);
  let artifact = "";
  const session = new FakeAppServerSession(
    codexHome,
    [
      readResult(prior),
      writeResult(),
      readResult(undefined, baseSource(), "sha256:two"),
    ],
    undefined,
    () => {
      artifact = corruptRecoveryInPlace(desired, "truncate");
    },
  );

  const removed = await adapterWith(
    new VersionRunner([versionResult()]),
    new FakeAppServerSessionFactory([session]),
  ).remove(desired);

  assert.equal(removed.status, "failed");
  assert.match(removed.detail ?? "", /recovery artifact is unavailable/i);
  assert.doesNotMatch(removed.detail ?? "", /manual recovery:/i);
  assert.equal(lstatSync(artifact).isFile(), true);
  assert.equal(session.closeCount, 1);
});

test("remove refuses ownership or provenance mismatch before mutation", async (t) => {
  const foreign = entryFor({ ...registration, command: "/opt/foreign-node" });
  const cases = [
    { name: "ownership", response: readResult(foreign) },
    {
      name: "provenance",
      response: readResult(entryFor(registration), {
        type: "project",
        dotCodexFolder: "/work/.codex",
      }),
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const session = new FakeAppServerSession(codexHome, [entry.response]);
      const adapter = adapterWith(
        new VersionRunner([versionResult()]),
        new FakeAppServerSessionFactory([session]),
      );

      const removed = await adapter.remove(registration);

      assert.equal(removed.status, "failed");
      assert.match(removed.detail ?? "", /owned|provenance/i);
      assert.deepEqual(session.requests.map(({ method }) => method), ["config/read"]);
    });
  }
});

test("remove post-state mismatch is failure with retained recovery authority", async (t) => {
  const desired = temporaryRegistration(t);
  const prior = entryFor(desired);
  const session = new FakeAppServerSession(codexHome, [
    readResult(prior),
    writeResult(),
    readResult(prior, baseSource(), "sha256:two"),
  ]);
  const adapter = adapterWith(
    new VersionRunner([versionResult()]),
    new FakeAppServerSessionFactory([session]),
  );

  const removed = await adapter.remove(desired);

  assert.equal(removed.status, "failed");
  assert.match(removed.detail ?? "", /verif/i);
  assert.deepEqual(JSON.parse(readFileSync(recoveryPath(removed.detail), "utf8")), prior);
});

test("removal verification is bound to the exact advanced write version", async (t) => {
  const desired = temporaryRegistration(t);
  const prior = entryFor(desired);
  const session = new FakeAppServerSession(codexHome, [
    readResult(prior),
    writeResult("sha256:two"),
    readResult(undefined, baseSource(), "sha256:three"),
  ]);

  const removed = await adapterWith(
    new VersionRunner([versionResult()]),
    new FakeAppServerSessionFactory([session]),
  ).remove(desired);

  assert.equal(removed.status, "failed");
  assert.deepEqual(JSON.parse(readFileSync(recoveryPath(removed.detail), "utf8")), prior);
});

test("missing Codex executable keeps existing skipped semantics without probing", async () => {
  const runner = new VersionRunner([]);
  const factory = new FakeAppServerSessionFactory([]);
  const adapter = createCodexAdapter({
    runner,
    sessionFactory: factory,
    env: { CODEX_HOME: codexHome },
    home: "/home/ada",
  });

  const results = await Promise.all([
    adapter.inspect(registration),
    adapter.configure(registration, false),
    adapter.remove(registration),
    adapter.check(registration),
  ]);

  assert.deepEqual(results, [
    { state: "blocked", detail: "Codex CLI is not installed" },
    { client: "codex", status: "skipped", detail: "Codex CLI is not installed" },
    { client: "codex", status: "skipped", detail: "Codex CLI is not installed" },
    { client: "codex", status: "skipped", detail: "Codex CLI is not installed" },
  ]);
  assert.deepEqual(runner.calls, []);
  assert.deepEqual(factory.calls, []);
});

test("old, timed-out, or missing app-server capability returns manual registration without mutation", async (t) => {
  const cases: Array<{
    name: string;
    version: ProcessResult;
    session?: AppServerSession | Error;
  }> = [
    { name: "old version", version: versionResult("0.145.9") },
    {
      name: "version timeout",
      version: {
        status: null,
        stdout: "",
        stderr: "SECRET_VERSION_TIMEOUT",
        error: new Error("SECRET_VERSION_TIMEOUT"),
      },
    },
    {
      name: "app-server missing",
      version: versionResult(),
      session: new Error("spawn ENOENT SECRET_APP_SERVER"),
    },
    {
      name: "app-server startup timeout",
      version: versionResult(),
      session: new Error("startup timed out SECRET_APP_SERVER"),
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const runner = new VersionRunner([entry.version]);
      const factory = new FakeAppServerSessionFactory(
        entry.session === undefined ? [] : [entry.session],
      );
      const configured = await adapterWith(runner, factory)
        .configure(registration, false);

      assert.equal(configured.status, "failed");
      assert.deepEqual(configured.manualRegistration, registration);
      assert.match(configured.detail ?? "", /manual registration/i);
      assert.doesNotMatch(
        configured.detail ?? "",
        /SECRET_VERSION_TIMEOUT|SECRET_APP_SERVER|ENOENT/,
      );
      assert.deepEqual(runner.calls[0]?.args, ["--version"]);
      assert.equal((runner.calls[0]?.options?.timeoutMs ?? 0) > 0, true);
      assert.equal(factory.calls.length, entry.session === undefined ? 0 : 1);
    });
  }
});

test("unsupported config read or expectedVersion write never invokes CLI mutation fallback", async (t) => {
  const cases: Array<{ name: string; steps: SessionStep[]; methods: string[] }> = [
    {
      name: "config read",
      steps: [new AppServerRequestError(-32601, { message: "SECRET_METHOD" })],
      methods: ["config/read"],
    },
    {
      name: "expectedVersion",
      steps: [
        readResult(undefined),
        new AppServerRequestError(-32602, { message: "SECRET_EXPECTED_VERSION" }),
      ],
      methods: ["config/read", "config/value/write"],
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const session = new FakeAppServerSession(codexHome, entry.steps);
      const runner = new VersionRunner([versionResult()]);
      const configured = await adapterWith(
        runner,
        new FakeAppServerSessionFactory([session]),
      ).configure(registration, false);

      assert.equal(configured.status, "failed");
      assert.deepEqual(configured.manualRegistration, registration);
      assert.match(configured.detail ?? "", /manual registration/i);
      assert.doesNotMatch(configured.detail ?? "", /SECRET_METHOD|SECRET_EXPECTED_VERSION/);
      assert.deepEqual(session.requests.map(({ method }) => method), entry.methods);
      assert.deepEqual(runner.calls.map(({ args }) => args), [["--version"]]);
      assert.equal(session.closeCount, 1);
    });
  }
});

test("session shutdown failure prevents configured success", async () => {
  const session = new FakeAppServerSession(
    codexHome,
    [readResult(entryFor(registration))],
    new Error("SECRET_SHUTDOWN_FAILURE"),
  );
  const configured = await adapterWith(
    new VersionRunner([versionResult()]),
    new FakeAppServerSessionFactory([session]),
  ).configure(registration, false);

  assert.equal(configured.status, "failed");
  assert.deepEqual(configured.manualRegistration, registration);
  assert.match(configured.detail ?? "", /manual registration/i);
  assert.doesNotMatch(configured.detail ?? "", /SECRET_SHUTDOWN_FAILURE/);
  assert.equal(session.closeCount, 1);
});

test("shutdown failure after destructive replacement retains and reports recovery authority", async (t) => {
  const desired = temporaryRegistration(t);
  const prior = entryFor({ ...desired, command: "/opt/prior-node" });
  const session = new FakeAppServerSession(
    codexHome,
    [
      readResult(prior),
      writeResult(),
      readResult(entryFor(desired), baseSource(), "sha256:two"),
    ],
    new Error("SECRET_DESTRUCTIVE_SHUTDOWN"),
  );
  const configured = await adapterWith(
    new VersionRunner([versionResult()]),
    new FakeAppServerSessionFactory([session]),
  ).configure(desired, true);

  assert.equal(configured.status, "failed");
  assert.doesNotMatch(configured.detail ?? "", /SECRET_DESTRUCTIVE_SHUTDOWN/);
  assert.deepEqual(JSON.parse(readFileSync(recoveryPath(configured.detail), "utf8")), prior);
});

test("dirty production app-server exit after replacement retains recovery authority", async (t) => {
  const desired = temporaryRegistration(t);
  const prior = entryFor({ ...desired, command: "/opt/prior-node" });
  const initialized = JSON.stringify({
    id: 1,
    result: { userAgent: "codex-cli/0.146.1", codexHome },
  });
  const processSession = new FakeProcessSession([
    initialized,
    JSON.stringify({ id: 2, result: readResult(prior) }),
    JSON.stringify({ id: 3, result: writeResult() }),
    JSON.stringify({ id: 4, result: readResult(entryFor(desired), baseSource(), "sha256:two") }),
  ], Promise.resolve({ status: 1, stdout: "", stderr: "SECRET_DIRTY_EXIT" }));
  const factory = createAppServerSessionFactory(new SessionRunner(processSession), timeouts);

  const configured = await adapterWith(
    new VersionRunner([versionResult()]),
    factory,
  ).configure(desired, true);

  assert.equal(configured.status, "failed");
  assert.match(configured.detail ?? "", /did not shut down cleanly/i);
  assert.doesNotMatch(configured.detail ?? "", /SECRET_DIRTY_EXIT/);
  assert.deepEqual(JSON.parse(readFileSync(recoveryPath(configured.detail), "utf8")), prior);
});

test("shutdown failure after destructive removal still reports retained recovery authority", async (t) => {
  const desired = temporaryRegistration(t);
  const prior = entryFor(desired);
  const session = new FakeAppServerSession(
    codexHome,
    [
      readResult(prior),
      writeResult(),
      readResult(undefined, baseSource(), "sha256:two"),
    ],
    new Error("SECRET_DESTRUCTIVE_SHUTDOWN"),
  );
  const removed = await adapterWith(
    new VersionRunner([versionResult()]),
    new FakeAppServerSessionFactory([session]),
  ).remove(desired);

  assert.equal(removed.status, "failed");
  assert.doesNotMatch(removed.detail ?? "", /SECRET_DESTRUCTIVE_SHUTDOWN/);
  assert.deepEqual(JSON.parse(readFileSync(recoveryPath(removed.detail), "utf8")), prior);
});

test("secret-bearing foreign config never appears in result detail", async () => {
  const secret = "SECRET_CONFIG_TOKEN_7f91";
  const foreign = entryFor({
    ...registration,
    command: "/opt/foreign-node",
    env: { ...registration.env, API_TOKEN: secret },
  });
  const response = readResult(foreign, {
    type: "enterpriseManaged",
    id: "policy",
    name: `managed-${secret}`,
  });
  (response.config as Record<string, unknown>).unrelated_secret = secret;
  const session = new FakeAppServerSession(codexHome, [response]);
  const configured = await adapterWith(
    new VersionRunner([versionResult()]),
    new FakeAppServerSessionFactory([session]),
  ).configure(registration, true);

  assert.equal(configured.status, "failed");
  assert.deepEqual(configured.manualRegistration, registration);
  assert.doesNotMatch(JSON.stringify(configured), new RegExp(secret));
  assert.deepEqual(session.requests.map(({ method }) => method), ["config/read"]);
});
