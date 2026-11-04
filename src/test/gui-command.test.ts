import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { guiWanted, openBrowser, openerFor } from "../commands/gui.js";
import { phrase, phraseKeys } from "../ui/phrases.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const entry = join(packageRoot, "dist", "index.js");
// Blocks every detached spawn (the way a browser opener starts) and every
// fetch inside the child, and leaves a marker behind when one is attempted.
const throwFetch = join(packageRoot, "test", "fixtures", "throw-fetch.cjs");

// Anti-hang guards only. They bound how long a test waits for an event or a
// child; no assertion depends on how generous they are. A missing-opener spawn
// error arrives on the next event-loop turns, so a few seconds is plenty. A
// cold Node start on a loaded windows-latest runner can take several seconds,
// so the child guard matches the other CLI-process suites at 30 s.
const OPENER_ERROR_GUARD_MS = 5_000;
const PROCESS_GUARD_MS = 30_000;

function antiHang<T>(pending: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: no answer within ${ms} ms`)), ms);
  });
  return Promise.race([pending, guard]).finally(() => clearTimeout(timer));
}

test("openBrowser reports a missing opener once and does not crash the process", async () => {
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown): void => { uncaught.push(error); };
  process.on("uncaughtException", onUncaught);

  let failures = 0;
  try {
    const reported = new Promise<void>((resolve) => {
      openBrowser(
        "http://127.0.0.1:1/#t",
        () => { failures += 1; resolve(); },
        { command: `rocky-no-such-opener-${process.pid}`, args: [] },
      );
    });
    await antiHang(reported, OPENER_ERROR_GUARD_MS, "openBrowser failure report");
    // One more turn of the event loop: a second report would land here.
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    process.off("uncaughtException", onUncaught);
  }

  assert.equal(failures, 1);
  assert.deepEqual(uncaught, [], "a missing opener must not become an uncaught exception");
});

test("openerFor picks each platform's own opener and hands it the url", () => {
  const url = "http://127.0.0.1:7777/#t";
  assert.deepEqual(openerFor("win32", url), { command: "cmd", args: ["/c", "start", "", url] });
  assert.deepEqual(openerFor("darwin", url), { command: "open", args: [url] });
  assert.deepEqual(openerFor("linux", url), { command: "xdg-open", args: [url] });
});

test("guiWanted wants the GUI for a real terminal or an explicit --no-open", () => {
  const rows: ReadonlyArray<readonly [readonly string[], boolean, boolean, boolean]> = [
    [[], true, true, true],
    [[], false, true, false],
    [[], true, false, false],
    [["--no-open"], false, false, true],
    [["--port=0"], false, false, false],
    [["--port=0", "--no-open"], false, false, true],
  ];
  for (const [flags, stdoutTty, stdinTty, expected] of rows) {
    assert.equal(
      guiWanted(flags, stdoutTty, stdinTty),
      expected,
      `flags=[${flags.join(" ")}] stdoutTty=${stdoutTty} stdinTty=${stdinTty}`,
    );
  }
});

test("opener failure speaks through the persona catalogue", () => {
  assert.ok(phraseKeys.includes("gui-opener-failed"));
  assert.equal(phrase("gui-opener-failed"), "browser opener does not start here. open link above by hand.");
});

interface Sandbox {
  env: NodeJS.ProcessEnv;
  backgroundMarker: string;
}

function createSandbox(t: TestContext): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "rocky-gui-command-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const rockyHome = join(root, "rocky-home");
  mkdirSync(home);
  mkdirSync(rockyHome);

  const backgroundMarker = join(root, "background-attempt.marker");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "appdata"),
    LOCALAPPDATA: join(home, "localappdata"),
    XDG_CONFIG_HOME: join(home, "xdg-config"),
    ROCKY_HOME: rockyHome,
    ROCKY_TEST_FETCH_MARKER: join(root, "fetch-used.marker"),
    ROCKY_TEST_BACKGROUND_MARKER: backgroundMarker,
  };
  // A node:test child must not inherit the runner's reporting channel.
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  return { env, backgroundMarker };
}

function assertNoOpenerAttempt(sandbox: Sandbox): void {
  assert.equal(existsSync(sandbox.backgroundMarker), false, "a browser opener was attempted");
}

const cliArgs = (args: readonly string[]): string[] => ["--require", throwFetch, entry, ...args];

function runCli(sandbox: Sandbox, args: readonly string[]): SpawnSyncReturns<string> {
  // spawnSync pipes all three streams, so stdin and stdout are not a terminal.
  return spawnSync(process.execPath, cliArgs(args), {
    cwd: packageRoot,
    env: sandbox.env,
    encoding: "utf8",
    timeout: PROCESS_GUARD_MS,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
}

function startCli(sandbox: Sandbox, args: readonly string[]): ChildProcessWithoutNullStreams {
  // No stdio option: all three streams are pipes, so nothing here is a terminal.
  const child = spawn(process.execPath, cliArgs(args), {
    cwd: packageRoot,
    env: sandbox.env,
    windowsHide: true,
  });
  child.stdout.resume();
  return child;
}

function waitForStderr(child: ChildProcessWithoutNullStreams, pattern: RegExp): Promise<string> {
  const heard = new Promise<string>((resolve, reject) => {
    let seen = "";
    const onData = (chunk: Buffer): void => {
      seen += chunk.toString("utf8");
      if (!pattern.test(seen)) return;
      cleanup();
      resolve(seen);
    };
    const onExit = (): void => {
      cleanup();
      reject(new Error(`child exited before stderr matched ${pattern}: ${JSON.stringify(seen)}`));
    };
    function cleanup(): void {
      child.stderr.off("data", onData);
      child.off("exit", onExit);
    }
    child.stderr.on("data", onData);
    child.once("exit", onExit);
  });
  return antiHang(heard, PROCESS_GUARD_MS, `stderr to match ${pattern}`);
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  // Dead before the sandbox is removed: a live child still holds files open.
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await antiHang(exited, PROCESS_GUARD_MS, "child exit after SIGKILL");
}

for (const args of [[], ["--port=0"]] as const) {
  test(`${["rocky", ...args].join(" ")} in a pipe prints usage help, exits 0, opens no browser`, (t) => {
    const sandbox = createSandbox(t);
    const result = runCli(sandbox, args);

    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /usage/);
    assertNoOpenerAttempt(sandbox);
  });
}

for (const args of [
  ["dash", "--no-open", "--port=0"],
  ["--no-open", "--port=0"],
  ["--port=0", "--no-open"],
] as const) {
  test(`rocky ${args.join(" ")} serves the page and prints the URL without a terminal`, async (t) => {
    const sandbox = createSandbox(t);
    const child = startCli(sandbox, args);
    try {
      await waitForStderr(child, /heard at http:\/\/127\.0\.0\.1:/);
    } finally {
      await stopChild(child);
    }
    assertNoOpenerAttempt(sandbox);
  });
}
