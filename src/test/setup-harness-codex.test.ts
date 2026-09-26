import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarnessCodexAdapter } from "../setup/harness-codex.js";
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

function fakeRunner(handlers: Record<string, { status: number | null; stdout: string }>): {
  run: (command: string, args: readonly string[]) => Promise<{ status: number | null; stdout: string; stderr: string }>;
  openSession: () => Promise<never>;
} {
  return {
    run: (command: string, args: readonly string[]) => {
      const key = `${command} ${args.join(" ")}`;
      const hit = handlers[key] ?? { status: 1, stdout: "" };
      return Promise.resolve({ ...hit, stderr: "" });
    },
    openSession: () => Promise.reject(new Error("protocol transport unavailable")),
  };
}

class HealthySession {
  private readonly lines: string[] = [];
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
        result: {
          tools: [
            "recall", "recent_failures", "stats", "recall_with_ai",
            "search_knowledge", "fetch_record", "why_file", "teach_lookup",
          ].map((name) => ({ name })),
        },
      }));
    } else {
      throw new Error(`unexpected probe method: ${message.method}`);
    }
  }
  async readLine(): Promise<string | undefined> { return this.lines.shift(); }
  end(): void { /* no-op */ }
  kill(): void { /* no-op */ }
  async wait(): Promise<{ status: number; stdout: string; stderr: string }> {
    return { status: 0, stdout: "", stderr: "" };
  }
}

function healthyListRunner(handlers: Record<string, { status: number | null; stdout: string }>) {
  const base = fakeRunner(handlers);
  return {
    run: base.run,
    openSession: () => Promise.resolve(new HealthySession()),
  };
}

function tempCodexHome(t: TestContext): { home: string; codexHome: string } {
  const home = mkdtempSync(join(tmpdir(), "rocky-harness-codex-"));
  const codexHome = join(home, ".codex");
  mkdirSync(codexHome, { recursive: true });
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, codexHome };
}

function fakeCodexBin(home: string): string {
  const binPath = join(home, "codex");
  writeFileSync(binPath, "");
  return binPath;
}

test("not-found binary inspects blocked and writes nothing", async (t) => {
  const { home, codexHome } = tempCodexHome(t);
  const adapter = createHarnessCodexAdapter({
    runner: fakeRunner({}),
    platform: fakePlatform(home),
    home,
    codexHome,
  });
  assert.equal((await adapter.inspect(REGISTRATION)).state, "blocked");
  const result = await adapter.configure(REGISTRATION, false);
  assert.equal(result.status, "skipped");
  assert.equal(result.client, "codex");
});

test("native mcp add success configures without touching config.toml", async (t) => {
  const { home, codexHome } = tempCodexHome(t);
  const configPath = join(codexHome, "config.toml");
  writeFileSync(configPath, '# user config\n[other]\nvalue = 1\n');
  const codexBin = fakeCodexBin(home);
  const adapter = createHarnessCodexAdapter({
    runner: fakeRunner({
      [`${codexBin} --version`]: { status: 0, stdout: "codex-cli 0.146.1" },
      [`${codexBin} mcp list`]: { status: 0, stdout: "rocky (stdio)" },
    }),
    platform: fakePlatform(home, { codex: codexBin }),
    home,
    codexHome,
  });
  const inspected = await adapter.inspect(REGISTRATION);
  assert.equal(inspected.state, "identical");
  assert.equal(readFileSync(configPath, "utf8"), '# user config\n[other]\nvalue = 1\n');
});

test("conflict without replace preserves the foreign block", async (t) => {
  const { home, codexHome } = tempCodexHome(t);
  const configPath = join(codexHome, "config.toml");
  writeFileSync(configPath, '[mcp_servers.rocky]\ncommand = "/bin/impostor"\n');
  const codexBin = fakeCodexBin(home);
  const adapter = createHarnessCodexAdapter({
    runner: fakeRunner({
      [`${codexBin} --version`]: { status: 0, stdout: "codex-cli 0.146.1" },
    }),
    platform: fakePlatform(home, { codex: codexBin }),
    home,
    codexHome,
  });
  const result = await adapter.configure(REGISTRATION, false);
  assert.equal(result.status, "requires-confirmation");
  assert.match(readFileSync(configPath, "utf8"), /impostor/);
});

test("unreadable config stops configure with failed", async (t) => {
  const { home, codexHome } = tempCodexHome(t);
  const configPath = join(codexHome, "config.toml");
  writeFileSync(configPath, '[mcp_servers.rocky\ncommand = unterminated\n');
  const codexBin = fakeCodexBin(home);
  const adapter = createHarnessCodexAdapter({
    runner: fakeRunner({
      [`${codexBin} --version`]: { status: 0, stdout: "codex-cli 0.146.1" },
    }),
    platform: fakePlatform(home, { codex: codexBin }),
    home,
    codexHome,
  });
  assert.equal((await adapter.inspect(REGISTRATION)).state, "unreadable");
  assert.equal((await adapter.configure(REGISTRATION, false)).status, "failed");
});

test("replace swaps an owned block and preserves neighboring sections", async (t) => {
  const { home, codexHome } = tempCodexHome(t);
  const configPath = join(codexHome, "config.toml");
  writeFileSync(configPath, '[other]\nvalue = 1\n[mcp_servers.rocky]\ncommand = "/usr/local/bin/node"\nargs = ["old"]\n');
  const codexBin = fakeCodexBin(home);
  const adapter = createHarnessCodexAdapter({
    runner: healthyListRunner({
      [`${codexBin} --version`]: { status: 0, stdout: "codex-cli 0.146.1" },
      [`${codexBin} mcp list`]: { status: 0, stdout: "rocky (stdio)" },
    }),
    platform: fakePlatform(home, { codex: codexBin }),
    home,
    codexHome,
  });
  const result = await adapter.configure(REGISTRATION, true);
  assert.equal(result.status, "configured");
  const after = readFileSync(configPath, "utf8");
  assert.match(after, /\[other\]/);
  assert.match(after, /dist\/index\.js/);
});

test("list hiding rocky after write reports configured-unverified", async (t) => {
  const { home, codexHome } = tempCodexHome(t);
  const codexBin = fakeCodexBin(home);
  const adapter = createHarnessCodexAdapter({
    runner: fakeRunner({
      [`${codexBin} --version`]: { status: 0, stdout: "codex-cli 0.146.1" },
      [`${codexBin} mcp list`]: { status: 0, stdout: "empty" },
    }),
    platform: fakePlatform(home, { codex: codexBin }),
    home,
    codexHome,
  });
  const result = await adapter.configure(REGISTRATION, false);
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /configured; MCP unverified/);
});
