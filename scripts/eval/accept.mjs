import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCommandInvocation,
  resolveExecutableOnPath,
  stripRockyFromPath,
} from "./sandbox.mjs";

const EVAL_DIR = resolve(dirname(fileURLToPath(import.meta.url)));
const TASKS_DIR = join(EVAL_DIR, "tasks");
const MANIFEST_PATH = join(TASKS_DIR, "manifest.json");
const ACCEPT_TIMEOUT_MS = 120_000;
export const ACCEPT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const ACCEPT_KILL_GRACE_MS = 10_000;
const WIN32_ALLOWLIST_KEYS = [
  "SystemRoot",
  "windir",
  "ComSpec",
  "PATHEXT",
  "SystemDrive",
];

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function findEnvKey(env, targetName) {
  if (!env) return undefined;
  if (Object.prototype.hasOwnProperty.call(env, targetName) && env[targetName] !== undefined) {
    return targetName;
  }
  const upper = targetName.toUpperCase();
  return Object.keys(env).find((key) => key.toUpperCase() === upper && env[key] !== undefined);
}

function getPathValue(env) {
  const key = findEnvKey(env, "PATH");
  return key === undefined ? "" : (env[key] ?? "");
}

function removeDirWithRetry(target) {
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      rmSync(target, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      const code = error && typeof error === "object" ? error.code : undefined;
      if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 75 * (attempt + 1));
    }
  }
  if (existsSync(target) && lastError) throw lastError;
}

function resolveNpmExecutable(env, platform = process.platform) {
  const names = platform === "win32" ? ["npm.cmd", "npm.exe"] : ["npm"];
  const found = resolveExecutableOnPath(names, getPathValue(env), platform, [dirname(process.execPath)]);
  if (!found) throw new Error("npm executable is unavailable");
  return found;
}

function collectRelativeFiles(dirPath, relPrefix) {
  /** @type {string[]} */
  const out = [];
  if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) return out;
  const entries = readdirSync(dirPath).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const name of entries) {
    const full = join(dirPath, name);
    const rel = relPrefix ? `${relPrefix}/${name}` : name;
    if (statSync(full).isDirectory()) {
      out.push(...collectRelativeFiles(full, rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

function verifyProtectedFiles(task, finalDir, manifest) {
  const filesMap = manifest?.files ?? {};
  const repoPrefix = `${task.fixture}/repo/`;
  const protectedEntries = Array.isArray(task.protected) ? task.protected : [];

  for (const rawEntry of protectedEntries) {
    const entry = String(rawEntry).replaceAll("\\", "/").replace(/^\.\//, "");
    if (entry.endsWith("/")) {
      const fullPrefix = `${repoPrefix}${entry}`;
      const expectedKeys = Object.keys(filesMap)
        .filter((key) => key.startsWith(fullPrefix))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      if (expectedKeys.length === 0) {
        return { ok: false, reason: `no manifest files matched protected prefix: ${entry}` };
      }
      const expectedRelSet = new Set();
      for (const key of expectedKeys) {
        const rel = key.slice(repoPrefix.length);
        expectedRelSet.add(rel);
        const targetPath = join(finalDir, rel);
        if (!existsSync(targetPath) || !statSync(targetPath).isFile()) {
          return { ok: false, reason: `protected file missing: ${rel}` };
        }
        if (sha256File(targetPath) !== filesMap[key]) {
          return { ok: false, reason: `protected file modified: ${rel}` };
        }
      }
      const actualFiles = collectRelativeFiles(join(finalDir, entry), entry.slice(0, -1));
      for (const rel of actualFiles) {
        if (!expectedRelSet.has(rel)) {
          return { ok: false, reason: `unexpected file under protected dir: ${rel}` };
        }
      }
    } else {
      const key = `${repoPrefix}${entry}`;
      const expectedHash = filesMap[key];
      if (typeof expectedHash !== "string") {
        return { ok: false, reason: `protected file absent from manifest: ${entry}` };
      }
      const targetPath = join(finalDir, entry);
      if (!existsSync(targetPath) || !statSync(targetPath).isFile()) {
        return { ok: false, reason: `protected file missing: ${entry}` };
      }
      if (sha256File(targetPath) !== expectedHash) {
        return { ok: false, reason: `protected file modified: ${entry}` };
      }
    }
  }

  return { ok: true };
}

/**
 * Create the isolated subdirectories expected inside an acceptance temp root.
 * @param {string} rootDir
 */
export function prepareAcceptTempDir(rootDir) {
  for (const name of ["tmp", "home", "appdata", "localappdata", "npm-cache"]) {
    mkdirSync(join(rootDir, name), { recursive: true });
  }
}

/**
 * Check whether stdout contains an exact line matching `acceptLine`.
 * @param {string} stdout
 * @param {string | undefined} acceptLine
 * @returns {boolean}
 */
export function stdoutHasAcceptLine(stdout, acceptLine) {
  if (typeof acceptLine !== "string" || acceptLine.length === 0) return false;
  return String(stdout ?? "")
    .split(/\r?\n/)
    .some((line) => line === acceptLine);
}

/**
 * Build a minimal allowlisted environment for running a task target command cleanly.
 * Copies only `PATH` (case-preserving key, Rocky shims stripped) and on win32
 * `SystemRoot`, `windir`, `ComSpec`, `PATHEXT`, and `SystemDrive`.
 * Points `TEMP`/`TMP`, `HOME`/`USERPROFILE`, `APPDATA`/`LOCALAPPDATA`, and
 * `NPM_CONFIG_CACHE` into `tempDir`. Nothing else crosses from `baseEnv`.
 * @param {Record<string, string | undefined>} [baseEnv]
 * @param {NodeJS.Platform} [platform]
 * @param {string} [tempDir]
 * @returns {Record<string, string>}
 */
export function buildAcceptEnv(baseEnv = process.env, platform = process.platform, tempDir = tmpdir()) {
  const source = baseEnv ?? {};
  const pathApi = platform === "win32" ? win32 : posix;
  /** @type {Record<string, string>} */
  const out = {};

  const pathKey = findEnvKey(source, "PATH") ?? "PATH";
  const rawPath = Object.prototype.hasOwnProperty.call(source, pathKey) ? (source[pathKey] ?? "") : "";
  out[pathKey] = stripRockyFromPath(rawPath, platform);

  if (platform === "win32") {
    for (const name of WIN32_ALLOWLIST_KEYS) {
      const existingKey = findEnvKey(source, name);
      if (existingKey !== undefined && typeof source[existingKey] === "string") {
        out[existingKey] = source[existingKey];
      }
    }
  }

  const tmpSubdir = pathApi.join(tempDir, "tmp");
  const homeSubdir = pathApi.join(tempDir, "home");
  out.TEMP = tmpSubdir;
  out.TMP = tmpSubdir;
  out.HOME = homeSubdir;
  out.USERPROFILE = homeSubdir;
  out.APPDATA = pathApi.join(tempDir, "appdata");
  out.LOCALAPPDATA = pathApi.join(tempDir, "localappdata");
  out.NPM_CONFIG_CACHE = pathApi.join(tempDir, "npm-cache");
  out.npm_config_color = "false";
  out.npm_config_loglevel = "error";

  return out;
}

function runTaskkillAsync(taskkill, pid, timeoutMs = 10_000) {
  return new Promise((resolveKill) => {
    let settled = false;
    /** @type {NodeJS.Timeout | null} */
    let timer = null;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      resolveKill(ok);
    };

    let killer;
    try {
      killer = spawn(taskkill, ["/T", "/F", "/PID", String(pid)], {
        stdio: "ignore",
        windowsHide: true,
        shell: false,
      });
    } catch {
      finish(false);
      return;
    }

    killer.on("error", () => finish(false));
    killer.on("close", (code) => finish(code === 0));

    timer = setTimeout(() => {
      try {
        killer.kill("SIGKILL");
      } catch {
        // Ignore if taskkill already exited.
      }
      finish(false);
    }, timeoutMs);
    timer.unref?.();
  });
}

async function killTargetTree(child, env, platform = process.platform) {
  const pid = child.pid;
  if (platform === "win32" && typeof pid === "number" && pid > 0) {
    const sysRoot = env?.SystemRoot ?? process.env.SystemRoot ?? process.env.windir;
    const extraDirs = typeof sysRoot === "string" && sysRoot.length > 0 ? [join(sysRoot, "System32")] : [];
    const taskkill = resolveExecutableOnPath(
      ["taskkill.exe"],
      getPathValue(env ?? process.env),
      "win32",
      extraDirs,
    );
    if (taskkill) {
      const killed = await runTaskkillAsync(taskkill, pid, 10_000);
      if (killed) return;
    }
  } else if (platform !== "win32" && typeof pid === "number" && pid > 0) {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      // Fall through to direct kill.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // Process may already have exited.
  }
}

/**
 * Execute a simple target command (such as `npm test` or `node ...`) asynchronously without a shell.
 * @param {string} command
 * @param {string} cwd
 * @param {Record<string, string>} env
 * @param {number} [timeoutMs]
 * @param {number} [maxBufferBytes]
 * @param {{
 *   killTree?: (child: import("node:child_process").ChildProcess, env: Record<string, string>, platform: NodeJS.Platform) => Promise<void> | void,
 *   killGraceMs?: number,
 *   platform?: NodeJS.Platform,
 * }} [options]
 * @returns {Promise<{ status: number, signal: NodeJS.Signals | null, stdout: string, stderr: string, timedOut: boolean, stdoutOverflow: boolean, stderrOverflow: boolean }>}
 */
export async function runTargetCommand(
  command,
  cwd,
  env,
  timeoutMs = ACCEPT_TIMEOUT_MS,
  maxBufferBytes = ACCEPT_MAX_BUFFER_BYTES,
  options = {},
) {
  const killTree = options.killTree ?? killTargetTree;
  const killGraceMs = options.killGraceMs ?? ACCEPT_KILL_GRACE_MS;
  const platform = options.platform ?? process.platform;
  const tokens = String(command ?? "").trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    throw new Error("Target command must be non-empty");
  }
  const [program, ...args] = tokens;
  let executable;
  if (program === "npm") {
    executable = resolveNpmExecutable(env, process.platform);
  } else if (program === "node") {
    executable = process.execPath;
  } else {
    const names = process.platform === "win32"
      ? [`${program}.exe`, `${program}.cmd`, program]
      : [program];
    executable = resolveExecutableOnPath(names, getPathValue(env), process.platform);
    if (!executable) throw new Error(`Target command executable not found: ${program}`);
  }

  const comSpecKey = findEnvKey(env, "ComSpec");
  const comSpec = (comSpecKey !== undefined ? env[comSpecKey] : undefined)
    ?? process.env.ComSpec
    ?? process.env.COMSPEC;
  const invocation = buildCommandInvocation(executable, args, process.platform, comSpec);

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(invocation.file, invocation.args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
      detached: process.platform !== "win32",
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });

    /** @type {Buffer[]} */
    const stdoutChunks = [];
    /** @type {Buffer[]} */
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutOverflow = false;
    let stderrOverflow = false;
    let timedOut = false;
    let settled = false;
    let childClosed = false;
    /** @type {number | null} */
    let closeCode = null;
    /** @type {NodeJS.Signals | null} */
    let closeSignal = null;
    let killInProgress = false;
    let killSettled = false;
    /** @type {NodeJS.Timeout | null} */
    let killTimer = null;
    /** @type {NodeJS.Timeout | null} */
    let graceTimer = null;

    const clearTimers = () => {
      if (killTimer !== null) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      if (graceTimer !== null) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
    };

    const settle = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolvePromise({
        status: timedOut ? 124 : (code ?? 1),
        signal: signal ?? null,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        timedOut,
        stdoutOverflow,
        stderrOverflow,
      });
    };

    child.stdout.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (stdoutBytes + buf.length > maxBufferBytes) {
        stdoutOverflow = true;
        if (stdoutBytes < maxBufferBytes) {
          const remaining = maxBufferBytes - stdoutBytes;
          stdoutChunks.push(buf.subarray(0, remaining));
          stdoutBytes += remaining;
        }
        return;
      }
      stdoutChunks.push(buf);
      stdoutBytes += buf.length;
    });

    child.stderr.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (stderrBytes + buf.length > maxBufferBytes) {
        stderrOverflow = true;
        if (stderrBytes < maxBufferBytes) {
          const remaining = maxBufferBytes - stderrBytes;
          stderrChunks.push(buf.subarray(0, remaining));
          stderrBytes += remaining;
        }
        return;
      }
      stderrChunks.push(buf);
      stderrBytes += buf.length;
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      rejectPromise(error);
    });

    child.on("close", (code, signal) => {
      childClosed = true;
      closeCode = code;
      closeSignal = signal;
      if (killInProgress && !killSettled) {
        return;
      }
      settle(code, signal);
    });

    if (typeof timeoutMs === "number" && timeoutMs > 0) {
      killTimer = setTimeout(() => {
        if (settled || childClosed) return;
        timedOut = true;
        killInProgress = true;
        Promise.resolve()
          .then(() => killTree(child, env, platform))
          .catch(() => {})
          .finally(() => {
            killSettled = true;
            if (settled) return;
            if (childClosed) {
              settle(closeCode, closeSignal);
              return;
            }
            graceTimer = setTimeout(() => {
              child.stdout.destroy();
              child.stderr.destroy();
              settle(124, "SIGKILL");
            }, killGraceMs);
            graceTimer.unref?.();
          });
      }, timeoutMs);
      killTimer.unref?.();
    }
  });
}

/**
 * Grade a candidate repository directory for a task:
 * 1. Every protected file must match its manifest sha256.
 * 2. The target command must exit 0 within 120 s under a minimal allowlisted env
 *    and print the task's exact `acceptLine` to stdout.
 * @param {any} task
 * @param {string} finalDir
 * @param {{
 *   manifest?: any,
 *   timeoutMs?: number,
 *   maxBufferBytes?: number,
 *   killTree?: (child: import("node:child_process").ChildProcess, env: Record<string, string>, platform: NodeJS.Platform) => Promise<void> | void,
 *   killGraceMs?: number,
 * }} [options]
 * @returns {Promise<{ solved: boolean, reason: string }>}
 */
export async function accept(task, finalDir, options = {}) {
  const manifest = options.manifest ?? JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  const protectedCheck = verifyProtectedFiles(task, finalDir, manifest);
  if (!protectedCheck.ok) {
    return { solved: false, reason: protectedCheck.reason };
  }

  const acceptTempDir = mkdtempSync(join(tmpdir(), "rocky-eval-accept-env-"));
  let res;
  try {
    prepareAcceptTempDir(acceptTempDir);
    const env = buildAcceptEnv(process.env, process.platform, acceptTempDir);
    res = await runTargetCommand(
      task.target.command,
      finalDir,
      env,
      options.timeoutMs ?? ACCEPT_TIMEOUT_MS,
      options.maxBufferBytes ?? ACCEPT_MAX_BUFFER_BYTES,
      {
        killTree: options.killTree,
        killGraceMs: options.killGraceMs,
      },
    );
  } finally {
    removeDirWithRetry(acceptTempDir);
  }

  if (res.stdoutOverflow) {
    return { solved: false, reason: "output-overflow" };
  }
  if (res.timedOut) {
    return { solved: false, reason: "timeout" };
  }
  if (res.signal) {
    return { solved: false, reason: `signal ${res.signal}` };
  }
  if (res.status !== 0) {
    return { solved: false, reason: `exit ${res.status}` };
  }
  // ponytail: an agent that copies the acceptLine into its own script without
  // running the protected test would still pass; acceptable for non-adversarial agents.
  if (!stdoutHasAcceptLine(res.stdout, task.acceptLine)) {
    return { solved: false, reason: "no-accept-line" };
  }
  return { solved: true, reason: "ok" };
}
