import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { fingerprint } from "../core/fingerprint.js";
import { quoteShellPath } from "../core/shell-quote.js";
import { PACKAGE_VERSION } from "../core/package-info.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const entry = join(packageRoot, "dist", "index.js");
const throwFetch = join(packageRoot, "test", "fixtures", "throw-fetch.cjs");
const PROCESS_TIMEOUT_MS = 5_000;

interface ProcessSandbox {
  root: string;
  rockyHome: string;
  fetchMarker: string;
  backgroundMarker: string;
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
    ROCKY_TEST_FETCH_MARKER: join(root, "fetch-used.marker"),
    ROCKY_TEST_BACKGROUND_MARKER: join(root, "background-attempt.marker"),
  };
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  return {
    root,
    rockyHome: directories.rockyHome,
    fetchMarker: env.ROCKY_TEST_FETCH_MARKER!,
    backgroundMarker: env.ROCKY_TEST_BACKGROUND_MARKER!,
    env,
  };
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
  envOverrides: NodeJS.ProcessEnv = {},
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: packageRoot,
    env: { ...sandbox.env, ...envOverrides },
    encoding: "utf8",
    timeout: PROCESS_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
}

function runPreloadProbe(sandbox: ProcessSandbox, source: string): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ["--require", throwFetch, "--eval", source], {
    cwd: packageRoot,
    env: sandbox.env,
    encoding: "utf8",
    timeout: PROCESS_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
}

/** The network-egress half of the guarantee: no external fetch was attempted. */
function assertNoFetchAttempt(sandbox: ProcessSandbox): void {
  assert.equal(existsSync(sandbox.fetchMarker), false, "isolated CLI attempted fetch");
}

/** The background-daemon half: no detached spawn / unref was attempted. */
function assertNoBackgroundSpawnAttempt(sandbox: ProcessSandbox): void {
  assert.equal(existsSync(sandbox.backgroundMarker), false, "isolated CLI attempted background child");
}

function assertNoDetectorMarkers(sandbox: ProcessSandbox): void {
  assertNoFetchAttempt(sandbox);
  assertNoBackgroundSpawnAttempt(sandbox);
}

function assertCompleted(result: SpawnSyncReturns<string>, expectedStatus: number): void {
  assert.ok(result.pid > 0);
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, expectedStatus, result.stderr);
  if (process.platform !== "win32") {
    assert.throws(
      () => process.kill(result.pid, 0),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH",
      `direct child pid ${result.pid} is still live`,
    );
  }
}

test("fetch detector records use even when the throwing fetch is caught", (t) => {
  const sandbox = processSandbox(t);
  const result = runPreloadProbe(sandbox, "try { fetch('http://127.0.0.1/'); } catch {}\n");

  assertCompleted(result, 0);
  assert.equal(readFileSync(sandbox.fetchMarker, "utf8"), "fetch\n");
  assert.equal(existsSync(sandbox.backgroundMarker), false);
});

test("background detector blocks detached and unref attempts before they can linger", (t) => {
  const sandbox = processSandbox(t);
  const source = [
    "const { spawn } = require('node:child_process');",
    "try { spawn(process.execPath, ['--eval', ''], { detached: true, stdio: 'ignore' }); } catch {}",
    "const child = spawn(process.execPath, ['--eval', ''], { stdio: 'ignore' });",
    "try { child.unref(); } catch {}",
  ].join("\n");
  const result = runPreloadProbe(sandbox, source);

  assertCompleted(result, 0);
  assert.equal(existsSync(sandbox.fetchMarker), false);
  assert.deepEqual(readFileSync(sandbox.backgroundMarker, "utf8").trim().split("\n"), ["detached", "unref"]);
});

test("help, recall, stats, and hook status finish successfully without external fetch", (t) => {
  const commands = [
    ["--help"],
    ["recall", "missing-error"],
    ["stats"],
    ["hook", "status"],
  ] as const;

  for (const args of commands) {
    const sandbox = processSandbox(t);
    const result = runCli(sandbox, args);
    assertCompleted(result, 0);
    assertNoDetectorMarkers(sandbox);
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
    ["-v"],
    ["--Version"],
    ["--version-typo"],
  ] as const) {
    const sandbox = processSandbox(t);
    const result = runCli(sandbox, args);
    assertCompleted(result, 2);
    assertNoDetectorMarkers(sandbox);
  }
});

test("--version prints the package version to stdout, matching PACKAGE_VERSION, and exits 0", (t) => {
  const sandbox = processSandbox(t);
  const result = runCli(sandbox, ["--version"]);
  assertCompleted(result, 0);
  assert.equal(result.stdout, `${PACKAGE_VERSION}\n`);
  assert.equal(result.stderr, "");
  assertNoDetectorMarkers(sandbox);
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

  const sandbox = processSandbox(t);
  const result = runCli(sandbox, ["run", command]);

  assertCompleted(result, 7);
  assert.equal(result.stdout, "CHILD_STDOUT_SENTINEL\n");
  assert.doesNotMatch(result.stdout, /new error|good trade|I remember|\/\\_/);
  assert.match(result.stderr, /CHILD_STDERR_SENTINEL/);
  assertNoDetectorMarkers(sandbox);
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

  const sandbox = processSandbox(t);
  const result = runCli(sandbox, ["mcp"], `${JSON.stringify(request)}\n`);

  assertCompleted(result, 0);
  assert.equal(result.stderr, "");
  const lines = result.stdout.split("\n").filter((line) => line.length > 0);
  assert.equal(lines.length, 1);
  const response = JSON.parse(lines[0]!) as { jsonrpc?: unknown; id?: unknown; result?: unknown };
  assert.equal(response.jsonrpc, "2.0");
  assert.equal(response.id, "cli-process-discover");
  assert.equal(typeof response.result, "object");
  assertNoDetectorMarkers(sandbox);
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
  assertNoDetectorMarkers(sandbox);
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

test("release checker partial report preserves a spawn failure without inventing exit 1", (t) => {
  const sandbox = processSandbox(t);
  const report = join(sandbox.root, "partial-release-report.md");
  const result = runNodeScript(
    sandbox,
    join(packageRoot, "scripts", "release-check.mjs"),
    ["--report", report],
    { ROCKY_RELEASE_CHECK_TEST_SPAWN_ERROR: "1" },
  );

  assertCompleted(result, 1);
  const markdown = readFileSync(report, "utf8");
  assert.match(markdown, /Result: \*\*FAIL\*\*/);
  assert.match(markdown, /npm version.*not exited.*spawn error: ENOENT/);
  assert.doesNotMatch(markdown, /npm version.*\| 1 \|/);
});

test("unsupported benchmark contract uses exact discriminator and separate pending prose", (t) => {
  const sandbox = processSandbox(t);
  const output = join(sandbox.root, "unsupported-performance.json");
  const result = runNodeScript(
    sandbox,
    join(packageRoot, "scripts", "benchmark-mcp.mjs"),
    ["--output", output],
    { ROCKY_BENCHMARK_TEST_UNSUPPORTED_REPORT: "1" },
  );

  assertCompleted(result, 0);
  const report = JSON.parse(readFileSync(output, "utf8")) as {
    steadyStateRssBytes: { median: unknown; p95: unknown; values: unknown[]; method: unknown; pending?: unknown };
  };
  assert.deepEqual(report.steadyStateRssBytes, {
    median: null,
    p95: null,
    values: [],
    method: "unsupported",
    pending: "requires Node 22 on Linux",
  });
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

test("run reports the shell convention exit code when the command dies from a signal", (t) => {
  if (process.platform === "win32") return;
  const sandbox = processSandbox(t);

  const terminated = runCli(sandbox, ["run", "kill -TERM $$"]);
  assert.equal(terminated.status, 143);

  const killed = runCli(sandbox, ["run", "kill -KILL $$"]);
  assert.equal(killed.status, 137);
});

test("rocky run passes cancel exit codes through without recording or speaking", (t) => {
  for (const code of [130, 143]) {
    const sandbox = processSandbox(t);
    const command = `${quoteShellPath(process.execPath, process.platform)} -e ${quoteShellPath(`process.exit(${code})`, process.platform)}`;
    const result = runCli(sandbox, ["run", command]);

    assertCompleted(result, code);
    assert.doesNotMatch(result.stderr, /\[Rocky\]/);
    assert.equal(result.stderr, "");
    assert.equal(existsSync(join(sandbox.rockyHome, "memory.jsonl")), false);
    assertNoDetectorMarkers(sandbox);
  }
});

test("a memory write failure never changes the wrapped command's exit code", (t) => {
  const sandbox = processSandbox(t);
  // A directory where the memory file belongs makes every write fail.
  mkdirSync(join(sandbox.rockyHome, "memory.jsonl"), { recursive: true });

  const failed = runCli(sandbox, ["run", "exit 42"]);
  assert.equal(failed.status, 42);

  const succeeded = runCli(sandbox, ["run", "exit 0"]);
  assert.equal(succeeded.status, 0);
});

/**
 * Builds a `rocky run` command line whose stderr is exactly `marker`, so the
 * fingerprint `run`'s onFailure computes from that real stderr can be
 * predicted in the test (via `fingerprint(marker, cmd, exitCode)`) and seeded ahead of
 * time. Quoted through `quoteShellPath` — same helper `deepMemoryHint` uses —
 * so the child's `-e` script survives the shell that `run.ts` spawns it
 * through.
 */
function failingCommandPrinting(marker: string): string {
  const script = `console.error('${marker}');process.exit(1)`;
  return `${quoteShellPath(process.execPath, process.platform)} -e ${quoteShellPath(script, process.platform)}`;
}

test("run's onFailure speaks the strong link basis, not just the fix command", (t) => {
  const sandbox = processSandbox(t);
  const marker = "error rocky basis strong boom";
  const fp = fingerprint(marker, "cargo build --release", 1);
  const failure = {
    kind: "failure", id: "basis-strong-failure", ts: 1_700_000_000_000, cwd: packageRoot,
    cmd: "cargo build --release", exitCode: 1, fingerprint: fp, signature: [marker], excerpt: marker,
    origin: "run",
  };
  const fix = {
    kind: "fix", id: "basis-strong-fix", ts: 1_700_000_120_000, cwd: packageRoot,
    cmd: "cargo build --release", failureIds: ["basis-strong-failure"],
    links: [{ id: "basis-strong-failure", basis: "identity", confidence: "confirmed" }],
  };
  writeFileSync(
    join(sandbox.rockyHome, "memory.jsonl"),
    `${JSON.stringify(failure)}\n${JSON.stringify(fix)}\n`,
    "utf8",
  );

  const result = runCli(sandbox, ["run", failingCommandPrinting(marker)]);

  assertCompleted(result, 1);
  assert.match(result.stderr, /same command, 2 minutes later\. strong\./);
  assert.doesNotMatch(result.stderr, /maybe not fix/);
  assertNoDetectorMarkers(sandbox);
});

test("run's onFailure never presents a weak candidate as a remembered fix", (t) => {
  const sandbox = processSandbox(t);
  const marker = "error rocky basis weak boom";
  const fp = fingerprint(marker, "npm run build", 1);
  const failure = {
    kind: "failure", id: "basis-weak-failure", ts: 1_700_000_000_000, cwd: packageRoot,
    cmd: "npm run build", exitCode: 1, fingerprint: fp, signature: [marker], excerpt: marker,
    origin: "run",
  };
  const fix = {
    kind: "fix", id: "basis-weak-fix", ts: 1_700_000_120_000, cwd: packageRoot,
    cmd: "npm rebuild sharp", failureIds: ["basis-weak-failure"],
    links: [{ id: "basis-weak-failure", basis: "program" }],
  };
  writeFileSync(
    join(sandbox.rockyHome, "memory.jsonl"),
    `${JSON.stringify(failure)}\n${JSON.stringify(fix)}\n`,
    "utf8",
  );

  const result = runCli(sandbox, ["run", failingCommandPrinting(marker)]);

  assertCompleted(result, 1);
  assert.doesNotMatch(result.stderr, /last time, you fix with:|same program|\bstrong\b/);
  assertNoDetectorMarkers(sandbox);
});

test("a v0.2.1-era unproven fix record is downgraded", (t) => {
  const sandbox = processSandbox(t);
  const marker = "error rocky basis absent boom";
  const fp = fingerprint(marker, "npm run build", 1);
  const failure = {
    kind: "failure", id: "basis-none-failure", ts: 1_700_000_000_000, cwd: packageRoot,
    cmd: "npm run build", exitCode: 1, fingerprint: fp, signature: [marker], excerpt: marker,
    origin: "run",
  };
  const fix = {
    kind: "fix", id: "basis-none-fix", ts: 1_700_000_120_000, cwd: packageRoot,
    cmd: "npm rebuild sharp", failureIds: ["basis-none-failure"],
  };
  writeFileSync(
    join(sandbox.rockyHome, "memory.jsonl"),
    `${JSON.stringify(failure)}\n${JSON.stringify(fix)}\n`,
    "utf8",
  );

  const result = runCli(sandbox, ["run", failingCommandPrinting(marker)]);

  assertCompleted(result, 1);
  assert.doesNotMatch(result.stderr, /last time, you fix with:|\bstrong\b|maybe not fix/);
  assertNoDetectorMarkers(sandbox);
});

test("run's onFailure admits when the remembered fix comes from a different directory", (t) => {
  const sandbox = processSandbox(t);
  const marker = "error rocky test boom elsewhere";
  const fp = fingerprint(marker, "whatever failed before", 1);
  const elsewhere = join(sandbox.root, "elsewhere-project");
  const failure = {
    kind: "failure", id: "elsewhere-failure", ts: 1_700_000_000_000, cwd: packageRoot,
    cmd: "whatever failed before", exitCode: 1, fingerprint: fp, signature: [marker], excerpt: marker,
    origin: "run",
  };
  const fix = {
    kind: "fix", id: "elsewhere-fix", ts: 1_700_000_001_000, cwd: elsewhere,
    cmd: "whatever failed before", failureIds: ["elsewhere-failure"],
  };
  writeFileSync(
    join(sandbox.rockyHome, "memory.jsonl"),
    `${JSON.stringify(failure)}\n${JSON.stringify(fix)}\n`,
    "utf8",
  );

  const result = runCli(sandbox, ["run", failingCommandPrinting(marker)]);

  assertCompleted(result, 1);
  assert.match(result.stderr, /but fix comes from other place\./);
  assert.match(result.stderr, new RegExp(`place:\\s*${elsewhere.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assertNoDetectorMarkers(sandbox);
});

test("watch records a failure with origin watch and saves exactly one log file with the stderr tail", (t) => {
  const sandbox = processSandbox(t);
  const result = runCli(sandbox, ["watch", "sh -c 'echo boom >&2; exit 3'"]);

  assertCompleted(result, 3);

  const lines = readFileSync(join(sandbox.rockyHome, "memory.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]!) as { kind: string; origin?: string };
  assert.equal(record.kind, "failure");
  assert.equal(record.origin, "watch");

  const watchDir = join(sandbox.rockyHome, "watch");
  const files = readdirSync(watchDir);
  assert.equal(files.length, 1);
  assert.match(readFileSync(join(watchDir, files[0]!), "utf8"), /boom/);
  // Only the fetch half of assertNoDetectorMarkers applies here: unlike
  // run/recall/stats/hook, watch's whole point is a best-effort detached
  // notify-send/osascript spawn on completion (core/notify.ts) — the
  // isolated preload's detached-spawn guard throws inside it, notify()'s own
  // try/catch swallows that and falls back to a bell, and the exit
  // code/memory/log assertions above already prove the wrapped command's
  // outcome was never touched by it. The network-egress guarantee this test
  // has nothing to do with notify still applies in full.
  assertNoFetchAttempt(sandbox);
});

test("watch passes a Ctrl-C-style exit code straight through, with no memory record and no log", (t) => {
  if (process.platform === "win32") return;
  const sandbox = processSandbox(t);
  const result = runCli(sandbox, ["watch", "sh -c 'exit 130'"]);

  assert.equal(result.status, 130);
  assert.equal(existsSync(join(sandbox.rockyHome, "memory.jsonl")), false);
  assert.equal(existsSync(join(sandbox.rockyHome, "watch")), false);
  assertNoDetectorMarkers(sandbox);
});

test("watch with an empty command exits 2", (t) => {
  const sandbox = processSandbox(t);
  const result = runCli(sandbox, ["watch", ""]);
  assertCompleted(result, 2);
  assertNoDetectorMarkers(sandbox);
});

test("run's onFailure adds no line when the remembered fix's cwd matches the current directory", (t) => {
  const sandbox = processSandbox(t);
  const marker = "error rocky test boom samecwd";
  const fp = fingerprint(marker, "whatever failed before", 1);
  // runCli spawns with cwd: packageRoot, so the fix must be seeded against
  // process.cwd()'s resolved form to match what `run.ts` compares against.
  const here = realpathSync(packageRoot);
  const failure = {
    kind: "failure", id: "samecwd-failure", ts: 1_700_000_000_000, cwd: here,
    cmd: "whatever failed before", exitCode: 1, fingerprint: fp, signature: [marker], excerpt: marker,
    origin: "run",
  };
  const fix = {
    kind: "fix", id: "samecwd-fix", ts: 1_700_000_001_000, cwd: here,
    cmd: "whatever failed before", failureIds: ["samecwd-failure"],
  };
  writeFileSync(
    join(sandbox.rockyHome, "memory.jsonl"),
    `${JSON.stringify(failure)}\n${JSON.stringify(fix)}\n`,
    "utf8",
  );

  const result = runCli(sandbox, ["run", failingCommandPrinting(marker)]);

  assertCompleted(result, 1);
  assert.doesNotMatch(result.stderr, /other place/);
  assert.doesNotMatch(result.stderr, /place:/);
  // sanity: the base fix line still speaks, proving the comparison — not the
  // whole fix branch — is what's being suppressed here.
  assert.match(result.stderr, /last time, you fix with:/);
  assertNoDetectorMarkers(sandbox);
});
