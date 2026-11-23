import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { accept as defaultAccept } from "./accept.mjs";
import { materializeTask as defaultMaterializeTask, renderClaudeMd } from "./history.mjs";
import {
  CLAUDE_FLAGS,
  MODEL,
  assertNoAncestorInstructions,
  assertOutsideWorkspace,
  buildCommandInvocation,
  buildToolEnv,
  createSandbox as defaultCreateSandbox,
  destroySandbox as defaultDestroySandbox,
  packArm as defaultPackArm,
  redactText,
  resolveExecutableOnPath,
} from "./sandbox.mjs";

const EVAL_DIR = resolve(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = resolve(EVAL_DIR, "..", "..");
const MANIFEST_PATH = join(EVAL_DIR, "tasks", "manifest.json");

export const ARMS = ["none", "before", "after"];
export const DEFAULT_K = 5;
export const DEFAULT_SEED = 20261123;
export const DEFAULT_CONCURRENCY = 2;
export const RUN_TIMEOUT_MS = 20 * 60 * 1000;
export const MAX_RETRIES = 2;
export const RETRYABLE_INVALIDS = new Set(["api_error", "harness_crash"]);

const ROCKY_HOME_ALLOWED_FILES = ["memory.jsonl", "advisories.jsonl"];
const KILL_GRACE_MS = 3_000;

const USAGE = [
  "Usage: node scripts/eval/runner.mjs --out <dir> --before <sha> --after <sha>",
  "         --auth <token|copy-credentials> [--from <credentials-path>]",
  "         [--concurrency <n>] [--root <dir>] [--cache <dir>]",
  "         [--k <n>] [--seed <n>] [--only <id1,id2,...>] [--retry-invalid]",
  "",
  "Options:",
  "  --out <dir>            Output directory (must lie outside repo and enclosing workspace)",
  "  --before <sha>         Git commit/ref for the 'before' Rocky arm",
  "  --after <sha>          Git commit/ref for the 'after' Rocky arm",
  "  --auth <mode>          Authentication mode: 'token' (reads ROCKY_EVAL_OAUTH_TOKEN) or 'copy-credentials'",
  "  --from <path>          Credentials file path (required when --auth copy-credentials)",
  `  --concurrency <n>      Concurrent runs (default: ${DEFAULT_CONCURRENCY})`,
  "  --root <dir>           Sandbox root directory (default: <os.tmpdir>/rocky-eval)",
  "  --cache <dir>          Tarball pack cache directory (default: <out>/../pack-cache; must be outside workspace)",
  `  --k <n>                Number of randomized blocks (default: ${DEFAULT_K})`,
  `  --seed <n>             PRNG seed for schedule shuffling (default: ${DEFAULT_SEED})`,
  "  --only <ids>           Comma-separated task IDs to run (default: all manifest tasks except SMOKE)",
  "  --retry-invalid        Re-run existing runs with invalid=api_error or harness_crash (up to 2 retries)",
  "  -h, --help             Show this help message and exit",
].join("\n");

/**
 * Deterministic 32-bit PRNG returning floats in [0, 1).
 * @param {number} seed
 * @returns {() => number}
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleWithRng(items, rng) {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Build an interleaved randomized schedule across `k` blocks.
 * For each block `1..k`, shuffles tasks and then shuffles arms per task.
 * @param {readonly string[]} taskIds
 * @param {readonly string[]} arms
 * @param {number} k
 * @param {number} seed
 * @returns {Array<{ runId: string, taskId: string, arm: string, block: number }>}
 */
export function schedule(taskIds, arms, k, seed) {
  if (!Array.isArray(taskIds)) {
    throw new Error("schedule requires an array of taskIds");
  }
  if (!Array.isArray(arms)) {
    throw new Error("schedule requires an array of arms");
  }
  if (!Number.isInteger(k) || k < 1) {
    throw new Error(`Invalid block count k: ${String(k)}`);
  }
  const rng = mulberry32(seed);
  /** @type {Array<{ runId: string, taskId: string, arm: string, block: number }>} */
  const planned = [];
  for (let block = 1; block <= k; block += 1) {
    const shuffledTasks = shuffleWithRng(taskIds, rng);
    for (const taskId of shuffledTasks) {
      const shuffledArms = shuffleWithRng(arms, rng);
      for (const arm of shuffledArms) {
        planned.push({
          runId: `${taskId}-${arm}-b${block}`,
          taskId,
          arm,
          block,
        });
      }
    }
  }
  return planned;
}

/**
 * Filter manifest tasks. Defaults to all tasks except `SMOKE`.
 * @param {readonly any[]} manifestTasks
 * @param {readonly string[] | null | undefined} onlyIds
 * @returns {any[]}
 */
export function selectTasks(manifestTasks, onlyIds) {
  if (!onlyIds || onlyIds.length === 0) {
    return manifestTasks.filter((task) => task.id !== "SMOKE");
  }
  const byId = new Map(manifestTasks.map((task) => [task.id, task]));
  const selected = [];
  const seen = new Set();
  for (const id of onlyIds) {
    const task = byId.get(id);
    if (!task) {
      throw new Error(`Unknown task ID in --only: ${id}`);
    }
    if (!seen.has(id)) {
      seen.add(id);
      selected.push(task);
    }
  }
  return selected;
}

function containsAnySecret(text, secrets) {
  if (typeof text !== "string" || text.length === 0) return false;
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length > 0 && text.includes(secret)) {
      return true;
    }
  }
  return false;
}

/**
 * Classify a completed Claude subprocess run into `invalid` status or `null`.
 * @param {{
 *   rawStdout: string,
 *   rawStderr: string,
 *   exitCode: number | null,
 *   timedOut: boolean,
 *   secrets?: readonly string[],
 * }} params
 * @returns {null | "api_error" | "timeout" | "transcript_broken" | "token_leak"}
 */
export function classifyOutcome({ rawStdout, rawStderr, timedOut, secrets = [] }) {
  if (containsAnySecret(rawStdout, secrets) || containsAnySecret(rawStderr, secrets)) {
    return "token_leak";
  }
  if (timedOut) {
    return "timeout";
  }
  const lines = String(rawStdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return "transcript_broken";
  }
  let resultEvent = null;
  for (const line of lines) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return "transcript_broken";
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return "transcript_broken";
    }
    if (parsed.type === "result") {
      resultEvent = parsed;
    }
  }
  if (!resultEvent) {
    return "transcript_broken";
  }
  if (
    resultEvent.is_error === true
    || (resultEvent.subtype !== "success" && resultEvent.subtype !== "error_max_turns")
  ) {
    return "api_error";
  }
  return null;
}

function getPathValue(env) {
  if (!env) return "";
  if (typeof env.PATH === "string") return env.PATH;
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH");
  return key === undefined ? "" : (env[key] ?? "");
}

function resolveGitExecutable(env, platform = process.platform) {
  const names = platform === "win32" ? ["git.exe", "git.cmd", "git"] : ["git"];
  const found = resolveExecutableOnPath(names, getPathValue(env), platform);
  if (!found) throw new Error("git executable is unavailable");
  return found;
}

function resolveClaudeExecutable(env, platform = process.platform) {
  const names = platform === "win32" ? ["claude.exe", "claude.cmd", "claude"] : ["claude"];
  const found = resolveExecutableOnPath(names, getPathValue(env), platform);
  if (!found) throw new Error("claude executable not found on PATH");
  return found;
}

function runSyncNoShell(file, args, options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const comSpec = env.ComSpec ?? env.COMSPEC ?? process.env.ComSpec ?? process.env.COMSPEC;
  const invocation = buildCommandInvocation(file, args, platform, comSpec);
  const res = spawnSync(invocation.file, invocation.args, {
    cwd: options.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    timeout: options.timeout ?? 60_000,
    windowsHide: true,
    shell: false,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  if (res.error) throw res.error;
  return {
    status: res.status ?? 1,
    signal: res.signal,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function hardKillProcessTree(child, env, platform = process.platform) {
  const pid = child.pid;
  if (platform === "win32" && typeof pid === "number" && pid > 0) {
    const sysRoot = env?.SystemRoot ?? process.env.SystemRoot ?? process.env.windir;
    const taskkillCandidates = [];
    if (typeof sysRoot === "string" && sysRoot.length > 0) {
      taskkillCandidates.push(join(sysRoot, "System32"));
    }
    const taskkill = resolveExecutableOnPath(
      ["taskkill.exe"],
      getPathValue(env ?? process.env),
      "win32",
      taskkillCandidates,
    );
    if (taskkill) {
      try {
        spawnSync(taskkill, ["/PID", String(pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
          shell: false,
          timeout: 10_000,
        });
      } catch {
        // Fall through to direct kill.
      }
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // Process may already have exited.
  }
}

/**
 * Spawn an external command asynchronously without a shell, collecting stdout/stderr
 * and enforcing a hard timeout kill.
 * @param {{
 *   file: string,
 *   args: readonly string[],
 *   cwd: string,
 *   env: Record<string, string | undefined>,
 *   timeoutMs?: number,
 *   platform?: NodeJS.Platform,
 * }} options
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number | null, signal: NodeJS.Signals | null, timedOut: boolean }>}
 */
export function spawnProcess({
  file,
  args,
  cwd,
  env,
  timeoutMs = RUN_TIMEOUT_MS,
  platform = process.platform,
}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const comSpec = env?.ComSpec ?? env?.COMSPEC ?? process.env.ComSpec ?? process.env.COMSPEC;
    let invocation;
    try {
      invocation = buildCommandInvocation(file, args, platform, comSpec);
    } catch (error) {
      rejectPromise(error);
      return;
    }

    const child = spawn(invocation.file, invocation.args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });

    /** @type {Buffer[]} */
    const stdoutChunks = [];
    /** @type {Buffer[]} */
    const stderrChunks = [];
    let timedOut = false;
    let settled = false;
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

    const settle = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolvePromise({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode,
        signal,
        timedOut,
      });
    };

    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      rejectPromise(error);
    });

    child.on("close", (code, signal) => {
      settle(code, signal);
    });

    if (typeof timeoutMs === "number" && timeoutMs > 0) {
      killTimer = setTimeout(() => {
        timedOut = true;
        hardKillProcessTree(child, env, platform);
        graceTimer = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          settle(null, "SIGKILL");
        }, KILL_GRACE_MS);
        graceTimer.unref?.();
      }, timeoutMs);
      killTimer.unref?.();
    }
  });
}

function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function writeTextAtomic(targetPath, text) {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    writeFileSync(tempPath, text, "utf8");
    renameSync(tempPath, targetPath);
  } finally {
    if (existsSync(tempPath)) {
      rmSync(tempPath, { force: true });
    }
  }
}

function writeJsonAtomic(targetPath, data, secrets) {
  const serialized = redactText(`${JSON.stringify(data, null, 2)}\n`, secrets);
  writeTextAtomic(targetPath, serialized);
}

function removeTreeWithRetry(target) {
  if (!existsSync(target)) return;
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

function copyFinalWithoutGit(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true });
  function walk(currentSrc, currentDest) {
    const entries = readdirSync(currentSrc).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const name of entries) {
      if (name === ".git") continue;
      const srcPath = join(currentSrc, name);
      const destPath = join(currentDest, name);
      const lstat = lstatSync(srcPath);
      if (lstat.isSymbolicLink()) {
        try {
          const targetStat = statSync(srcPath);
          if (targetStat.isFile()) {
            copyFileSync(srcPath, destPath);
          }
        } catch {
          // Skip broken symlinks created during a run.
        }
        continue;
      }
      if (lstat.isDirectory()) {
        mkdirSync(destPath, { recursive: true });
        walk(srcPath, destPath);
      } else if (lstat.isFile()) {
        copyFileSync(srcPath, destPath);
      }
    }
  }
  walk(srcDir, destDir);
}

function copyRockyHomeFiles(srcRockyHome, destRockyHome, arm, secrets) {
  if (arm === "none") return;
  mkdirSync(destRockyHome, { recursive: true });
  for (const name of ROCKY_HOME_ALLOWED_FILES) {
    const srcPath = join(srcRockyHome, name);
    if (!existsSync(srcPath)) continue;
    if (!statSync(srcPath).isFile()) continue;
    const content = redactText(readFileSync(srcPath, "utf8"), secrets);
    writeFileSync(join(destRockyHome, name), content, "utf8");
  }
}

function decideRunAction(runJsonPath, retryInvalid) {
  if (!existsSync(runJsonPath)) {
    return { action: "run", retries: 0 };
  }
  let existing;
  try {
    existing = JSON.parse(readFileSync(runJsonPath, "utf8"));
  } catch {
    return retryInvalid
      ? { action: "run", retries: 1 }
      : { action: "skip", reason: "existing" };
  }
  if (!retryInvalid) {
    return { action: "skip", reason: "existing" };
  }
  if (!RETRYABLE_INVALIDS.has(existing?.invalid)) {
    return { action: "skip", reason: `invalid=${String(existing?.invalid)}` };
  }
  const prevRetries = Number.isInteger(existing?.retries) && existing.retries >= 0
    ? existing.retries
    : 0;
  if (prevRetries >= MAX_RETRIES) {
    return { action: "skip", reason: "max-retries" };
  }
  return { action: "run", retries: prevRetries + 1 };
}

function defaultResolveCommit(ref) {
  const toolEnv = buildToolEnv(process.env, process.platform);
  const git = resolveGitExecutable(toolEnv, process.platform);
  const res = runSyncNoShell(git, ["rev-parse", "--verify", `${ref}^{commit}`], {
    cwd: REPO_ROOT,
    env: toolEnv,
  });
  if (res.status !== 0) {
    throw new Error(`Unable to resolve commit ${ref}: ${res.stderr.trim() || res.stdout.trim()}`);
  }
  return res.stdout.trim();
}

function defaultGetHeadCommit() {
  const toolEnv = buildToolEnv(process.env, process.platform);
  const git = resolveGitExecutable(toolEnv, process.platform);
  const res = runSyncNoShell(git, ["rev-parse", "HEAD"], {
    cwd: REPO_ROOT,
    env: toolEnv,
  });
  if (res.status !== 0) {
    throw new Error(`Unable to resolve HEAD: ${res.stderr.trim() || res.stdout.trim()}`);
  }
  return res.stdout.trim();
}

function defaultGetClaudeVersion() {
  const toolEnv = buildToolEnv(process.env, process.platform);
  const claudeExe = resolveClaudeExecutable(toolEnv, process.platform);
  const res = runSyncNoShell(claudeExe, ["--version"], {
    cwd: REPO_ROOT,
    env: toolEnv,
    timeout: 30_000,
  });
  if (res.status !== 0) {
    throw new Error(`claude --version failed (exit ${res.status}): ${res.stderr.trim() || res.stdout.trim()}`);
  }
  return (res.stdout.trim() || res.stderr.trim() || "(unavailable)");
}

async function defaultRunClaude({ task, sandbox, timeoutMs }) {
  const claudeExe = resolveClaudeExecutable(sandbox.env, process.platform);
  return spawnProcess({
    file: claudeExe,
    args: [...CLAUDE_FLAGS, task.prompt],
    cwd: sandbox.taskDir,
    env: sandbox.env,
    timeoutMs,
  });
}

async function runWithConcurrency(items, concurrency, worker) {
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const idx = nextIndex;
      nextIndex += 1;
      if (idx >= items.length) break;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

/**
 * Execute an interleaved eval batch.
 * @param {{
 *   outDir: string,
 *   rootDir: string,
 *   cacheDir: string,
 *   beforeRef: string,
 *   afterRef: string,
 *   auth: { kind: "token" } | { kind: "copy-credentials", from: string },
 *   secrets?: readonly string[],
 *   concurrency?: number,
 *   k?: number,
 *   seed?: number,
 *   only?: readonly string[] | null,
 *   retryInvalid?: boolean,
 *   timeoutMs?: number,
 * }} options
 * @param {Partial<{
 *   manifest: any,
 *   resolveCommit: (ref: string) => string,
 *   getHeadCommit: () => string,
 *   getClaudeVersion: () => string,
 *   packArm: typeof defaultPackArm,
 *   createSandbox: typeof defaultCreateSandbox,
 *   materializeTask: typeof defaultMaterializeTask,
 *   runClaude: (args: { runId: string, task: any, sandbox: any, timeoutMs: number }) => Promise<{ stdout: string, stderr: string, exitCode: number | null, timedOut: boolean }>,
 *   accept: typeof defaultAccept,
 *   destroySandbox: typeof defaultDestroySandbox,
 *   assertRootClean: (dir: string) => void,
 *   log: (line: string) => void,
 * }>} [overrides]
 */
export async function runBatch(options, overrides = {}) {
  const deps = {
    manifest: overrides.manifest ?? JSON.parse(readFileSync(MANIFEST_PATH, "utf8")),
    resolveCommit: overrides.resolveCommit ?? defaultResolveCommit,
    getHeadCommit: overrides.getHeadCommit ?? defaultGetHeadCommit,
    getClaudeVersion: overrides.getClaudeVersion ?? defaultGetClaudeVersion,
    packArm: overrides.packArm ?? defaultPackArm,
    createSandbox: overrides.createSandbox ?? defaultCreateSandbox,
    materializeTask: overrides.materializeTask ?? defaultMaterializeTask,
    runClaude: overrides.runClaude ?? defaultRunClaude,
    accept: overrides.accept ?? defaultAccept,
    destroySandbox: overrides.destroySandbox ?? defaultDestroySandbox,
    assertRootClean: overrides.assertRootClean ?? ((dir) => assertNoAncestorInstructions(dir)),
    log: overrides.log ?? ((line) => process.stderr.write(`${line}\n`)),
  };

  const secrets = options.secrets ?? [];
  const redact = (value) => redactText(value, secrets);
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const k = options.k ?? DEFAULT_K;
  const seed = options.seed ?? DEFAULT_SEED;
  const timeoutMs = options.timeoutMs ?? RUN_TIMEOUT_MS;
  const retryInvalid = Boolean(options.retryInvalid);

  const outDir = resolve(options.outDir);
  const rootDir = resolve(options.rootDir);
  const cacheDir = resolve(options.cacheDir);

  deps.assertRootClean(rootDir);

  const selectedTasks = selectTasks(deps.manifest.tasks, options.only);
  const taskById = new Map(selectedTasks.map((task) => [task.id, task]));
  const taskIds = selectedTasks.map((task) => task.id);
  const planned = schedule(taskIds, ARMS, k, seed);

  const beforeSha = deps.resolveCommit(options.beforeRef);
  const afterSha = deps.resolveCommit(options.afterRef);
  const evaluatorCommit = deps.getHeadCommit();
  const claudeVersion = redact(deps.getClaudeVersion());

  const claudeMdSha256 = {
    none: sha256Text(renderClaudeMd("none")),
    before: sha256Text(renderClaudeMd("before")),
    after: sha256Text(renderClaudeMd("after")),
  };

  const runsDir = join(outDir, "runs");
  mkdirSync(runsDir, { recursive: true });

  const batchPath = join(outDir, "batch.json");
  if (!existsSync(batchPath)) {
    const provenance = {
      v: 1,
      startedAt: new Date().toISOString(),
      claudeVersion,
      model: MODEL,
      claudeFlags: [...CLAUDE_FLAGS],
      beforeRef: options.beforeRef,
      afterRef: options.afterRef,
      beforeSha,
      afterSha,
      evaluatorCommit,
      taskSetSha256: deps.manifest.taskSetSha256,
      claudeMdSha256,
      seed,
      k,
      concurrency,
      arms: [...ARMS],
      taskIds,
      auth: options.auth.kind,
    };
    writeJsonAtomic(batchPath, provenance, secrets);
  }

  /** @type {Array<{ item: typeof planned[number], retries: number }>} */
  const pending = [];
  for (const item of planned) {
    const runJsonPath = join(runsDir, item.runId, "run.json");
    const decision = decideRunAction(runJsonPath, retryInvalid);
    if (decision.action === "run") {
      pending.push({ item, retries: decision.retries });
    }
  }

  const skipped = planned.length - pending.length;
  if (pending.length === 0) {
    deps.log(redact(`[eval] 0 runs to execute (${skipped} skipped).`));
    return { batchPath, total: planned.length, ran: 0, skipped };
  }

  // Pack both Rocky arms once, sequentially, before any run starts.
  const beforeTgz = await deps.packArm(beforeSha, cacheDir);
  const afterTgz = await deps.packArm(afterSha, cacheDir);
  const tarballs = {
    none: undefined,
    before: beforeTgz,
    after: afterTgz,
  };

  let completed = 0;
  await runWithConcurrency(pending, concurrency, async ({ item, retries }) => {
    const task = taskById.get(item.taskId);
    const runDir = join(runsDir, item.runId);
    const runJsonPath = join(runDir, "run.json");
    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    const sandboxRunId = `${item.runId}-${randomBytes(3).toString("hex")}`;

    let sandbox = null;
    /** @type {number | null} */
    let exitCode = null;
    let timedOut = false;
    /** @type {{ solved: boolean, reason: string } | null} */
    let acceptResult = null;

    try {
      removeTreeWithRetry(runDir);
      mkdirSync(runDir, { recursive: true });

      sandbox = await deps.createSandbox({
        arm: item.arm,
        runId: sandboxRunId,
        root: rootDir,
        tgz: tarballs[item.arm],
        auth: options.auth,
      });

      await deps.materializeTask(task, sandbox, item.arm);

      const claudeRes = await deps.runClaude({
        runId: item.runId,
        task,
        sandbox,
        timeoutMs,
      });
      exitCode = claudeRes.exitCode ?? null;
      timedOut = Boolean(claudeRes.timedOut);

      writeFileSync(join(runDir, "transcript.jsonl"), redact(claudeRes.stdout), "utf8");
      writeFileSync(join(runDir, "stderr.txt"), redact(claudeRes.stderr), "utf8");

      const invalid = classifyOutcome({
        rawStdout: claudeRes.stdout,
        rawStderr: claudeRes.stderr,
        exitCode,
        timedOut,
        secrets,
      });

      const finalDir = join(runDir, "final");
      copyFinalWithoutGit(sandbox.taskDir, finalDir);
      copyRockyHomeFiles(sandbox.rockyHome, join(runDir, "rocky-home"), item.arm, secrets);

      acceptResult = await deps.accept(task, finalDir, { manifest: deps.manifest });

      const record = {
        runId: item.runId,
        taskId: item.taskId,
        arm: item.arm,
        block: item.block,
        startedAt,
        wallMs: Math.max(0, Date.now() - startMs),
        exitCode,
        timedOut,
        invalid,
        accept: acceptResult,
        retries,
      };
      writeJsonAtomic(runJsonPath, record, secrets);
      completed += 1;
      deps.log(
        redact(
          `[eval ${completed}/${pending.length}] ${item.runId}: solved=${acceptResult.solved} invalid=${String(invalid)} (${record.wallMs}ms)`,
        ),
      );
    } catch (error) {
      const errorMessage = redact(error instanceof Error ? error.message : String(error));
      mkdirSync(runDir, { recursive: true });
      const record = {
        runId: item.runId,
        taskId: item.taskId,
        arm: item.arm,
        block: item.block,
        startedAt,
        wallMs: Math.max(0, Date.now() - startMs),
        exitCode,
        timedOut,
        invalid: "harness_crash",
        error: errorMessage,
        accept: acceptResult,
        retries,
      };
      writeJsonAtomic(runJsonPath, record, secrets);
      completed += 1;
      deps.log(
        redact(
          `[eval ${completed}/${pending.length}] ${item.runId}: invalid=harness_crash (${errorMessage})`,
        ),
      );
    } finally {
      if (sandbox) {
        try {
          await deps.destroySandbox(sandbox);
        } catch (cleanupError) {
          const msg = redact(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
          deps.log(`[eval] warning: destroySandbox failed for ${item.runId}: ${msg}`);
        }
      }
    }
  });

  return { batchPath, total: planned.length, ran: pending.length, skipped };
}

function usageError(message) {
  process.stderr.write(`Error: ${message}\n`);
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}

function parsePositiveInt(raw, flagName) {
  if (!/^\d+$/.test(raw)) {
    usageError(`${flagName} must be a positive integer (got ${raw})`);
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 1) {
    usageError(`${flagName} must be a positive integer (got ${raw})`);
  }
  return value;
}

function parseIntStrict(raw, flagName) {
  if (!/^-?\d+$/.test(raw)) {
    usageError(`${flagName} must be an integer (got ${raw})`);
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value)) {
    usageError(`${flagName} must be a safe integer (got ${raw})`);
  }
  return value;
}

function parseArgs(argv) {
  const opts = {
    help: false,
    out: undefined,
    root: join(tmpdir(), "rocky-eval"),
    cache: undefined,
    before: undefined,
    after: undefined,
    auth: undefined,
    from: undefined,
    concurrency: DEFAULT_CONCURRENCY,
    k: DEFAULT_K,
    seed: DEFAULT_SEED,
    /** @type {string[] | null} */
    only: null,
    retryInvalid: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
      return opts;
    }
    if (arg === "--retry-invalid") {
      opts.retryInvalid = true;
      continue;
    }
    const next = argv[i + 1];
    const takeValue = (flag) => {
      if (next === undefined || next.startsWith("--")) {
        usageError(`${flag} requires a value`);
      }
      i += 1;
      return next;
    };

    if (arg === "--out") opts.out = takeValue("--out");
    else if (arg === "--root") opts.root = takeValue("--root");
    else if (arg === "--cache") opts.cache = takeValue("--cache");
    else if (arg === "--before") opts.before = takeValue("--before");
    else if (arg === "--after") opts.after = takeValue("--after");
    else if (arg === "--auth") opts.auth = takeValue("--auth");
    else if (arg === "--from") opts.from = takeValue("--from");
    else if (arg === "--concurrency") opts.concurrency = parsePositiveInt(takeValue("--concurrency"), "--concurrency");
    else if (arg === "--k") opts.k = parsePositiveInt(takeValue("--k"), "--k");
    else if (arg === "--seed") opts.seed = parseIntStrict(takeValue("--seed"), "--seed");
    else if (arg === "--only") {
      const raw = takeValue("--only");
      const ids = raw.split(",").map((part) => part.trim()).filter(Boolean);
      if (ids.length === 0) {
        usageError("--only requires at least one task ID");
      }
      opts.only = opts.only ? [...opts.only, ...ids] : ids;
    } else {
      usageError(`Unknown option: ${arg}`);
    }
  }

  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  if (!opts.out) {
    usageError("--out <dir> is required");
  }
  const outDir = resolve(opts.out);
  try {
    assertOutsideWorkspace(outDir, REPO_ROOT);
  } catch (error) {
    usageError(error instanceof Error ? error.message : String(error));
  }

  const cacheDir = opts.cache ? resolve(opts.cache) : resolve(outDir, "..", "pack-cache");
  try {
    assertOutsideWorkspace(cacheDir, REPO_ROOT);
  } catch (error) {
    usageError(error instanceof Error ? error.message : String(error));
  }

  if (!opts.before) {
    usageError("--before <sha> is required");
  }
  if (!opts.after) {
    usageError("--after <sha> is required");
  }
  if (opts.auth !== "token" && opts.auth !== "copy-credentials") {
    usageError("--auth must be 'token' or 'copy-credentials'");
  }
  if (opts.auth === "copy-credentials" && !opts.from) {
    usageError("--from <credentials-path> is required when --auth copy-credentials is used");
  }
  if (opts.auth === "token" && opts.from) {
    usageError("--from is only valid when --auth copy-credentials is used");
  }

  const secrets = [];
  /** @type {{ kind: "token" } | { kind: "copy-credentials", from: string }} */
  let auth;
  if (opts.auth === "token") {
    const token = process.env.ROCKY_EVAL_OAUTH_TOKEN;
    if (typeof token !== "string" || token.length === 0) {
      process.stderr.write(
        "Error: ROCKY_EVAL_OAUTH_TOKEN is missing or empty in environment (required for --auth token).\n",
      );
      process.exit(2);
    }
    secrets.push(token);
    auth = { kind: "token" };
  } else {
    const fromPath = resolve(opts.from);
    if (!existsSync(fromPath) || !lstatSync(fromPath).isFile()) {
      usageError(`Credentials file does not exist or is not a file: ${fromPath}`);
    }
    auth = { kind: "copy-credentials", from: fromPath };
  }

  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  try {
    selectTasks(manifest.tasks, opts.only);
  } catch (error) {
    usageError(error instanceof Error ? error.message : String(error));
  }

  const rootDir = resolve(opts.root);
  try {
    assertNoAncestorInstructions(rootDir);
  } catch (error) {
    usageError(error instanceof Error ? error.message : String(error));
  }

  try {
    await runBatch(
      {
        outDir,
        rootDir,
        cacheDir,
        beforeRef: opts.before,
        afterRef: opts.after,
        auth,
        secrets,
        concurrency: opts.concurrency,
        k: opts.k,
        seed: opts.seed,
        only: opts.only,
        retryInvalid: opts.retryInvalid,
      },
      { manifest },
    );
  } catch (error) {
    const msg = redactText(error instanceof Error ? (error.stack ?? error.message) : String(error), secrets);
    process.stderr.write(`${msg}\n`);
    process.exitCode = 1;
  }
}

export function isMainModule(
  argv1 = process.argv[1],
  metaUrl = import.meta.url,
  realpath = realpathSync.native,
) {
  if (!argv1) return false;
  try {
    return realpath(resolve(argv1)) === realpath(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  await main();
}
