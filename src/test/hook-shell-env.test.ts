import test, { after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROCKY_HOOK_PROTOCOL_VERSION } from "../commands/hook.js";
import { verifyShellAssetsStaged } from "./shell-assets-fixture.js";
import {
  bashAvailable,
  disposeSharedFakeHook,
  installFakeHook,
  readShellEnvRecords,
  removeTreeWithRetry,
  toBashPath,
  writeShellEnvScript,
} from "./shell-env-fixture.js";

// The shell hooks start `rocky-hook shell-env` once, at load. These tests drive
// the staged shell assets (.test-dist/shell, see shell-assets-fixture.ts) in an
// interactive bash started with --norc and --noprofile, so the developer's own
// profile never runs. The detached start is observed through the fake hook.

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const stagedShell = join(packageRoot, ".test-dist", "shell");
const BASH_RUN_GUARD_MS = 30_000;
const bashOk = bashAvailable();
const bashSkip = "Bash executable unavailable; owner: Linux/WSL hook smoke CI";

after(disposeSharedFakeHook);

interface ShellHome {
  userHome: string;
  home: string;
  cwd: string;
  hook: string;
  log: string;
}

function makeShellHome(t: TestContext, withHook: boolean): ShellHome {
  verifyShellAssetsStaged();
  const root = mkdtempSync(join(tmpdir(), "rocky-shell-env-"));
  t.after(() => removeTreeWithRetry(root));
  const home = join(root, "rocky-home");
  const shellHome: ShellHome = {
    userHome: join(root, "user-home"),
    home,
    cwd: join(root, "cwd"),
    hook: join(home, "rocky-hook.bash"),
    log: join(home, "shell-env.log"),
  };
  for (const dir of [shellHome.userHome, home, shellHome.cwd]) mkdirSync(dir, { recursive: true });
  copyFileSync(join(stagedShell, "rocky-hook.bash"), shellHome.hook);
  copyFileSync(join(stagedShell, "bash-preexec.sh"), join(home, "bash-preexec.sh"));
  writeShellEnvScript(shellHome.cwd, shellHome.log);
  if (withHook) installFakeHook(home);
  return shellHome;
}

function runInteractiveBash(shellHome: ShellHome, script: string, configDir?: string): SpawnSyncReturns<string> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: toBashPath(shellHome.userHome),
    ROCKY_HOME: toBashPath(shellHome.home),
  };
  delete env.BASH_ENV;
  delete env.PROMPT_COMMAND;
  delete env.CLAUDE_CONFIG_DIR;
  if (configDir !== undefined) env.CLAUDE_CONFIG_DIR = configDir;
  return spawnSync("bash", ["--norc", "--noprofile", "-i"], {
    input: script,
    cwd: shellHome.cwd,
    env,
    encoding: "utf8",
    timeout: BASH_RUN_GUARD_MS,
    windowsHide: true,
  });
}

test("bash hook reports config env once at load", { skip: bashOk ? false : bashSkip }, async (t) => {
  const shellHome = makeShellHome(t, true);
  const script = `. "${toBashPath(shellHome.hook)}"\necho first\necho second\nexit\n`;
  const run = runInteractiveBash(shellHome, script, "/cfg");
  assert.equal(run.error, undefined, `bash must start: ${run.error?.message}`);
  assert.equal(run.status, 0, `the session must exit cleanly; stderr: ${run.stderr}`);
  const records = await readShellEnvRecords(shellHome.log);
  assert.equal(records.length, 1, `the load must start the hook exactly once; got: ${JSON.stringify(records)}`);
  assert.equal(records[0]?.configDir, "/cfg", "the hook must inherit CLAUDE_CONFIG_DIR from its shell");
  assert.equal(basename(records[0]?.argv[0] ?? ""), "shell-env", "node must have run the shell-env argument");
});

test("bash hook load keeps status and prints nothing", { skip: bashOk ? false : bashSkip }, async (t) => {
  // One home for both runs: interactive bash echoes the typed script to
  // stderr, so the two runs must type byte-identical text.
  const shellHome = makeShellHome(t, false);
  const script = `. "${toBashPath(shellHome.hook)}"\necho "rc=$?"\nexit\n`;
  const withoutHook = runInteractiveBash(shellHome, script);
  installFakeHook(shellHome.home);
  const withHook = runInteractiveBash(shellHome, script);
  assert.equal(withoutHook.error, undefined, `bash must start without the hook: ${withoutHook.error?.message}`);
  assert.equal(withHook.error, undefined, `bash must start with the hook: ${withHook.error?.message}`);
  assert.match(withHook.stdout, /^rc=\d+$/m, "the load must leave a status line behind");
  assert.equal(withHook.stdout, withoutHook.stdout, "a present hook must not change stdout");
  assert.equal(withHook.stderr, withoutHook.stderr, "a present hook must not change stderr");
  const records = await readShellEnvRecords(shellHome.log);
  assert.equal(records.length, 1, "the fake hook must have started, or this comparison proves nothing");
});

test("shell hook protocol version is 0.6.0", () => {
  assert.equal(ROCKY_HOOK_PROTOCOL_VERSION, "0.6.0");
});
