import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarnessClaudeCodeAdapter } from "../setup/harness-claude-code.js";
import type { McpRegistration } from "../setup/clients.js";
import type { PlatformServices } from "../setup/platform.js";

const REGISTRATION: McpRegistration = {
  name: "rocky",
  command: "/usr/local/bin/node",
  args: ["/home/user/.rocky/dist/index.js", "mcp"],
  env: { ROCKY_HOME: "/home/user/.rocky", ROCKY_MCP_EXPOSURE: "sanitized" },
};

function fakePlatform(home: string, executables: Record<string, string> = {}): PlatformServices {
  return {
    platform: "linux" as const,
    home,
    isWsl: false,
    resolveExecutable: (name: string) => executables[name],
    fileExists: () => true,
    hasClaudeDesktop: () => false,
    hasBashHook: () => false,
  } as unknown as PlatformServices;
}

function fakeRunner(handlers: Record<string, { status: number | null; stdout: string }>) {
  return {
    run: (command: string, args: readonly string[]) => {
      const key = `${command} ${args.join(" ")}`;
      const hit = handlers[key] ?? { status: 1, stdout: "" };
      return Promise.resolve({ ...hit, stderr: "" });
    },
  };
}

function tempHome(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "rocky-harness-claude-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeClaudeBin(home: string): string {
  const binPath = join(home, "claude");
  writeFileSync(binPath, "");
  return binPath;
}

test("not-found binary inspects blocked and configures skipped without writing", async (t) => {
  const home = tempHome(t);
  const adapter = createHarnessClaudeCodeAdapter({
    runner: fakeRunner({}),
    platform: fakePlatform(home),
    home,
    userConfigPath: join(home, ".claude.json"),
    scope: "user",
  });
  const inspected = await adapter.inspect(REGISTRATION);
  assert.equal(inspected.state, "blocked");
  const result = await adapter.configure(REGISTRATION, false);
  assert.equal(result.status, "skipped");
  assert.equal(result.client, "claude-code");
});

test("user-scope merge preserves foreign servers and reports already-configured when identical", async (t) => {
  const home = tempHome(t);
  const configPath = join(home, ".claude.json");
  writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      other: { type: "stdio", command: "/bin/other", args: [], env: {} },
      rocky: { type: "stdio", command: REGISTRATION.command, args: [...REGISTRATION.args], env: { ...REGISTRATION.env } },
    },
  }));
  const claudeBin = fakeClaudeBin(home);
  const adapter = createHarnessClaudeCodeAdapter({
    runner: fakeRunner({}),
    platform: fakePlatform(home, { claude: claudeBin }),
    home,
    userConfigPath: configPath,
    scope: "user",
  });
  const inspected = await adapter.inspect(REGISTRATION);
  assert.equal(inspected.state, "identical");
});

test("conflict without replace asks for confirmation and never overwrites the foreign entry", async (t) => {
  const home = tempHome(t);
  const configPath = join(home, ".claude.json");
  writeFileSync(configPath, JSON.stringify({
    mcpServers: { rocky: { type: "stdio", command: "/bin/impostor", args: [], env: {} } },
  }));
  const claudeBin = fakeClaudeBin(home);
  const adapter = createHarnessClaudeCodeAdapter({
    runner: fakeRunner({}),
    platform: fakePlatform(home, { claude: claudeBin }),
    home,
    userConfigPath: configPath,
    scope: "user",
  });
  const result = await adapter.configure(REGISTRATION, false);
  assert.equal(result.status, "requires-confirmation");
  const after = JSON.parse(readFileSync(configPath, "utf8")) as {
    mcpServers: Record<string, { command?: string }>;
  };
  assert.equal(after.mcpServers.rocky.command, "/bin/impostor");
});

test("unreadable config fails configure without writing", async (t) => {
  const home = tempHome(t);
  const configPath = join(home, ".claude.json");
  writeFileSync(configPath, "{ not json");
  const claudeBin = fakeClaudeBin(home);
  const adapter = createHarnessClaudeCodeAdapter({
    runner: fakeRunner({}),
    platform: fakePlatform(home, { claude: claudeBin }),
    home,
    userConfigPath: configPath,
    scope: "user",
  });
  const inspected = await adapter.inspect(REGISTRATION);
  assert.equal(inspected.state, "unreadable");
  const result = await adapter.configure(REGISTRATION, false);
  assert.equal(result.status, "failed");
});

test("health failure after write reports configured-unverified, never healthy", async (t) => {
  const home = tempHome(t);
  const configPath = join(home, ".claude.json");
  writeFileSync(configPath, JSON.stringify({ mcpServers: {} }));
  const claudeBin = fakeClaudeBin(home);
  const adapter = createHarnessClaudeCodeAdapter({
    runner: fakeRunner({
      [`${claudeBin} mcp list --scope user`]: { status: 0, stdout: "no servers" },
    }),
    platform: fakePlatform(home, { claude: claudeBin }),
    home,
    userConfigPath: configPath,
    scope: "user",
  });
  const result = await adapter.configure(REGISTRATION, false);
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /configured; MCP unverified/);
});

test("replace swaps only a Rocky-owned entry; remove drops only the rocky key", async (t) => {
  const home = tempHome(t);
  const configPath = join(home, ".claude.json");
  writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      keep: { type: "stdio", command: "/bin/keep", args: [], env: {} },
      rocky: { type: "stdio", command: REGISTRATION.command, args: ["old"], env: {} },
    },
  }));
  const claudeBin = fakeClaudeBin(home);
  const adapter = createHarnessClaudeCodeAdapter({
    runner: fakeRunner({}),
    platform: fakePlatform(home, { claude: claudeBin }),
    home,
    userConfigPath: configPath,
    scope: "user",
  });
  const replaced = await adapter.configure(REGISTRATION, true);
  assert.equal(replaced.status, "failed");
  assert.match(replaced.detail ?? "", /not owned/);
  const removed = await adapter.remove({
    ...REGISTRATION,
    command: "/bin/impostor",
  });
  assert.equal(removed.status, "failed");
});
