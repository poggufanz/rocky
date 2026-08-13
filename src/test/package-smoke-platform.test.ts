import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const supportUrl = pathToFileURL(join(packageRoot, "scripts", "package-smoke-support.mjs")).href;

interface CommandInvocation {
  file: string;
  args: string[];
}

interface FakeClientLauncher {
  kind: "codex" | "claude";
  path: string;
  type: "copy-node" | "posix-wrapper";
}

interface SmokeSupport {
  commandInvocation(
    file: string,
    args: readonly string[],
    platform: NodeJS.Platform,
    comSpec?: string,
  ): CommandInvocation;
  fakeClientLaunchers(
    platform: NodeJS.Platform,
    directory: string,
  ): FakeClientLauncher[];
  nodeOptionsRequire(path: string, platform: NodeJS.Platform): string;
  shouldRunInstalledSetup(platform: NodeJS.Platform): boolean;
}

async function loadSupport(): Promise<SmokeSupport> {
  return await import(supportUrl) as SmokeSupport;
}

test("Windows command scripts run through ComSpec with every token quoted", async () => {
  const { commandInvocation } = await loadSupport();
  const invocation = commandInvocation(
    "C:\\Program Files\\Rocky's CLI\\rocky.cmd",
    ["--flag", "value with spaces"],
    "win32",
    "C:\\Windows\\System32\\cmd.exe",
  );

  assert.deepEqual(invocation, {
    file: "C:\\Windows\\System32\\cmd.exe",
    args: [
      "/d",
      "/s",
      "/c",
      '""C:\\Program Files\\Rocky\'s CLI\\rocky.cmd" "--flag" "value with spaces""',
    ],
  });
});

test("Windows command-script invocation refuses expansion and control characters", async () => {
  const { commandInvocation } = await loadSupport();
  for (const unsafe of ['"', "\r", "\n", "\0", "%", "!"]) {
    assert.throws(
      () => commandInvocation(
        "C:\\Rocky\\rocky.cmd",
        [`unsafe${unsafe}value`],
        "win32",
        "C:\\Windows\\System32\\cmd.exe",
      ),
      /unsafe/i,
    );
  }
});

test("ordinary executables bypass command processors", async () => {
  const { commandInvocation } = await loadSupport();
  assert.deepEqual(
    commandInvocation("/usr/bin/node", ["entry.js", "--help"], "linux"),
    { file: "/usr/bin/node", args: ["entry.js", "--help"] },
  );
  assert.deepEqual(
    commandInvocation("C:\\Program Files\\nodejs\\node.exe", ["entry.js"], "win32"),
    { file: "C:\\Program Files\\nodejs\\node.exe", args: ["entry.js"] },
  );
});

test("Windows fake clients are executable copies rather than command scripts", async () => {
  const { fakeClientLaunchers } = await loadSupport();
  assert.deepEqual(fakeClientLaunchers("win32", "C:\\Temp\\rocky clients"), [
    { kind: "codex", path: "C:\\Temp\\rocky clients\\codex.exe", type: "copy-node" },
    { kind: "claude", path: "C:\\Temp\\rocky clients\\claude.exe", type: "copy-node" },
  ]);
});

test("package-smoke preload blocks only mounted-profile discovery through ESM", async (t) => {
  const { nodeOptionsRequire } = await loadSupport();
  const root = mkdtempSync(join(tmpdir(), "rocky preload with spaces "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const preload = join(root, "package-smoke-preload.cjs");
  copyFileSync(join(packageRoot, "scripts", "package-smoke-preload.cjs"), preload);
  const normalized = process.platform === "win32" ? preload.replaceAll("\\", "/") : preload;
  assert.equal(nodeOptionsRequire(preload, process.platform), `--require ${JSON.stringify(normalized)}`);

  const require = createRequire(import.meta.url);
  const mutableFs = require("node:fs") as typeof import("node:fs");
  const originalReaddirSync = mutableFs.readdirSync;
  const originalSentinel = process.env.ROCKY_PACKAGE_SMOKE_HERMETIC;
  t.after(() => {
    mutableFs.readdirSync = originalReaddirSync;
    syncBuiltinESMExports();
    if (originalSentinel === undefined) delete process.env.ROCKY_PACKAGE_SMOKE_HERMETIC;
    else process.env.ROCKY_PACKAGE_SMOKE_HERMETIC = originalSentinel;
  });
  process.env.ROCKY_PACKAGE_SMOKE_HERMETIC = "1";
  require(preload);

  const esmFs = await import("node:fs");
  assert.deepEqual(esmFs.readdirSync("/mnt/c/Users"), []);
});

test("copied Node fake client is intercepted by exact executable basename", async (t) => {
  const { nodeOptionsRequire } = await loadSupport();
  const root = mkdtempSync(join(tmpdir(), "rocky copied node "));
  t.after(() => rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  }));
  const preload = join(root, "package-smoke-preload.cjs");
  const handler = join(root, "fake-client-handler.cjs");
  const executable = join(root, "codex.exe");
  const observed = join(root, "observed.json");
  copyFileSync(join(packageRoot, "scripts", "package-smoke-preload.cjs"), preload);
  copyFileSync(process.execPath, executable);
  chmodSync(executable, 0o755);
  writeFileSync(
    handler,
    'const { writeFileSync } = require("node:fs"); const [kind, ...args] = process.argv.slice(2); writeFileSync(process.env.ROCKY_PACKAGE_SMOKE_OBSERVED, JSON.stringify({ kind, args })); process.stdout.write("fake-output"); process.exitCode = 7;\n',
    "utf8",
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_OPTIONS: nodeOptionsRequire(preload, process.platform),
    ROCKY_PACKAGE_SMOKE_FAKE_CLIENT: handler,
    ROCKY_PACKAGE_SMOKE_HERMETIC: "1",
    ROCKY_PACKAGE_SMOKE_NODE: process.execPath,
    ROCKY_PACKAGE_SMOKE_OBSERVED: observed,
  };
  delete env.NODE_TEST_CONTEXT;

  const result = spawnSync(executable, ["mcp", "get", "rocky", "--json"], {
    encoding: "utf8",
    env,
  });

  assert.equal(result.status, 7, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(observed, "utf8")), {
    kind: "codex",
    args: ["mcp", "get", "rocky", "--json"],
  });
});

test("installed setup lifecycle is enabled on every supported host", async () => {
  const { shouldRunInstalledSetup } = await loadSupport();
  for (const platform of ["linux", "darwin", "win32"] as const) {
    assert.equal(shouldRunInstalledSetup(platform), true, `${platform} skipped installed setup`);
  }
});
