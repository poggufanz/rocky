import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarnessOpencodeAdapter } from "../setup/harness-opencode.js";
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
  const dir = mkdtempSync(join(tmpdir(), "rocky-harness-opencode-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeOpencodeBin(home: string): string {
  const binPath = join(home, "opencode");
  writeFileSync(binPath, "");
  return binPath;
}

test("not-found binary writes nothing and reports skipped", async (t) => {
  const dir = tempDir(t);
  const configPath = join(dir, "opencode.json");
  const adapter = createHarnessOpencodeAdapter({
    runner: fakeRunner({}),
    platform: fakePlatform(dir),
    home: dir,
    configPath,
  });
  assert.equal((await adapter.inspect(REGISTRATION)).state, "blocked");
  assert.equal((await adapter.configure(REGISTRATION, false)).status, "skipped");
});

test("merge preserves foreign mcp servers and detects identical", async (t) => {
  const dir = tempDir(t);
  const configPath = join(dir, "opencode.json");
  writeFileSync(configPath, JSON.stringify({
    mcp: {
      other: { type: "local", command: ["/bin/other"], environment: {} },
      rocky: {
        type: "local",
        command: [REGISTRATION.command, ...REGISTRATION.args],
        environment: { ...REGISTRATION.env },
      },
    },
  }));
  const bin = fakeOpencodeBin(dir);
  const adapter = createHarnessOpencodeAdapter({
    runner: fakeRunner({ [`${bin} --version`]: { status: 0, stdout: "opencode 1.2.0" } }),
    platform: fakePlatform(dir, { opencode: bin }),
    home: dir,
    configPath,
  });
  assert.equal((await adapter.inspect(REGISTRATION)).state, "identical");
  const before = readFileSync(configPath, "utf8");
  assert.match(before, /other/);
});

test("conflict without replace leaves the file untouched", async (t) => {
  const dir = tempDir(t);
  const configPath = join(dir, "opencode.json");
  const original = JSON.stringify({ mcp: { rocky: { type: "local", command: ["/bin/impostor"], environment: {} } } });
  writeFileSync(configPath, original);
  const bin = fakeOpencodeBin(dir);
  const adapter = createHarnessOpencodeAdapter({
    runner: fakeRunner({ [`${bin} --version`]: { status: 0, stdout: "opencode 1.2.0" } }),
    platform: fakePlatform(dir, { opencode: bin }),
    home: dir,
    configPath,
  });
  assert.equal((await adapter.configure(REGISTRATION, false)).status, "requires-confirmation");
  assert.equal(readFileSync(configPath, "utf8"), original);
});

test("configure writes atomically with a backup and preserves order", async (t) => {
  const dir = tempDir(t);
  const configPath = join(dir, "opencode.json");
  writeFileSync(configPath, JSON.stringify({ mcp: { aaa: { type: "local", command: ["/bin/a"], environment: {} } } }));
  const bin = fakeOpencodeBin(dir);
  const adapter = createHarnessOpencodeAdapter({
    runner: fakeRunner({ [`${bin} --version`]: { status: 0, stdout: "opencode 1.2.0" } }),
    platform: fakePlatform(dir, { opencode: bin }),
    home: dir,
    configPath,
  });
  const result = await adapter.configure(REGISTRATION, false);
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /configured; MCP unverified/);
  const after = JSON.parse(readFileSync(configPath, "utf8")) as { mcp: Record<string, unknown> };
  assert.deepEqual(Object.keys(after.mcp), ["aaa", "rocky"]);
  const backups = readdirSync(dir).filter((f) => f !== "opencode.json" && f !== "opencode");
  assert.equal(backups.length >= 1, true);
});

test("remove deletes only rocky and keeps foreign servers", async (t) => {
  const dir = tempDir(t);
  const configPath = join(dir, "opencode.json");
  writeFileSync(configPath, JSON.stringify({
    mcp: {
      keep: { type: "local", command: ["/bin/keep"], environment: {} },
      rocky: {
        type: "local",
        command: [REGISTRATION.command, ...REGISTRATION.args],
        environment: { ...REGISTRATION.env },
      },
    },
  }));
  const bin = fakeOpencodeBin(dir);
  const adapter = createHarnessOpencodeAdapter({
    runner: fakeRunner({ [`${bin} --version`]: { status: 0, stdout: "opencode 1.2.0" } }),
    platform: fakePlatform(dir, { opencode: bin }),
    home: dir,
    configPath,
  });
  const result = await adapter.remove(REGISTRATION);
  assert.equal(result.status, "removed");
  const after = JSON.parse(readFileSync(configPath, "utf8")) as { mcp: Record<string, unknown> };
  assert.deepEqual(Object.keys(after.mcp), ["keep"]);
});

test("malformed config is unreadable and blocks mutation", async (t) => {
  const dir = tempDir(t);
  const configPath = join(dir, "opencode.json");
  writeFileSync(configPath, "{ broken");
  const bin = fakeOpencodeBin(dir);
  const adapter = createHarnessOpencodeAdapter({
    runner: fakeRunner({ [`${bin} --version`]: { status: 0, stdout: "opencode 1.2.0" } }),
    platform: fakePlatform(dir, { opencode: bin }),
    home: dir,
    configPath,
  });
  assert.equal((await adapter.inspect(REGISTRATION)).state, "unreadable");
  assert.equal((await adapter.configure(REGISTRATION, false)).status, "failed");
});
