import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeLine } from "../../dist/core/fingerprint.js";
import { canonicalPath } from "../../dist/core/memory-read.js";
import { validateCard } from "../../dist/desk/cards-record.js";
import { cardsFilePath } from "../../dist/listening/cards-path.js";
import {
  buildCommandInvocation,
  buildToolEnv,
  resolveExecutableOnPath,
} from "./sandbox.mjs";

const EVAL_DIR = resolve(dirname(fileURLToPath(import.meta.url)));
const TASKS_DIR = join(EVAL_DIR, "tasks");
const CLAUDE_MD_DIR = join(EVAL_DIR, "fixtures", "claude-md");
const GIT_CONFIG_ENV_RE = /^GIT_CONFIG_(?:PARAMETERS|COUNT|GLOBAL|SYSTEM|(?:KEY|VALUE)_\d+)$/i;

// Keep consecutive failed command steps strictly beyond the 5 s card-join
// post-window so each failure matches its own command step unambiguously.
const FAILURE_STEP_GAP_MS = 5_150;
const STEP_ORDER_GAP_MS = 10;

const FIXED_GIT_AUTHOR_ENV = {
  GIT_AUTHOR_NAME: "eval",
  GIT_COMMITTER_NAME: "eval",
  GIT_AUTHOR_EMAIL: "eval@example.invalid",
  GIT_COMMITTER_EMAIL: "eval@example.invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

function sleepMs(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function getPathValue(env) {
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

function runSubprocess(file, args, options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const comSpec = env.ComSpec ?? env.COMSPEC ?? process.env.ComSpec ?? process.env.COMSPEC;
  const invocation = buildCommandInvocation(file, args, platform, comSpec);
  const result = spawnSync(invocation.file, invocation.args, {
    cwd: options.cwd,
    env,
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

function removeEntryWithRetry(target) {
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
 * Remove all entries inside `dir` while leaving `dir` itself intact.
 * @param {string} dir
 */
export function wipeDirContents(dir) {
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(dir)) {
    removeEntryWithRetry(join(dir, name));
  }
}

/**
 * Recursively copy files from `srcDir` into `destDir` and return sorted repo-relative POSIX paths.
 * @param {string} srcDir
 * @param {string} destDir
 * @returns {string[]}
 */
export function copyTree(srcDir, destDir) {
  if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) {
    throw new Error(`Source directory does not exist: ${srcDir}`);
  }
  mkdirSync(destDir, { recursive: true });
  /** @type {string[]} */
  const copied = [];

  function walk(currentSrc, currentDest, relPrefix) {
    const entries = readdirSync(currentSrc).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const name of entries) {
      const srcPath = join(currentSrc, name);
      const destPath = join(currentDest, name);
      const rel = relPrefix ? `${relPrefix}/${name}` : name;
      if (statSync(srcPath).isDirectory()) {
        mkdirSync(destPath, { recursive: true });
        walk(srcPath, destPath, rel);
      } else {
        mkdirSync(dirname(destPath), { recursive: true });
        copyFileSync(srcPath, destPath);
        copied.push(rel);
      }
    }
  }

  walk(srcDir, destDir, "");
  return copied;
}

/**
 * Check whether `stderr` contains a line matching `trapLine` under `normalizeLine`.
 * @param {string} stderr
 * @param {string} trapLine
 * @returns {boolean}
 */
export function stderrHasTrapLine(stderr, trapLine) {
  const target = normalizeLine(trapLine);
  if (target.length === 0) return false;
  return String(stderr ?? "")
    .split(/\r?\n/)
    .some((line) => normalizeLine(line).includes(target));
}

/**
 * Render the CLAUDE.md text for an eval arm.
 * @param {"none" | "before" | "after"} arm
 * @returns {string}
 */
export function renderClaudeMd(arm) {
  const base = readFileSync(join(CLAUDE_MD_DIR, "base.md"), "utf8").trimEnd();
  if (arm === "none") return `${base}\n`;
  if (arm === "before" || arm === "after") {
    const rocky = readFileSync(join(CLAUDE_MD_DIR, "rocky-section.md"), "utf8").trimEnd();
    return `${base}\n\n${rocky}\n`;
  }
  throw new Error(`Invalid arm for CLAUDE.md: ${String(arm)}`);
}

function buildHistoryRockyEnv(sandbox) {
  const env = { ...sandbox.env };
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === "FORCE_COLOR" || GIT_CONFIG_ENV_RE.test(key)) {
      delete env[key];
    }
  }
  env.npm_config_color = "false";
  // History replay populates memory without triggering advisory cooldown or
  // writing pre-run rows to advisories.jsonl.
  env.ROCKY_ATTEMPT_ADVISORY = "off";
  return env;
}

function buildHistoryCard({
  cardId,
  root,
  prompt,
  editedFiles,
  editStartMs,
  editEndMs,
  cmd,
  ok,
  exitCode,
  cmdStartMs,
  cmdEndMs,
}) {
  const blocks = editedFiles.map((filePath, index) => ({
    seq: index + 1,
    path: filePath,
    symbol: null,
    labels: [{ id: "body_changed", args: {} }],
    importance: "medium",
    via: "edit",
    tool_use_ids: [`${cardId}-edit-${index + 1}`],
    bash: null,
    before: null,
    after: null,
    recorded: true,
    line: 1,
    added: 1,
    removed: 0,
  }));

  const flow = [
    ...editedFiles.map((_filePath, index) => ({
      kind: "edit",
      text: "edit",
      ok: true,
      dur_ms: Math.max(1, editEndMs - editStartMs),
      seqs: [index + 1],
      start_ms: editStartMs,
      end_ms: editEndMs,
    })),
    {
      kind: "cmd",
      text: cmd,
      ok,
      dur_ms: Math.max(1, cmdEndMs - cmdStartMs),
      seqs: [],
      exit_code: exitCode,
      start_ms: cmdStartMs,
      end_ms: cmdEndMs,
      cwd: root,
    },
  ];

  const card = {
    v: 1,
    card_id: cardId,
    rev: 1,
    repo_id: "eval-history",
    root,
    main_root: null,
    branch: "main",
    agent_id: "",
    agent_type: "",
    parent_card_id: null,
    started_ms: editedFiles.length > 0 ? editStartMs : cmdStartMs,
    ended_ms: cmdEndMs,
    status: "done",
    prompt,
    prompt_truncated: false,
    importance: "medium",
    blocks,
    more_count: 0,
    flow,
    flow_more: 0,
    outside_count: 0,
    coverage: { state: "complete", reasons: [] },
  };

  if (!validateCard(card)) {
    throw new Error(`Constructed history card failed validateCard: ${cardId}`);
  }
  return card;
}

function appendCard(logPath, card) {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${JSON.stringify(card)}\n`, "utf8");
}

function initSeedRepo(taskDir, sandbox, claudeMd) {
  if (typeof claudeMd === "string") {
    writeFileSync(join(taskDir, "CLAUDE.md"), claudeMd, "utf8");
  }
  const gitEnv = {
    ...buildToolEnv(sandbox.env, process.platform, { home: sandbox.home }),
    ...FIXED_GIT_AUTHOR_ENV,
  };
  const git = resolveGitExecutable(gitEnv, process.platform);

  const init = runSubprocess(git, ["init", "-b", "main"], { cwd: taskDir, env: gitEnv });
  if (init.status !== 0) {
    throw new Error(`git init failed in ${taskDir}: ${init.stderr || init.stdout}`);
  }
  const add = runSubprocess(git, ["add", "-A"], { cwd: taskDir, env: gitEnv });
  if (add.status !== 0) {
    throw new Error(`git add -A failed in ${taskDir}: ${add.stderr || add.stdout}`);
  }
  const commit = runSubprocess(git, ["commit", "-m", "initial"], { cwd: taskDir, env: gitEnv });
  if (commit.status !== 0) {
    throw new Error(`git commit failed in ${taskDir}: ${commit.stderr || commit.stdout}`);
  }
}

/**
 * Replay a task's prior failure/fix history inside a sandbox with Rocky installed,
 * then reset `sandbox.taskDir` to a fresh git repository copied from `repo/`.
 * @param {any} task
 * @param {any} sandbox
 * @param {{ claudeMd?: string }} [options]
 * @returns {Promise<{ runs: Array<{ cmd: string, exit: number }>, cards: number }>}
 */
export async function runHistory(task, sandbox, options = {}) {
  if (!task || !task.history) {
    throw new Error(`runHistory requires a task with non-null history: ${task?.id ?? "unknown"}`);
  }
  if (!sandbox || typeof sandbox.prefixBin !== "string" || sandbox.prefixBin.length === 0) {
    throw new Error("runHistory requires a sandbox with Rocky installed");
  }

  const rockyShim = process.platform === "win32"
    ? join(sandbox.prefixBin, "rocky.cmd")
    : join(sandbox.prefixBin, "rocky");
  if (!existsSync(rockyShim)) {
    throw new Error(`Rocky shim is missing in sandbox: ${rockyShim}`);
  }

  const fixtureDir = join(TASKS_DIR, task.fixture);
  const initialSource = task.kind === "stale"
    ? join(fixtureDir, "history-repo")
    : join(fixtureDir, "repo");
  const repoDir = join(fixtureDir, "repo");
  const cmd = task.target.command;

  wipeDirContents(sandbox.taskDir);
  copyTree(initialSource, sandbox.taskDir);

  const canonicalRoot = canonicalPath(realpathSync.native(sandbox.taskDir));
  const cardsPath = cardsFilePath(canonicalRoot, sandbox.rockyHome);
  const rockyEnv = buildHistoryRockyEnv(sandbox);
  const nonce = randomBytes(4).toString("hex");

  /** @type {Array<{ cmd: string, exit: number }>} */
  const runs = [];
  let cards = 0;
  let cardIndex = 0;

  const nextCardId = () => {
    cardIndex += 1;
    return `eval-${task.id.toLowerCase()}-${nonce}-${cardIndex}`;
  };

  // Initial failing run on history state.
  const initStart = Date.now();
  const initRes = runSubprocess(rockyShim, ["run", cmd], {
    cwd: sandbox.taskDir,
    env: rockyEnv,
  });
  const initEnd = Date.now();
  runs.push({ cmd, exit: initRes.status });
  if (initRes.status === 0 || !stderrHasTrapLine(initRes.stderr, task.trapLine)) {
    throw new Error(
      `History initial run for ${task.id} did not fail with expected trap line "${task.trapLine}" (exit ${initRes.status}): ${initRes.stderr}`,
    );
  }
  appendCard(
    cardsPath,
    buildHistoryCard({
      cardId: nextCardId(),
      root: canonicalRoot,
      prompt: task.prompt,
      editedFiles: [],
      editStartMs: initStart,
      editEndMs: initStart,
      cmd,
      ok: false,
      exitCode: initRes.status,
      cmdStartMs: initStart,
      cmdEndMs: initEnd,
    }),
  );
  cards += 1;
  let lastFailedEndMs = initEnd;

  // Replay each wrong overlay; keep failed steps separated beyond the join window.
  for (const wrongName of task.history.wrong) {
    const waitMs = (lastFailedEndMs + FAILURE_STEP_GAP_MS) - Date.now();
    await sleepMs(waitMs);

    const editStart = Date.now();
    const editedFiles = copyTree(join(fixtureDir, "patches", wrongName), sandbox.taskDir);
    const editEnd = Date.now();
    if (editedFiles.length === 0) {
      throw new Error(`Overlay ${wrongName} for ${task.id} contains no files`);
    }

    await sleepMs(STEP_ORDER_GAP_MS);
    const cmdStart = Date.now();
    const res = runSubprocess(rockyShim, ["run", cmd], {
      cwd: sandbox.taskDir,
      env: rockyEnv,
    });
    const cmdEnd = Date.now();
    runs.push({ cmd, exit: res.status });
    if (res.status === 0 || !stderrHasTrapLine(res.stderr, task.trapLine)) {
      throw new Error(
        `History overlay ${wrongName} for ${task.id} did not fail with expected trap line "${task.trapLine}" (exit ${res.status}): ${res.stderr}`,
      );
    }

    appendCard(
      cardsPath,
      buildHistoryCard({
        cardId: nextCardId(),
        root: canonicalRoot,
        prompt: task.prompt,
        editedFiles,
        editStartMs: editStart,
        editEndMs: editEnd,
        cmd,
        ok: false,
        exitCode: res.status,
        cmdStartMs: cmdStart,
        cmdEndMs: cmdEnd,
      }),
    );
    cards += 1;
    lastFailedEndMs = cmdEnd;
  }

  // Apply the history fix overlay and record the passing run.
  await sleepMs(STEP_ORDER_GAP_MS);
  const fixEditStart = Date.now();
  const fixFiles = copyTree(join(fixtureDir, "patches", task.history.fix), sandbox.taskDir);
  const fixEditEnd = Date.now();
  if (fixFiles.length === 0) {
    throw new Error(`Fix overlay ${task.history.fix} for ${task.id} contains no files`);
  }

  await sleepMs(STEP_ORDER_GAP_MS);
  const fixCmdStart = Date.now();
  const fixRes = runSubprocess(rockyShim, ["run", cmd], {
    cwd: sandbox.taskDir,
    env: rockyEnv,
  });
  const fixCmdEnd = Date.now();
  runs.push({ cmd, exit: fixRes.status });
  if (fixRes.status !== 0) {
    throw new Error(
      `History fix overlay ${task.history.fix} for ${task.id} failed (exit ${fixRes.status}): ${fixRes.stderr || fixRes.stdout}`,
    );
  }

  appendCard(
    cardsPath,
    buildHistoryCard({
      cardId: nextCardId(),
      root: canonicalRoot,
      prompt: task.prompt,
      editedFiles: fixFiles,
      editStartMs: fixEditStart,
      editEndMs: fixEditEnd,
      cmd,
      ok: true,
      exitCode: 0,
      cmdStartMs: fixCmdStart,
      cmdEndMs: fixCmdEnd,
    }),
  );
  cards += 1;

  // Reset taskDir to repo/ and create the initial git commit.
  wipeDirContents(sandbox.taskDir);
  copyTree(repoDir, sandbox.taskDir);
  initSeedRepo(sandbox.taskDir, sandbox, options.claudeMd);

  return { runs, cards };
}

/**
 * Materialize a task repository into `sandbox.taskDir` for the given arm.
 * Tasks with history replay it first in arms `before` and `after`.
 * @param {any} task
 * @param {any} sandbox
 * @param {"none" | "before" | "after"} arm
 * @returns {Promise<{ runs: Array<{ cmd: string, exit: number }>, cards: number }>}
 */
export async function materializeTask(task, sandbox, arm) {
  const claudeMd = renderClaudeMd(arm);
  if (task.history !== null && (arm === "before" || arm === "after")) {
    return runHistory(task, sandbox, { claudeMd });
  }

  const repoDir = join(TASKS_DIR, task.fixture, "repo");
  wipeDirContents(sandbox.taskDir);
  copyTree(repoDir, sandbox.taskDir);
  initSeedRepo(sandbox.taskDir, sandbox, claudeMd);
  return { runs: [], cards: 0 };
}
