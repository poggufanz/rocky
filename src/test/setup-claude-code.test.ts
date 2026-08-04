import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ProcessResult, ProcessRunOptions, ProcessRunner } from "../setup/process.js";
import { createClaudeCodeAdapter } from "../setup/claude-code.js";

const registration = {
  name: "rocky" as const,
  command: "/opt/node",
  args: ["/opt/rocky/dist/index.js", "mcp"],
  env: { ROCKY_MCP_EXPOSURE: "sanitized", ROCKY_HOME: "/home/ada/.rocky" },
};

const addArgs = [
  "mcp", "add",
  "--scope", "user",
  "--transport", "stdio",
  "--env", "ROCKY_MCP_EXPOSURE=sanitized",
  "--env", "ROCKY_HOME=/home/ada/.rocky",
  "rocky", "--", "/opt/node", "/opt/rocky/dist/index.js", "mcp",
];
const removeArgs = ["mcp", "remove", "--scope", "user", "rocky"];

interface RunnerCall {
  command: string;
  args: readonly string[];
  options?: ProcessRunOptions;
}

type RunnerStep = ProcessResult | ((call: RunnerCall) => ProcessResult);

class FakeRunner implements ProcessRunner {
  readonly calls: RunnerCall[] = [];

  constructor(private readonly steps: RunnerStep[]) {}

  async run(command: string, args: readonly string[], options?: ProcessRunOptions): Promise<ProcessResult> {
    const call = { command, args: [...args], options };
    this.calls.push(call);
    const step = this.steps.shift();
    assert.ok(step, `unexpected process call: ${command} ${args.join(" ")}`);
    return typeof step === "function" ? step(call) : step;
  }
}

function result(status: number, stdout = "", stderr = ""): ProcessResult {
  return { status, stdout, stderr };
}

function claudeCall(args: readonly string[]): RunnerCall {
  return { command: "/opt/claude", args, options: { timeoutMs: 10_000 } };
}

function userConfig(t: test.TestContext, value?: Record<string, unknown>): string {
  const directory = mkdtempSync(join(tmpdir(), "rocky-claude-code-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, ".claude.json");
  if (value !== undefined) writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o640 });
  return path;
}

function rockyEntry(command = registration.command): Record<string, unknown> {
  return {
    type: "stdio",
    command,
    args: [...registration.args],
    env: { ...registration.env },
  };
}

function backupNames(path: string): string[] {
  return readdirSync(dirname(path)).filter((name) => name.startsWith(`${basename(path)}.backup-`));
}

test("missing Claude executable is skipped without reading real home or running a command", async (t) => {
  const path = userConfig(t);
  const runner = new FakeRunner([]);
  const adapter = createClaudeCodeAdapter({ runner, userConfigPath: path });

  assert.equal((await adapter.configure(registration, false)).status, "skipped");
  assert.equal((await adapter.remove(registration)).status, "skipped");
  assert.equal((await adapter.check(registration)).status, "skipped");
  assert.deepEqual(runner.calls, []);
});

test("new user registration uses exact official Claude add argv", async (t) => {
  const path = userConfig(t, { theme: "dark", mcpServers: { other: { url: "https://local" } } });
  const runner = new FakeRunner([result(0)]);
  const adapter = createClaudeCodeAdapter({ runner, executable: "/opt/claude", userConfigPath: path });

  assert.equal((await adapter.inspect(registration)).state, "absent");
  assert.equal((await adapter.configure(registration, false)).status, "configured");
  assert.deepEqual(runner.calls, [claudeCall(addArgs)]);
});

test("identical user registration is a no-op and healthy without human CLI inspection", async (t) => {
  const path = userConfig(t, { mcpServers: { rocky: rockyEntry() } });
  const runner = new FakeRunner([]);
  const adapter = createClaudeCodeAdapter({ runner, executable: "/opt/claude", userConfigPath: path });

  assert.equal((await adapter.inspect(registration)).state, "identical");
  assert.equal((await adapter.configure(registration, false)).status, "already-configured");
  assert.equal((await adapter.check(registration)).status, "healthy");
  assert.deepEqual(runner.calls, []);
});

test("foreign registration requires confirmation and is not mutated", async (t) => {
  const path = userConfig(t, { mcpServers: { rocky: rockyEntry("/usr/bin/foreign") } });
  const runner = new FakeRunner([]);
  const adapter = createClaudeCodeAdapter({ runner, executable: "/opt/claude", userConfigPath: path });

  const configured = await adapter.configure(registration, false);

  assert.equal(configured.status, "requires-confirmation");
  assert.deepEqual(configured.manualRegistration, registration);
  assert.deepEqual(runner.calls, []);
});

test("explicit replacement backs up exact config then uses official remove and add", async (t) => {
  const original = {
    theme: "dark",
    secret: "fake-secret-token",
    mcpServers: {
      other: { url: "https://local", token: "other-secret" },
      rocky: { ...rockyEntry("/old/node"), disabled: true, future: { value: 7 } },
    },
  };
  const path = userConfig(t, original);
  const originalBytes = readFileSync(path);
  const runner = new FakeRunner([result(0), result(0)]);
  const adapter = createClaudeCodeAdapter({ runner, executable: "/opt/claude", userConfigPath: path });

  const configured = await adapter.configure(registration, true);

  assert.equal(configured.status, "configured");
  assert.deepEqual(runner.calls, [claudeCall(removeArgs), claudeCall(addArgs)]);
  const backups = readdirSync(join(path, "..")).filter((name) => name.startsWith(".claude.json.backup-"));
  assert.equal(backups.length, 1);
  assert.deepEqual(readFileSync(join(path, "..", backups[0]!)), originalBytes);
});

test("replacement stops before remove when the full config backup cannot be created", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "rocky-claude-backup-failure-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, `${"x".repeat(230)}.json`);
  const original = { mcpServers: { rocky: rockyEntry("/old/node") } };
  writeFileSync(path, `${JSON.stringify(original)}\n`, "utf8");
  const runner = new FakeRunner([]);
  const adapter = createClaudeCodeAdapter({ runner, executable: "/opt/claude", userConfigPath: path });

  const configured = await adapter.configure(registration, true);

  assert.equal(configured.status, "failed");
  assert.match(configured.detail ?? "", /back up/i);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), original);
  assert.deepEqual(runner.calls, []);
});

test("replacement remove refusal stops before add and preserves config", async (t) => {
  const cases = [
    { name: "enterprise policy", response: result(1, "", "enterprise policy: remove-secret"), status: "blocked-by-policy" },
    { name: "ordinary error", response: result(1, "", "ordinary remove-secret"), status: "failed" },
  ] as const;

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const original = { mcpServers: { rocky: rockyEntry("/old/node") } };
      const path = userConfig(t, original);
      const originalBytes = readFileSync(path);
      const runner = new FakeRunner([entry.response]);
      const adapter = createClaudeCodeAdapter({ runner, executable: "/opt/claude", userConfigPath: path });

      const configured = await adapter.configure(registration, true);

      assert.equal(configured.status, entry.status);
      assert.match(configured.detail ?? "", /backup/i);
      assert.doesNotMatch(configured.detail ?? "", /remove-secret/);
      assert.deepEqual(readFileSync(path), originalBytes);
      assert.equal(backupNames(path).length, 1);
      assert.deepEqual(runner.calls, [claudeCall(removeArgs)]);
    });
  }
});

test("failed add restores exact rocky snapshot into current unrelated config", async (t) => {
  const snapshot = {
    ...rockyEntry("/old/node"),
    disabled: true,
    cwd: "/private/project",
    metadata: { nested: [1, "two", { secret: "snapshot-secret" }] },
  };
  const path = userConfig(t, {
    theme: "before",
    mcpServers: { other: { version: 1 }, rocky: snapshot },
  });
  const afterRemove = {
    theme: "changed-concurrently",
    newTopLevel: { keep: true },
    mcpServers: { other: { version: 2 }, concurrent: { url: "https://new" } },
  };
  const runner = new FakeRunner([
    () => {
      writeFileSync(path, `${JSON.stringify(afterRemove, null, 2)}\n`, { mode: 0o640 });
      return result(0);
    },
    result(1, "", "add denied"),
  ]);
  const adapter = createClaudeCodeAdapter({ runner, executable: "/opt/claude", userConfigPath: path });

  const configured = await adapter.configure(registration, true);

  assert.equal(configured.status, "failed");
  assert.match(configured.detail ?? "", /restored/i);
  assert.doesNotMatch(configured.detail ?? "", /snapshot-secret|private\/project/);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
    ...afterRemove,
    mcpServers: { ...afterRemove.mcpServers, rocky: snapshot },
  });
  assert.deepEqual(runner.calls, [claudeCall(removeArgs), claudeCall(addArgs)]);
});

test("enterprise refusal during replacement add restores snapshot and reports policy block", async (t) => {
  const snapshot = { ...rockyEntry("/old/node"), metadata: { token: "snapshot-secret" } };
  const path = userConfig(t, { theme: "keep", mcpServers: { rocky: snapshot } });
  const afterRemove = { theme: "changed", mcpServers: { other: { keep: true } } };
  const runner = new FakeRunner([
    () => {
      writeFileSync(path, `${JSON.stringify(afterRemove, null, 2)}\n`, { mode: 0o640 });
      return result(0);
    },
    result(1, "", "enterprise MCP policy: add-secret"),
  ]);
  const adapter = createClaudeCodeAdapter({ runner, executable: "/opt/claude", userConfigPath: path });

  const configured = await adapter.configure(registration, true);

  assert.equal(configured.status, "blocked-by-policy");
  assert.match(configured.detail ?? "", /restored|backup/i);
  assert.doesNotMatch(configured.detail ?? "", /snapshot-secret|add-secret/);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
    ...afterRemove,
    mcpServers: { ...afterRemove.mcpServers, rocky: snapshot },
  });
  assert.deepEqual(runner.calls, [claudeCall(removeArgs), claudeCall(addArgs)]);
});

test("rollback restores the exact snapshot when the current config disappeared", async (t) => {
  const snapshot = { ...rockyEntry("/old/node"), metadata: { exact: [1, 2, 3] } };
  const path = userConfig(t, { unrelated: "lost-with-file", mcpServers: { rocky: snapshot } });
  const runner = new FakeRunner([
    () => {
      rmSync(path);
      return result(0);
    },
    result(1, "", "ordinary add failure"),
  ]);
  const adapter = createClaudeCodeAdapter({ runner, executable: "/opt/claude", userConfigPath: path });

  const configured = await adapter.configure(registration, true);

  assert.equal(configured.status, "failed");
  assert.match(configured.detail ?? "", /restored/i);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { mcpServers: { rocky: snapshot } });
});

test("rollback refuses unreadable or non-object current config without overwriting it", async (t) => {
  const cases = [
    { name: "malformed JSON", bytes: '{"token":"malformed-secret"' },
    { name: "non-object root", bytes: '["array-secret"]\n' },
    { name: "non-object mcpServers", bytes: '{"theme":"keep","mcpServers":["server-secret"]}\n' },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const path = userConfig(t, { mcpServers: { rocky: rockyEntry("/old/node") } });
      const runner = new FakeRunner([
        () => {
          writeFileSync(path, entry.bytes, "utf8");
          return result(0);
        },
        result(1, "", "ordinary add failure"),
      ]);
      const adapter = createClaudeCodeAdapter({ runner, executable: "/opt/claude", userConfigPath: path });

      const configured = await adapter.configure(registration, true);

      assert.equal(configured.status, "failed");
      assert.match(configured.detail ?? "", /backup|manual|cannot be read/i);
      assert.doesNotMatch(configured.detail ?? "", /malformed-secret|array-secret|server-secret/);
      assert.equal(readFileSync(path, "utf8"), entry.bytes);
    });
  }
});

test("rollback atomic write failure leaves current unrelated config and reports manual recovery", async (t) => {
  const path = userConfig(t, { mcpServers: { rocky: rockyEntry("/old/node") } });
  const current = { theme: "keep", mcpServers: { other: { keep: true } } };
  const directory = dirname(path);
  const runner = new FakeRunner([
    () => {
      writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o640 });
      return result(0);
    },
    () => {
      chmodSync(directory, 0o500);
      return result(1, "", "ordinary add failure");
    },
  ]);
  const adapter = createClaudeCodeAdapter({ runner, executable: "/opt/claude", userConfigPath: path });

  try {
    const configured = await adapter.configure(registration, true);
    assert.equal(configured.status, "failed");
    assert.match(configured.detail ?? "", /manual recovery/i);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), current);
  } finally {
    chmodSync(directory, 0o700);
  }
});

test("failed add never overwrites a concurrent rocky entry and reports backup", async (t) => {
  const original = { mcpServers: { rocky: { ...rockyEntry("/old/node"), token: "old-secret" } } };
  const path = userConfig(t, original);
  const concurrent = {
    theme: "keep",
    mcpServers: { rocky: { ...rockyEntry("/concurrent/node"), token: "concurrent-secret" } },
  };
  const runner = new FakeRunner([
    () => result(0),
    () => {
      writeFileSync(path, `${JSON.stringify(concurrent, null, 2)}\n`, { mode: 0o640 });
      return result(1, "", "enterprise details: concurrent-secret");
    },
  ]);
  const adapter = createClaudeCodeAdapter({ runner, executable: "/opt/claude", userConfigPath: path });

  const configured = await adapter.configure(registration, true);

  assert.equal(configured.status, "failed");
  assert.match(configured.detail ?? "", /backup/i);
  assert.doesNotMatch(configured.detail ?? "", /old-secret|concurrent-secret/);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), concurrent);
  assert.equal(readdirSync(join(path, "..")).filter((name) => name.startsWith(".claude.json.backup-")).length, 1);
});

test("malformed user config is unreadable and never sent to diagnostics or CLI", async (t) => {
  const path = userConfig(t);
  writeFileSync(path, '{"mcpServers":{"rocky":{"token":"fake-secret-token"}', "utf8");
  const runner = new FakeRunner([]);
  const adapter = createClaudeCodeAdapter({ runner, executable: "/opt/claude", userConfigPath: path });

  const inspection = await adapter.inspect(registration);
  const configured = await adapter.configure(registration, true);

  assert.equal(inspection.state, "unreadable");
  assert.equal(configured.status, "failed");
  assert.doesNotMatch(`${inspection.detail ?? ""}${configured.detail ?? ""}`, /fake-secret-token/);
  assert.deepEqual(runner.calls, []);
});

test("enterprise refusal is reported as policy block without exposing CLI output", async (t) => {
  const path = userConfig(t, { mcpServers: {} });
  const runner = new FakeRunner([result(1, "", "Managed by enterprise policy: fake-secret-token")]);
  const adapter = createClaudeCodeAdapter({ runner, executable: "/opt/claude", userConfigPath: path });

  const configured = await adapter.configure(registration, false);

  assert.equal(configured.status, "blocked-by-policy");
  assert.doesNotMatch(configured.detail ?? "", /fake-secret-token/);
  assert.deepEqual(configured.manualRegistration, registration);
  assert.deepEqual(runner.calls, [claudeCall(addArgs)]);
});

test("remove calls official user-scope command only for an owned identity", async (t) => {
  const ownedPath = userConfig(t, { mcpServers: { rocky: rockyEntry() } });
  const ownedRunner = new FakeRunner([result(0)]);
  const owned = createClaudeCodeAdapter({
    runner: ownedRunner,
    executable: "/opt/claude",
    userConfigPath: ownedPath,
  });
  assert.equal((await owned.remove(registration)).status, "removed");
  assert.deepEqual(ownedRunner.calls, [claudeCall(removeArgs)]);

  const foreignPath = userConfig(t, { mcpServers: { rocky: rockyEntry("/usr/bin/foreign") } });
  const foreignRunner = new FakeRunner([]);
  const foreign = createClaudeCodeAdapter({
    runner: foreignRunner,
    executable: "/opt/claude",
    userConfigPath: foreignPath,
  });
  assert.equal((await foreign.remove(registration)).status, "failed");
  assert.deepEqual(foreignRunner.calls, []);
});

test("owned removal distinguishes policy refusal from ordinary failure without exposing output", async (t) => {
  const cases = [
    { name: "enterprise policy", response: result(1, "", "managed policy: removal-secret"), status: "blocked-by-policy" },
    { name: "ordinary error", response: result(1, "", "ordinary removal-secret"), status: "failed" },
  ] as const;

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const path = userConfig(t, { mcpServers: { rocky: rockyEntry() } });
      const runner = new FakeRunner([entry.response]);
      const adapter = createClaudeCodeAdapter({ runner, executable: "/opt/claude", userConfigPath: path });

      const removed = await adapter.remove(registration);

      assert.equal(removed.status, entry.status);
      assert.doesNotMatch(removed.detail ?? "", /removal-secret/);
      assert.deepEqual(runner.calls, [claudeCall(removeArgs)]);
    });
  }
});
