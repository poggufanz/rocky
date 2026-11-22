import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { hookFail } from "../commands/hook.js";
import { watch } from "../commands/watch.js";
import { MAX_COMMAND_BYTES } from "../core/memory.js";
import { quoteShellPath } from "../core/shell-quote.js";
import { flushHookSpeech } from "../ui/rocky.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(packageRoot, "dist", "index.js");
const PROCESS_TIMEOUT_MS = 30_000;
const TOKEN = "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function makeSandbox(t: TestContext, prefix: string): { root: string; home: string; cwd: string } {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "rocky-home");
  const cwd = join(root, "work");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { root, home, cwd };
}

function baseChildEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ROCKY_HOME: home,
  };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CLAUDECODE;
  delete env.ROCKY_AGENT_SESSION;
  delete env.ROCKY_ATTEMPT_ADVISORY;
  delete env.ROCKY_ATTEMPT_ARM;
  delete env.ROCKY_TEST_SEAMS;
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const restore = (): void => {
    for (const [key, prev] of saved.entries()) {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  };
  try {
    const value = fn();
    if (value instanceof Promise) {
      return value.finally(restore) as T;
    }
    restore();
    return value;
  } catch (error) {
    restore();
    throw error;
  }
}

function cleanInProcessEnv(home: string): Record<string, string | undefined> {
  return {
    ROCKY_HOME: home,
    CLAUDE_CONFIG_DIR: undefined,
    CLAUDECODE: undefined,
    ROCKY_AGENT_SESSION: undefined,
    ROCKY_ATTEMPT_ADVISORY: undefined,
    ROCKY_ATTEMPT_ARM: undefined,
    ROCKY_TEST_SEAMS: undefined,
  };
}

function captureTty<T>(fn: () => T): { result: T; tty: string } {
  const scratch = mkdtempSync(join(tmpdir(), "rocky-lookup-tty-"));
  const speechFile = join(scratch, "speech.txt");
  return withEnv({ ROCKY_HOOK_SPEECH_FILE: speechFile }, () => {
    try {
      const result = fn();
      flushHookSpeech();
      const tty = existsSync(speechFile) ? readFileSync(speechFile, "utf8") : "";
      return { result, tty };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}

async function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; stderr: string }> {
  const original = process.stderr.write;
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: await fn(), stderr };
  } finally {
    process.stderr.write = original;
  }
}

function silentExitNodeCmd(extraArgs: string): string {
  const node = quoteShellPath(process.execPath, process.platform);
  const script = quoteShellPath("process.exit(3)", process.platform);
  return `${node} -e ${script} -- ${extraArgs}`;
}

function tokenBearingSilentCmd(): string {
  return silentExitNodeCmd(`--token ${TOKEN}`);
}

function longSilentCmd(): string {
  const prefix = silentExitNodeCmd("//");
  const targetBytes = 1500;
  const padBytes = Math.max(1, targetBytes - Buffer.byteLength(prefix, "utf8"));
  const cmd = `${prefix}${"a".repeat(padBytes)}`;
  assert.equal(Buffer.byteLength(cmd, "utf8"), targetBytes);
  assert.ok(Buffer.byteLength(cmd, "utf8") > MAX_COMMAND_BYTES);
  return cmd;
}

function runCliProcess(cwd: string, env: NodeJS.ProcessEnv, cmd: string) {
  return spawnSync(process.execPath, [cli, "run", cmd], {
    cwd,
    env,
    encoding: "utf8",
    timeout: PROCESS_TIMEOUT_MS,
    windowsHide: true,
  });
}

test("run recognises a repeated silent failure whose command carries a token", (t) => {
  const { home, cwd } = makeSandbox(t, "rocky-lookup-run-token-");
  const env = baseChildEnv(home);
  const cmd = tokenBearingSilentCmd();

  const first = runCliProcess(cwd, env, cmd);
  assert.equal(first.status, 3, first.stderr);
  assert.match(first.stderr, /New error recorded \(exit code 3\)\./, first.stderr);

  const second = runCliProcess(cwd, env, cmd);
  assert.equal(second.status, 3, second.stderr);
  assert.match(second.stderr, /Same error as before/, second.stderr);
  assert.doesNotMatch(second.stderr, /New error recorded/, second.stderr);
});

test("run recognises a repeated silent failure longer than the bounded command length", (t) => {
  const { home, cwd } = makeSandbox(t, "rocky-lookup-run-long-");
  const env = baseChildEnv(home);
  const cmd = longSilentCmd();

  const first = runCliProcess(cwd, env, cmd);
  assert.equal(first.status, 3, first.stderr);
  assert.match(first.stderr, /New error recorded \(exit code 3\)\./, first.stderr);

  const second = runCliProcess(cwd, env, cmd);
  assert.equal(second.status, 3, second.stderr);
  assert.match(second.stderr, /Same error as before/, second.stderr);
  assert.doesNotMatch(second.stderr, /New error recorded/, second.stderr);
});

test("hookFail recognises the same token-bearing command twice", (t) => {
  const { home, cwd } = makeSandbox(t, "rocky-lookup-hook-token-");
  const cmd = tokenBearingSilentCmd();

  withEnv(cleanInProcessEnv(home), () => {
    const first = captureTty(() => hookFail(cmd, 3, cwd));
    assert.equal(first.result, 0);
    assert.equal(first.tty, "", `expected silence on first hook failure, got: ${first.tty}`);

    const second = captureTty(() => hookFail(cmd, 3, cwd));
    assert.equal(second.result, 0);
    assert.match(second.tty, /Same error again\./, second.tty);
  });
});

test("hookFail recognises a command longer than the bounded command length twice", (t) => {
  const { home, cwd } = makeSandbox(t, "rocky-lookup-hook-long-");
  const cmd = longSilentCmd();

  withEnv(cleanInProcessEnv(home), () => {
    const first = captureTty(() => hookFail(cmd, 3, cwd));
    assert.equal(first.result, 0);
    assert.equal(first.tty, "", `expected silence on first hook failure, got: ${first.tty}`);

    const second = captureTty(() => hookFail(cmd, 3, cwd));
    assert.equal(second.result, 0);
    assert.match(second.tty, /Same error again\./, second.tty);
  });
});

test("watch recognises a repeated silent failure whose command carries a token", async (t) => {
  const { home } = makeSandbox(t, "rocky-lookup-watch-token-");
  const cmd = tokenBearingSilentCmd();

  await withEnv(cleanInProcessEnv(home), async () => {
    const first = await captureStderr(() => watch([cmd], { notify: () => {} }));
    assert.equal(first.result, 3, first.stderr);
    assert.match(first.stderr, /New error recorded \(exit code 3\)\./, first.stderr);

    const second = await captureStderr(() => watch([cmd], { notify: () => {} }));
    assert.equal(second.result, 3, second.stderr);
    assert.match(second.stderr, /Same error as before/, second.stderr);
    assert.doesNotMatch(second.stderr, /New error recorded/, second.stderr);
  });
});

test("watch recognises a repeated silent failure longer than the bounded command length", async (t) => {
  const { home } = makeSandbox(t, "rocky-lookup-watch-long-");
  const cmd = longSilentCmd();

  await withEnv(cleanInProcessEnv(home), async () => {
    const first = await captureStderr(() => watch([cmd], { notify: () => {} }));
    assert.equal(first.result, 3, first.stderr);
    assert.match(first.stderr, /New error recorded \(exit code 3\)\./, first.stderr);

    const second = await captureStderr(() => watch([cmd], { notify: () => {} }));
    assert.equal(second.result, 3, second.stderr);
    assert.match(second.stderr, /Same error as before/, second.stderr);
    assert.doesNotMatch(second.stderr, /New error recorded/, second.stderr);
  });
});
