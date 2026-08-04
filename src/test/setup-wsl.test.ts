import test from "node:test";
import assert from "node:assert/strict";
import type { ProcessResult, ProcessRunOptions, ProcessRunner } from "../setup/process.js";
import {
  WslManualConfigurationError,
  buildWslDesktopRegistration,
  convertMountedWindowsPath,
} from "../setup/claude-desktop.js";

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
