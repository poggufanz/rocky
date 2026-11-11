import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fixtures for the load-time `shell-env` start: a fake desktop hook binary, the
// helpers that wait for it and reap it, and the bash path form the bash-driven
// tests need.
//
// ponytail: node stands in for the hook binary so Node tests need no cargo build.
// The shell hooks start `<ROCKY_HOME>/bin/rocky-hook[.exe] shell-env` from the
// shell's working directory. Node runs a `shell-env` argument as a script found
// there, so the fake is node itself plus an extensionless CommonJS `shell-env`.

export interface ShellEnvRecord {
  argv: string[];
  configDir: string | null;
  pid: number;
}

const SHELL_ENV_WAIT_GUARD_MS = 20_000;
const SHELL_ENV_KILL_GUARD_MS = 5_000;
const POLL_INTERVAL_MS = 100;

let sharedDir: string | undefined;
let sharedWindowsExe: string | undefined;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One copy of node.exe per test file (Windows only), reused by every home in that file. */
function sharedWindowsHook(): string {
  if (sharedWindowsExe === undefined) {
    sharedDir = mkdtempSync(join(tmpdir(), "rocky-shell-env-bin-"));
    sharedWindowsExe = join(sharedDir, "rocky-hook.exe");
    copyFileSync(process.execPath, sharedWindowsExe);
  }
  return sharedWindowsExe;
}

/** Removes the shared copy. Register once per test file with `after()`. */
export function disposeSharedFakeHook(): void {
  if (sharedDir !== undefined) removeTreeWithRetry(sharedDir);
  sharedDir = undefined;
  sharedWindowsExe = undefined;
}

/**
 * Recursive removal that rides out transient Windows locks (a child that is
 * still finishing holds its working directory). Gives up quietly after a
 * bounded number of attempts: leftover temp litter must never fail a test.
 */
export function removeTreeWithRetry(path: string): void {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
}

/**
 * Places the fake hook at `<home>/bin/rocky-hook` (a symlink to node on POSIX)
 * or `<home>/bin/rocky-hook.exe` (a hard link to the shared copy on Windows, a
 * plain copy when linking is refused, e.g. across volumes).
 */
export function installFakeHook(home: string): void {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  if (process.platform !== "win32") {
    symlinkSync(process.execPath, join(bin, "rocky-hook"));
    return;
  }
  const target = join(bin, "rocky-hook.exe");
  const source = sharedWindowsHook();
  try {
    linkSync(source, target);
  } catch {
    copyFileSync(source, target);
  }
}

/**
 * Writes the extensionless CommonJS `shell-env` script into `cwd`. Each start
 * appends one JSON line to `logPath`: argv[1], the script path Node resolved
 * (`shell-env` is consumed as the script name, so no further arguments exist),
 * the CLAUDE_CONFIG_DIR the hook inherited, and the process id, so a test can
 * wait for that exact process to exit.
 */
export function writeShellEnvScript(cwd: string, logPath: string): void {
  const record = "{ argv: process.argv.slice(1), configDir: process.env.CLAUDE_CONFIG_DIR ?? null, pid: process.pid }";
  writeFileSync(
    join(cwd, "shell-env"),
    `require("node:fs").appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(${record}) + "\\n");\n`,
  );
}

/** Every complete record in `logPath` so far. A partly written last line is not a record yet. */
export function readShellEnvRecords(logPath: string): ShellEnvRecord[] {
  const text = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  const complete = text.slice(0, text.lastIndexOf("\n") + 1);
  return complete
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ShellEnvRecord);
}

/**
 * Polls until `logPath` holds at least one complete record. Returns false when
 * the anti-hang guard expires first. The guard is not a timing claim.
 */
export async function waitForShellEnvRecord(logPath: string, guardMs = SHELL_ENV_WAIT_GUARD_MS): Promise<boolean> {
  const deadline = Date.now() + guardMs;
  while (readShellEnvRecords(logPath).length === 0) {
    if (Date.now() >= deadline) return false;
    await sleep(POLL_INTERVAL_MS);
  }
  return true;
}

/** True while `pid` names a live process. EPERM means it exists under another user. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Reaps the detached hook processes behind `records`. Each exits on its own
 * right after its single write, so this polls `process.kill(pid, 0)` until it
 * throws, inside the anti-hang guard. A process still alive at the guard is
 * killed and polled briefly more. Returns true only when every process exited
 * on its own, so a run that needed killing cannot pass silently.
 */
export async function reapShellEnvChildren(
  records: ShellEnvRecord[],
  guardMs = SHELL_ENV_WAIT_GUARD_MS,
  killGuardMs = SHELL_ENV_KILL_GUARD_MS,
): Promise<boolean> {
  let exitedOnItsOwn = true;
  for (const { pid } of records) {
    const deadline = Date.now() + guardMs;
    while (isAlive(pid) && Date.now() < deadline) await sleep(POLL_INTERVAL_MS);
    if (!isAlive(pid)) continue;
    exitedOnItsOwn = false;
    try {
      process.kill(pid);
    } catch {
      // It exited between the liveness check and the kill.
    }
    const killDeadline = Date.now() + killGuardMs;
    while (isAlive(pid) && Date.now() < killDeadline) await sleep(POLL_INTERVAL_MS);
  }
  return exitedOnItsOwn;
}

/** True when a `bash` that answers `--version` is on PATH. */
export function bashAvailable(): boolean {
  try {
    const probe = spawnSync("bash", ["--version"], { stdio: "ignore", timeout: 5_000 });
    return !probe.error && probe.status === 0;
  } catch {
    return false;
  }
}

let bashKernel: string | undefined;

/** The `uname -s` of whichever bash answers on PATH; decides the path form. */
function kernelOfBash(): string {
  if (bashKernel === undefined) {
    const probe = spawnSync("bash", ["-c", "uname -s"], { encoding: "utf8", timeout: 5_000 });
    bashKernel = (probe.stdout ?? "").trim();
  }
  return bashKernel;
}

/**
 * Converts a Windows path into the form the bash on PATH accepts: `C:/...` for
 * Git Bash (MSYS), `/mnt/<drive>/...` for WSL. Anything else passes through.
 */
export function toBashPath(native: string): string {
  const forward = native.replace(/\\/g, "/");
  const match = /^([A-Za-z]):\/(.*)$/.exec(forward);
  if (!match) return native;
  if (/^(MINGW|MSYS|CYGWIN)/i.test(kernelOfBash())) return forward;
  return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
}
