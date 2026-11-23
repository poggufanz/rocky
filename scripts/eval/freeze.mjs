import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { fingerprint, normalizeLine } from "../../dist/core/fingerprint.js";
import {
  accept,
  buildAcceptEnv,
  prepareAcceptTempDir,
  runTargetCommand,
  stdoutHasAcceptLine,
} from "./accept.mjs";
import { copyTree, stderrHasTrapLine } from "./history.mjs";
import {
  buildCommandInvocation,
  buildToolEnv,
  resolveExecutableOnPath,
} from "./sandbox.mjs";

const EVAL_DIR = resolve(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = resolve(EVAL_DIR, "..", "..");
const TASKS_DIR = join(EVAL_DIR, "tasks");
const TASKS_JSON_PATH = join(TASKS_DIR, "tasks.json");
const MANIFEST_PATH = join(TASKS_DIR, "manifest.json");

const ERROR_SIGNAL_RE = /error|exception|fail|fatal|cannot|unable|not found|missing|denied|refused|invalid|unexpected|undefined|panic|traceback/i;
const VALID_KINDS = new Set(["trap", "control", "stale", "smoke"]);
export const TASK_SETS = ["v1", "v2"];
const VALID_SETS = new Set(TASK_SETS);

function sortCodePoint(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sha256Buffer(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function formatTasksJsonValue(value, depth = 0) {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.every((item) => typeof item !== "object" || item === null)) {
      return `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
    }
    const pad = "  ".repeat(depth + 1);
    const closePad = "  ".repeat(depth);
    return `[\n${value.map((item) => `${pad}${formatTasksJsonValue(item, depth + 1)}`).join(",\n")}\n${closePad}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) return "{}";
    const pad = "  ".repeat(depth + 1);
    const closePad = "  ".repeat(depth);
    const entries = keys.map(
      (key) => `${pad}${JSON.stringify(key)}: ${formatTasksJsonValue(value[key], depth + 1)}`,
    );
    return `{\n${entries.join(",\n")}\n${closePad}}`;
  }
  return JSON.stringify(value);
}

export function serializeTasksJson(tasks) {
  return `${formatTasksJsonValue(tasks, 0)}\n`;
}

export function computeTaskSetSha256(setName, rawTasks, diskFiles, files) {
  const setTasks = rawTasks
    .filter((task) => task.set === setName)
    .map(({ set: _set, ...rest }) => rest);
  const setFixtures = new Set(setTasks.map((task) => task.fixture));
  const setTasksJsonHash = sha256Buffer(Buffer.from(serializeTasksJson(setTasks), "utf8"));
  const setFiles = diskFiles.filter((rel) => {
    if (rel === ".gitignore" || rel === "tasks.json") return true;
    const slashIdx = rel.indexOf("/");
    if (slashIdx === -1) return false;
    const topDir = rel.slice(0, slashIdx);
    return setFixtures.has(topDir);
  });
  const hashLines = setFiles
    .map((rel) => `${rel}\t${rel === "tasks.json" ? setTasksJsonHash : files[rel]}\n`)
    .join("");
  return sha256Buffer(Buffer.from(hashLines, "utf8"));
}

function getPathValue(env) {
  if (typeof env.PATH === "string") return env.PATH;
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH");
  return key === undefined ? "" : (env[key] ?? "");
}

function runGit(args, env) {
  const names = process.platform === "win32" ? ["git.exe", "git.cmd", "git"] : ["git"];
  const git = resolveExecutableOnPath(names, getPathValue(env), process.platform);
  if (!git) throw new Error("git executable is unavailable");
  const comSpec = env.ComSpec ?? env.COMSPEC ?? process.env.ComSpec ?? process.env.COMSPEC;
  const invocation = buildCommandInvocation(git, args, process.platform, comSpec);
  const res = spawnSync(invocation.file, invocation.args, {
    cwd: REPO_ROOT,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60_000,
    windowsHide: true,
    shell: false,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (exit ${res.status}): ${res.stderr || res.stdout}`);
  }
  return res.stdout;
}

function listDiskFilesUnderTasks() {
  /** @type {string[]} */
  const out = [];
  function walk(dir, prefix) {
    const entries = readdirSync(dir).sort(sortCodePoint);
    for (const name of entries) {
      const full = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (rel === "manifest.json") continue;
      if (statSync(full).isDirectory()) {
        walk(full, rel);
      } else {
        out.push(rel);
      }
    }
  }
  walk(TASKS_DIR, "");
  return out.sort(sortCodePoint);
}

function listTrackedFilesUnderTasks(gitEnv) {
  const raw = runGit(["ls-files", "--cached", "-z", "--", "scripts/eval/tasks"], gitEnv);
  const prefix = "scripts/eval/tasks/";
  return raw
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.replaceAll("\\", "/"))
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => entry.slice(prefix.length))
    .filter((rel) => rel !== "manifest.json")
    .sort(sortCodePoint);
}

function checkForbiddenFixtureNames(diskFiles) {
  for (const rel of diskFiles) {
    const segments = rel.split("/");
    if (segments.includes(".git")) {
      throw new Error(`Forbidden nested .git file under tasks/: ${rel}`);
    }
    if (segments.includes("node_modules")) {
      throw new Error(`Forbidden node_modules entry under tasks/: ${rel}`);
    }
    if (segments.at(-1) === ".env") {
      throw new Error(`Forbidden .env file under tasks/: ${rel}`);
    }
  }
}

function checkTrackedMatchesDisk(tracked, disk) {
  const trackedSet = new Set(tracked);
  const diskSet = new Set(disk);
  const untracked = disk.filter((rel) => !trackedSet.has(rel));
  const missingOnDisk = tracked.filter((rel) => !diskSet.has(rel));
  if (untracked.length > 0 || missingOnDisk.length > 0) {
    const parts = [];
    if (untracked.length > 0) parts.push(`untracked on disk: ${untracked.join(", ")}`);
    if (missingOnDisk.length > 0) parts.push(`tracked but missing on disk: ${missingOnDisk.join(", ")}`);
    throw new Error(`Tracked file check failed under tasks/: ${parts.join("; ")}`);
  }
}

function checkStdoutClean(stdout, label) {
  const lines = String(stdout ?? "").split(/\r?\n/);
  for (const line of lines) {
    if (ERROR_SIGNAL_RE.test(line)) {
      throw new Error(`${label}: stdout carries error-signal text: ${JSON.stringify(line)}`);
    }
  }
}

function listOverlayFiles(overlayDir) {
  /** @type {string[]} */
  const out = [];
  function walk(dir, prefix) {
    for (const name of readdirSync(dir).sort(sortCodePoint)) {
      const full = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (statSync(full).isDirectory()) walk(full, rel);
      else out.push(rel);
    }
  }
  walk(overlayDir, "");
  return out;
}

function matchesProtected(relPath, protectedEntries) {
  for (const rawEntry of protectedEntries) {
    const entry = String(rawEntry).replaceAll("\\", "/").replace(/^\.\//, "");
    if (entry.endsWith("/")) {
      if (relPath.startsWith(entry)) return true;
    } else if (relPath === entry) {
      return true;
    }
  }
  return false;
}

async function withTempWorkDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function computeManifest(options = {}) {
  const gitEnv = buildToolEnv(process.env, process.platform);
  const diskFiles = listDiskFilesUnderTasks();
  checkForbiddenFixtureNames(diskFiles);
  const trackedFiles = listTrackedFilesUnderTasks(gitEnv);
  checkTrackedMatchesDisk(trackedFiles, diskFiles);

  /** @type {Record<string, string>} */
  const files = {};
  for (const rel of diskFiles) {
    files[rel] = sha256Buffer(readFileSync(join(TASKS_DIR, rel)));
  }
  if (options.extraFiles && typeof options.extraFiles === "object") {
    for (const [rel, digest] of Object.entries(options.extraFiles)) {
      if (typeof rel === "string" && rel.length > 0 && typeof digest === "string") {
        if (!Object.prototype.hasOwnProperty.call(files, rel)) {
          diskFiles.push(rel);
        }
        files[rel] = digest;
      }
    }
    diskFiles.sort(sortCodePoint);
    checkForbiddenFixtureNames(diskFiles);
  }

  const rawTasks = JSON.parse(readFileSync(TASKS_JSON_PATH, "utf8"));
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
    throw new Error("tasks.json must contain a non-empty array of tasks");
  }

  const seenIds = new Set();
  const tasksWithNormalized = rawTasks.map((task) => {
    if (!task || typeof task.id !== "string" || task.id.length === 0) {
      throw new Error("Each task in tasks.json must have a non-empty id");
    }
    if (seenIds.has(task.id)) {
      throw new Error(`Duplicate task id in tasks.json: ${task.id}`);
    }
    seenIds.add(task.id);
    if (!VALID_SETS.has(task.set)) {
      throw new Error(`Invalid task set for ${task.id}: ${String(task.set)}`);
    }
    if (!VALID_KINDS.has(task.kind)) {
      throw new Error(`Invalid task kind for ${task.id}: ${String(task.kind)}`);
    }
    const normalizedTrapLine = normalizeLine(task.trapLine);
    if (normalizedTrapLine.length === 0) {
      throw new Error(`Empty normalizedTrapLine for ${task.id}`);
    }
    const expectedAcceptLine = `eval-accept: ${task.fixture} ok`;
    if (task.acceptLine !== expectedAcceptLine) {
      throw new Error(
        `Invalid acceptLine for ${task.id}: expected "${expectedAcceptLine}", got ${JSON.stringify(task.acceptLine)}`,
      );
    }
    return { ...task, normalizedTrapLine };
  });

  const taskSets = {
    v1: computeTaskSetSha256("v1", rawTasks, diskFiles, files),
    v2: computeTaskSetSha256("v2", rawTasks, diskFiles, files),
  };
  const taskSetSha256 = taskSets.v1;

  const evaluatorCommit = runGit(["rev-parse", "HEAD"], gitEnv).trim();
  return {
    v: 1,
    frozenAt: new Date().toISOString(),
    evaluatorCommit,
    tasks: tasksWithNormalized,
    files,
    taskSets,
    taskSetSha256,
  };
}

export async function validateTaskBehaviors(manifest) {
  const envTempDir = mkdtempSync(join(tmpdir(), "rocky-freeze-env-"));
  prepareAcceptTempDir(envTempDir);
  const targetEnv = buildAcceptEnv(process.env, process.platform, envTempDir);

  try {
    for (const task of manifest.tasks) {
      const fixtureDir = join(TASKS_DIR, task.fixture);
      const repoDir = join(fixtureDir, "repo");
      const patchesDir = join(fixtureDir, "patches");

      if (!existsSync(repoDir) || !statSync(repoDir).isDirectory()) {
        throw new Error(`${task.id}: missing repo/ directory at ${repoDir}`);
      }

      // Check every overlay leaves protected files untouched.
      if (existsSync(patchesDir) && statSync(patchesDir).isDirectory()) {
        for (const patchName of readdirSync(patchesDir).sort(sortCodePoint)) {
          const patchDir = join(patchesDir, patchName);
          if (!statSync(patchDir).isDirectory()) continue;
          for (const rel of listOverlayFiles(patchDir)) {
            if (matchesProtected(rel, task.protected)) {
              throw new Error(`${task.id}: overlay ${patchName} touches protected path ${rel}`);
            }
          }
        }
      }

      // Check untouched repo/ fails with normalizedTrapLine on stderr, clean stdout, and no acceptLine.
      let repoFp = "";
      await withTempWorkDir(`rocky-freeze-${task.id}-repo-`, async (workDir) => {
        copyTree(repoDir, workDir);
        const res = await runTargetCommand(task.target.command, workDir, targetEnv);
        if (res.status === 0) {
          throw new Error(`${task.id}: untouched repo/ unexpectedly exited 0`);
        }
        checkStdoutClean(res.stdout, `${task.id} repo/`);
        if (stdoutHasAcceptLine(res.stdout, task.acceptLine)) {
          throw new Error(`${task.id}: untouched repo/ stdout unexpectedly contained acceptLine "${task.acceptLine}"`);
        }
        if (!stderrHasTrapLine(res.stderr, task.trapLine)) {
          throw new Error(
            `${task.id}: repo/ stderr missing normalized trap line "${task.normalizedTrapLine}". Got:\n${res.stderr}`,
          );
        }
        repoFp = fingerprint(res.stderr, task.target.command, res.status);
        const acc = await accept(task, workDir, { manifest });
        if (acc.solved !== false) {
          throw new Error(`${task.id}: accept unexpectedly returned solved=true on untouched repo/`);
        }
      });

      // Check ambient API_TOKEN in process.env does not allow untouched T07 to pass accept().
      if (task.id === "T07") {
        await withTempWorkDir(`rocky-freeze-${task.id}-ambient-`, async (workDir) => {
          copyTree(repoDir, workDir);
          const hadApiToken = Object.prototype.hasOwnProperty.call(process.env, "API_TOKEN");
          const prevApiToken = process.env.API_TOKEN;
          process.env.API_TOKEN = "probe";
          try {
            const ambientAcc = await accept(task, workDir, { manifest });
            if (ambientAcc.solved !== false) {
              throw new Error(
                `${task.id}: accept returned solved=true on untouched repo/ with ambient API_TOKEN=probe`,
              );
            }
          } finally {
            if (hadApiToken) process.env.API_TOKEN = prevApiToken;
            else delete process.env.API_TOKEN;
          }
        });
      }

      // Check trap and stale history sequence.
      if (task.kind === "trap" || task.kind === "stale") {
        if (!task.history || !Array.isArray(task.history.wrong) || typeof task.history.fix !== "string") {
          throw new Error(`${task.id}: ${task.kind} task requires history.wrong and history.fix`);
        }
        const historySource = task.kind === "stale"
          ? join(fixtureDir, "history-repo")
          : repoDir;
        if (!existsSync(historySource) || !statSync(historySource).isDirectory()) {
          throw new Error(`${task.id}: missing history source directory ${historySource}`);
        }

        await withTempWorkDir(`rocky-freeze-${task.id}-hist-`, async (workDir) => {
          copyTree(historySource, workDir);
          const initial = await runTargetCommand(task.target.command, workDir, targetEnv);
          if (initial.status === 0) {
            throw new Error(`${task.id}: initial history state unexpectedly exited 0`);
          }
          checkStdoutClean(initial.stdout, `${task.id} history initial`);
          if (!stderrHasTrapLine(initial.stderr, task.trapLine)) {
            throw new Error(`${task.id}: initial history state missing trap line. Got:\n${initial.stderr}`);
          }
          const initialFp = fingerprint(initial.stderr, task.target.command, initial.status);
          if (initialFp !== repoFp) {
            throw new Error(
              `${task.id}: history initial fingerprint (${initialFp}) differs from repo/ fingerprint (${repoFp})`,
            );
          }

          for (const wrongName of task.history.wrong) {
            copyTree(join(patchesDir, wrongName), workDir);
            const wrongRes = await runTargetCommand(task.target.command, workDir, targetEnv);
            if (wrongRes.status === 0) {
              throw new Error(`${task.id}: wrong overlay ${wrongName} unexpectedly exited 0`);
            }
            checkStdoutClean(wrongRes.stdout, `${task.id} ${wrongName}`);
            if (!stderrHasTrapLine(wrongRes.stderr, task.trapLine)) {
              throw new Error(
                `${task.id}: wrong overlay ${wrongName} did not keep trap line "${task.normalizedTrapLine}". Got:\n${wrongRes.stderr}`,
              );
            }
            const wrongFp = fingerprint(wrongRes.stderr, task.target.command, wrongRes.status);
            if (wrongFp !== initialFp) {
              throw new Error(
                `${task.id}: wrong overlay ${wrongName} fingerprint (${wrongFp}) differs from initial (${initialFp})`,
              );
            }
          }

          copyTree(join(patchesDir, task.history.fix), workDir);
          const fixRes = await runTargetCommand(task.target.command, workDir, targetEnv);
          if (fixRes.status !== 0) {
            throw new Error(`${task.id}: history fix ${task.history.fix} exited ${fixRes.status}:\n${fixRes.stderr}`);
          }
          if (stderrHasTrapLine(fixRes.stderr, task.trapLine)) {
            throw new Error(`${task.id}: history fix ${task.history.fix} still emitted trap line`);
          }
          if (!stdoutHasAcceptLine(fixRes.stdout, task.acceptLine)) {
            throw new Error(
              `${task.id}: history fix ${task.history.fix} stdout missing acceptLine "${task.acceptLine}"`,
            );
          }
        });
      }

      // Check stale fix-fails-on-repo and current-fix-passes-on-repo.
      if (task.kind === "stale") {
        await withTempWorkDir(`rocky-freeze-${task.id}-stale-oldfix-`, async (workDir) => {
          copyTree(repoDir, workDir);
          copyTree(join(patchesDir, task.history.fix), workDir);
          const oldFixRes = await runTargetCommand(task.target.command, workDir, targetEnv);
          if (oldFixRes.status === 0) {
            throw new Error(`${task.id}: stale history fix unexpectedly passed on current repo/`);
          }
          checkStdoutClean(oldFixRes.stdout, `${task.id} repo + old fix`);
          if (!stderrHasTrapLine(oldFixRes.stderr, task.trapLine)) {
            throw new Error(`${task.id}: stale history fix on repo/ did not keep trap line:\n${oldFixRes.stderr}`);
          }
          const oldFixFp = fingerprint(oldFixRes.stderr, task.target.command, oldFixRes.status);
          if (oldFixFp !== repoFp) {
            throw new Error(
              `${task.id}: repo/ + old fix fingerprint (${oldFixFp}) differs from repo/ (${repoFp})`,
            );
          }
        });
      }

      // Check real fix removes trap line, prints acceptLine, and passes accept().
      const realFixName = task.kind === "stale" ? "current-fix" : "fix";
      const realFixDir = join(patchesDir, realFixName);
      if (!existsSync(realFixDir) || !statSync(realFixDir).isDirectory()) {
        throw new Error(`${task.id}: missing real fix overlay at ${realFixDir}`);
      }
      await withTempWorkDir(`rocky-freeze-${task.id}-realfix-`, async (workDir) => {
        copyTree(repoDir, workDir);
        copyTree(realFixDir, workDir);
        const res = await runTargetCommand(task.target.command, workDir, targetEnv);
        if (res.status !== 0) {
          throw new Error(`${task.id}: real fix ${realFixName} exited ${res.status}:\n${res.stderr}`);
        }
        if (stderrHasTrapLine(res.stderr, task.trapLine)) {
          throw new Error(`${task.id}: real fix ${realFixName} still emitted trap line`);
        }
        if (!stdoutHasAcceptLine(res.stdout, task.acceptLine)) {
          throw new Error(
            `${task.id}: real fix ${realFixName} stdout missing acceptLine "${task.acceptLine}"`,
          );
        }
        const acc = await accept(task, workDir, { manifest });
        if (acc.solved !== true) {
          throw new Error(`${task.id}: accept returned solved=false on repo/ + ${realFixName}: ${acc.reason}`);
        }
      });
    }
  } finally {
    rmSync(envTempDir, { recursive: true, force: true });
  }

  return manifest;
}

export async function buildAndValidateManifest() {
  const manifest = computeManifest();
  return validateTaskBehaviors(manifest);
}

export function compareManifests(expected, actual) {
  const diffs = [];
  if (actual?.v !== expected.v) diffs.push(`v: expected ${expected.v}, got ${actual?.v}`);
  if (actual?.taskSetSha256 !== expected.taskSetSha256) {
    diffs.push(`taskSetSha256: expected ${expected.taskSetSha256}, got ${actual?.taskSetSha256}`);
  }
  if (
    (expected.taskSets !== undefined || actual?.taskSets !== undefined)
    && !isDeepStrictEqual(actual?.taskSets ?? null, expected.taskSets ?? null)
  ) {
    diffs.push("taskSets map differs");
  }
  if (!isDeepStrictEqual(actual?.files ?? null, expected.files)) {
    diffs.push("files map differs");
  }
  if (!isDeepStrictEqual(actual?.tasks ?? null, expected.tasks)) {
    diffs.push("tasks array differs");
  }
  return diffs;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync.native(resolve(process.argv[1])) === realpathSync.native(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const verifyOnly = args.includes("--verify");
  const unknown = args.filter((arg) => arg !== "--verify");
  if (unknown.length > 0) {
    process.stderr.write(`Unknown argument(s): ${unknown.join(" ")}\n`);
    process.exitCode = 2;
    return;
  }

  try {
    if (verifyOnly) {
      const computed = computeManifest();
      if (!existsSync(MANIFEST_PATH)) {
        process.stderr.write(`Manifest not found: ${MANIFEST_PATH}\n`);
        process.exitCode = 1;
        return;
      }
      const committed = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
      const diffs = compareManifests(computed, committed);
      if (diffs.length > 0) {
        process.stderr.write(`Manifest verification failed:\n- ${diffs.join("\n- ")}\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(
        `Verified ${computed.tasks.length} tasks, ${Object.keys(computed.files).length} files. taskSetSha256=${computed.taskSetSha256}\n`,
      );
      return;
    }

    const computed = await buildAndValidateManifest();
    writeFileSync(MANIFEST_PATH, `${JSON.stringify(computed, null, 2)}\n`, "utf8");
    process.stdout.write(
      `Froze ${computed.tasks.length} tasks, ${Object.keys(computed.files).length} files.\ntaskSetSha256=${computed.taskSetSha256}\nmanifest=${MANIFEST_PATH}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (isMainModule()) {
  await main();
}
