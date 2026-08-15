import test from "node:test";
import assert from "node:assert/strict";
import fs, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, win32 } from "node:path";
import type { ProcessResult, ProcessRunOptions, ProcessRunner } from "../setup/process.js";
import {
  WslManualConfigurationError,
  buildWslDesktopRegistration,
  convertMountedWindowsPath,
} from "../setup/claude-desktop.js";
import { createPlatformServices } from "../setup/platform.js";
import { directorySyncCapability } from "../setup/directory-sync.js";
import { createProductionAdapters } from "../commands/setup.js";
import type { McpRegistration } from "../setup/clients.js";
import { skipIfSymlinkUnavailable } from "./symlink-capability.js";

const completeInput = {
  exposure: "sanitized" as const,
  windowsConfigPath: "/mnt/c/Users/Ada/AppData/Roaming/Claude/claude_desktop_config.json",
  wslExecutable: "C:\\Windows\\System32\\wsl.exe",
  distro: "Ubuntu-24.04",
  envExecutable: "/usr/bin/env",
  nodePath: "/usr/bin/node",
  entryPath: "/opt/rocky/dist/index.js",
  rockyHome: "/home/ada/.rocky",
};

const completeRegistration: McpRegistration = {
  name: "rocky",
  command: completeInput.nodePath,
  args: [completeInput.entryPath, "mcp"],
  env: {
    ROCKY_MCP_EXPOSURE: completeInput.exposure,
    ROCKY_HOME: completeInput.rockyHome,
  },
};

class FakeRunner implements ProcessRunner {
  readonly calls: Array<{ command: string; args: readonly string[]; options?: ProcessRunOptions }> = [];

  constructor(private readonly response: ProcessResult) {}

  async run(command: string, args: readonly string[], options?: ProcessRunOptions): Promise<ProcessResult> {
    this.calls.push({ command, args: [...args], options });
    return this.response;
  }
}

function nativeDesktopFixture(root: string): {
  parent: string;
  configPath: string;
  platform: ReturnType<typeof createPlatformServices>;
} {
  if (process.platform === "win32") {
    const parent = join(root, "Claude");
    return {
      parent,
      configPath: join(parent, "claude_desktop_config.json"),
      platform: createPlatformServices({
        platform: "win32",
        home: "C:\\Users\\Ada",
        appData: root,
        env: { PATH: "" },
        isWsl: false,
        claudeDesktopInstalled: true,
      }),
    };
  }
  const parent = join(root, "Library", "Application Support", "Claude");
  return {
    parent,
    configPath: join(parent, "claude_desktop_config.json"),
    platform: createPlatformServices({
      platform: "darwin",
      home: root,
      env: { PATH: "" },
      isWsl: false,
      claudeDesktopInstalled: true,
    }),
  };
}

function posixFilesystemRoot(t: test.TestContext): string {
  const nativeRoot = mkdtempSync(join(process.cwd(), ".rocky-wsl-production-"));
  t.after(() => rmSync(nativeRoot, { recursive: true, force: true }));
  if (process.platform !== "win32") return nativeRoot;
  const drive = win32.parse(nativeRoot).root;
  return `/${nativeRoot.slice(drive.length).replaceAll("\\", "/")}`;
}

test("WSL Desktop registration stores exact Windows command and Linux argv", () => {
  const registration = buildWslDesktopRegistration(completeInput);

  assert.deepEqual(registration, {
    name: "rocky",
    command: "C:\\Windows\\System32\\wsl.exe",
    args: [
      "-d", "Ubuntu-24.04", "--exec", "/usr/bin/env",
      "ROCKY_MCP_EXPOSURE=sanitized",
      "ROCKY_HOME=/home/ada/.rocky",
      "/usr/bin/node",
      "/opt/rocky/dist/index.js",
      "mcp",
    ],
    env: {},
  });
});

test("raw WSL registration changes only the explicit exposure argument", () => {
  const registration = buildWslDesktopRegistration({ ...completeInput, exposure: "raw" });

  assert.equal(registration.args[4], "ROCKY_MCP_EXPOSURE=raw");
  assert.deepEqual(registration.args.slice(5), [
    "ROCKY_HOME=/home/ada/.rocky",
    "/usr/bin/node",
    "/opt/rocky/dist/index.js",
    "mcp",
  ]);
});

test("unresolved WSL discovery fields require typed manual configuration without guesses", () => {
  const cases: Array<{ name: string; value: Partial<typeof completeInput> }> = [
    { name: "Windows config", value: { windowsConfigPath: undefined } },
    { name: "wsl.exe", value: { wslExecutable: undefined } },
    { name: "distro", value: { distro: undefined } },
    { name: "empty distro", value: { distro: "  " } },
    { name: "/usr/bin/env", value: { envExecutable: undefined } },
    { name: "Node", value: { nodePath: undefined } },
    { name: "entry", value: { entryPath: undefined } },
    { name: "Rocky home", value: { rockyHome: undefined } },
    { name: "absolute config", value: { windowsConfigPath: "mnt/c/Users/Ada/config.json" } },
    { name: "absolute Windows wsl.exe", value: { wslExecutable: "/mnt/c/Windows/System32/wsl.exe" } },
    { name: "wsl.exe identity", value: { wslExecutable: "C:\\Windows\\System32\\cmd.exe" } },
    { name: "absolute Linux env", value: { envExecutable: "usr/bin/env" } },
    { name: "canonical Linux env", value: { envExecutable: "/opt/bin/env" } },
    { name: "absolute Linux Node", value: { nodePath: "usr/bin/node" } },
    { name: "absolute Linux entry", value: { entryPath: "opt/rocky/dist/index.js" } },
    { name: "absolute Linux home", value: { rockyHome: "home/ada/.rocky" } },
  ];

  for (const entry of cases) {
    assert.throws(
      () => buildWslDesktopRegistration({ ...completeInput, ...entry.value }),
      (error: unknown) => {
        const candidate = error as Error & { code?: string };
        return error instanceof WslManualConfigurationError
          && candidate.code === "WSL_MANUAL_CONFIGURATION_REQUIRED"
          && /manual configuration/i.test(candidate.message)
          && !candidate.message.includes(String(Object.values(entry.value)[0]));
      },
      entry.name,
    );
  }
});

test("invalid WSL exposure requires manual configuration", () => {
  assert.throws(
    () => buildWslDesktopRegistration({ ...completeInput, exposure: "RAW" as "raw" }),
    WslManualConfigurationError,
  );
});

test("mounted Windows path conversion invokes direct wslpath argv without a shell", async () => {
  const runner = new FakeRunner({
    status: 0,
    stdout: "C:\\Windows\\System32\\wsl.exe\r\n",
    stderr: "",
  });

  const converted = await convertMountedWindowsPath({
    mountedPath: "/mnt/c/Windows/System32/wsl.exe",
    wslpathExecutable: "/usr/bin/wslpath",
    runner,
  });

  assert.equal(converted, "C:\\Windows\\System32\\wsl.exe");
  assert.deepEqual(runner.calls, [{
    command: "/usr/bin/wslpath",
    args: ["-w", "/mnt/c/Windows/System32/wsl.exe"],
    options: { timeoutMs: 10_000 },
  }]);
});

test("mounted path conversion refuses missing tools, relative paths, and invalid output", async () => {
  const cases = [
    {
      name: "missing wslpath",
      input: { mountedPath: "/mnt/c/Windows/System32/wsl.exe", runner: new FakeRunner({ status: 0, stdout: "", stderr: "" }) },
    },
    {
      name: "relative mounted path",
      input: { mountedPath: "mnt/c/Windows/System32/wsl.exe", wslpathExecutable: "/usr/bin/wslpath", runner: new FakeRunner({ status: 0, stdout: "C:\\Windows\\System32\\wsl.exe", stderr: "" }) },
    },
    {
      name: "relative wslpath",
      input: { mountedPath: "/mnt/c/Windows/System32/wsl.exe", wslpathExecutable: "usr/bin/wslpath", runner: new FakeRunner({ status: 0, stdout: "C:\\Windows\\System32\\wsl.exe", stderr: "" }) },
    },
    {
      name: "process failure",
      input: { mountedPath: "/mnt/c/Windows/System32/wsl.exe", wslpathExecutable: "/usr/bin/wslpath", runner: new FakeRunner({ status: 1, stdout: "fake-secret", stderr: "fake-error" }) },
    },
    {
      name: "non-Windows output",
      input: { mountedPath: "/mnt/c/Windows/System32/wsl.exe", wslpathExecutable: "/usr/bin/wslpath", runner: new FakeRunner({ status: 0, stdout: "/mnt/c/Windows/System32/wsl.exe\n", stderr: "" }) },
    },
    {
      name: "multiple output lines",
      input: { mountedPath: "/mnt/c/Windows/System32/wsl.exe", wslpathExecutable: "/usr/bin/wslpath", runner: new FakeRunner({ status: 0, stdout: "C:\\Windows\\wsl.exe\nC:\\Other\\wsl.exe\n", stderr: "" }) },
    },
  ];

  for (const entry of cases) {
    await assert.rejects(
      () => convertMountedWindowsPath(entry.input),
      (error: unknown) => {
        const candidate = error as Error;
        return error instanceof WslManualConfigurationError
          && /manual configuration/i.test(candidate.message)
          && !/fake-secret|fake-error/.test(candidate.message);
      },
      entry.name,
    );
  }
});

test("mounted path conversion turns runner rejection into secret-free manual guidance", async () => {
  const runner: ProcessRunner = {
    async run() {
      throw new Error("fake-runner-secret");
    },
  };

  await assert.rejects(
    () => convertMountedWindowsPath({
      mountedPath: "/mnt/c/Windows/System32/wsl.exe",
      wslpathExecutable: "/usr/bin/wslpath",
      runner,
    }),
    (error: unknown) => {
      const candidate = error as Error;
      return error instanceof WslManualConfigurationError
        && /manual configuration/i.test(candidate.message)
        && !/fake-runner-secret/.test(candidate.message);
    },
  );
});

test("production WSL Desktop construction verifies every bridge input before conversion", async (t) => {
  const root = posixFilesystemRoot(t);
  const configPath = posix.join(root, "mnt/c/Users/Ada/AppData/Roaming/Claude/claude_desktop_config.json");
  const mountedWsl = posix.join(root, "mnt/c/Windows/System32/wsl.exe");
  const wslpath = posix.join(root, "usr/bin/wslpath");
  const envPath = "/usr/bin/env";
  const nodePath = posix.join(root, "usr/bin/node");
  const entryPath = posix.join(root, "opt/rocky/dist/index.js");
  const rockyHome = posix.join(root, "home/ada/.rocky");
  for (const path of [configPath, mountedWsl, wslpath, nodePath, entryPath]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, path === configPath ? "{}\n" : "fixture", "utf8");
  }
  const existing = new Set([configPath, mountedWsl, wslpath, envPath, nodePath, entryPath]);
  const platform = createPlatformServices({
    platform: "linux",
    home: posix.join(root, "home/ada"),
    env: { PATH: "" },
    isWsl: true,
    wslDistro: "Ubuntu-24.04",
    wslDesktopConfigPaths: [configPath],
    wslExecutablePaths: [mountedWsl],
    wslpathExecutablePaths: [wslpath],
    fileExists: (path) => existing.has(path),
  });
  const runner = new FakeRunner({
    status: 0,
    stdout: "C:\\Windows\\System32\\wsl.exe\r\n",
    stderr: "",
  });
  const registration: McpRegistration = {
    name: "rocky",
    command: nodePath,
    args: [entryPath, "mcp"],
    env: { ROCKY_MCP_EXPOSURE: "raw", ROCKY_HOME: rockyHome },
  };

  const adapters = await createProductionAdapters(platform, runner, registration);
  const desktop = adapters.find(({ id }) => id === "claude-desktop");
  assert.ok(desktop !== undefined);
  assert.equal((await desktop.configure(registration, false)).status, "configured");
  assert.deepEqual(runner.calls, [{
    command: wslpath,
    args: ["-w", mountedWsl],
    options: { timeoutMs: 10_000 },
  }]);
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
    mcpServers: {
      rocky: {
        type: "stdio",
        command: "C:\\Windows\\System32\\wsl.exe",
        args: [
          "-d", "Ubuntu-24.04", "--exec", "/usr/bin/env",
          "ROCKY_MCP_EXPOSURE=raw", `ROCKY_HOME=${rockyHome}`,
          nodePath, entryPath, "mcp",
        ],
        env: {},
      },
    },
  });
  assert.deepEqual(await desktop.check({
    ...registration,
    env: { ...registration.env, ROCKY_MCP_EXPOSURE: "sanitized" },
  }), {
    client: "claude-desktop",
    status: "healthy",
    healthRegistration: {
      name: "rocky",
      command: mountedWsl,
      args: [
        "-d", "Ubuntu-24.04", "--exec", "/usr/bin/env",
        "ROCKY_MCP_EXPOSURE=raw", `ROCKY_HOME=${rockyHome}`,
        nodePath, entryPath, "mcp",
      ],
      env: {},
    },
  });
});

test("missing or ambiguous WSL discovery skips Desktop before conversion or builder mutation", async (t) => {
  const baseRegistration: McpRegistration = {
    name: "rocky",
    command: "/usr/bin/node",
    args: ["/opt/rocky/dist/index.js", "mcp"],
    env: { ROCKY_MCP_EXPOSURE: "sanitized", ROCKY_HOME: "/home/ada/.rocky" },
  };
  const required = new Set([
    "/mnt/c/config.json",
    "/mnt/c/Windows/System32/wsl.exe",
    "/usr/bin/wslpath",
    "/usr/bin/env",
    "/usr/bin/node",
    "/opt/rocky/dist/index.js",
  ]);
  const cases: Array<{
    name: string;
    configPaths?: readonly string[];
    wslPaths?: readonly string[];
    wslpathPaths?: readonly string[];
    distro?: string;
    registration?: McpRegistration;
    missing?: string;
  }> = [
    { name: "missing Desktop config", configPaths: [] },
    { name: "ambiguous Desktop config", configPaths: ["/mnt/c/config.json", "/mnt/d/config.json"] },
    { name: "missing wsl.exe", wslPaths: [] },
    { name: "ambiguous wsl.exe", wslPaths: ["/mnt/c/Windows/System32/wsl.exe", "/mnt/d/wsl.exe"] },
    { name: "missing wslpath", wslpathPaths: [] },
    { name: "ambiguous wslpath", wslpathPaths: ["/usr/bin/wslpath", "/opt/bin/wslpath"] },
    { name: "missing canonical env", missing: "/usr/bin/env" },
    { name: "missing Node", missing: "/usr/bin/node" },
    { name: "missing entry", missing: "/opt/rocky/dist/index.js" },
    { name: "missing distro", distro: "" },
    {
      name: "relative Rocky home",
      registration: { ...baseRegistration, env: { ...baseRegistration.env, ROCKY_HOME: "state/.rocky" } },
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const existing = new Set(required);
      if (entry.missing !== undefined) existing.delete(entry.missing);
      const platform = createPlatformServices({
        platform: "linux",
        home: "/home/ada",
        env: { PATH: "" },
        isWsl: true,
        wslDistro: entry.distro ?? "Ubuntu-24.04",
        wslDesktopConfigPaths: entry.configPaths ?? ["/mnt/c/config.json"],
        wslExecutablePaths: entry.wslPaths ?? ["/mnt/c/Windows/System32/wsl.exe"],
        wslpathExecutablePaths: entry.wslpathPaths ?? ["/usr/bin/wslpath"],
        fileExists: (path) => existing.has(path),
      });
      const runner = new FakeRunner({ status: 0, stdout: "C:\\Windows\\System32\\wsl.exe\n", stderr: "" });

      const adapters = await createProductionAdapters(
        platform,
        runner,
        entry.registration ?? baseRegistration,
      );
      const desktop = adapters.find(({ id }) => id === "claude-desktop");
      assert.ok(desktop !== undefined);
      const result = await desktop.configure(entry.registration ?? baseRegistration, false);

      assert.equal(result.status, "skipped");
      assert.match(result.detail ?? "", /manual|unavailable|incomplete/i);
      assert.deepEqual(runner.calls, []);
    });
  }
});

test("production WSL Desktop construction turns a non-wsl.exe conversion into manual setup", async () => {
  const registration: McpRegistration = {
    name: "rocky",
    command: "/usr/bin/node",
    args: ["/opt/rocky/dist/index.js", "mcp"],
    env: { ROCKY_MCP_EXPOSURE: "sanitized", ROCKY_HOME: "/home/ada/.rocky" },
  };
  const existing = new Set([
    "/mnt/c/config.json",
    "/mnt/c/Windows/System32/wsl.exe",
    "/usr/bin/wslpath",
    "/usr/bin/env",
    "/usr/bin/node",
    "/opt/rocky/dist/index.js",
  ]);
  const platform = createPlatformServices({
    platform: "linux",
    home: "/home/ada",
    env: { PATH: "" },
    isWsl: true,
    wslDistro: "Ubuntu-24.04",
    wslDesktopConfigPaths: ["/mnt/c/config.json"],
    wslExecutablePaths: ["/mnt/c/Windows/System32/wsl.exe"],
    wslpathExecutablePaths: ["/usr/bin/wslpath"],
    fileExists: (path) => existing.has(path),
  });
  const runner = new FakeRunner({
    status: 0,
    stdout: "C:\\Windows\\System32\\cmd.exe\n",
    stderr: "fake-secret",
  });

  const adapters = await createProductionAdapters(platform, runner, registration);
  const desktop = adapters.find(({ id }) => id === "claude-desktop");
  assert.ok(desktop !== undefined);
  const result = await desktop.configure(registration, false);

  assert.equal(result.status, "skipped");
  assert.match(result.detail ?? "", /manual|unavailable|incomplete/i);
  assert.doesNotMatch(result.detail ?? "", /fake-secret|cmd\.exe/i);
  assert.equal(runner.calls.length, 1);
});

test("production WSL discovery enumerates real mounted Windows profile config paths", () => {
  const adaConfig = "/mnt/c/Users/Ada/AppData/Roaming/Claude/claude_desktop_config.json";
  const listed: string[] = [];
  const platform = createPlatformServices({
    platform: "linux",
    home: "/home/ada",
    env: { PATH: "" },
    isWsl: true,
    listDirectory(path: string) {
      listed.push(path);
      return ["Ada", "Grace", "Public"];
    },
    fileExists: (path: string) => path === adaConfig,
  });

  assert.deepEqual(listed, ["/mnt/c/Users"]);
  assert.deepEqual(platform.wslDesktopConfigPaths, [adaConfig]);
});

test("explicit WSL Desktop config is an additional deduplicated candidate", () => {
  const discovered = "/mnt/c/Users/Ada/AppData/Roaming/Claude/claude_desktop_config.json";
  const explicit = "/mnt/c/Users/Grace/AppData/Roaming/Claude/claude_desktop_config.json";
  const existing = new Set([discovered, explicit]);
  const platform = createPlatformServices({
    platform: "linux",
    home: "/home/ada",
    env: { PATH: "", ROCKY_WSL_CLAUDE_CONFIG: explicit },
    isWsl: true,
    listDirectory: () => ["Ada"],
    fileExists: (path: string) => existing.has(path),
  });

  assert.deepEqual(platform.wslDesktopConfigPaths, [discovered, explicit]);
});

test("native macOS and Windows skip Desktop when the client is absent", async (t) => {
  const cases = [
    {
      name: "macOS",
      platform: createPlatformServices({
        platform: "darwin",
        home: "/Users/Ada",
        env: { PATH: "" },
        isWsl: false,
        fileExists: () => false,
      }),
    },
    {
      name: "Windows",
      platform: createPlatformServices({
        platform: "win32",
        home: "C:\\Users\\Ada",
        appData: "C:\\Users\\Ada\\AppData\\Roaming",
        env: { PATH: "", LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" },
        isWsl: false,
        fileExists: () => false,
      }),
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const runner = new FakeRunner({
        status: 0,
        stdout: "",
        stderr: "",
      });
      const adapters = await createProductionAdapters(entry.platform, runner, completeRegistration);
      const desktop = adapters.find(({ id }) => id === "claude-desktop");
      assert.ok(desktop !== undefined);

      const inspected = await desktop.inspect(completeRegistration);
      const configured = await desktop.configure(completeRegistration, false);

      assert.equal(inspected.state, "blocked");
      assert.match(inspected.detail ?? "", /not installed/i);
      assert.equal(configured.status, "skipped");
      assert.deepEqual(runner.calls, []);
    });
  }
});

test("installed native Desktop is configurable before its first config file exists", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rocky-native-desktop-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = nativeDesktopFixture(root);
  const adapters = await createProductionAdapters(fixture.platform, new FakeRunner({
    status: 0,
    stdout: "",
    stderr: "",
  }), completeRegistration);
  const desktop = adapters.find(({ id }) => id === "claude-desktop");
  assert.ok(desktop !== undefined);

  assert.equal((await desktop.inspect(completeRegistration)).state, "absent");
  assert.equal((await desktop.configure(completeRegistration, false)).status, "configured");
  assert.deepEqual(JSON.parse(readFileSync(fixture.configPath, "utf8")), {
    mcpServers: {
      rocky: {
        type: "stdio",
        command: completeRegistration.command,
        args: [...completeRegistration.args],
        env: { ...completeRegistration.env },
      },
    },
  });
});

test("native Desktop rejects parent replacement during fresh inspection", async (t) => {
  if (skipIfSymlinkUnavailable(t, "dir")) return;
  const root = mkdtempSync(join(tmpdir(), "rocky-native-fresh-swap-"));
  const attackerRoot = mkdtempSync(join(tmpdir(), "rocky-native-fresh-target-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  t.after(() => rmSync(attackerRoot, { recursive: true, force: true }));
  const fixture = nativeDesktopFixture(root);
  const displacedParent = `${fixture.parent}-prepared`;
  const attackerTarget = join(attackerRoot, "attacker");
  mkdirSync(attackerTarget);
  const originalReaddir = fs.readdirSync;
  let swapped = false;
  fs.readdirSync = ((path: fs.PathLike, options?: unknown) => {
    if (!swapped && String(path) === fixture.parent && existsSync(fixture.parent)) {
      fs.renameSync(fixture.parent, displacedParent);
      symlinkSync(attackerTarget, fixture.parent, "dir");
      swapped = true;
    }
    return options === undefined
      ? originalReaddir(path)
      : originalReaddir(path, options as never);
  }) as typeof fs.readdirSync;
  syncBuiltinESMExports();

  try {
    const adapters = await createProductionAdapters(
      fixture.platform,
      new FakeRunner({ status: 0, stdout: "", stderr: "" }),
      completeRegistration,
    );
    const desktop = adapters.find(({ id }) => id === "claude-desktop");
    assert.ok(desktop !== undefined);

    const result = await desktop.configure(completeRegistration, false);

    assert.equal(swapped, true);
    assert.equal(result.status, "failed");
    assert.doesNotMatch(result.detail ?? "", /fake-secret|ROCKY_HOME|\/home\/ada/i);
    assert.deepEqual(originalReaddir(attackerTarget), []);
    assert.deepEqual(originalReaddir(displacedParent), []);
  } finally {
    fs.readdirSync = originalReaddir;
    syncBuiltinESMExports();
  }
});

test("native Desktop revalidates parent inside writer before publication", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rocky-native-writer-swap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = nativeDesktopFixture(root);
  const configName = basename(fixture.configPath);
  const displacedParent = `${fixture.parent}-prepared`;
  const originalLstat = fs.lstatSync;
  const originalReaddir = fs.readdirSync;
  let swapped = false;
  (fs as unknown as { lstatSync: typeof fs.lstatSync }).lstatSync = ((path: fs.PathLike, options?: unknown) => {
    const transactionExists = existsSync(fixture.parent)
      && originalReaddir(fixture.parent).some((name) => name.startsWith(`.${configName}.transaction-`));
    if (!swapped && transactionExists) {
      fs.renameSync(fixture.parent, displacedParent);
      mkdirSync(fixture.parent, { mode: 0o700 });
      swapped = true;
    }
    return options === undefined
      ? originalLstat(path)
      : originalLstat(path, options as never);
  }) as typeof fs.lstatSync;
  syncBuiltinESMExports();

  try {
    const adapters = await createProductionAdapters(
      fixture.platform,
      new FakeRunner({ status: 0, stdout: "", stderr: "" }),
      completeRegistration,
    );
    const desktop = adapters.find(({ id }) => id === "claude-desktop");
    assert.ok(desktop !== undefined);

    const result = await desktop.configure(completeRegistration, false);

    assert.equal(swapped, true);
    assert.equal(result.status, "failed");
    assert.doesNotMatch(result.detail ?? "", /fake-secret|ROCKY_HOME|\/home\/ada/i);
    assert.deepEqual(originalReaddir(fixture.parent), []);
    assert.equal(existsSync(join(displacedParent, configName)), false);
    assert.equal(
      originalReaddir(displacedParent).some((name) => name.startsWith(`.${configName}.transaction-`)),
      true,
    );
  } finally {
    (fs as unknown as { lstatSync: typeof fs.lstatSync }).lstatSync = originalLstat;
    syncBuiltinESMExports();
  }
});

test("native Desktop never cleans through topology rebound after publication collision", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rocky-native-cleanup-swap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = nativeDesktopFixture(root);
  const parent = fixture.parent;
  const displacedParent = `${parent}-prepared`;
  const configPath = fixture.configPath;
  const sentinel = "attacker-sentinel\n";
  const originalLink = fs.linkSync;
  let sentinelPath: string | undefined;
  (fs as unknown as { linkSync: typeof fs.linkSync }).linkSync = ((existingPath, newPath) => {
    if (sentinelPath === undefined && String(newPath) === configPath) {
      const transactionName = basename(dirname(String(existingPath)));
      fs.renameSync(parent, displacedParent);
      mkdirSync(join(parent, transactionName), { recursive: true, mode: 0o700 });
      writeFileSync(configPath, "attacker-config\n", "utf8");
      sentinelPath = join(parent, transactionName, "sentinel");
      writeFileSync(sentinelPath, sentinel, "utf8");
    }
    return originalLink(existingPath, newPath);
  }) as typeof fs.linkSync;
  syncBuiltinESMExports();

  try {
    const adapters = await createProductionAdapters(
      fixture.platform,
      new FakeRunner({ status: 0, stdout: "", stderr: "" }),
      completeRegistration,
    );
    const desktop = adapters.find(({ id }) => id === "claude-desktop");
    assert.ok(desktop !== undefined);

    const result = await desktop.configure(completeRegistration, false);

    assert.equal(result.status, "failed");
    assert.doesNotMatch(result.detail ?? "", /attacker-config|attacker-sentinel|ROCKY_HOME/i);
    assert.ok(sentinelPath !== undefined);
    assert.equal(readFileSync(sentinelPath, "utf8"), sentinel);
    assert.equal(readFileSync(configPath, "utf8"), "attacker-config\n");
    assert.equal(existsSync(join(displacedParent, "claude_desktop_config.json")), false);
  } finally {
    (fs as unknown as { linkSync: typeof fs.linkSync }).linkSync = originalLink;
    syncBuiltinESMExports();
  }
});

test("native Desktop does not create or advertise a backup after parent identity changes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rocky-native-backup-create-swap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = nativeDesktopFixture(root);
  const parent = fixture.parent;
  const displacedParent = `${parent}-prepared`;
  const configPath = fixture.configPath;
  mkdirSync(parent, { recursive: true });
  writeFileSync(configPath, '{"theme":"dark"}\n', "utf8");
  const originalFstat = fs.fstatSync;
  const originalLstat = fs.lstatSync;
  let backupSourceRead = false;
  let swapped = false;
  (fs as unknown as { fstatSync: typeof fs.fstatSync }).fstatSync = ((fd, options?: unknown) => {
    backupSourceRead = true;
    return options === undefined
      ? originalFstat(fd)
      : originalFstat(fd, options as never);
  }) as typeof fs.fstatSync;
  (fs as unknown as { lstatSync: typeof fs.lstatSync }).lstatSync = ((path: fs.PathLike, options?: unknown) => {
    if (backupSourceRead && !swapped && String(path) === root) {
      fs.renameSync(parent, displacedParent);
      mkdirSync(parent, { mode: 0o700 });
      swapped = true;
    }
    const metadata = options === undefined
      ? originalLstat(path)
      : originalLstat(path, options as never);
    const isBigInt = typeof options === "object"
      && options !== null
      && (options as { bigint?: unknown }).bigint === true;
    if (!isBigInt && String(path) === parent) {
      metadata.dev = Number.MAX_SAFE_INTEGER + 2;
      metadata.ino = Number.MAX_SAFE_INTEGER + 2;
    }
    return metadata;
  }) as typeof fs.lstatSync;
  syncBuiltinESMExports();

  try {
    const adapters = await createProductionAdapters(
      fixture.platform,
      new FakeRunner({ status: 0, stdout: "", stderr: "" }),
      completeRegistration,
    );
    const desktop = adapters.find(({ id }) => id === "claude-desktop");
    assert.ok(desktop !== undefined);

    const result = await desktop.configure(completeRegistration, false);

    assert.equal(swapped, true);
    assert.equal(result.status, "failed");
    assert.doesNotMatch(result.detail ?? "", /backup-|ROCKY_HOME|\/home\/ada/i);
    assert.deepEqual(fs.readdirSync(parent), []);
    assert.deepEqual(
      fs.readdirSync(displacedParent).filter((name) => name.includes(".backup-")),
      [],
    );
    assert.equal(readFileSync(join(displacedParent, "claude_desktop_config.json"), "utf8"), '{"theme":"dark"}\n');
  } finally {
    (fs as unknown as { fstatSync: typeof fs.fstatSync }).fstatSync = originalFstat;
    (fs as unknown as { lstatSync: typeof fs.lstatSync }).lstatSync = originalLstat;
    syncBuiltinESMExports();
  }
});

test("native Desktop backup cleanup never removes a rebound attacker file", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rocky-native-backup-cleanup-swap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = nativeDesktopFixture(root);
  const parent = fixture.parent;
  const displacedParent = `${parent}-prepared`;
  const configPath = fixture.configPath;
  const sentinel = "attacker-backup-sentinel\n";
  const originalConfig = '{"theme":"dark"}\n';
  mkdirSync(parent, { recursive: true });
  writeFileSync(configPath, originalConfig, "utf8");
  const originalDirectorySync = directorySyncCapability.sync;
  let injectedDirectory: string | undefined;
  let reboundBackupPath: string | undefined;
  directorySyncCapability.sync = (directory) => {
    const backupName = directory === parent
      ? fs.readdirSync(parent).find((name) => name.startsWith(`${basename(configPath)}.backup-`))
      : undefined;
    if (reboundBackupPath === undefined && backupName !== undefined) {
      injectedDirectory = directory;
      fs.renameSync(parent, displacedParent);
      mkdirSync(parent, { mode: 0o700 });
      reboundBackupPath = join(parent, backupName);
      writeFileSync(reboundBackupPath, sentinel, "utf8");
      throw new Error("injected backup durability failure");
    }
    return originalDirectorySync(directory);
  };

  try {
    const adapters = await createProductionAdapters(
      fixture.platform,
      new FakeRunner({ status: 0, stdout: "", stderr: "" }),
      completeRegistration,
    );
    const desktop = adapters.find(({ id }) => id === "claude-desktop");
    assert.ok(desktop !== undefined);

    const result = await desktop.configure(completeRegistration, false);

    assert.equal(result.status, "failed");
    assert.doesNotMatch(result.detail ?? "", /backup-|attacker-backup|ROCKY_HOME/i);
    assert.equal(injectedDirectory, parent);
    assert.ok(reboundBackupPath !== undefined);
    assert.equal(readFileSync(reboundBackupPath, "utf8"), sentinel);
    assert.equal(fs.lstatSync(reboundBackupPath).isFile(), true);
    assert.equal(fs.lstatSync(reboundBackupPath).isSymbolicLink(), false);
    const originalBackupPath = join(displacedParent, basename(reboundBackupPath));
    assert.equal(readFileSync(originalBackupPath, "utf8"), originalConfig);
    assert.equal(fs.lstatSync(originalBackupPath).isFile(), true);
    assert.equal(fs.lstatSync(originalBackupPath).isSymbolicLink(), false);
  } finally {
    directorySyncCapability.sync = originalDirectorySync;
  }
});

test("native Desktop drops cached backup path when topology changes after backup returns", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rocky-native-backup-report-swap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = nativeDesktopFixture(root);
  const parent = fixture.parent;
  const displacedParent = `${parent}-prepared`;
  const configName = basename(fixture.configPath);
  const configPath = fixture.configPath;
  const originalConfig = '{"theme":"dark","secret":"fake-original-secret"}\n';
  mkdirSync(parent, { recursive: true });
  writeFileSync(configPath, originalConfig, "utf8");
  const originalLstat = fs.lstatSync;
  let backupPath: string | undefined;
  let rootChecksAfterBackupProbe = 0;
  let swapped = false;
  (fs as unknown as { lstatSync: typeof fs.lstatSync }).lstatSync = ((path: fs.PathLike, options?: unknown) => {
    const pathText = String(path);
    if (pathText.includes(`${configName}.backup-`)) backupPath = pathText;
    if (backupPath !== undefined && pathText === root) {
      rootChecksAfterBackupProbe += 1;
      if (!swapped && rootChecksAfterBackupProbe === 2) {
        fs.renameSync(parent, displacedParent);
        mkdirSync(parent, { mode: 0o700 });
        swapped = true;
      }
    }
    return options === undefined
      ? originalLstat(path)
      : originalLstat(path, options as never);
  }) as typeof fs.lstatSync;
  syncBuiltinESMExports();

  try {
    const adapters = await createProductionAdapters(
      fixture.platform,
      new FakeRunner({ status: 0, stdout: "", stderr: "" }),
      completeRegistration,
    );
    const desktop = adapters.find(({ id }) => id === "claude-desktop");
    assert.ok(desktop !== undefined);

    const result = await desktop.configure(completeRegistration, false);

    assert.equal(swapped, true);
    assert.equal(result.status, "failed");
    assert.doesNotMatch(result.detail ?? "", /claude_desktop_config\.json\.backup-|fake-original-secret|ROCKY_HOME/i);
    assert.deepEqual(fs.readdirSync(parent), []);
    assert.equal(readFileSync(join(displacedParent, configName), "utf8"), originalConfig);
    const displacedNames = fs.readdirSync(displacedParent);
    assert.equal(displacedNames.filter((name) => name.includes(`${configName}.backup-`)).length, 1);
    assert.equal(displacedNames.some((name) => name.includes(".transaction-")), false);
  } finally {
    (fs as unknown as { lstatSync: typeof fs.lstatSync }).lstatSync = originalLstat;
    syncBuiltinESMExports();
  }
});

test("native Desktop manifest cleanup revalidates after probing a rebound temporary path", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rocky-native-manifest-cleanup-swap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = nativeDesktopFixture(root);
  const parent = fixture.parent;
  const displacedParent = `${parent}-prepared`;
  const originalLstat = fs.lstatSync;
  const originalRename = fs.renameSync;
  const sentinel = "attacker-manifest-sentinel\n";
  let reboundManifestPath: string | undefined;
  (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = ((oldPath, newPath) => {
    if (String(oldPath).endsWith("manifest.tmp") && String(newPath).endsWith("manifest.json")) {
      throw new Error("injected manifest rename failure");
    }
    return originalRename(oldPath, newPath);
  }) as typeof fs.renameSync;
  (fs as unknown as { lstatSync: typeof fs.lstatSync }).lstatSync = ((path: fs.PathLike, options?: unknown) => {
    if (reboundManifestPath === undefined && String(path).endsWith("manifest.tmp")) {
      const transactionName = basename(dirname(String(path)));
      originalRename(parent, displacedParent);
      mkdirSync(join(parent, transactionName), { recursive: true, mode: 0o700 });
      reboundManifestPath = join(parent, transactionName, "manifest.tmp");
      writeFileSync(reboundManifestPath, sentinel, "utf8");
    }
    return options === undefined
      ? originalLstat(path)
      : originalLstat(path, options as never);
  }) as typeof fs.lstatSync;
  syncBuiltinESMExports();

  try {
    const adapters = await createProductionAdapters(
      fixture.platform,
      new FakeRunner({ status: 0, stdout: "", stderr: "" }),
      completeRegistration,
    );
    const desktop = adapters.find(({ id }) => id === "claude-desktop");
    assert.ok(desktop !== undefined);

    const result = await desktop.configure(completeRegistration, false);

    assert.equal(result.status, "failed");
    assert.doesNotMatch(result.detail ?? "", /attacker-manifest|ROCKY_HOME|\/home\/ada/i);
    assert.ok(reboundManifestPath !== undefined);
    assert.equal(readFileSync(reboundManifestPath, "utf8"), sentinel);
    assert.equal(existsSync(join(displacedParent, basename(fixture.configPath))), false);
  } finally {
    (fs as unknown as { lstatSync: typeof fs.lstatSync }).lstatSync = originalLstat;
    (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = originalRename;
    syncBuiltinESMExports();
  }
});

test("native Desktop parent preparation rejects linked and non-directory topology", async (t) => {
  await t.test("symlink", async (subtest) => {
    if (skipIfSymlinkUnavailable(subtest, "dir")) return;
    const root = mkdtempSync(join(tmpdir(), "rocky-native-topology-linked-"));
    const linkedTarget = mkdtempSync(join(tmpdir(), "rocky-native-target-"));
    subtest.after(() => rmSync(root, { recursive: true, force: true }));
    subtest.after(() => rmSync(linkedTarget, { recursive: true, force: true }));
    const fixture = nativeDesktopFixture(root);
    mkdirSync(dirname(fixture.parent), { recursive: true });
    symlinkSync(linkedTarget, fixture.parent, "dir");

    const adapters = await createProductionAdapters(
      fixture.platform,
      new FakeRunner({ status: 0, stdout: "", stderr: "" }),
      completeRegistration,
    );
    const desktop = adapters.find(({ id }) => id === "claude-desktop");
    assert.ok(desktop !== undefined);

    const configured = await desktop.configure(completeRegistration, false);

    assert.equal(configured.status, "failed");
    assert.match(configured.detail ?? "", /parent|topology|manual|read/i);
    assert.equal(existsSync(join(linkedTarget, basename(fixture.configPath))), false);
  });

  await t.test("non-directory", async (subtest) => {
    const root = mkdtempSync(join(tmpdir(), "rocky-native-topology-file-"));
    subtest.after(() => rmSync(root, { recursive: true, force: true }));
    const fixture = nativeDesktopFixture(root);
    mkdirSync(dirname(fixture.parent), { recursive: true });
    writeFileSync(fixture.parent, "not-a-directory\n", "utf8");

    const adapters = await createProductionAdapters(
      fixture.platform,
      new FakeRunner({ status: 0, stdout: "", stderr: "" }),
      completeRegistration,
    );
    const desktop = adapters.find(({ id }) => id === "claude-desktop");
    assert.ok(desktop !== undefined);

    const configured = await desktop.configure(completeRegistration, false);

    assert.equal(configured.status, "failed");
    assert.match(configured.detail ?? "", /parent|topology|manual|read/i);
    assert.equal(readFileSync(fixture.parent, "utf8"), "not-a-directory\n");
  });
});
