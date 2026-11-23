import { spawnSync } from "node:child_process";
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

/**
 * Execute a simple target command (such as `npm test` or `node ...`) without a shell.
 * @param {string} command
 * @param {string} cwd
 * @param {Record<string, string>} env
 * @param {number} [timeoutMs]
 * @returns {{ status: number, signal: NodeJS.Signals | null, stdout: string, stderr: string, timedOut: boolean }}
 */
export function runTargetCommand(command, cwd, env, timeoutMs = ACCEPT_TIMEOUT_MS) {
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
  const result = spawnSync(invocation.file, invocation.args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: timeoutMs,
    windowsHide: true,
    shell: false,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });

  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      return {
        status: 124,
        signal: result.signal ?? null,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        timedOut: true,
      };
    }
    throw result.error;
  }

  return {
    status: result.status ?? 1,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    timedOut: false,
  };
}

/**
 * Grade a candidate repository directory for a task:
 * 1. Every protected file must match its manifest sha256.
 * 2. The target command must exit 0 within 120 s under a minimal allowlisted env
 *    and print the task's exact `acceptLine` to stdout.
 * @param {any} task
 * @param {string} finalDir
 * @param {{ manifest?: any, timeoutMs?: number }} [options]
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
    res = runTargetCommand(task.target.command, finalDir, env, options.timeoutMs ?? ACCEPT_TIMEOUT_MS);
  } finally {
    removeDirWithRetry(acceptTempDir);
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
