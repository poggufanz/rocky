import test from "node:test";
import assert from "node:assert/strict";
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

test("replace removes and adds a fully restorable conflict with exact argv", async () => {
  const runner = new FakeRunner([
    result(0, JSON.stringify(completeSnapshot("/old/node"))),
    result(0),
    result(0),
  ]);
  const adapter = createCodexAdapter({ runner, executable: "/opt/codex" });

  const configured = await adapter.configure(registration, true);

  assert.deepEqual(configured, { client: "codex", status: "configured" });
  assert.deepEqual(runner.calls, [
    codexCall(getArgs),
    codexCall(removeArgs),
    codexCall(addArgs),
  ]);
});

test("failed replacement add recreates and verifies the exact prior snapshot", async () => {
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

  const configured = await adapter.configure(registration, true);

  assert.deepEqual(configured, {
    client: "codex",
    status: "failed",
    detail: "Codex registration update failed; previous registration was restored",
  });
  assert.doesNotMatch(configured.detail ?? "", /SECRET_VALUE|alpha|bravo/);
  assert.deepEqual(runner.calls, [
    codexCall(getArgs),
    codexCall(removeArgs),
    codexCall(addArgs),
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
});

test("rollback verification mismatch fails with secret-free manual recovery guidance", async () => {
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

  const configured = await adapter.configure(registration, true);

  assert.equal(configured.status, "failed");
  assert.match(configured.detail ?? "", /manual recovery/i);
  assert.doesNotMatch(configured.detail ?? "", /secret-token|API_TOKEN|old\/server/);
  assert.deepEqual(configured.manualRegistration, registration);
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

  const checkRunner = new FakeRunner([result(0, JSON.stringify(completeSnapshot()))]);
  const checkAdapter = createCodexAdapter({ runner: checkRunner, executable: "/opt/codex" });
  assert.deepEqual(await checkAdapter.check(registration), { client: "codex", status: "healthy" });
  assert.deepEqual(checkRunner.calls, [codexCall(getArgs)]);
});
