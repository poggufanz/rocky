import test from "node:test";
import assert from "node:assert/strict";
import fs, {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  type Stats,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createCodexAdapter } from "../setup/codex.js";
import type { McpRegistration } from "../setup/clients.js";
import type { ProcessResult, ProcessRunOptions, ProcessRunner } from "../setup/process.js";

const registration: McpRegistration = {
  name: "rocky",
  command: "/opt/node",
  args: ["/opt/rocky/dist/index.js", "mcp"],
  env: {
    ROCKY_MCP_EXPOSURE: "sanitized",
    ROCKY_HOME: "/home/ada/.rocky",
  },
};

const getArgs = ["mcp", "get", "rocky", "--json"];
const addArgs = [
  "mcp", "add",
  "--env", "ROCKY_MCP_EXPOSURE=sanitized",
  "--env", "ROCKY_HOME=/home/ada/.rocky",
  "rocky", "--", "/opt/node", "/opt/rocky/dist/index.js", "mcp",
];
const removeArgs = ["mcp", "remove", "rocky"];

interface RunnerCall {
  command: string;
  args: string[];
  options?: ProcessRunOptions;
}

function codexCall(args: readonly string[]): RunnerCall {
  return {
    command: "/opt/codex",
    args: [...args],
    options: { timeoutMs: 10_000 },
  };
}

class FakeRunner implements ProcessRunner {
  readonly calls: RunnerCall[] = [];

  constructor(private readonly results: ProcessResult[]) {}

  async run(command: string, args: readonly string[], options?: ProcessRunOptions): Promise<ProcessResult> {
    const call: RunnerCall = { command, args: [...args] };
    if (options !== undefined) call.options = options;
    this.calls.push(call);
    const result = this.results.shift();
    assert.ok(result, `unexpected process call: ${command} ${args.join(" ")}`);
    return result;
  }
}

function result(status: number, stdout = "", stderr = ""): ProcessResult {
  return { status, stdout, stderr };
}

function temporaryRegistration(t: test.TestContext): McpRegistration {
  const root = mkdtempSync(join(tmpdir(), "rocky-codex-recovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    ...registration,
    env: { ...registration.env, ROCKY_HOME: join(root, ".rocky") },
  };
}

function addArgumentsFor(value: McpRegistration): string[] {
  return [
    "mcp", "add",
    "--env", `ROCKY_MCP_EXPOSURE=${value.env.ROCKY_MCP_EXPOSURE}`,
    "--env", `ROCKY_HOME=${value.env.ROCKY_HOME}`,
    "rocky", "--", value.command, ...value.args,
  ];
}

function recoveryPath(detail: string | undefined): string {
  const match = /manual recovery:\s+([^;\n]+)/i.exec(detail ?? "");
  assert.ok(match?.[1], "result must report a recovery artifact path");
  return match[1];
}

function simulateWindowsArtifactMetadata(
  t: test.TestContext,
  mutate: (metadata: Stats) => void = () => {},
): void {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const originalLstat = fs.lstatSync;
  assert.ok(platform);
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  const injectedLstat = ((path: fs.PathLike, options?: fs.StatSyncOptions) => {
    const metadata = originalLstat(path, options as never) as Stats;
    if (basename(String(path)).startsWith("codex-rocky-")) {
      Object.defineProperty(metadata, "mode", {
        configurable: true,
        value: (metadata.mode & ~0o777) | 0o666,
      });
      mutate(metadata);
    }
    return metadata as never;
  }) as typeof fs.lstatSync;
  Object.defineProperty(fs, "lstatSync", { configurable: true, value: injectedLstat });
  syncBuiltinESMExports();
  t.after(() => {
    Object.defineProperty(fs, "lstatSync", { configurable: true, value: originalLstat });
    Object.defineProperty(process, "platform", platform);
    syncBuiltinESMExports();
  });
}

function assertRequestedMode(path: string, posixMode: number, kind: "file" | "directory"): void {
  const metadata = lstatSync(path);
  assert.equal(kind === "file" ? metadata.isFile() : metadata.isDirectory(), true);
  assert.equal(metadata.isSymbolicLink(), false);
  if (process.platform === "win32") {
    assert.equal((metadata.mode & 0o222) === 0, (posixMode & 0o222) === 0);
  } else {
    assert.equal(metadata.mode & 0o777, posixMode);
  }
}

function completeSnapshot(
  command = registration.command,
  args: readonly string[] = registration.args,
  env: Readonly<Record<string, string>> = registration.env,
): Record<string, unknown> {
  return {
    name: "rocky",
    enabled: true,
    disabled_reason: null,
    transport: {
      type: "stdio",
      command,
      args: [...args],
      env: { ...env },
      env_vars: [],
      cwd: null,
    },
    enabled_tools: null,
    disabled_tools: null,
    startup_timeout_sec: null,
    tool_timeout_sec: null,
  };
}

test("missing Codex executable skips setup without invoking runner", async () => {
  const runner = new FakeRunner([]);
  const adapter = createCodexAdapter({ runner });

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
});

test("not-found get configures with exact get and add argv", async () => {
  const runner = new FakeRunner([
    result(1, "", "Error: No MCP server named 'rocky' found."),
    result(0),
  ]);
  const adapter = createCodexAdapter({ runner, executable: "/opt/codex" });

  const configured = await adapter.configure(registration, false);

  assert.deepEqual(configured, { client: "codex", status: "configured" });
  assert.deepEqual(runner.calls, [
    codexCall(getArgs),
    codexCall(addArgs),
  ]);
});

test("timeout and spawn failures never become absent from not-found text", async (t) => {
  const notFound = "Error: No MCP server named 'rocky' found.";
  const cases: Array<{ name: string; processResult: ProcessResult }> = [
    {
      name: "timeout",
      processResult: {
        status: null,
        stdout: "",
        stderr: notFound,
        error: new Error("process timeout after 10000ms"),
      },
    },
    {
      name: "spawn error",
      processResult: {
        status: null,
        stdout: "",
        stderr: notFound,
        error: new Error("spawn /opt/codex ENOENT"),
      },
    },
    {
      name: "numeric exit carrying runner error",
      processResult: {
        status: 1,
        stdout: "",
        stderr: notFound,
        error: new Error("runner failed while collecting output"),
      },
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const runner = new FakeRunner([entry.processResult]);
      const adapter = createCodexAdapter({ runner, executable: "/opt/codex" });

      const configured = await adapter.configure(registration, false);

      assert.equal(configured.status, "failed");
      assert.match(configured.detail ?? "", /read/i);
      assert.doesNotMatch(configured.detail ?? "", /ENOENT|timeout|runner failed|No MCP server/);
      assert.deepEqual(runner.calls, [codexCall(getArgs)]);
    });
  }
});

test("identical registration is a no-op after normalized command comparison", async () => {
  const snapshot = completeSnapshot("/opt/bin/../node");
  const runner = new FakeRunner([result(0, JSON.stringify(snapshot))]);
  const adapter = createCodexAdapter({ runner, executable: "/opt/codex" });

  const configured = await adapter.configure(registration, false);

  assert.deepEqual(configured, { client: "codex", status: "already-configured" });
  assert.deepEqual(runner.calls, [codexCall(getArgs)]);
});

test("conflicting registration requires confirmation when replace is false", async () => {
  const runner = new FakeRunner([result(0, JSON.stringify(completeSnapshot("/old/node")))]);
  const adapter = createCodexAdapter({ runner, executable: "/opt/codex" });

  const configured = await adapter.configure(registration, false);

  assert.deepEqual(configured, {
    client: "codex",
    status: "requires-confirmation",
    detail: "Codex already has a different rocky registration",
    manualRegistration: registration,
  });
  assert.deepEqual(runner.calls, [codexCall(getArgs)]);
});

test("replace persists then deletes prior snapshot only after desired registration verifies", async (t) => {
  const desired = temporaryRegistration(t);
  const runner = new FakeRunner([
    result(0, JSON.stringify(completeSnapshot("/old/node"))),
    result(0),
    result(0),
    result(0, JSON.stringify(completeSnapshot(
      desired.command,
      desired.args,
      desired.env,
    ))),
  ]);
  const adapter = createCodexAdapter({ runner, executable: "/opt/codex" });

  const configured = await adapter.configure(desired, true);

  assert.deepEqual(configured, { client: "codex", status: "configured" });
  assert.deepEqual(runner.calls, [
    codexCall(getArgs),
    codexCall(removeArgs),
    codexCall(addArgumentsFor(desired)),
    codexCall(getArgs),
  ]);
  const recoveryDirectory = join(dirname(desired.env.ROCKY_HOME!), ".rocky-setup-recovery");
  assert.deepEqual(readdirSync(recoveryDirectory), []);
  assertRequestedMode(recoveryDirectory, 0o700, "directory");
  assert.throws(() => lstatSync(desired.env.ROCKY_HOME!), { code: "ENOENT" });
});

test("Windows recovery mode semantics reach the intended remove and replacement flow", async (t) => {
  simulateWindowsArtifactMetadata(t);
  const desired = temporaryRegistration(t);
  const runner = new FakeRunner([
    result(0, JSON.stringify(completeSnapshot("C:\\old\\node.exe"))),
    result(0),
    result(0),
    result(0, JSON.stringify(completeSnapshot(desired.command, desired.args, desired.env))),
  ]);

  const configured = await createCodexAdapter({ runner, executable: "C:\\tools\\codex.exe" })
    .configure(desired, true);

  assert.deepEqual(configured, { client: "codex", status: "configured" });
  assert.deepEqual(runner.calls.map((call) => call.args), [
    getArgs,
    removeArgs,
    addArgumentsFor(desired),
    getArgs,
  ]);
});

test("Windows recovery artifact identity and link-count mismatches stop before remove", async (t) => {
  const cases: Array<{
    name: string;
    mutate(metadata: Stats): void;
  }> = [
    {
      name: "identity",
      mutate(metadata) {
        Object.defineProperty(metadata, "ino", { configurable: true, value: metadata.ino + 1 });
      },
    },
    {
      name: "link count",
      mutate(metadata) {
        Object.defineProperty(metadata, "nlink", { configurable: true, value: 2 });
      },
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async (child) => {
      simulateWindowsArtifactMetadata(child, entry.mutate);
      const desired = temporaryRegistration(child);
      const runner = new FakeRunner([
        result(0, JSON.stringify(completeSnapshot("C:\\old\\node.exe"))),
      ]);

      const configured = await createCodexAdapter({ runner, executable: "C:\\tools\\codex.exe" })
        .configure(desired, true);

      assert.equal(configured.status, "failed");
      assert.match(configured.detail ?? "", /recovery artifact/i);
      assert.deepEqual(runner.calls.map((call) => call.args), [getArgs]);
    });
  }
});

test("failed replacement add recreates, verifies, and deletes the durable prior snapshot", async (t) => {
  const desired = temporaryRegistration(t);
  const priorEnv = { KEEP_FIRST: "alpha", KEEP_SECOND: "bravo" };
  const snapshot = completeSnapshot("/old/node", ["/old/server.js", "--flag", "two words"], priorEnv);
  const runner = new FakeRunner([
    result(0, JSON.stringify(snapshot)),
    result(0),
    result(1, "", "add failed with SECRET_VALUE"),
    result(0),
    result(0, JSON.stringify(snapshot)),
  ]);
  const adapter = createCodexAdapter({ runner, executable: "/opt/codex" });

  const configured = await adapter.configure(desired, true);

  assert.deepEqual(configured, {
    client: "codex",
    status: "failed",
    detail: "Codex registration update failed; previous registration was restored",
  });
  assert.doesNotMatch(configured.detail ?? "", /SECRET_VALUE|alpha|bravo/);
  assert.deepEqual(runner.calls, [
    codexCall(getArgs),
    codexCall(removeArgs),
    codexCall(addArgumentsFor(desired)),
    {
      command: "/opt/codex",
      args: [
        "mcp", "add",
        "--env", "KEEP_FIRST=alpha",
        "--env", "KEEP_SECOND=bravo",
        "rocky", "--", "/old/node", "/old/server.js", "--flag", "two words",
      ],
      options: { timeoutMs: 10_000 },
    },
    codexCall(getArgs),
  ]);
  assert.deepEqual(readdirSync(join(dirname(desired.env.ROCKY_HOME!), ".rocky-setup-recovery")), []);
  assert.throws(() => lstatSync(desired.env.ROCKY_HOME!), { code: "ENOENT" });
});

test("rollback verification mismatch retains a private exact recovery artifact", async (t) => {
  const desired = temporaryRegistration(t);
  const snapshot = completeSnapshot("/old/node", ["/old/server.js"], { API_TOKEN: "secret-token" });
  const changed = completeSnapshot("/different/node", ["/old/server.js"], { API_TOKEN: "secret-token" });
  const runner = new FakeRunner([
    result(0, JSON.stringify(snapshot)),
    result(0),
    result(1),
    result(0),
    result(0, JSON.stringify(changed)),
  ]);
  const adapter = createCodexAdapter({ runner, executable: "/opt/codex" });

  const configured = await adapter.configure(desired, true);

  assert.equal(configured.status, "failed");
  assert.match(configured.detail ?? "", /manual recovery/i);
  assert.doesNotMatch(configured.detail ?? "", /secret-token|API_TOKEN|old\/server/);
  assert.deepEqual(configured.manualRegistration, desired);
  const artifact = recoveryPath(configured.detail);
  assert.deepEqual(JSON.parse(readFileSync(artifact, "utf8")), snapshot);
  assert.equal(lstatSync(artifact).isFile(), true);
  assert.equal(lstatSync(artifact).nlink, 1);
  assertRequestedMode(artifact, 0o600, "file");
  assert.equal(dirname(artifact), join(dirname(desired.env.ROCKY_HOME!), ".rocky-setup-recovery"));
  assert.equal(lstatSync(dirname(artifact)).isSymbolicLink(), false);
  assertRequestedMode(dirname(artifact), 0o700, "directory");
});

test("rollback add failure retains collision-safe recovery artifacts and reports no secrets", async (t) => {
  const desired = temporaryRegistration(t);
  const snapshots = [
    completeSnapshot("/old/one", ["/old/one.js"], { TOKEN: "first-secret" }),
    completeSnapshot("/old/two", ["/old/two.js"], { TOKEN: "second-secret" }),
  ];
  const paths: string[] = [];

  for (const snapshot of snapshots) {
    const runner = new FakeRunner([
      result(0, JSON.stringify(snapshot)),
      result(0),
      result(1, "", "desired-add-secret"),
      result(1, "", "rollback-add-secret"),
    ]);
    const configured = await createCodexAdapter({ runner, executable: "/opt/codex" })
      .configure(desired, true);

    assert.equal(configured.status, "failed");
    assert.deepEqual(configured.manualRegistration, desired);
    assert.doesNotMatch(configured.detail ?? "", /first-secret|second-secret|add-secret|TOKEN/);
    paths.push(recoveryPath(configured.detail));
  }

  assert.notEqual(paths[0], paths[1]);
  assert.deepEqual(JSON.parse(readFileSync(paths[0]!, "utf8")), snapshots[0]);
  assert.deepEqual(JSON.parse(readFileSync(paths[1]!, "utf8")), snapshots[1]);
});

test("malformed and nonzero rollback verification retain the durable recovery artifact", async (t) => {
  const cases = [
    { name: "malformed", verification: result(0, "{not-json") },
    { name: "nonzero", verification: result(9, "", "verification-secret") },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const desired = temporaryRegistration(t);
      const snapshot = completeSnapshot("/old/node", ["/old/server.js"], { TOKEN: "prior-secret" });
      const runner = new FakeRunner([
        result(0, JSON.stringify(snapshot)),
        result(0),
        result(1),
        result(0),
        entry.verification,
      ]);

      const configured = await createCodexAdapter({ runner, executable: "/opt/codex" })
        .configure(desired, true);

      assert.equal(configured.status, "failed");
      assert.match(configured.detail ?? "", /manual recovery/i);
      assert.doesNotMatch(configured.detail ?? "", /prior-secret|verification-secret|TOKEN/);
      assert.deepEqual(JSON.parse(readFileSync(recoveryPath(configured.detail), "utf8")), snapshot);
    });
  }
});

test("symlinked recovery directory is refused before destructive remove", async (t) => {
  const desired = temporaryRegistration(t);
  const outside = mkdtempSync(join(tmpdir(), "rocky-codex-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const recoveryDirectory = join(dirname(desired.env.ROCKY_HOME!), ".rocky-setup-recovery");
  symlinkSync(outside, recoveryDirectory);
  const runner = new FakeRunner([
    result(0, JSON.stringify(completeSnapshot("/old/node", [], { TOKEN: "prior-secret" }))),
  ]);

  const configured = await createCodexAdapter({ runner, executable: "/opt/codex" })
    .configure(desired, true);

  assert.equal(configured.status, "failed");
  assert.match(configured.detail ?? "", /recovery/i);
  assert.doesNotMatch(configured.detail ?? "", /prior-secret|TOKEN/);
  assert.deepEqual(runner.calls, [codexCall(getArgs)]);
  assert.deepEqual(readdirSync(outside), []);
});

test("private recovery directory is allowed under an existing searchable user home", async (t) => {
  const desired = temporaryRegistration(t);
  const userHome = dirname(desired.env.ROCKY_HOME!);
  chmodSync(userHome, 0o755);
  const runner = new FakeRunner([
    result(0, JSON.stringify(completeSnapshot("/old/node"))),
    result(0),
    result(0),
    result(0, JSON.stringify(completeSnapshot(desired.command, desired.args, desired.env))),
  ]);

  const configured = await createCodexAdapter({ runner, executable: "/opt/codex" })
    .configure(desired, true);

  assert.equal(configured.status, "configured");
  assertRequestedMode(join(userHome, ".rocky-setup-recovery"), 0o700, "directory");
  assert.throws(() => lstatSync(desired.env.ROCKY_HOME!), { code: "ENOENT" });
});

test("non-default and unknown snapshot metadata blocks replacement before remove", async (t) => {
  const cases: Array<{ name: string; mutate(snapshot: Record<string, unknown>): void }> = [
    {
      name: "cwd",
      mutate(snapshot) {
        (snapshot.transport as Record<string, unknown>).cwd = "/private/work";
      },
    },
    {
      name: "startup timeout",
      mutate(snapshot) {
        snapshot.startup_timeout_sec = 15;
      },
    },
    {
      name: "approval mode",
      mutate(snapshot) {
        snapshot.default_tools_approval_mode = "prompt";
      },
    },
    {
      name: "tool policy",
      mutate(snapshot) {
        snapshot.enabled_tools = ["memory_search"];
      },
    },
    {
      name: "OAuth",
      mutate(snapshot) {
        snapshot.oauth = { access_token: "never-log-this" };
      },
    },
    {
      name: "unknown metadata",
      mutate(snapshot) {
        snapshot.future_metadata = { secret: "never-log-this" };
      },
    },
    {
      name: "disabled registration",
      mutate(snapshot) {
        snapshot.enabled = false;
        snapshot.disabled_reason = "managed policy details";
      },
    },
    {
      name: "empty environment that Codex add serializes as null",
      mutate(snapshot) {
        (snapshot.transport as Record<string, unknown>).env = {};
      },
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const snapshot = completeSnapshot("/old/node");
      entry.mutate(snapshot);
      const runner = new FakeRunner([result(0, JSON.stringify(snapshot))]);
      const adapter = createCodexAdapter({ runner, executable: "/opt/codex" });

      const configured = await adapter.configure(registration, true);

      assert.equal(configured.status, "failed");
      assert.match(configured.detail ?? "", /manual/i);
      assert.doesNotMatch(configured.detail ?? "", /never-log-this|private\/work|managed policy details/);
      assert.deepEqual(configured.manualRegistration, registration);
      assert.deepEqual(runner.calls, [codexCall(getArgs)]);
    });
  }
});

test("matching core with unsafe metadata is conflicting, unhealthy, and not replaceable", async (t) => {
  const cases: Array<{ name: string; mutate(snapshot: Record<string, unknown>): void }> = [
    {
      name: "disabled",
      mutate(snapshot) {
        snapshot.enabled = false;
        snapshot.disabled_reason = "secret managed reason";
      },
    },
    {
      name: "cwd",
      mutate(snapshot) {
        (snapshot.transport as Record<string, unknown>).cwd = "/secret/project";
      },
    },
    {
      name: "timeout",
      mutate(snapshot) {
        snapshot.tool_timeout_sec = 45;
      },
    },
    {
      name: "approval",
      mutate(snapshot) {
        snapshot.default_tools_approval_mode = "prompt";
      },
    },
    {
      name: "tool policy",
      mutate(snapshot) {
        snapshot.disabled_tools = ["secret_tool_name"];
      },
    },
    {
      name: "OAuth",
      mutate(snapshot) {
        snapshot.oauth = { access_token: "secret-access-token" };
      },
    },
    {
      name: "unknown metadata",
      mutate(snapshot) {
        snapshot.future_metadata = { value: "secret-future-value" };
      },
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const snapshot = completeSnapshot();
      entry.mutate(snapshot);
      const encoded = JSON.stringify(snapshot);
      const runner = new FakeRunner([
        result(0, encoded),
        result(0, encoded),
        result(0, encoded),
      ]);
      const adapter = createCodexAdapter({ runner, executable: "/opt/codex" });

      const inspection = await adapter.inspect(registration);
      const checked = await adapter.check(registration);
      const replaced = await adapter.configure(registration, true);

      assert.equal(inspection.state, "conflict");
      assert.equal(checked.status, "failed");
      assert.equal(replaced.status, "failed");
      assert.match(replaced.detail ?? "", /manual/i);
      assert.doesNotMatch(
        `${inspection.detail ?? ""}${checked.detail ?? ""}${replaced.detail ?? ""}`,
        /secret managed|secret\/project|secret_tool_name|secret-access-token|secret-future-value/,
      );
      assert.deepEqual(runner.calls, [codexCall(getArgs), codexCall(getArgs), codexCall(getArgs)]);
    });
  }
});

test("malformed or partial get JSON is unreadable without exposing its contents", async () => {
  const partial = {
    name: "rocky",
    enabled: true,
    transport: { type: "stdio", command: "/old/node", args: [], env: { TOKEN: "sensitive" } },
  };
  const runner = new FakeRunner([result(0, JSON.stringify(partial))]);
  const adapter = createCodexAdapter({ runner, executable: "/opt/codex" });

  const configured = await adapter.configure(registration, true);

  assert.equal(configured.status, "failed");
  assert.match(configured.detail ?? "", /read/i);
  assert.doesNotMatch(configured.detail ?? "", /TOKEN|sensitive|old\/node/);
  assert.deepEqual(runner.calls, [codexCall(getArgs)]);
});

test("remove refuses foreign command, args, and environment without mutation", async (t) => {
  const cases: Array<{ name: string; snapshot: Record<string, unknown> }> = [
    {
      name: "foreign command",
      snapshot: completeSnapshot("/secret/foreign-node"),
    },
    {
      name: "foreign args",
      snapshot: completeSnapshot(registration.command, ["/secret/foreign-server.js", "mcp"]),
    },
    {
      name: "foreign environment",
      snapshot: completeSnapshot(registration.command, registration.args, {
        ROCKY_MCP_EXPOSURE: "sanitized",
        ROCKY_HOME: "/secret/foreign-home",
        API_TOKEN: "secret-token",
      }),
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const runner = new FakeRunner([result(0, JSON.stringify(entry.snapshot))]);
      const adapter = createCodexAdapter({ runner, executable: "/opt/codex" });

      const removed = await adapter.remove(registration);

      assert.equal(removed.status, "failed");
      assert.doesNotMatch(
        removed.detail ?? "",
        /foreign-node|foreign-server|foreign-home|API_TOKEN|secret-token/,
      );
      assert.deepEqual(runner.calls, [codexCall(getArgs)]);
    });
  }
});

test("remove and check use inspection results and exact remove argv", async () => {
  const ownedRaw = completeSnapshot(registration.command, registration.args, {
    ROCKY_MCP_EXPOSURE: "raw",
    ROCKY_HOME: registration.env.ROCKY_HOME,
  });
  const removeRunner = new FakeRunner([
    result(0, JSON.stringify(ownedRaw)),
    result(0),
  ]);
  const removeAdapter = createCodexAdapter({ runner: removeRunner, executable: "/opt/codex" });
  const removed = await removeAdapter.remove(registration);

  assert.deepEqual(removed, { client: "codex", status: "removed" });
  assert.deepEqual(removeRunner.calls, [
    codexCall(getArgs),
    codexCall(removeArgs),
  ]);

  const storedRawRegistration: McpRegistration = {
    ...registration,
    env: { ...registration.env, ROCKY_MCP_EXPOSURE: "raw" },
  };
  const checkRunner = new FakeRunner([result(0, JSON.stringify(completeSnapshot(
    storedRawRegistration.command,
    storedRawRegistration.args,
    storedRawRegistration.env,
  )))]);
  const checkAdapter = createCodexAdapter({ runner: checkRunner, executable: "/opt/codex" });
  assert.deepEqual(await checkAdapter.check(registration), {
    client: "codex",
    status: "healthy",
    healthRegistration: storedRawRegistration,
  });
  assert.deepEqual(checkRunner.calls, [codexCall(getArgs)]);
});
