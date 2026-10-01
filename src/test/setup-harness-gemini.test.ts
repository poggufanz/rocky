import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarnessGeminiAdapter } from "../setup/harness-gemini-cli.js";
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
  const dir = mkdtempSync(join(tmpdir(), "rocky-harness-gemini-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeGeminiBin(home: string): string {
  const binPath = join(home, "gemini");
  writeFileSync(binPath, "");
  return binPath;
}

test("not-found binary writes nothing", async (t) => {
  const dir = tempDir(t);
  const settingsPath = join(dir, "settings.json");
  const adapter = createHarnessGeminiAdapter({
    runner: fakeRunner({}),
    platform: fakePlatform(dir),
    home: dir,
    settingsPath,
  });
  assert.equal((await adapter.inspect(REGISTRATION)).state, "blocked");
  assert.equal((await adapter.configure(REGISTRATION, false)).status, "skipped");
});

test("identical settings inspect identical and leave telemetry alone", async (t) => {
  const dir = tempDir(t);
  const settingsPath = join(dir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({
    telemetry: { enabled: false },
    mcpServers: {
      rocky: { command: REGISTRATION.command, args: [...REGISTRATION.args], env: { ...REGISTRATION.env } },
    },
  }));
  const bin = fakeGeminiBin(dir);
  const adapter = createHarnessGeminiAdapter({
    runner: fakeRunner({ [`${bin} --version`]: { status: 0, stdout: "0.9.0" } }),
    platform: fakePlatform(dir, { gemini: bin }),
    home: dir,
    settingsPath,
  });
  assert.equal((await adapter.inspect(REGISTRATION)).state, "identical");
});

test("conflict without replace preserves the foreign entry", async (t) => {
  const dir = tempDir(t);
  const settingsPath = join(dir, "settings.json");
  const original = JSON.stringify({
    telemetry: { enabled: true },
    mcpServers: { rocky: { command: "/bin/impostor", args: [], env: {} } },
  });
  writeFileSync(settingsPath, original);
  const bin = fakeGeminiBin(dir);
  const adapter = createHarnessGeminiAdapter({
    runner: fakeRunner({ [`${bin} --version`]: { status: 0, stdout: "0.9.0" } }),
    platform: fakePlatform(dir, { gemini: bin }),
    home: dir,
    settingsPath,
  });
  assert.equal((await adapter.configure(REGISTRATION, false)).status, "requires-confirmation");
  assert.equal(readFileSync(settingsPath, "utf8"), original);
});

test("malformed settings block mutation", async (t) => {
  const dir = tempDir(t);
  const settingsPath = join(dir, "settings.json");
  writeFileSync(settingsPath, "[broken");
  const bin = fakeGeminiBin(dir);
  const adapter = createHarnessGeminiAdapter({
    runner: fakeRunner({ [`${bin} --version`]: { status: 0, stdout: "0.9.0" } }),
    platform: fakePlatform(dir, { gemini: bin }),
    home: dir,
    settingsPath,
  });
  assert.equal((await adapter.inspect(REGISTRATION)).state, "unreadable");
  assert.equal((await adapter.configure(REGISTRATION, false)).status, "failed");
});

interface GeminiSettingsShape {
  telemetry?: unknown;
  mcpServers?: Record<string, { command?: string }>;
}

function readSettingsShape(settingsPath: string): GeminiSettingsShape {
  const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
  if (typeof parsed !== "object" || parsed === null) throw new Error("settings are not an object");
  return parsed as GeminiSettingsShape;
}

test("configure preserves telemetry keys byte-identical in value", async (t) => {
  const dir = tempDir(t);
  const settingsPath = join(dir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({
    telemetry: { enabled: true, endpoint: "https://example.invalid" },
    mcpServers: {},
  }));
  const bin = fakeGeminiBin(dir);
  const adapter = createHarnessGeminiAdapter({
    runner: fakeRunner({
      [`${bin} --version`]: { status: 0, stdout: "0.9.0" },
      [`${bin} mcp list`]: { status: 0, stdout: "rocky stdio" },
    }),
    platform: fakePlatform(dir, { gemini: bin }),
    home: dir,
    settingsPath,
  });
  const before = readSettingsShape(settingsPath).telemetry;
  const result = await adapter.configure(REGISTRATION, false);
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /configured; MCP unverified/);
  const after = readSettingsShape(settingsPath);
  assert.deepEqual(after.telemetry, before);
  assert.deepEqual(after.mcpServers?.rocky?.command, REGISTRATION.command);
});

test("remove keeps telemetry and foreign servers, drops only rocky", async (t) => {
  const dir = tempDir(t);
  const settingsPath = join(dir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({
    telemetry: { enabled: false },
    mcpServers: {
      keep: { command: "/bin/keep", args: [], env: {} },
      rocky: { command: REGISTRATION.command, args: [...REGISTRATION.args], env: { ...REGISTRATION.env } },
    },
  }));
  const bin = fakeGeminiBin(dir);
  const adapter = createHarnessGeminiAdapter({
    runner: fakeRunner({ [`${bin} --version`]: { status: 0, stdout: "0.9.0" } }),
    platform: fakePlatform(dir, { gemini: bin }),
    home: dir,
    settingsPath,
  });
  assert.equal((await adapter.remove(REGISTRATION)).status, "removed");
  const after = readSettingsShape(settingsPath);
  assert.deepEqual(after.telemetry, { enabled: false });
  assert.deepEqual(Object.keys(after.mcpServers ?? {}), ["keep"]);
});
