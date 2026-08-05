import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { quoteShellPath } from "../core/shell-quote.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const entry = join(packageRoot, "dist", "index.js");
const throwFetch = join(packageRoot, "test", "fixtures", "throw-fetch.cjs");
const PROCESS_TIMEOUT_MS = 5_000;

interface ProcessSandbox {
  root: string;
  rockyHome: string;
  env: NodeJS.ProcessEnv;
}

function processSandbox(t: TestContext): ProcessSandbox {
  const root = mkdtempSync(join(tmpdir(), "rocky-cli-process-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const directories = {
    home: join(root, "home"),
    appData: join(root, "appdata"),
    localAppData: join(root, "localappdata"),
    xdgConfig: join(root, "xdg-config"),
    claudeConfig: join(root, "claude-config"),
    codexHome: join(root, "codex-home"),
    rockyHome: join(root, "rocky-home"),
  };
  for (const directory of Object.values(directories)) mkdirSync(directory, { recursive: true });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: directories.home,
    USERPROFILE: directories.home,
    APPDATA: directories.appData,
    LOCALAPPDATA: directories.localAppData,
    XDG_CONFIG_HOME: directories.xdgConfig,
    CLAUDE_CONFIG_DIR: directories.claudeConfig,
    CODEX_HOME: directories.codexHome,
    ROCKY_HOME: directories.rockyHome,
  };
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  return { root, rockyHome: directories.rockyHome, env };
}

function runCli(
  sandbox: ProcessSandbox,
  args: readonly string[],
  input?: string,
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ["--require", throwFetch, entry, ...args], {
    cwd: packageRoot,
    env: sandbox.env,
    encoding: "utf8",
    input,
    timeout: PROCESS_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
}

function runNodeScript(
  sandbox: ProcessSandbox,
  script: string,
  args: readonly string[],
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: packageRoot,
    env: sandbox.env,
    encoding: "utf8",
    timeout: PROCESS_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
}

function assertCompleted(result: SpawnSyncReturns<string>, expectedStatus: number): void {
  assert.ok(result.pid > 0);
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, expectedStatus, result.stderr);
}

test("help, recall, stats, and hook status finish successfully without external fetch", (t) => {
  const commands = [
    ["--help"],
    ["recall", "missing-error"],
    ["stats"],
    ["hook", "status"],
  ] as const;

  for (const args of commands) {
    const result = runCli(processSandbox(t), args);
    assertCompleted(result, 0);
    assert.doesNotMatch(result.stderr, /unexpected fetch from isolated Rocky CLI process/);
  }
});

test("unknown commands and invalid command grammar exit 2", (t) => {
  for (const args of [
    ["unknown-command"],
    ["run"],
    ["recall"],
    ["recall", "--invalid-option"],
    ["hook"],
    ["hook", "invalid-subcommand"],
  ] as const) {
    const result = runCli(processSandbox(t), args);
    assertCompleted(result, 2);
  }
});

test("run preserves path-with-spaces child streams and exit status", (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "rocky child fixture "));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const child = join(fixtureRoot, "child with spaces.mjs");
  writeFileSync(
    child,
    [
      'process.stdout.write("CHILD_STDOUT_SENTINEL\\n");',
      'process.stderr.write("CHILD_STDERR_SENTINEL\\n");',
      "process.exitCode = 7;",
      "",
    ].join("\n"),
    "utf8",
  );
  const command = `${quoteShellPath(process.execPath, process.platform)} ${quoteShellPath(child, process.platform)}`;

  const result = runCli(processSandbox(t), ["run", command]);

  assertCompleted(result, 7);
  assert.equal(result.stdout, "CHILD_STDOUT_SENTINEL\n");
  assert.doesNotMatch(result.stdout, /new error|good trade|I remember|\/\\_/);
  assert.match(result.stderr, /CHILD_STDERR_SENTINEL/);
});

test("modern MCP emits JSON lines only and exits after EOF", (t) => {
  const request = {
    jsonrpc: "2.0",
    id: "cli-process-discover",
    method: "server/discover",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": { name: "cli-process-test", version: "1" },
      },
    },
  };

  const result = runCli(processSandbox(t), ["mcp"], `${JSON.stringify(request)}\n`);

  assertCompleted(result, 0);
  assert.equal(result.stderr, "");
  const lines = result.stdout.split("\n").filter((line) => line.length > 0);
  assert.equal(lines.length, 1);
  const response = JSON.parse(lines[0]!) as { jsonrpc?: unknown; id?: unknown; result?: unknown };
  assert.equal(response.jsonrpc, "2.0");
  assert.equal(response.id, "cli-process-discover");
  assert.equal(typeof response.result, "object");
});

test("seeded recall --ai falls back before any no-Ollama fetch", (t) => {
  const sandbox = processSandbox(t);
  const failure = {
    kind: "failure",
    id: "seeded-failure",
    ts: 1_700_000_000_000,
    cwd: sandbox.root,
    cmd: "node seeded-command.mjs",
    exitCode: 1,
    fingerprint: "0123456789abcdef",
    signature: ["seeded recall failure"],
    excerpt: "seeded recall failure",
    origin: "run",
  };
  writeFileSync(join(sandbox.rockyHome, "memory.jsonl"), `${JSON.stringify(failure)}\n`, "utf8");

  const result = runCli(sandbox, ["recall", "--ai", "seeded"]);

  assertCompleted(result, 0);
  assert.match(result.stderr, /small model sleeps\. memory still works\./);
  assert.doesNotMatch(result.stderr, /unexpected fetch from isolated Rocky CLI process/);
});

test("release checker refuses publishing arguments before doing release work", (t) => {
  const sandbox = processSandbox(t);
  const report = join(sandbox.root, "release-report.md");
  const result = runNodeScript(
    sandbox,
    join(packageRoot, "scripts", "release-check.mjs"),
    ["--publish", "--report", report],
  );

  assertCompleted(result, 2);
  assert.match(result.stderr, /publish.*refus|refus.*publish/i);
  assert.equal(existsSync(report), false);
});

test("release checker source has no registry-mutation subprocess argument", () => {
  const source = readFileSync(join(packageRoot, "scripts", "release-check.mjs"), "utf8");
  assert.doesNotMatch(source, /npm\s+(?:publish|deprecate|dist-tag)\b/i);
  assert.doesNotMatch(source, /\[\s*["'](?:publish|deprecate|dist-tag)["']/i);
});

test("benchmark rejects relative and package-internal output paths before spawning MCP", (t) => {
  const invalidOutputs = [
    "relative-performance.json",
    join(packageRoot, "performance.json"),
  ];
  for (const output of invalidOutputs) {
    const result = runNodeScript(
      processSandbox(t),
      join(packageRoot, "scripts", "benchmark-mcp.mjs"),
      ["--output", output],
    );
    assertCompleted(result, 2);
    assert.match(result.stderr, /output.*absolute|outside.*package/i);
  }
});
