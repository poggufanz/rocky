import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCommandInvocation,
  buildToolEnv,
  resolveExecutableOnPath,
  stripRockyFromPath,
} from "./sandbox.mjs";

const EVAL_DIR = resolve(dirname(fileURLToPath(import.meta.url)));
const TASKS_DIR = join(EVAL_DIR, "tasks");
const MANIFEST_PATH = join(TASKS_DIR, "manifest.json");
const ACCEPT_TIMEOUT_MS = 120_000;

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function getPathValue(env) {
  if (typeof env.PATH === "string") return env.PATH;
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH");
  return key === undefined ? "" : (env[key] ?? "");
}

function setSinglePath(env, value) {
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === "PATH") delete env[key];
  }
  env.PATH = value;
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
 * Build the scrubbed environment for running a task target command cleanly.
 * Drops every `ROCKY_*` variable, agent tokens, and git config overrides.
 * @param {Record<string, string | undefined>} [baseEnv]
 * @param {NodeJS.Platform} [platform]
 * @returns {Record<string, string>}
 */
export function buildAcceptEnv(baseEnv = process.env, platform = process.platform) {
  const env = buildToolEnv(baseEnv, platform);
  for (const key of Object.keys(env)) {
    if (/^ROCKY_/i.test(key)) delete env[key];
  }
  setSinglePath(env, stripRockyFromPath(getPathValue(env), platform));
  return env;
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

  const comSpec = env.ComSpec ?? env.COMSPEC ?? process.env.ComSpec ?? process.env.COMSPEC;
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
 * 2. The target command must exit 0 within 120 s under a scrubbed env with no `ROCKY_*`.
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

  const env = buildAcceptEnv(process.env, process.platform);
  const res = runTargetCommand(task.target.command, finalDir, env, options.timeoutMs ?? ACCEPT_TIMEOUT_MS);
  if (res.timedOut) {
    return { solved: false, reason: "timeout" };
  }
  if (res.signal) {
    return { solved: false, reason: `signal ${res.signal}` };
  }
  if (res.status !== 0) {
    return { solved: false, reason: `exit ${res.status}` };
  }
  return { solved: true, reason: "ok" };
}
