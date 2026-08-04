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
    { command: "/opt/codex", args: getArgs },
    { command: "/opt/codex", args: addArgs },
  ]);
});

test("identical registration is a no-op after normalized command comparison", async () => {
  const snapshot = completeSnapshot("/opt/bin/../node");
  const runner = new FakeRunner([result(0, JSON.stringify(snapshot))]);
  const adapter = createCodexAdapter({ runner, executable: "/opt/codex" });

  const configured = await adapter.configure(registration, false);

  assert.deepEqual(configured, { client: "codex", status: "already-configured" });
  assert.deepEqual(runner.calls, [{ command: "/opt/codex", args: getArgs }]);
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
  assert.deepEqual(runner.calls, [{ command: "/opt/codex", args: getArgs }]);
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
    { command: "/opt/codex", args: getArgs },
    { command: "/opt/codex", args: removeArgs },
    { command: "/opt/codex", args: addArgs },
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
    { command: "/opt/codex", args: getArgs },
    { command: "/opt/codex", args: removeArgs },
    { command: "/opt/codex", args: addArgs },
    {
      command: "/opt/codex",
      args: [
        "mcp", "add",
        "--env", "KEEP_FIRST=alpha",
        "--env", "KEEP_SECOND=bravo",
        "rocky", "--", "/old/node", "/old/server.js", "--flag", "two words",
      ],
    },
    { command: "/opt/codex", args: getArgs },
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
      assert.deepEqual(runner.calls, [{ command: "/opt/codex", args: getArgs }]);
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
  assert.deepEqual(runner.calls, [{ command: "/opt/codex", args: getArgs }]);
});

test("remove and check use inspection results and exact remove argv", async () => {
  const removeRunner = new FakeRunner([
    result(0, JSON.stringify(completeSnapshot())),
    result(0),
  ]);
  const removeAdapter = createCodexAdapter({ runner: removeRunner, executable: "/opt/codex" });
  const removed = await removeAdapter.remove(registration);

  assert.deepEqual(removed, { client: "codex", status: "removed" });
  assert.deepEqual(removeRunner.calls, [
    { command: "/opt/codex", args: getArgs },
    { command: "/opt/codex", args: removeArgs },
  ]);

  const checkRunner = new FakeRunner([result(0, JSON.stringify(completeSnapshot()))]);
  const checkAdapter = createCodexAdapter({ runner: checkRunner, executable: "/opt/codex" });
  assert.deepEqual(await checkAdapter.check(registration), { client: "codex", status: "healthy" });
  assert.deepEqual(checkRunner.calls, [{ command: "/opt/codex", args: getArgs }]);
});
