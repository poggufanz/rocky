import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ProcessResult, ProcessRunOptions, ProcessRunner } from "../setup/process.js";
import {
  WslManualConfigurationError,
  buildWslDesktopRegistration,
  convertMountedWindowsPath,
} from "../setup/claude-desktop.js";
import { createPlatformServices } from "../setup/platform.js";
import { createProductionAdapters } from "../commands/setup.js";
import type { McpRegistration } from "../setup/clients.js";

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
  const root = mkdtempSync(join(tmpdir(), "rocky-wsl-production-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configPath = join(root, "mnt/c/Users/Ada/AppData/Roaming/Claude/claude_desktop_config.json");
  const mountedWsl = join(root, "mnt/c/Windows/System32/wsl.exe");
  const wslpath = join(root, "usr/bin/wslpath");
  const envPath = "/usr/bin/env";
  const nodePath = join(root, "usr/bin/node");
  const entryPath = join(root, "opt/rocky/dist/index.js");
  const rockyHome = join(root, "home/ada/.rocky");
  for (const path of [configPath, mountedWsl, wslpath, nodePath, entryPath]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, path === configPath ? "{}\n" : "fixture", "utf8");
  }
  const existing = new Set([configPath, mountedWsl, wslpath, envPath, nodePath, entryPath]);
  const platform = createPlatformServices({
    platform: "linux",
    home: join(root, "home/ada"),
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
  const macRoot = mkdtempSync(join(tmpdir(), "rocky-native-absent-"));
  const windowsRoot = mkdtempSync(join(tmpdir(), "rocky-native-absent-"));
  t.after(() => rmSync(macRoot, { recursive: true, force: true }));
  t.after(() => rmSync(windowsRoot, { recursive: true, force: true }));
  const cases = [
    {
      name: "macOS",
      configParent: join(macRoot, "Library"),
      platform: createPlatformServices({
        platform: "darwin",
        home: macRoot,
        env: { PATH: "" },
        isWsl: false,
        fileExists: () => false,
      }),
    },
    {
      name: "Windows",
      configParent: join(windowsRoot, "Claude"),
      platform: createPlatformServices({
        platform: "win32",
        home: "C:\\Users\\Ada",
        appData: windowsRoot,
        env: { PATH: "", LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" },
        isWsl: false,
        fileExists: () => false,
      }),
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const adapters = await createProductionAdapters(entry.platform, new FakeRunner({
        status: 0,
        stdout: "",
        stderr: "",
      }), completeRegistration);
      const desktop = adapters.find(({ id }) => id === "claude-desktop");
      assert.ok(desktop !== undefined);

      const inspected = await desktop.inspect(completeRegistration);
      const configured = await desktop.configure(completeRegistration, false);

      assert.equal(inspected.state, "blocked");
      assert.match(inspected.detail ?? "", /not installed/i);
      assert.equal(configured.status, "skipped");
      assert.equal(existsSync(entry.configParent), false);
    });
  }
});

test("installed native Desktop is configurable before its first config file exists", async (t) => {
  const macRoot = mkdtempSync(join(tmpdir(), "rocky-native-desktop-"));
  const windowsRoot = mkdtempSync(join(tmpdir(), "rocky-native-desktop-"));
  t.after(() => rmSync(macRoot, { recursive: true, force: true }));
  t.after(() => rmSync(windowsRoot, { recursive: true, force: true }));
  const macApp = "/Applications/Claude.app";
  const windowsApp = "C:\\Users\\Ada\\AppData\\Local\\AnthropicClaude\\Claude.exe";
  const cases = [
    {
      name: "macOS",
      configPath: join(macRoot, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
      platform: createPlatformServices({
        platform: "darwin",
        home: macRoot,
        env: { PATH: "" },
        isWsl: false,
        fileExists: (path) => path === macApp,
      }),
    },
    {
      name: "Windows",
      configPath: join(windowsRoot, "Claude", "claude_desktop_config.json"),
      platform: createPlatformServices({
        platform: "win32",
        home: "C:\\Users\\Ada",
        appData: windowsRoot,
        env: { PATH: "", LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" },
        isWsl: false,
        fileExists: (path) => path === windowsApp,
      }),
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const adapters = await createProductionAdapters(entry.platform, new FakeRunner({
        status: 0,
        stdout: "",
        stderr: "",
      }), completeRegistration);
      const desktop = adapters.find(({ id }) => id === "claude-desktop");
      assert.ok(desktop !== undefined);

      assert.equal((await desktop.inspect(completeRegistration)).state, "absent");
      assert.equal((await desktop.configure(completeRegistration, false)).status, "configured");
      assert.deepEqual(JSON.parse(readFileSync(entry.configPath, "utf8")), {
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
  }
});

test("native Desktop parent preparation rejects linked and non-directory topology", async (t) => {
  const macRoot = mkdtempSync(join(tmpdir(), "rocky-native-topology-"));
  const linkedTarget = mkdtempSync(join(tmpdir(), "rocky-native-target-"));
  const windowsRoot = mkdtempSync(join(tmpdir(), "rocky-native-topology-"));
  t.after(() => rmSync(macRoot, { recursive: true, force: true }));
  t.after(() => rmSync(linkedTarget, { recursive: true, force: true }));
  t.after(() => rmSync(windowsRoot, { recursive: true, force: true }));

  mkdirSync(join(linkedTarget, "Application Support", "Claude"), { recursive: true });
  symlinkSync(linkedTarget, join(macRoot, "Library"));
  writeFileSync(join(windowsRoot, "Claude"), "not-a-directory\n", "utf8");
  const linkedConfig = join(linkedTarget, "Application Support", "Claude", "claude_desktop_config.json");
  const cases = [
    {
      name: "macOS symlink",
      platform: createPlatformServices({
        platform: "darwin",
        home: macRoot,
        env: { PATH: "" },
        isWsl: false,
        claudeDesktopInstalled: true,
      }),
    },
    {
      name: "Windows non-directory",
      platform: createPlatformServices({
        platform: "win32",
        home: "C:\\Users\\Ada",
        appData: windowsRoot,
        env: { PATH: "" },
        isWsl: false,
        claudeDesktopInstalled: true,
      }),
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const adapters = await createProductionAdapters(
        entry.platform,
        new FakeRunner({ status: 0, stdout: "", stderr: "" }),
        completeRegistration,
      );
      const desktop = adapters.find(({ id }) => id === "claude-desktop");
      assert.ok(desktop !== undefined);

      const configured = await desktop.configure(completeRegistration, false);

      assert.equal(configured.status, "failed");
      assert.match(configured.detail ?? "", /parent|topology|manual|read/i);
      assert.equal(existsSync(linkedConfig), false);
      assert.equal(readFileSync(join(windowsRoot, "Claude"), "utf8"), "not-a-directory\n");
    });
  }
});
