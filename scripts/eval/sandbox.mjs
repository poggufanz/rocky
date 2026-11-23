import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

/** @typedef {"none"|"before"|"after"} Arm */
/** @typedef {{ kind: "token" } | { kind: "copy-credentials", from: string }} SandboxAuth */
/**
 * @typedef {{
 *   dir: string,
 *   home: string,
 *   configDir: string,
 *   rockyHome: string,
 *   taskDir: string,
 *   prefixBin: string | null,
 *   env: Record<string, string>,
 * }} Sandbox
 */

// Frozen from the harness capture recorded in README.md; the trailing `--`
// keeps the prompt from being read as an `--allowedTools` value.
export const MODEL = "claude-sonnet-5-5";
export const CLAUDE_FLAGS = [
  "-p",
  "--output-format",
  "stream-json",
  "--verbose",
  "--max-turns",
  "30",
  "--model",
  MODEL,
  "--effort",
  "high",
  "--allowedTools",
  "Bash,PowerShell,Edit,Write,Read,Glob,Grep,mcp__rocky__*",
  "--",
];

const VALID_ARMS = new Set(["none", "before", "after"]);
const SCRUB_ENV_RE = /^(?:CLAUDE|CLAUDECODE|ROCKY_|ANTHROPIC_|CLAUDE_ENV_FILE$|NODE_OPTIONS$)/i;
const GIT_CONFIG_ENV_RE = /^GIT_CONFIG_(?:PARAMETERS|COUNT|GLOBAL|SYSTEM|(?:KEY|VALUE)_\d+)$/i;
const ANCESTOR_SENTINELS = ["CLAUDE.md", "AGENTS.md", ".claude"];
const UNSAFE_WIN_TOKEN_RE = /["\r\n\0%!]/u;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Replace every occurrence of each non-empty secret with `<redacted>`.
 * @param {string} text
 * @param {readonly string[]} secrets
 * @returns {string}
 */
export function redactText(text, secrets) {
  let out = String(text ?? "");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length > 0) {
      out = out.split(secret).join("<redacted>");
    }
  }
  return out;
}

/**
 * Drop agent, Rocky, Anthropic, and Node preload variables without mutating the input.
 * @param {Record<string, string | undefined>} env
 * @param {NodeJS.Platform} [platform]
 * @returns {Record<string, string>}
 */
export function scrubEnv(env, platform = process.platform) {
  void platform;
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value === undefined) continue;
    if (SCRUB_ENV_RE.test(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Build a scrubbed environment for git/npm helper children without agent tokens, color overrides,
 * or inherited git config overrides.
 * When `options.home` is set, pins `HOME`/`USERPROFILE` to that directory and disables system git config.
 * @param {Record<string, string | undefined>} [env]
 * @param {NodeJS.Platform} [platform]
 * @param {{ home?: string }} [options]
 * @returns {Record<string, string>}
 */
export function buildToolEnv(env = process.env, platform = process.platform, options = {}) {
  const toolEnv = scrubEnv(env, platform);
  const hasPathKey = Object.keys(toolEnv).some((key) => key.toUpperCase() === "PATH");
  if (hasPathKey) {
    setSinglePath(toolEnv, getPathValue(toolEnv));
  }
  for (const key of Object.keys(toolEnv)) {
    if (key.toUpperCase() === "FORCE_COLOR" || GIT_CONFIG_ENV_RE.test(key)) {
      delete toolEnv[key];
    }
  }
  toolEnv.npm_config_color = "false";
  if (typeof options.home === "string" && options.home.length > 0) {
    for (const key of Object.keys(toolEnv)) {
      const upper = key.toUpperCase();
      if (
        upper === "HOME"
        || upper === "USERPROFILE"
        || upper === "GIT_CONFIG_NOSYSTEM"
        || upper === "XDG_CONFIG_HOME"
      ) {
        delete toolEnv[key];
      }
    }
    toolEnv.HOME = options.home;
    toolEnv.USERPROFILE = options.home;
    toolEnv.GIT_CONFIG_NOSYSTEM = "1";
  }
  return toolEnv;
}

function defaultHasRockyShim(dir, platform) {
  const pathApi = platform === "win32" ? win32 : posix;
  const cleanDir = platform === "win32" ? dir.replace(/^"|"$/g, "") : dir;
  if (cleanDir.length === 0) return false;
  const names = platform === "win32"
    ? ["rocky.cmd", "rocky.exe", "rocky.ps1", "rocky.bat", "rocky"]
    : ["rocky"];
  return names.some((name) => existsSync(pathApi.join(cleanDir, name)));
}

function isAbsolutePathEntry(entry, platform) {
  if (platform === "win32") {
    return win32.isAbsolute(entry) && /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(entry);
  }
  return posix.isAbsolute(entry);
}

/**
 * Remove empty, non-absolute, and rocky-shim PATH entries.
 * @param {string | undefined} pathValue
 * @param {NodeJS.Platform} [platform]
 * @param {(dir: string) => boolean} [hasRockyShim]
 * @returns {string}
 */
export function stripRockyFromPath(
  pathValue,
  platform = process.platform,
  hasRockyShim,
) {
  if (!pathValue) return "";
  const sep = platform === "win32" ? ";" : ":";
  const checker = hasRockyShim ?? ((dir) => defaultHasRockyShim(dir, platform));
  return pathValue
    .split(sep)
    .filter((entry) => {
      const clean = platform === "win32" ? entry.replace(/^"|"$/g, "") : entry;
      if (clean.length === 0) return false;
      if (!isAbsolutePathEntry(clean, platform)) return false;
      return !checker(entry);
    })
    .join(sep);
}

function pathApiFor(target, fallbackApi = process.platform === "win32" ? win32 : posix) {
  if (/^[A-Za-z]:[\\/]|^\\\\/.test(target)) return win32;
  if (fallbackApi === win32 && target.startsWith("//")) return win32;
  if (target.startsWith("/")) return posix;
  return fallbackApi;
}

function stripTrailingSep(target, pathApi) {
  const root = pathApi.parse(target).root;
  let current = target;
  const isSep = pathApi === win32
    ? (ch) => ch === "/" || ch === "\\"
    : (ch) => ch === "/";
  while (current.length > root.length && isSep(current[current.length - 1])) {
    current = current.slice(0, -1);
  }
  return current;
}

function resolveDeepestExisting(absolute, pathApi, realpath) {
  let cursor = stripTrailingSep(absolute, pathApi);
  /** @type {string[]} */
  const suffix = [];
  while (true) {
    try {
      const resolved = realpath(cursor);
      const resolvedApi = pathApiFor(resolved, pathApi);
      const cleanResolved = stripTrailingSep(resolved, resolvedApi);
      const canonical = suffix.length > 0
        ? resolvedApi.join(cleanResolved, ...suffix.slice().reverse())
        : cleanResolved;
      return { deepestExisting: cleanResolved, canonical, pathApi: resolvedApi };
    } catch (error) {
      const code = error && typeof error === "object" ? error.code : undefined;
      if (code !== undefined && code !== "ENOENT" && code !== "ENOTDIR") {
        throw error;
      }
      const parent = pathApi.dirname(cursor);
      if (parent === cursor) return null;
      suffix.push(pathApi.basename(cursor));
      cursor = stripTrailingSep(parent, pathApi);
    }
  }
}

function walkAncestorsForSentinels(startDir, pathApi, exists, visited) {
  let current = stripTrailingSep(startDir, pathApi);
  while (true) {
    if (!visited.has(current)) {
      visited.add(current);
      for (const sentinel of ANCESTOR_SENTINELS) {
        const candidate = pathApi.join(current, sentinel);
        if (exists(candidate)) {
          throw new Error(`Refusing sandbox root: found ancestor instruction or config at ${candidate}`);
        }
      }
    }
    const parent = pathApi.dirname(current);
    if (parent === current) break;
    current = stripTrailingSep(parent, pathApi);
  }
}

/**
 * Refuse a sandbox root if CLAUDE.md, AGENTS.md, or .claude exists in it or any lexical/canonical ancestor.
 * @param {string} dir
 * @param {(candidate: string) => boolean} [exists]
 * @param {(candidate: string) => string} [realpath]
 * @param {NodeJS.Platform} [platform]
 */
export function assertNoAncestorInstructions(
  dir,
  exists = existsSync,
  realpath = realpathSync.native,
  platform,
) {
  if (typeof dir !== "string" || dir.length === 0) {
    throw new Error("Sandbox root must be a non-empty path");
  }
  const pathApi = platform !== undefined
    ? (platform === "win32" ? win32 : posix)
    : pathApiFor(dir);
  const absolute = pathApi.isAbsolute(dir) ? pathApi.normalize(dir) : pathApi.resolve(dir);
  const visited = new Set();

  walkAncestorsForSentinels(absolute, pathApi, exists, visited);

  const canonical = resolveDeepestExisting(absolute, pathApi, realpath);
  if (canonical) {
    walkAncestorsForSentinels(canonical.deepestExisting, canonical.pathApi, exists, visited);
  }
}

function isPathInside(target, base, pathApi, caseInsensitive) {
  const normTarget = caseInsensitive ? target.toLowerCase() : target;
  const normBase = caseInsensitive ? base.toLowerCase() : base;
  const rel = pathApi.relative(normBase, normTarget);
  if (rel === "") return true;
  if (pathApi.isAbsolute(rel)) return false;
  const firstSegment = rel.split(pathApi.sep)[0];
  return firstSegment !== "..";
}

/**
 * Refuse a destination path that resolves inside the repository or its enclosing workspace.
 * @param {string} targetPath
 * @param {string} [repoRoot]
 * @param {NodeJS.Platform} [platform]
 * @param {(candidate: string) => string} [realpath]
 */
export function assertOutsideWorkspace(
  targetPath,
  repoRoot = REPO_ROOT,
  platform = process.platform,
  realpath = realpathSync.native,
) {
  if (typeof targetPath !== "string" || targetPath.trim().length === 0) {
    throw new Error("Output path must be a non-empty path");
  }
  if (typeof repoRoot !== "string" || repoRoot.trim().length === 0) {
    throw new Error("Repository root must be a non-empty path");
  }

  const fallbackApi = platform === "win32" ? win32 : posix;
  const targetApi = pathApiFor(targetPath, fallbackApi);
  const repoApi = pathApiFor(repoRoot, fallbackApi);
  const absTarget = targetApi.isAbsolute(targetPath) ? targetApi.normalize(targetPath) : resolve(targetPath);
  const absRepo = repoApi.isAbsolute(repoRoot) ? repoApi.normalize(repoRoot) : resolve(repoRoot);

  const targetResolved = resolveDeepestExisting(absTarget, targetApi, realpath);
  const repoResolved = resolveDeepestExisting(absRepo, repoApi, realpath);

  const canonicalTarget = targetResolved ? targetResolved.canonical : stripTrailingSep(absTarget, targetApi);
  const canonicalRepo = repoResolved ? repoResolved.canonical : stripTrailingSep(absRepo, repoApi);
  const effectiveApi = repoResolved ? repoResolved.pathApi : repoApi;
  const caseInsensitive = platform === "win32" || effectiveApi === win32;

  const workspaceDir = effectiveApi.dirname(canonicalRepo);
  const workspaceResolved = resolveDeepestExisting(workspaceDir, effectiveApi, realpath);
  const canonicalWorkspace = workspaceResolved ? workspaceResolved.canonical : stripTrailingSep(workspaceDir, effectiveApi);

  if (isPathInside(canonicalTarget, canonicalRepo, effectiveApi, caseInsensitive)) {
    throw new Error(`Path must be outside the repo (${canonicalRepo}); got ${targetPath}`);
  }
  if (isPathInside(canonicalTarget, canonicalWorkspace, effectiveApi, caseInsensitive)) {
    throw new Error(`Path must be outside the repo and enclosing workspace (${canonicalWorkspace}); got ${targetPath}`);
  }
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

/**
 * Resolve an executable on PATH without spawning a shell.
 * @param {readonly string[]} names
 * @param {string} pathValue
 * @param {NodeJS.Platform} [platform]
 * @param {readonly string[]} [extraDirs]
 * @returns {string | null}
 */
export function resolveExecutableOnPath(
  names,
  pathValue,
  platform = process.platform,
  extraDirs = [],
) {
  const sep = platform === "win32" ? ";" : ":";
  const pathApi = platform === "win32" ? win32 : posix;
  const dirs = [
    ...extraDirs,
    ...(pathValue ?? "").split(sep).map((dir) => (
      platform === "win32" ? dir.replace(/^"|"$/g, "") : dir
    )),
  ].filter(Boolean);
  const mode = platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK;
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = pathApi.join(dir, name);
      try {
        accessSync(candidate, mode);
        if (statSync(candidate).isFile()) return resolve(candidate);
      } catch {
        // Keep searching PATH candidates.
      }
    }
  }
  return null;
}

function quoteWinCmdToken(value) {
  if (typeof value !== "string" || UNSAFE_WIN_TOKEN_RE.test(value)) {
    throw new Error("Unsafe Windows command token");
  }
  return `"${value}"`;
}

/**
 * Prepare a shell-free spawn invocation, wrapping Windows `.cmd`/`.bat` shims via ComSpec.
 * @param {string} file
 * @param {readonly string[]} args
 * @param {NodeJS.Platform} [platform]
 * @param {string | undefined} [comSpec]
 * @returns {{ file: string, args: string[], windowsVerbatimArguments: boolean }}
 */
export function buildCommandInvocation(
  file,
  args,
  platform = process.platform,
  comSpec = process.env.ComSpec ?? process.env.COMSPEC,
) {
  const copiedArgs = [...args];
  const ext = win32.extname(file).toLowerCase();
  if (platform !== "win32" || (ext !== ".cmd" && ext !== ".bat")) {
    return { file, args: copiedArgs, windowsVerbatimArguments: false };
  }
  if (!win32.isAbsolute(file)) {
    throw new Error(`Windows batch wrapper must be an absolute path: ${file}`);
  }
  if (typeof comSpec !== "string" || !win32.isAbsolute(comSpec)) {
    throw new Error("Absolute ComSpec is unavailable for Windows .cmd invocation");
  }
  const command = [file, ...copiedArgs].map(quoteWinCmdToken).join(" ");
  return {
    file: comSpec,
    args: ["/d", "/s", "/c", `"${command}"`],
    windowsVerbatimArguments: true,
  };
}

function runCommand(file, args, options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const comSpec = env.ComSpec ?? env.COMSPEC ?? process.env.ComSpec ?? process.env.COMSPEC;
  const invocation = buildCommandInvocation(file, args, platform, comSpec);
  const result = spawnSync(invocation.file, invocation.args, {
    cwd: options.cwd,
    env,
    input: options.input,
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    timeout: options.timeout ?? 120_000,
    windowsHide: true,
    shell: false,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function resolveNpmExecutable(env, platform = process.platform) {
  const names = platform === "win32" ? ["npm.cmd", "npm.exe"] : ["npm"];
  const found = resolveExecutableOnPath(names, getPathValue(env), platform, [dirname(process.execPath)]);
  if (!found) throw new Error("npm executable is unavailable");
  return found;
}

function resolveGitExecutable(env, platform = process.platform) {
  const names = platform === "win32" ? ["git.exe", "git.cmd", "git"] : ["git"];
  const found = resolveExecutableOnPath(names, getPathValue(env), platform);
  if (!found) throw new Error("git executable is unavailable");
  return found;
}

function removeTreeWithRetry(target) {
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

/**
 * Publish a staged tarball to its cache path without replacing an existing entry,
 * falling back to an exclusive copy when hard links fail.
 * @param {string} staged
 * @param {string} cached
 * @param {(existingPath: string, newPath: string) => void} [link]
 * @returns {string}
 */
export function publishTarball(staged, cached, link = linkSync) {
  try {
    try {
      link(staged, cached);
    } catch (error) {
      const code = error && typeof error === "object" ? error.code : undefined;
      if (code !== "EEXIST") {
        try {
          copyFileSync(staged, cached, fsConstants.COPYFILE_EXCL);
        } catch (copyError) {
          const copyCode = copyError && typeof copyError === "object" ? copyError.code : undefined;
          if (copyCode !== "EEXIST") throw copyError;
        }
      }
    }
  } finally {
    rmSync(staged, { force: true });
  }
  return cached;
}

/**
 * Pack a Rocky commit into a cached tarball using a temporary detached git worktree.
 * @param {string} commit
 * @param {string} cacheDir
 * @returns {Promise<string>}
 */
export async function packArm(commit, cacheDir) {
  if (typeof commit !== "string" || commit.trim().length === 0) {
    throw new Error("packArm requires a non-empty commit reference");
  }
  if (typeof cacheDir !== "string" || cacheDir.trim().length === 0) {
    throw new Error("packArm requires a non-empty cacheDir");
  }

  const toolEnv = buildToolEnv(process.env, process.platform);
  const git = resolveGitExecutable(toolEnv);
  const npm = resolveNpmExecutable(toolEnv);
  const resolvedCache = resolve(cacheDir);
  mkdirSync(resolvedCache, { recursive: true });

  const rev = runCommand(git, ["rev-parse", "--verify", `${commit}^{commit}`], {
    cwd: REPO_ROOT,
    env: toolEnv,
  });
  if (rev.status !== 0) {
    throw new Error(`Unable to resolve commit ${commit}: ${rev.stderr.trim()}`);
  }
  const sha = rev.stdout.trim();
  const cachedTgz = join(resolvedCache, `rocky-${sha}.tgz`);
  if (existsSync(cachedTgz)) return cachedTgz;

  const unique = `${process.pid}-${randomBytes(4).toString("hex")}`;
  const worktreeDir = join(resolvedCache, `wt-${sha}-${unique}`);
  const packTmpDir = join(resolvedCache, `pack-${sha.slice(0, 12)}-${unique}`);
  const staging = `${cachedTgz}.tmp-${unique}`;

  const add = runCommand(git, ["worktree", "add", "--detach", worktreeDir, sha], {
    cwd: REPO_ROOT,
    env: toolEnv,
  });
  if (add.status !== 0) {
    throw new Error(`git worktree add failed for ${sha}: ${add.stderr.trim()}`);
  }

  try {
    const ci = runCommand(npm, ["ci", "--no-audit", "--no-fund"], {
      cwd: worktreeDir,
      env: toolEnv,
      timeout: 300_000,
    });
    if (ci.status !== 0) {
      throw new Error(`npm ci failed in ${worktreeDir}: ${ci.stderr.trim() || ci.stdout.trim()}`);
    }

    mkdirSync(packTmpDir, { recursive: true });
    const pack = runCommand(npm, ["pack", "--pack-destination", packTmpDir], {
      cwd: worktreeDir,
      env: toolEnv,
      timeout: 180_000,
    });
    if (pack.status !== 0) {
      throw new Error(`npm pack failed in ${worktreeDir}: ${pack.stderr.trim() || pack.stdout.trim()}`);
    }

    const tarballs = readdirSync(packTmpDir).filter((name) => name.endsWith(".tgz"));
    if (tarballs.length !== 1) {
      throw new Error(`Expected 1 tarball from npm pack, found ${tarballs.length}`);
    }
    const produced = join(packTmpDir, tarballs[0]);
    renameSync(produced, staging);
    return publishTarball(staging, cachedTgz);
  } finally {
    rmSync(staging, { force: true });
    removeTreeWithRetry(packTmpDir);
    const removed = runCommand(git, ["worktree", "remove", "--force", worktreeDir], {
      cwd: REPO_ROOT,
      env: toolEnv,
    });
    if (removed.status !== 0 || existsSync(worktreeDir)) {
      removeTreeWithRetry(worktreeDir);
    }
  }
}

/**
 * Create an isolated sandbox directory and environment for one eval arm.
 * @param {{
 *   arm: Arm,
 *   runId: string,
 *   root: string,
 *   tgz?: string,
 *   auth?: SandboxAuth,
 *   platform?: NodeJS.Platform,
 *   exists?: (candidate: string) => boolean,
 *   realpath?: (candidate: string) => string,
 *   env?: Record<string, string | undefined>,
 * }} options
 * @returns {Promise<Sandbox>}
 */
export async function createSandbox({
  arm,
  runId,
  root,
  tgz,
  auth,
  platform = process.platform,
  exists = existsSync,
  realpath = realpathSync.native,
  env = process.env,
}) {
  if (!VALID_ARMS.has(arm)) {
    throw new Error(`Invalid arm: ${String(arm)} (expected none, before, or after)`);
  }
  if (typeof runId !== "string" || runId.length === 0 || /[\\/]/.test(runId) || runId === "." || runId === "..") {
    throw new Error(`Invalid runId: ${String(runId)}`);
  }
  if (typeof root !== "string" || root.length === 0) {
    throw new Error("createSandbox requires a non-empty root directory");
  }

  const resolvedRoot = resolve(root);
  assertNoAncestorInstructions(resolvedRoot, exists, realpath, platform);

  const dir = join(resolvedRoot, runId);
  const home = join(dir, "home");
  const configDir = join(home, ".claude");
  const rockyHome = join(dir, "rocky-home");
  const taskDir = join(dir, "task");
  const prefixDir = join(dir, "prefix");
  const prefixBin = arm === "none"
    ? null
    : (platform === "win32" ? prefixDir : join(prefixDir, "bin"));

  mkdirSync(resolvedRoot, { recursive: true });
  try {
    mkdirSync(dir);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EEXIST") {
      throw new Error(`Sandbox run directory already exists: ${dir}`);
    }
    throw error;
  }

  try {
    mkdirSync(home, { recursive: true });
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    if (platform !== "win32") chmodSync(configDir, 0o700);
    mkdirSync(rockyHome, { recursive: true });
    mkdirSync(taskDir, { recursive: true });

    const sandboxEnv = scrubEnv(env, platform);
    const cleanedPath = stripRockyFromPath(getPathValue(env), platform);
    const sep = platform === "win32" ? ";" : ":";
    const nextPath = prefixBin === null
      ? cleanedPath
      : [prefixBin, cleanedPath].filter(Boolean).join(sep);
    setSinglePath(sandboxEnv, nextPath);

    sandboxEnv.HOME = home;
    sandboxEnv.USERPROFILE = home;
    sandboxEnv.CLAUDE_CONFIG_DIR = configDir;
    sandboxEnv.ROCKY_HOME = rockyHome;

    if (arm === "after") {
      sandboxEnv.ROCKY_TEST_SEAMS = "1";
      sandboxEnv.ROCKY_ATTEMPT_ARM = "shown";
    }

    const secrets = [];
    if (auth !== undefined) {
      if (auth.kind === "token") {
        const token = env.ROCKY_EVAL_OAUTH_TOKEN;
        if (typeof token !== "string" || token.length === 0) {
          throw new Error("Missing ROCKY_EVAL_OAUTH_TOKEN in harness environment");
        }
        sandboxEnv.CLAUDE_CODE_OAUTH_TOKEN = token;
        secrets.push(token);
      } else if (auth.kind === "copy-credentials") {
        if (typeof auth.from !== "string" || auth.from.length === 0) {
          throw new Error("copy-credentials auth requires a 'from' file path");
        }
        if (!existsSync(auth.from) || !lstatSync(auth.from).isFile()) {
          throw new Error(`Credentials file does not exist or is not a file: ${auth.from}`);
        }
        const dest = join(configDir, ".credentials.json");
        copyFileSync(auth.from, dest);
        if (platform !== "win32") chmodSync(dest, 0o600);
      } else {
        throw new Error(`Unsupported auth kind: ${String(auth.kind)}`);
      }
    }

    if (arm === "before" || arm === "after") {
      if (typeof tgz !== "string" || tgz.length === 0 || !existsSync(tgz)) {
        throw new Error(`Arm '${arm}' requires an existing tarball path`);
      }
      mkdirSync(prefixDir, { recursive: true });
      const npm = resolveNpmExecutable(sandboxEnv, platform);
      const npmEnv = { ...sandboxEnv };
      delete npmEnv.CLAUDE_CODE_OAUTH_TOKEN;
      for (const key of Object.keys(npmEnv)) {
        if (key.toUpperCase() === "FORCE_COLOR") delete npmEnv[key];
      }
      npmEnv.NPM_CONFIG_CACHE = join(dir, ".npm-cache");
      npmEnv.npm_config_color = "false";

      const install = runCommand(
        npm,
        ["i", "-g", "--prefix", prefixDir, resolve(tgz), "--no-audit", "--no-fund"],
        { cwd: taskDir, env: npmEnv, platform, timeout: 180_000 },
      );
      if (install.status !== 0) {
        throw new Error(
          redactText(`npm install failed for arm '${arm}': ${install.stderr || install.stdout}`, secrets),
        );
      }

      const rockyShim = platform === "win32"
        ? join(prefixBin, "rocky.cmd")
        : join(prefixBin, "rocky");
      if (!existsSync(rockyShim)) {
        throw new Error(`Installed rocky shim is missing: ${rockyShim}`);
      }

      const runSetupMcp = () => runCommand(
        rockyShim,
        ["setup", "--harness", "claude-code", "--yes"],
        { cwd: taskDir, env: sandboxEnv, platform, timeout: 60_000 },
      );
      // The first `claude mcp list` health probe after a fresh install can miss
      // the cold start of the new package and exit 1 although the registration
      // was written. Setup is idempotent, so one rerun verifies the same entry.
      let setupMcp = runSetupMcp();
      if (setupMcp.status !== 0) setupMcp = runSetupMcp();
      if (setupMcp.status !== 0) {
        throw new Error(
          redactText(
            `rocky setup --harness claude-code --yes failed (exit ${setupMcp.status}): ${setupMcp.stderr || setupMcp.stdout}`,
            secrets,
          ),
        );
      }

      // `rocky setup --agent-hooks` intentionally requires a TTY for consent.
      // Pass a one-shot preload solely to this setup child so the absolute shim
      // accepts "y\n" without polluting sandboxEnv.
      const ttyPreload = join(dir, ".tty-confirm-preload.cjs");
      writeFileSync(
        ttyPreload,
        'Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });\n',
        "utf8",
      );
      try {
        const hookEnv = {
          ...sandboxEnv,
          NODE_OPTIONS: `--require ${JSON.stringify(
            platform === "win32" ? ttyPreload.replaceAll("\\", "/") : ttyPreload,
          )}`,
        };
        const setupHooks = runCommand(
          rockyShim,
          ["setup", "--agent-hooks"],
          { cwd: taskDir, env: hookEnv, input: "y\n", platform, timeout: 60_000 },
        );
        if (setupHooks.status !== 0) {
          throw new Error(
            redactText(
              `rocky setup --agent-hooks failed (exit ${setupHooks.status}): ${setupHooks.stderr || setupHooks.stdout}`,
              secrets,
            ),
          );
        }
      } finally {
        rmSync(ttyPreload, { force: true });
      }
    }

    return {
      dir,
      home,
      configDir,
      rockyHome,
      taskDir,
      prefixBin,
      env: sandboxEnv,
    };
  } catch (error) {
    try {
      removeTreeWithRetry(dir);
    } catch {
      // Preserve the original initialization error.
    }
    throw error;
  }
}

/**
 * Remove a sandbox directory tree.
 * @param {Sandbox} sandbox
 */
export async function destroySandbox(sandbox) {
  if (!sandbox || typeof sandbox.dir !== "string" || sandbox.dir.length === 0) return;
  removeTreeWithRetry(sandbox.dir);
}
