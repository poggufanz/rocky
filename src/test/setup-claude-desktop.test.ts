import test from "node:test";
import assert from "node:assert/strict";
import fs, {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  createClaudeDesktopAdapter,
  resolveDesktopConfigPath,
} from "../setup/claude-desktop.js";
import { createPlatformServices } from "../setup/platform.js";

const registration = {
  name: "rocky" as const,
  command: "/opt/node",
  args: ["/opt/rocky/dist/index.js", "mcp"],
  env: { ROCKY_MCP_EXPOSURE: "sanitized", ROCKY_HOME: "/home/ada/.rocky" },
};

function storedRegistration(command = registration.command): Record<string, unknown> {
  return {
    type: "stdio",
    command,
    args: [...registration.args],
    env: { ...registration.env },
  };
}

function configPath(t: test.TestContext, value?: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), "rocky-claude-desktop-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "claude_desktop_config.json");
  if (value !== undefined) {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o640 });
    chmodSync(path, 0o640);
  }
  return path;
}

function backupPaths(path: string): string[] {
  return readdirSync(dirname(path))
    .filter((name) => name.startsWith(`${basename(path)}.backup-`))
    .map((name) => join(dirname(path), name));
}

test("native Claude Desktop config paths are exact and unsupported hosts stay unresolved", () => {
  const mac = createPlatformServices({
    platform: "darwin",
    home: "/Users/Ada",
    env: { PATH: "/usr/bin" },
    isWsl: false,
  });
  const macWithRelativeHome = createPlatformServices({
    platform: "darwin",
    home: "Users/Ada",
    env: { PATH: "/usr/bin" },
    isWsl: false,
  });
  const windows = createPlatformServices({
    platform: "win32",
    home: "C:\\Users\\Ada",
    appData: "C:\\Users\\Ada\\AppData\\Roaming",
    env: { PATH: "C:\\Windows\\System32" },
    isWsl: false,
  });
  const windowsWithoutAppData = createPlatformServices({
    platform: "win32",
    home: "C:\\Users\\Ada",
    env: {},
    isWsl: false,
  });
  const windowsWithRelativeAppData = createPlatformServices({
    platform: "win32",
    home: "C:\\Users\\Ada",
    appData: "AppData\\Roaming",
    env: {},
    isWsl: false,
  });
  const linux = createPlatformServices({
    platform: "linux",
    home: "/home/ada",
    env: { PATH: "/usr/bin" },
    isWsl: false,
  });

  assert.equal(
    resolveDesktopConfigPath(mac),
    "/Users/Ada/Library/Application Support/Claude/claude_desktop_config.json",
  );
  assert.equal(
    resolveDesktopConfigPath(windows),
    "C:\\Users\\Ada\\AppData\\Roaming\\Claude\\claude_desktop_config.json",
  );
  assert.equal(resolveDesktopConfigPath(macWithRelativeHome), undefined);
  assert.equal(resolveDesktopConfigPath(windowsWithoutAppData), undefined);
  assert.equal(resolveDesktopConfigPath(windowsWithRelativeAppData), undefined);
  assert.equal(resolveDesktopConfigPath(linux), undefined);
});

test("configure merges only mcpServers.rocky and backs up exact existing bytes", async (t) => {
  const original = {
    theme: "dark",
    secret: "fake-top-level-secret",
    mcpServers: {
      other: { command: "/opt/other", env: { TOKEN: "fake-other-secret" } },
    },
  };
  const path = configPath(t, original);
  const originalBytes = readFileSync(path);
  const adapter = createClaudeDesktopAdapter({ configPath: path });

  const configured = await adapter.configure(registration, false);

  assert.equal(configured.status, "configured");
  assert.match(configured.detail ?? "", /backup/i);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
    ...original,
    mcpServers: { ...original.mcpServers, rocky: storedRegistration() },
  });
  const backups = backupPaths(path);
  assert.equal(backups.length, 1);
  assert.deepEqual(readFileSync(backups[0]!), originalBytes);
  assert.equal(statSync(path).mode & 0o777, 0o640);
});

test("configure creates a private missing config without inventing unrelated keys or backup", async (t) => {
  const path = configPath(t);
  const adapter = createClaudeDesktopAdapter({ configPath: path });

  const configured = await adapter.configure(registration, false);

  assert.deepEqual(configured, { client: "claude-desktop", status: "configured" });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
    mcpServers: { rocky: storedRegistration() },
  });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(backupPaths(path), []);
});

test("identical registration is an inspectable no-op and healthy", async (t) => {
  const original = { theme: "dark", mcpServers: { rocky: storedRegistration() } };
  const path = configPath(t, original);
  const originalBytes = readFileSync(path);
  const adapter = createClaudeDesktopAdapter({ configPath: path });

  assert.deepEqual(await adapter.inspect(registration), {
    state: "identical",
    snapshot: storedRegistration(),
  });
  assert.deepEqual(await adapter.configure(registration, false), {
    client: "claude-desktop",
    status: "already-configured",
  });
  assert.deepEqual(await adapter.check(registration), {
    client: "claude-desktop",
    status: "healthy",
  });
  assert.deepEqual(readFileSync(path), originalBytes);
  assert.deepEqual(backupPaths(path), []);
});

test("foreign rocky entry requires explicit replacement and remains byte-identical on refusal", async (t) => {
  const original = {
    theme: "dark",
    mcpServers: { rocky: { command: "/usr/bin/foreign", token: "fake-secret" } },
  };
  const path = configPath(t, original);
  const originalBytes = readFileSync(path);
  const adapter = createClaudeDesktopAdapter({ configPath: path });

  const refused = await adapter.configure(registration, false);

  assert.deepEqual(refused, {
    client: "claude-desktop",
    status: "requires-confirmation",
    detail: "Claude Desktop already has a different rocky registration",
    manualRegistration: registration,
  });
  assert.deepEqual(readFileSync(path), originalBytes);
  assert.deepEqual(backupPaths(path), []);

  const replaced = await adapter.configure(registration, true);
  assert.equal(replaced.status, "configured");
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
    theme: "dark",
    mcpServers: { rocky: storedRegistration() },
  });
  assert.equal(backupPaths(path).length, 1);
});

test("malformed JSON and non-object mcpServers refuse every mutation without leaking secrets", async (t) => {
  const cases = [
    { name: "malformed JSON", bytes: '{"secret":"fake-malformed-secret",' },
    { name: "array mcpServers", bytes: '{"mcpServers":["fake-array-secret"]}\n' },
    { name: "scalar mcpServers", bytes: '{"mcpServers":"fake-scalar-secret"}\n' },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async (st) => {
      const path = configPath(st);
      writeFileSync(path, entry.bytes, "utf8");
      const originalBytes = readFileSync(path);
      const adapter = createClaudeDesktopAdapter({ configPath: path });

      for (const result of [
        await adapter.configure(registration, true),
        await adapter.remove(registration),
        await adapter.check(registration),
      ]) {
        assert.equal(result.status, "failed");
        assert.match(result.detail ?? "", /read Claude Desktop config/i);
        assert.doesNotMatch(result.detail ?? "", /fake-malformed|fake-array|fake-scalar/);
      }
      assert.deepEqual(readFileSync(path), originalBytes);
      assert.deepEqual(backupPaths(path), []);
    });
  }
});

test("remove deletes only a recognized Rocky identity and preserves unrelated config", async (t) => {
  const recognized = {
    ...storedRegistration(),
    env: {
      ROCKY_MCP_EXPOSURE: "raw",
      ROCKY_HOME: "/home/ada/state/../.rocky",
      FUTURE_FIELD: "preserved-until-removal",
    },
    futureMetadata: { secret: "fake-metadata-secret" },
  };
  const original = {
    theme: "dark",
    mcpServers: {
      other: { token: "fake-other-secret" },
      rocky: recognized,
    },
  };
  const path = configPath(t, original);
  const originalBytes = readFileSync(path);
  const adapter = createClaudeDesktopAdapter({ configPath: path });

  const removed = await adapter.remove(registration);

  assert.equal(removed.status, "removed");
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
    theme: "dark",
    mcpServers: { other: { token: "fake-other-secret" } },
  });
  const backups = backupPaths(path);
  assert.equal(backups.length, 1);
  assert.deepEqual(readFileSync(backups[0]!), originalBytes);
});

test("remove refuses an entry merely named rocky and leaves exact bytes untouched", async (t) => {
  const original = {
    mcpServers: {
      rocky: {
        type: "stdio",
        command: "/usr/bin/foreign",
        args: [...registration.args],
        env: { ...registration.env, TOKEN: "fake-secret" },
      },
    },
  };
  const path = configPath(t, original);
  const originalBytes = readFileSync(path);
  const adapter = createClaudeDesktopAdapter({ configPath: path });

  const removed = await adapter.remove(registration);

  assert.deepEqual(removed, {
    client: "claude-desktop",
    status: "failed",
    detail: "Claude Desktop rocky registration is not owned by Rocky",
  });
  assert.deepEqual(readFileSync(path), originalBytes);
  assert.deepEqual(backupPaths(path), []);
});

test("missing config path produces manual configuration instead of guessing", async () => {
  const adapter = createClaudeDesktopAdapter({});

  assert.deepEqual(await adapter.inspect(registration), {
    state: "blocked",
    detail: "Claude Desktop config path is unresolved; use manual configuration",
  });
  for (const result of [
    await adapter.configure(registration, false),
    await adapter.remove(registration),
    await adapter.check(registration),
  ]) {
    assert.equal(result.status, "failed");
    assert.match(result.detail ?? "", /manual configuration/i);
    assert.deepEqual(result.manualRegistration, registration);
  }
});

test("relative config path is unresolved instead of being interpreted against process cwd", async () => {
  const adapter = createClaudeDesktopAdapter({ configPath: "relative/claude_desktop_config.json" });

  assert.deepEqual(await adapter.inspect(registration), {
    state: "blocked",
    detail: "Claude Desktop config path is unresolved; use manual configuration",
  });
});

test("failed registration transform stays secret-free and does not offer unusable Linux argv", async (t) => {
  const path = configPath(t);
  const adapter = createClaudeDesktopAdapter({
    configPath: path,
    transformRegistration() {
      throw new Error("fake-transform-secret");
    },
  });

  const configured = await adapter.configure(registration, false);

  assert.equal(configured.status, "failed");
  assert.match(configured.detail ?? "", /manual configuration/i);
  assert.doesNotMatch(configured.detail ?? "", /fake-transform-secret/);
  assert.equal(configured.manualRegistration, undefined);
  assert.equal(readdirSync(dirname(path)).length, 0);
});

test("managed policy blocks a required mutation but permits read-only identical checks", async (t) => {
  const path = configPath(t, { theme: "dark" });
  const originalBytes = readFileSync(path);
  const adapter = createClaudeDesktopAdapter({ configPath: path, policyBlocked: true });

  const configured = await adapter.configure(registration, false);

  assert.deepEqual(configured, {
    client: "claude-desktop",
    status: "blocked-by-policy",
    detail: "Claude Desktop policy blocks config mutation",
    manualRegistration: registration,
  });
  assert.deepEqual(readFileSync(path), originalBytes);
  assert.deepEqual(backupPaths(path), []);

  const identicalPath = configPath(t, { mcpServers: { rocky: storedRegistration() } });
  const identical = createClaudeDesktopAdapter({ configPath: identicalPath, policyBlocked: true });
  assert.equal((await identical.configure(registration, false)).status, "already-configured");
  assert.equal((await identical.check(registration)).status, "healthy");
});

test("atomic write failure preserves current config, keeps backup, and cleans temporary sibling", async (t) => {
  const original = { secret: "fake-write-secret", mcpServers: { other: { enabled: true } } };
  const path = configPath(t, original);
  const originalBytes = readFileSync(path);
  const originalRename = fs.renameSync;
  fs.renameSync = ((source: fs.PathLike, destination: fs.PathLike) => {
    if (String(destination) === path) throw Object.assign(new Error("injected rename failure"), { code: "EACCES" });
    return originalRename(source, destination);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();

  try {
    const adapter = createClaudeDesktopAdapter({ configPath: path });
    const configured = await adapter.configure(registration, false);

    assert.equal(configured.status, "failed");
    assert.match(configured.detail ?? "", /write Claude Desktop config/i);
    assert.doesNotMatch(configured.detail ?? "", /fake-write-secret|injected rename/);
    assert.deepEqual(configured.manualRegistration, registration);
    assert.deepEqual(readFileSync(path), originalBytes);
    assert.equal(backupPaths(path).length, 1);
    assert.equal(readdirSync(dirname(path)).some((name) => name.includes(".tmp-")), false);
  } finally {
    fs.renameSync = originalRename;
    syncBuiltinESMExports();
  }
});

test("concurrent unrelated config change after backup is preserved instead of overwritten", async (t) => {
  const original = { theme: "dark", mcpServers: { other: { enabled: true } } };
  const concurrent = {
    theme: "light",
    secret: "fake-concurrent-secret",
    mcpServers: { other: { enabled: false }, concurrent: { command: "/opt/new" } },
  };
  const path = configPath(t, original);
  const originalBytes = readFileSync(path);
  const concurrentBytes = Buffer.from(`${JSON.stringify(concurrent, null, 2)}\n`, "utf8");
  const originalCopy = fs.copyFileSync;
  fs.copyFileSync = ((source: fs.PathLike, destination: fs.PathLike, mode?: number) => {
    originalCopy(source, destination, mode);
    if (String(source) === path) writeFileSync(path, concurrentBytes);
  }) as typeof fs.copyFileSync;
  syncBuiltinESMExports();

  try {
    const adapter = createClaudeDesktopAdapter({ configPath: path });
    const configured = await adapter.configure(registration, false);

    assert.equal(configured.status, "failed");
    assert.match(configured.detail ?? "", /changed|retry|manual/i);
    assert.doesNotMatch(configured.detail ?? "", /fake-concurrent-secret/);
    assert.deepEqual(readFileSync(path), concurrentBytes);
    const backups = backupPaths(path);
    assert.equal(backups.length, 1);
    assert.deepEqual(readFileSync(backups[0]!), originalBytes);
    assert.equal(readdirSync(dirname(path)).some((name) => name.includes(".tmp-")), false);
  } finally {
    fs.copyFileSync = originalCopy;
    syncBuiltinESMExports();
  }
});

test("registration transform is used for storage, inspection, and removal", async (t) => {
  const path = configPath(t);
  const bridged = {
    name: "rocky" as const,
    command: "C:\\Windows\\System32\\wsl.exe",
    args: [
      "-d", "Ubuntu", "--exec", "/usr/bin/env",
      "ROCKY_MCP_EXPOSURE=sanitized", "ROCKY_HOME=/home/ada/.rocky",
      "/usr/bin/node", "/opt/rocky/dist/index.js", "mcp",
    ],
    env: {},
  };
  const adapter = createClaudeDesktopAdapter({
    configPath: path,
    transformRegistration: () => bridged,
  });

  assert.equal((await adapter.configure(registration, false)).status, "configured");
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
    mcpServers: {
      rocky: { type: "stdio", command: bridged.command, args: bridged.args, env: {} },
    },
  });
  assert.equal((await adapter.inspect(registration)).state, "identical");
  assert.equal((await adapter.remove(registration)).status, "removed");
});

test("WSL removal recognizes the same bridge identity across safe exposure changes", async (t) => {
  const path = configPath(t);
  const bridge = (exposure: "sanitized" | "raw") => ({
    name: "rocky" as const,
    command: "C:\\Windows\\System32\\wsl.exe",
    args: [
      "-d", "Ubuntu-24.04", "--exec", "/usr/bin/env",
      `ROCKY_MCP_EXPOSURE=${exposure}`, "ROCKY_HOME=/home/ada/.rocky",
      "/usr/bin/node", "/opt/rocky/dist/index.js", "mcp",
    ],
    env: {},
  });
  const rawAdapter = createClaudeDesktopAdapter({
    configPath: path,
    transformRegistration: () => bridge("raw"),
  });
  assert.equal((await rawAdapter.configure(registration, false)).status, "configured");

  const defaultAdapter = createClaudeDesktopAdapter({
    configPath: path,
    transformRegistration: () => ({
      ...bridge("sanitized"),
      command: "c:\\WINDOWS\\system32\\WSL.EXE",
    }),
  });
  assert.equal((await defaultAdapter.remove(registration)).status, "removed");
});
