import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarnessCopilotAdapter } from "../setup/harness-copilot-cli.js";
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
    openSession: () => Promise.reject(new Error("protocol transport unavailable")),
  };
}

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "rocky-harness-copilot-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeCopilotBin(home: string): string {
  const binPath = join(home, "copilot");
  writeFileSync(binPath, "");
  return binPath;
}

test("not-found binary writes nothing", async (t) => {
  const dir = tempDir(t);
  const adapter = createHarnessCopilotAdapter({
    runner: fakeRunner({}),
    platform: fakePlatform(dir),
    home: dir,
    configPath: join(dir, "config.json"),
  });
  assert.equal((await adapter.inspect(REGISTRATION)).state, "blocked");
  assert.equal((await adapter.configure(REGISTRATION, false)).status, "skipped");
});

test("COPILOT_HOME selects the config root", async (t) => {
  const dir = tempDir(t);
  const copilotHome = join(dir, "custom-copilot-home");
  mkdirSync(copilotHome, { recursive: true });
  const expected = join(copilotHome, "config.json");
  writeFileSync(expected, JSON.stringify({
    mcpServers: {
      rocky: { type: "local", command: REGISTRATION.command, args: [...REGISTRATION.args], env: { ...REGISTRATION.env } },
    },
  }));
  const bin = fakeCopilotBin(dir);
  const adapter = createHarnessCopilotAdapter({
    runner: fakeRunner({ [`${bin} --version`]: { status: 0, stdout: "copilot 1.0.0" } }),
    platform: fakePlatform(dir, { copilot: bin }),
    env: { COPILOT_HOME: copilotHome } as NodeJS.ProcessEnv,
    home: dir,
  });
  assert.equal((await adapter.inspect(REGISTRATION)).state, "identical");
});

test("conflict without replace leaves the file untouched", async (t) => {
  const dir = tempDir(t);
  const configPath = join(dir, "config.json");
  const original = JSON.stringify({ mcpServers: { rocky: { type: "local", command: "/bin/impostor", args: [], env: {} } } });
  writeFileSync(configPath, original);
  const bin = fakeCopilotBin(dir);
  const adapter = createHarnessCopilotAdapter({
    runner: fakeRunner({ [`${bin} --version`]: { status: 0, stdout: "copilot 1.0.0" } }),
    platform: fakePlatform(dir, { copilot: bin }),
    home: dir,
    configPath,
  });
  assert.equal((await adapter.configure(REGISTRATION, false)).status, "requires-confirmation");
  assert.equal(readFileSync(configPath, "utf8"), original);
});

test("list hiding rocky after write reports configured-unverified", async (t) => {
  const dir = tempDir(t);
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({ mcpServers: {} }));
  const bin = fakeCopilotBin(dir);
  const adapter = createHarnessCopilotAdapter({
    runner: fakeRunner({
      [`${bin} --version`]: { status: 0, stdout: "copilot 1.0.0" },
      [`${bin} mcp list`]: { status: 0, stdout: "no servers configured" },
    }),
    platform: fakePlatform(dir, { copilot: bin }),
    home: dir,
    configPath,
  });
  const result = await adapter.configure(REGISTRATION, false);
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /configured; MCP unverified/);
});

test("remove refuses a foreign rocky entry and keeps it", async (t) => {
  const dir = tempDir(t);
  const configPath = join(dir, "config.json");
  const original = JSON.stringify({ mcpServers: { rocky: { type: "local", command: "/bin/impostor", args: [], env: {} } } });
  writeFileSync(configPath, original);
  const bin = fakeCopilotBin(dir);
  const adapter = createHarnessCopilotAdapter({
    runner: fakeRunner({ [`${bin} --version`]: { status: 0, stdout: "copilot 1.0.0" } }),
    platform: fakePlatform(dir, { copilot: bin }),
    home: dir,
    configPath,
  });
  const result = await adapter.remove(REGISTRATION);
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /not owned/);
  assert.equal(readFileSync(configPath, "utf8"), original);
});

test("malformed config blocks mutation", async (t) => {
  const dir = tempDir(t);
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, "not json{{{");
  const bin = fakeCopilotBin(dir);
  const adapter = createHarnessCopilotAdapter({
    runner: fakeRunner({ [`${bin} --version`]: { status: 0, stdout: "copilot 1.0.0" } }),
    platform: fakePlatform(dir, { copilot: bin }),
    home: dir,
    configPath,
  });
  assert.equal((await adapter.inspect(REGISTRATION)).state, "unreadable");
  assert.equal((await adapter.configure(REGISTRATION, false)).status, "failed");
});
