import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fixtures for the load-time `shell-env` start: a fake desktop hook binary and
// the bash path form the bash-driven tests need.
//
// ponytail: node stands in for the hook binary so Node tests need no cargo build.
// The shell hooks start `<ROCKY_HOME>/bin/rocky-hook[.exe] shell-env` from the
// shell's working directory. Node runs a `shell-env` argument as a script found
// there, so the fake is node itself plus an extensionless CommonJS `shell-env`.

export interface ShellEnvRecord {
  argv: string[];
  configDir: string | null;
}

const SHELL_ENV_WAIT_GUARD_MS = 20_000;

let sharedDir: string | undefined;
let sharedWindowsExe: string | undefined;

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
 * and the CLAUDE_CONFIG_DIR the hook inherited from its shell.
 */
export function writeShellEnvScript(cwd: string, logPath: string): void {
  const record = "{ argv: process.argv.slice(1), configDir: process.env.CLAUDE_CONFIG_DIR ?? null }";
  writeFileSync(
    join(cwd, "shell-env"),
    `require("node:fs").appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(${record}) + "\\n");\n`,
  );
}

/**
 * Waits until `logPath` holds at least one complete record, then returns the
 * complete records. The guard only stops a hung start from stalling the suite;
 * it is not a timing claim. A start that never writes yields an empty list.
 */
export async function readShellEnvRecords(logPath: string, guardMs = SHELL_ENV_WAIT_GUARD_MS): Promise<ShellEnvRecord[]> {
  const deadline = Date.now() + guardMs;
  let text = "";
  while (Date.now() < deadline) {
    text = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    if (text.endsWith("\n")) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const complete = text.slice(0, text.lastIndexOf("\n") + 1);
  return complete
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ShellEnvRecord);
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
