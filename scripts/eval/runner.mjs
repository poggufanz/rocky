import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { open as openFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
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
export const MAX_K = 12;
export const DEFAULT_SEED = 20261123;
export const DEFAULT_CONCURRENCY = 2;
export const RUN_TIMEOUT_MS = 20 * 60 * 1000;
export const MAX_RETRIES = 2;
export const VALID_INVALIDS = new Set([
  "api_error",
  "timeout",
  "harness_crash",
  "transcript_broken",
  "token_leak",
]);
export const RETRYABLE_INVALIDS = new Set(["api_error", "harness_crash"]);
export const MAX_TRANSCRIPT_LINE_BYTES = 1024 * 1024;
export const COPY_CREDENTIALS_DISABLED_MESSAGE =
  "copy-credentials is disabled for batches: token auth was captured working (see README harness facts)";

const ROCKY_HOME_ALLOWED_FILES = ["memory.jsonl", "advisories.jsonl"];
const KILL_GRACE_MS = 3_000;

const USAGE = [
  "Usage: node scripts/eval/runner.mjs --out <dir> --before <sha> --after <sha>",
  "         --auth token [--concurrency <n>] [--root <dir>] [--cache <dir>]",
  "         [--k <n>] [--seed <n>] [--only <id1,id2,...>] [--retry-invalid]",
  "",
  "Options:",
  "  --out <dir>            Output directory (must lie outside repo and enclosing workspace)",
  "  --before <sha>         Git commit/ref for the 'before' Rocky arm",
  "  --after <sha>          Git commit/ref for the 'after' Rocky arm",
  "  --auth token           Authentication mode: 'token' only (reads ROCKY_EVAL_OAUTH_TOKEN; copy-credentials is disabled for batches)",
  `  --concurrency <n>      Concurrent runs (default: ${DEFAULT_CONCURRENCY})`,
  "  --root <dir>           Sandbox root directory (default: <os.tmpdir>/rocky-eval)",
  "  --cache <dir>          Tarball pack cache directory (default: <out>/../pack-cache; must be outside workspace)",
  `  --k <n>                Number of randomized blocks (1..${MAX_K}, default: ${DEFAULT_K})`,
  `  --seed <n>             PRNG seed for schedule shuffling (default: ${DEFAULT_SEED})`,
  "  --only <ids>           Comma-separated task IDs to run (default: all manifest tasks except SMOKE)",
  "  --retry-invalid        Re-run existing runs with invalid=api_error or harness_crash (up to 2 retries)",
  "  -h, --help             Show this help message and exit",
].join("\n");

export class ProvenanceMismatchError extends Error {
  /**
   * @param {string} message
   * @param {string[]} differingFields
   */
  constructor(message, differingFields) {
    super(message);
    this.name = "ProvenanceMismatchError";
    this.exitCode = 2;
    this.differingFields = differingFields;
  }
}

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
  if (!Number.isInteger(k) || k < 1 || k > MAX_K) {
    throw new RangeError(`Invalid block count k: ${String(k)} (must be an integer in 1..${MAX_K})`);
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

function normalizeSecrets(secrets) {
  /** @type {Set<string>} */
  const unique = new Set();
  for (const secret of secrets ?? []) {
    if (typeof secret === "string" && secret.length > 0) {
      unique.add(secret);
    }
  }
  return Array.from(unique).sort((a, b) => b.length - a.length);
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
 * Incremental streaming file writer that redacts secrets split across chunk boundaries
 * by holding back `maxSecretLength - 1` characters between writes, preserving UTF-16
 * surrogate pairs and propagating writable backpressure.
 * @param {string} filePath
 * @param {readonly string[]} [secrets]
 * @param {{ stream?: import("node:stream").Writable }} [options]
 */
export function createRedactingFileWriter(filePath, secrets = [], options = {}) {
  const normalizedSecrets = normalizeSecrets(secrets);
  const maxSecretLen = normalizedSecrets.reduce((max, s) => Math.max(max, s.length), 0);
  const holdback = maxSecretLen > 1 ? maxSecretLen - 1 : 0;
  const decoder = new StringDecoder("utf8");
  const stream = options.stream ?? createWriteStream(filePath, { encoding: "utf8" });

  let pending = "";
  let leaked = false;
  let ended = false;
  /** @type {Error | null} */
  let streamError = null;
  let streamClosed = false;

  const donePromise = new Promise((resolveDone) => {
    const onDone = () => {
      streamClosed = true;
      resolveDone();
    };
    stream.once("finish", onDone);
    stream.once("close", onDone);
    stream.on("error", (error) => {
      if (!streamError) {
        streamError = error instanceof Error ? error : new Error(String(error));
      }
      onDone();
    });
  });

  /**
   * @param {Buffer | string} chunk
   * @returns {boolean}
   */
  function write(chunk) {
    if (ended) return true;
    const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
    if (text.length === 0) return true;
    const combined = pending + text;
    let processed = combined;
    if (normalizedSecrets.length > 0 && containsAnySecret(combined, normalizedSecrets)) {
      leaked = true;
      processed = redactText(combined, normalizedSecrets);
    }
    let splitAt = holdback === 0 ? processed.length : processed.length - holdback;
    if (splitAt <= 0) {
      pending = processed;
      return true;
    }
    // Never split a UTF-16 surrogate pair at the holdback boundary.
    const boundaryCodeUnit = processed.charCodeAt(splitAt - 1);
    if (boundaryCodeUnit >= 0xd800 && boundaryCodeUnit <= 0xdbff) {
      splitAt -= 1;
    }
    if (splitAt <= 0) {
      pending = processed;
      return true;
    }
    const flush = processed.slice(0, splitAt);
    pending = processed.slice(splitAt);
    if (!streamError && !streamClosed && flush.length > 0) {
      return stream.write(flush);
    }
    return true;
  }

  /**
   * Invoke `listener` once the underlying writable drains (or errors/closes).
   * @param {() => void} listener
   */
  function onceDrain(listener) {
    if (streamError || streamClosed) {
      queueMicrotask(listener);
      return;
    }
    const onWake = () => {
      stream.off("drain", onWake);
      stream.off("error", onWake);
      stream.off("close", onWake);
      listener();
    };
    stream.once("drain", onWake);
    stream.once("error", onWake);
    stream.once("close", onWake);
  }

  async function end() {
    if (!ended) {
      ended = true;
      const tail = pending + decoder.end();
      pending = "";
      let finalChunk = tail;
      if (tail.length > 0 && normalizedSecrets.length > 0 && containsAnySecret(tail, normalizedSecrets)) {
        leaked = true;
        finalChunk = redactText(tail, normalizedSecrets);
      }
      if (!streamError && !streamClosed) {
        if (finalChunk.length > 0) {
          stream.write(finalChunk);
        }
        stream.end();
      }
    }
    await donePromise;
    if (streamError) {
      throw streamError;
    }
    return { leaked };
  }

  return {
    write,
    end,
    onceDrain,
    getLeaked: () => leaked,
    getError: () => streamError,
  };
}

/**
 * Connect a readable stream to a redacting writer, pausing the source when
 * `writer.write()` returns `false` and resuming on `drain`.
 * @param {import("node:stream").Readable} readable
 * @param {{ write: (chunk: Buffer) => boolean, onceDrain: (listener: () => void) => void }} writer
 * @param {(chunk: Buffer) => void} [onChunk]
 */
export function pipeReadableToRedactingWriter(readable, writer, onChunk) {
  let paused = false;
  let waitingForDrain = false;
  const onDrain = () => {
    waitingForDrain = false;
    if (paused && !readable.destroyed) {
      paused = false;
      readable.resume();
    }
  };
  readable.on("data", (chunk) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (onChunk) onChunk(buf);
    const ok = writer.write(buf);
    if (ok === false && !readable.destroyed) {
      paused = true;
      readable.pause();
      if (!waitingForDrain) {
        waitingForDrain = true;
        writer.onceDrain(onDrain);
      }
    }
  });
}

/**
 * Bounded line-by-line JSONL transcript parser keeping only the last `result` event metadata.
 * Lines exceeding `maxLineBytes` are skipped for JSON parsing (still written to disk by the writer).
 * @param {number} [maxLineBytes]
 */
export function createTranscriptParser(maxLineBytes = MAX_TRANSCRIPT_LINE_BYTES) {
  const decoder = new StringDecoder("utf8");
  let lineBuf = "";
  let lineBytes = 0;
  let lineOverflowed = false;
  let nonEmptyLines = 0;
  let malformedLineCount = 0;
  let oversizedLineCount = 0;
  /** @type {{ subtype: unknown, is_error: unknown } | null} */
  let lastResult = null;

  function processLine(rawLine) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) return;
    nonEmptyLines += 1;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      malformedLineCount += 1;
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      malformedLineCount += 1;
      return;
    }
    if (parsed.type === "result") {
      lastResult = {
        subtype: parsed.subtype,
        is_error: parsed.is_error,
      };
    }
  }

  function appendSegment(segment) {
    if (lineOverflowed || segment.length === 0) return;
    const segBytes = Buffer.byteLength(segment, "utf8");
    if (lineBytes + segBytes > maxLineBytes) {
      lineOverflowed = true;
      lineBuf = "";
      lineBytes = 0;
      return;
    }
    lineBuf += segment;
    lineBytes += segBytes;
  }

  function finishLine() {
    if (lineOverflowed) {
      nonEmptyLines += 1;
      oversizedLineCount += 1;
      lineOverflowed = false;
      lineBuf = "";
      lineBytes = 0;
      return;
    }
    processLine(lineBuf);
    lineBuf = "";
    lineBytes = 0;
  }

  /**
   * @param {Buffer | string} chunk
   */
  function write(chunk) {
    const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
    if (text.length === 0) return;
    let start = 0;
    while (start < text.length) {
      const nl = text.indexOf("\n", start);
      if (nl === -1) {
        appendSegment(text.slice(start));
        break;
      }
      appendSegment(text.slice(start, nl));
      finishLine();
      start = nl + 1;
    }
  }

  function end() {
    const tail = decoder.end();
    if (tail.length > 0) {
      write(tail);
    }
    if (lineOverflowed) {
      nonEmptyLines += 1;
      oversizedLineCount += 1;
      lineOverflowed = false;
      lineBuf = "";
      lineBytes = 0;
    } else if (lineBuf.length > 0) {
      processLine(lineBuf);
      lineBuf = "";
      lineBytes = 0;
    }
    return {
      nonEmptyLines,
      malformedLineCount,
      oversizedLineCount,
      lastResult,
    };
  }

  return { write, end };
}

/**
 * Classify a completed Claude subprocess run into `invalid` status or `null`.
 * Accepts either streaming summary `{ transcript, tokenLeaked, timedOut }` or raw strings.
 * @param {{
 *   transcript?: { nonEmptyLines: number, malformedLineCount: number, oversizedLineCount: number, lastResult: { subtype: unknown, is_error: unknown } | null },
 *   tokenLeaked?: boolean,
 *   rawStdout?: string,
 *   rawStderr?: string,
 *   exitCode?: number | null,
 *   timedOut: boolean,
 *   secrets?: readonly string[],
 * }} params
 * @returns {null | "api_error" | "timeout" | "transcript_broken" | "token_leak"}
 */
export function classifyOutcome({
  transcript,
  tokenLeaked,
  rawStdout,
  rawStderr,
  timedOut,
  secrets = [],
}) {
  const leaked = tokenLeaked !== undefined
    ? Boolean(tokenLeaked)
    : (containsAnySecret(rawStdout, secrets) || containsAnySecret(rawStderr, secrets));
  if (leaked) {
    return "token_leak";
  }
  if (timedOut) {
    return "timeout";
  }

  let summary = transcript;
  if (!summary) {
    const parser = createTranscriptParser();
    parser.write(String(rawStdout ?? ""));
    summary = parser.end();
  }

  if (summary.nonEmptyLines === 0 || summary.malformedLineCount > 0 || !summary.lastResult) {
    return "transcript_broken";
  }
  if (
    summary.lastResult.is_error === true
    || (summary.lastResult.subtype !== "success" && summary.lastResult.subtype !== "error_max_turns")
  ) {
    return "api_error";
  }
  return null;
}

/**
 * Compare saved batch provenance against current invocation values.
 * Concurrency and `--retry-invalid` are allowed to differ.
 * @param {any} existing
 * @param {{
 *   beforeSha: string,
 *   afterSha: string,
 *   model: string,
 *   claudeFlags: readonly string[],
 *   claudeVersion: string,
 *   evaluatorCommit: string,
 *   taskSetSha256: string,
 *   seed: number,
 *   k: number,
 *   taskIds: readonly string[],
 * }} current
 * @returns {string[]}
 */
export function diffBatchProvenance(existing, current) {
  /** @type {string[]} */
  const diffs = [];
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
    return ["batch.json"];
  }
  const scalarFields = [
    "beforeSha",
    "afterSha",
    "model",
    "claudeVersion",
    "evaluatorCommit",
    "taskSetSha256",
    "seed",
    "k",
  ];
  for (const field of scalarFields) {
    if (existing[field] !== current[field]) {
      diffs.push(field);
    }
  }
  const arrayFields = ["claudeFlags", "taskIds"];
  for (const field of arrayFields) {
    const a = existing[field];
    const b = current[field];
    const same = Array.isArray(a)
      && Array.isArray(b)
      && a.length === b.length
      && a.every((val, idx) => val === b[idx]);
    if (!same) {
      diffs.push(field);
    }
  }
  return diffs;
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

function resolveTaskkillExecutable(env) {
  const sysRoot = env?.SystemRoot ?? process.env.SystemRoot ?? process.env.windir;
  const extraDirs = typeof sysRoot === "string" && sysRoot.length > 0
    ? [join(sysRoot, "System32")]
    : [];
  return resolveExecutableOnPath(
    ["taskkill.exe"],
    getPathValue(env ?? process.env),
    "win32",
    extraDirs,
  );
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

/**
 * Terminate a child process tree on timeout and report whether termination failed.
 * @param {import("node:child_process").ChildProcess} child
 * @param {Record<string, string | undefined>} env
 * @param {NodeJS.Platform} [platform]
 * @returns {{ killFailed: boolean, taskkillStatus: number | null }}
 */
function hardKillProcessTree(child, env, platform = process.platform) {
  const pid = child.pid;
  if (platform === "win32") {
    let killFailed = true;
    /** @type {number | null} */
    let taskkillStatus = null;
    if (typeof pid === "number" && pid > 0) {
      const taskkill = resolveTaskkillExecutable(env);
      if (taskkill) {
        try {
          const res = spawnSync(taskkill, ["/T", "/F", "/PID", String(pid)], {
            stdio: "ignore",
            windowsHide: true,
            shell: false,
            timeout: 10_000,
          });
          taskkillStatus = res.error ? null : res.status;
          killFailed = Boolean(res.error) || taskkillStatus !== 0;
        } catch {
          killFailed = true;
        }
      }
    }
    if (killFailed) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Process may already have exited.
      }
    }
    return { killFailed, taskkillStatus };
  }

  let killFailed = false;
  if (typeof pid === "number" && pid > 0) {
    try {
      process.kill(-pid, "SIGKILL");
      return { killFailed: false, taskkillStatus: null };
    } catch (error) {
      const code = error && typeof error === "object" ? error.code : undefined;
      if (code === "ESRCH") {
        return { killFailed: false, taskkillStatus: null };
      }
      killFailed = true;
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // Process may already have exited.
  }
  return { killFailed, taskkillStatus: null };
}

/**
 * Spawn an external command asynchronously without a shell.
 * When `stdoutPath` and `stderrPath` are provided, streams output directly to disk
 * through redacting writers and parses JSONL stdout incrementally with bounded memory.
 * @param {{
 *   file: string,
 *   args: readonly string[],
 *   cwd: string,
 *   env: Record<string, string | undefined>,
 *   timeoutMs?: number,
 *   platform?: NodeJS.Platform,
 *   stdoutPath?: string,
 *   stderrPath?: string,
 *   secrets?: readonly string[],
 *   maxTranscriptLineBytes?: number,
 * }} options
 */
export function spawnProcess({
  file,
  args,
  cwd,
  env,
  timeoutMs = RUN_TIMEOUT_MS,
  platform = process.platform,
  stdoutPath,
  stderrPath,
  secrets = [],
  maxTranscriptLineBytes = MAX_TRANSCRIPT_LINE_BYTES,
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

    const streaming = typeof stdoutPath === "string" && typeof stderrPath === "string";
    let stdoutWriter = null;
    let stderrWriter = null;
    let transcriptParser = null;
    if (streaming) {
      try {
        stdoutWriter = createRedactingFileWriter(stdoutPath, secrets);
        stderrWriter = createRedactingFileWriter(stderrPath, secrets);
        transcriptParser = createTranscriptParser(maxTranscriptLineBytes);
      } catch (error) {
        rejectPromise(error);
        return;
      }
    }

    const child = spawn(invocation.file, invocation.args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
      detached: platform !== "win32",
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });

    /** @type {Buffer[]} */
    const stdoutChunks = [];
    /** @type {Buffer[]} */
    const stderrChunks = [];
    let timedOut = false;
    let killFailed = false;
    /** @type {number | null} */
    let taskkillStatus = null;
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

      if (!streaming) {
        resolvePromise({
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          exitCode,
          signal,
          timedOut,
          killFailed,
          taskkillStatus,
          streamed: false,
        });
        return;
      }

      Promise.all([stdoutWriter.end(), stderrWriter.end()])
        .then(([outRes, errRes]) => {
          const transcript = transcriptParser.end();
          resolvePromise({
            exitCode,
            signal,
            timedOut,
            killFailed,
            taskkillStatus,
            streamed: true,
            tokenLeaked: outRes.leaked || errRes.leaked,
            transcript,
          });
        })
        .catch((error) => {
          rejectPromise(error);
        });
    };

    if (streaming) {
      pipeReadableToRedactingWriter(child.stdout, stdoutWriter, (buf) => {
        transcriptParser.write(buf);
      });
      pipeReadableToRedactingWriter(child.stderr, stderrWriter);
    } else {
      child.stdout.on("data", (chunk) => {
        stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      child.stderr.on("data", (chunk) => {
        stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
    }

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (streaming) {
        Promise.allSettled([stdoutWriter.end(), stderrWriter.end()]).finally(() => {
          rejectPromise(error);
        });
      } else {
        rejectPromise(error);
      }
    });

    child.on("close", (code, signal) => {
      settle(code, signal);
    });

    if (typeof timeoutMs === "number" && timeoutMs > 0) {
      killTimer = setTimeout(() => {
        timedOut = true;
        const killRes = hardKillProcessTree(child, env, platform);
        killFailed = killRes.killFailed;
        taskkillStatus = killRes.taskkillStatus;
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

// ponytail: win32 stray sweep matches Win32_Process.CommandLine against the sandbox path,
// so a detached descendant whose command line does not mention the sandbox dir will be missed.
/**
 * Sweep any remaining Windows processes whose command line references `sandboxDir`
 * and terminate them with `taskkill /T /F`. Returns the number of killed processes.
 * @param {string} sandboxDir
 * @param {{ platform?: NodeJS.Platform, env?: Record<string, string | undefined>, timeoutMs?: number }} [options]
 * @returns {Promise<number>}
 */
export async function sweepWin32Strays(sandboxDir, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return 0;
  if (typeof sandboxDir !== "string" || sandboxDir.length === 0) return 0;

  const toolEnv = buildToolEnv(options.env ?? process.env, "win32");
  const sysRoot = toolEnv.SystemRoot ?? process.env.SystemRoot ?? process.env.windir ?? "";
  const psExtraDirs = sysRoot ? [join(sysRoot, "System32", "WindowsPowerShell", "v1.0")] : [];
  const psExe = resolveExecutableOnPath(
    ["powershell.exe", "pwsh.exe"],
    getPathValue(toolEnv),
    "win32",
    psExtraDirs,
  );
  if (!psExe) return 0;

  const escapedDir = sandboxDir
    .replace(/([`*?[\]])/g, "`$1")
    .replaceAll("'", "''");
  const psCommand =
    `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${escapedDir}*' } | Select-Object -ExpandProperty ProcessId`;

  let listRes;
  try {
    listRes = await spawnProcess({
      file: psExe,
      args: ["-NoProfile", "-Command", psCommand],
      cwd: REPO_ROOT,
      env: toolEnv,
      timeoutMs: options.timeoutMs ?? 15_000,
      platform: "win32",
    });
  } catch {
    return 0;
  }
  if (listRes.timedOut || listRes.exitCode !== 0) {
    return 0;
  }

  const pids = Array.from(
    new Set(
      String(listRes.stdout ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^\d+$/.test(line))
        .map((line) => Number.parseInt(line, 10))
        .filter((pid) => Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid),
    ),
  );
  if (pids.length === 0) return 0;

  const taskkill = resolveTaskkillExecutable(toolEnv);
  if (!taskkill) return 0;

  let killed = 0;
  for (const pid of pids) {
    try {
      const killRes = await spawnProcess({
        file: taskkill,
        args: ["/T", "/F", "/PID", String(pid)],
        cwd: REPO_ROOT,
        env: toolEnv,
        timeoutMs: 10_000,
        platform: "win32",
      });
      if (!killRes.timedOut && killRes.exitCode === 0) {
        killed += 1;
      }
    } catch {
      // Continue sweeping remaining stray PIDs.
    }
  }
  return killed;
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

function renameDirWithRetry(oldPath, newPath) {
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      renameSync(oldPath, newPath);
      return;
    } catch (error) {
      lastError = error;
      const code = error && typeof error === "object" ? error.code : undefined;
      if (code !== "EBUSY" && code !== "EPERM" && code !== "EACCES") throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 75 * (attempt + 1));
    }
  }
  if (lastError) throw lastError;
}

function containsAnySecretBuffer(buf, secretBuffers) {
  if (buf.length === 0 || secretBuffers.length === 0) return false;
  for (const secretBuf of secretBuffers) {
    if (secretBuf.length > 0 && buf.indexOf(secretBuf) !== -1) {
      return true;
    }
  }
  return false;
}

async function fileContainsAnySecret(filePath, secretBuffers) {
  if (secretBuffers.length === 0) return false;
  const maxSecretLen = secretBuffers.reduce((max, buf) => Math.max(max, buf.length), 0);
  const holdback = maxSecretLen > 1 ? maxSecretLen - 1 : 0;
  const chunkSize = Math.max(64 * 1024, maxSecretLen * 2);
  const readBuf = Buffer.allocUnsafe(chunkSize);
  let tail = Buffer.alloc(0);

  const fh = await openFile(filePath, "r");
  try {
    while (true) {
      const { bytesRead } = await fh.read(readBuf, 0, chunkSize, null);
      if (bytesRead === 0) break;
      const chunk = readBuf.subarray(0, bytesRead);
      const combined = tail.length > 0 ? Buffer.concat([tail, chunk]) : chunk;
      if (containsAnySecretBuffer(combined, secretBuffers)) {
        return true;
      }
      if (holdback > 0) {
        const keep = Math.min(holdback, combined.length);
        tail = Buffer.from(combined.subarray(combined.length - keep));
      }
    }
    return false;
  } finally {
    await fh.close().catch(() => {});
  }
}

/**
 * Scan saved run artifacts (`transcript.jsonl`, `stderr.txt`, `final/**`, and `rocky-home/*`)
 * for any secret value using bounded chunked byte scans without following symlinks.
 * @param {string} workRunDir
 * @param {string} arm
 * @param {readonly string[]} secrets
 * @returns {Promise<boolean>}
 */
export async function scanRunArtifactsForSecrets(workRunDir, arm, secrets) {
  const secretBuffers = normalizeSecrets(secrets).map((s) => Buffer.from(s, "utf8"));
  if (secretBuffers.length === 0) return false;

  for (const name of ["transcript.jsonl", "stderr.txt"]) {
    const filePath = join(workRunDir, name);
    const stat = lstatOrNull(filePath);
    if (stat?.isFile() && await fileContainsAnySecret(filePath, secretBuffers)) {
      return true;
    }
  }

  async function scanTree(dirPath, recursive) {
    const rootStat = lstatOrNull(dirPath);
    if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) return false;
    const entries = readdirSync(dirPath).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const name of entries) {
      const fullPath = join(dirPath, name);
      const stat = lstatSync(fullPath);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (recursive && await scanTree(fullPath, true)) {
          return true;
        }
      } else if (stat.isFile()) {
        if (await fileContainsAnySecret(fullPath, secretBuffers)) {
          return true;
        }
      }
    }
    return false;
  }

  if (await scanTree(join(workRunDir, "final"), true)) {
    return true;
  }
  if (arm !== "none" && await scanTree(join(workRunDir, "rocky-home"), false)) {
    return true;
  }
  return false;
}

/**
 * Copy `srcDir` into `destDir` excluding `.git`, using `lstat` only.
 * Checks `srcDir` itself before descending; never follows symlinks or junctions.
 * Copies regular files plainly with `copyFileSync` (preserving source mode).
 * @param {string} srcDir
 * @param {string} destDir
 * @returns {string[]}
 */
function copyFinalWithoutGit(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true });
  /** @type {string[]} */
  const skippedLinks = [];
  let rootStat;
  try {
    rootStat = lstatSync(srcDir);
  } catch (error) {
    const code = error && typeof error === "object" ? error.code : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") {
      skippedLinks.push("final");
      return skippedLinks;
    }
    throw error;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    skippedLinks.push("final");
    return skippedLinks;
  }
  function walk(currentSrc, currentDest, relPrefix) {
    const entries = readdirSync(currentSrc).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const name of entries) {
      if (name === ".git") continue;
      const srcPath = join(currentSrc, name);
      const destPath = join(currentDest, name);
      const rel = relPrefix ? `${relPrefix}/${name}` : name;
      const lstat = lstatSync(srcPath);
      if (lstat.isSymbolicLink()) {
        skippedLinks.push(`final/${rel}`);
        continue;
      }
      if (lstat.isDirectory()) {
        mkdirSync(destPath, { recursive: true });
        walk(srcPath, destPath, rel);
      } else if (lstat.isFile()) {
        copyFileSync(srcPath, destPath);
      }
    }
  }
  walk(srcDir, destDir, "");
  return skippedLinks;
}

/**
 * Copy allowlisted files from `srcRockyHome` into `destRockyHome` using `lstat` only.
 * Checks `srcRockyHome` itself before reading children; never follows symlinks or junctions.
 * Copies regular files plainly with `copyFileSync` (preserving source mode).
 * @param {string} srcRockyHome
 * @param {string} destRockyHome
 * @param {string} arm
 * @returns {string[]}
 */
function copyRockyHomeFiles(srcRockyHome, destRockyHome, arm) {
  if (arm === "none") return [];
  mkdirSync(destRockyHome, { recursive: true });
  /** @type {string[]} */
  const skippedLinks = [];
  let rootStat;
  try {
    rootStat = lstatSync(srcRockyHome);
  } catch (error) {
    const code = error && typeof error === "object" ? error.code : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") {
      skippedLinks.push("rocky-home");
      return skippedLinks;
    }
    throw error;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    skippedLinks.push("rocky-home");
    return skippedLinks;
  }
  for (const name of ROCKY_HOME_ALLOWED_FILES) {
    const srcPath = join(srcRockyHome, name);
    let lstat;
    try {
      lstat = lstatSync(srcPath);
    } catch (error) {
      const code = error && typeof error === "object" ? error.code : undefined;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw error;
    }
    if (lstat.isSymbolicLink()) {
      skippedLinks.push(`rocky-home/${name}`);
      continue;
    }
    if (!lstat.isFile()) continue;
    copyFileSync(srcPath, join(destRockyHome, name));
  }
  return skippedLinks;
}

function listNoneRockyHomeEntries(srcRockyHome, lstatFn = lstatSync) {
  const stat = lstatOrNull(srcRockyHome, lstatFn);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return [];
  return readdirSync(srcRockyHome).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function lstatOrNull(targetPath, lstatFn = lstatSync) {
  try {
    return lstatFn(targetPath);
  } catch (error) {
    const code = error && typeof error === "object" ? error.code : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

function recoverInterruptedSwap(runDir, lstatFn = lstatSync) {
  const nextDir = `${runDir}.next`;
  const prevDir = `${runDir}.prev`;
  const hasRun = lstatOrNull(runDir, lstatFn) !== null;
  const hasPrev = lstatOrNull(prevDir, lstatFn) !== null;
  const hasNext = lstatOrNull(nextDir, lstatFn) !== null;

  if (!hasRun && hasPrev) {
    if (hasNext && lstatOrNull(join(nextDir, "run.json"), lstatFn)?.isFile()) {
      renameDirWithRetry(nextDir, runDir);
      removeTreeWithRetry(prevDir);
    } else {
      renameDirWithRetry(prevDir, runDir);
    }
    return;
  }
  if (hasRun && hasPrev) {
    removeTreeWithRetry(prevDir);
  }
}

function readDurableRetries(retriesPath, lstatFn = lstatSync) {
  const stat = lstatOrNull(retriesPath, lstatFn);
  if (!stat) return { present: false, malformed: false, count: null };
  if (!stat.isFile()) return { present: true, malformed: true, count: null };
  try {
    const parsed = JSON.parse(readFileSync(retriesPath, "utf8"));
    if (
      !parsed
      || typeof parsed !== "object"
      || Array.isArray(parsed)
      || !Number.isInteger(parsed.count)
      || parsed.count < 0
    ) {
      return { present: true, malformed: true, count: null };
    }
    return { present: true, malformed: false, count: parsed.count };
  } catch {
    return { present: true, malformed: true, count: null };
  }
}

export function isValidRunJson(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  if (typeof parsed.runId !== "string" || parsed.runId.length === 0) return false;
  if (typeof parsed.taskId !== "string" || parsed.taskId.length === 0) return false;
  if (typeof parsed.arm !== "string" || !ARMS.includes(parsed.arm)) return false;
  if (typeof parsed.block !== "number" || !Number.isFinite(parsed.block)) return false;
  if (!Object.prototype.hasOwnProperty.call(parsed, "invalid")) return false;
  if (
    parsed.invalid !== null
    && (typeof parsed.invalid !== "string" || !VALID_INVALIDS.has(parsed.invalid))
  ) {
    return false;
  }
  if (!Number.isInteger(parsed.retries) || parsed.retries < 0) return false;
  return true;
}

function decideRunAction(runDir, retryInvalid, lstatFn = lstatSync) {
  try {
    recoverInterruptedSwap(runDir, lstatFn);

    const retriesPath = join(runDir, "retries.json");
    const runJsonPath = join(runDir, "run.json");
    const durable = readDurableRetries(retriesPath, lstatFn);
    if (durable.malformed) {
      return { action: "malformed", reason: "malformed or unreadable retries.json" };
    }

    const runJsonStat = lstatOrNull(runJsonPath, lstatFn);
    if (!runJsonStat) {
      if (durable.present && durable.count >= MAX_RETRIES) {
        return { action: "skip", reason: "max-retries" };
      }
      return { action: "run", retries: durable.count ?? 0, isRetry: false };
    }
    if (!runJsonStat.isFile()) {
      return { action: "malformed", reason: "run.json is not a regular file" };
    }

    let existing;
    try {
      existing = JSON.parse(readFileSync(runJsonPath, "utf8"));
    } catch {
      return { action: "malformed", reason: "unreadable or invalid JSON in run.json" };
    }
    if (!isValidRunJson(existing)) {
      return { action: "malformed", reason: "malformed run.json structure" };
    }

    if (!retryInvalid) {
      return { action: "skip", reason: "existing" };
    }
    if (!RETRYABLE_INVALIDS.has(existing.invalid)) {
      return { action: "skip", reason: `invalid=${String(existing.invalid)}` };
    }
    const prevRetries = Math.max(durable.count ?? 0, existing.retries);
    if (prevRetries >= MAX_RETRIES) {
      return { action: "skip", reason: "max-retries" };
    }
    return { action: "run", retries: prevRetries + 1, isRetry: true };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { action: "malformed", reason: `metadata lookup failed: ${msg}` };
  }
}

function hasRunArtifacts(workRunDir, arm, lstatFn = lstatSync) {
  const transcriptOk = lstatOrNull(join(workRunDir, "transcript.jsonl"), lstatFn)?.isFile() === true;
  const stderrOk = lstatOrNull(join(workRunDir, "stderr.txt"), lstatFn)?.isFile() === true;
  const finalOk = lstatOrNull(join(workRunDir, "final"), lstatFn)?.isDirectory() === true;
  const rockyOk = arm === "none"
    ? true
    : lstatOrNull(join(workRunDir, "rocky-home"), lstatFn)?.isDirectory() === true;
  return transcriptOk && stderrOk && finalOk && rockyOk;
}

function swapStagedRunDir(runDir, nextDir, lstatFn = lstatSync) {
  const prevDir = `${runDir}.prev`;
  removeTreeWithRetry(prevDir);
  renameDirWithRetry(runDir, prevDir);
  try {
    renameDirWithRetry(nextDir, runDir);
  } catch (error) {
    if (lstatOrNull(runDir, lstatFn) === null && lstatOrNull(prevDir, lstatFn) !== null) {
      try {
        renameDirWithRetry(prevDir, runDir);
      } catch {
        // Best-effort restore of previous committed run dir.
      }
    }
    throw error;
  }
  removeTreeWithRetry(prevDir);
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

async function defaultRunClaude({ task, sandbox, timeoutMs, stdoutPath, stderrPath, secrets }) {
  const claudeExe = resolveClaudeExecutable(sandbox.env, process.platform);
  return spawnProcess({
    file: claudeExe,
    args: [...CLAUDE_FLAGS, task.prompt],
    cwd: sandbox.taskDir,
    env: sandbox.env,
    timeoutMs,
    stdoutPath,
    stderrPath,
    secrets,
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
 *   auth: { kind: "token" },
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
 *   runClaude: (args: {
 *     runId: string,
 *     task: any,
 *     sandbox: any,
 *     timeoutMs: number,
 *     stdoutPath: string,
 *     stderrPath: string,
 *     secrets: readonly string[],
 *   }) => Promise<any>,
 *   accept: typeof defaultAccept,
 *   destroySandbox: typeof defaultDestroySandbox,
 *   sweepStrays: (sandboxDir: string) => Promise<number>,
 *   assertRootClean: (dir: string) => void,
 *   lstatSync: typeof lstatSync,
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
    sweepStrays: overrides.sweepStrays ?? ((dir) => sweepWin32Strays(dir)),
    assertRootClean: overrides.assertRootClean ?? ((dir) => assertNoAncestorInstructions(dir)),
    lstatSync: overrides.lstatSync ?? lstatSync,
    log: overrides.log ?? ((line) => process.stderr.write(`${line}\n`)),
  };

  if (options.auth?.kind === "copy-credentials") {
    const err = new Error(COPY_CREDENTIALS_DISABLED_MESSAGE);
    err.exitCode = 2;
    throw err;
  }
  if (options.auth?.kind !== "token") {
    const err = new Error("--auth must be 'token'");
    err.exitCode = 2;
    throw err;
  }

  const secrets = normalizeSecrets(Array.isArray(options.secrets) ? options.secrets : []);
  const redact = (value) => redactText(value, secrets);

  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const k = options.k ?? DEFAULT_K;
  if (!Number.isInteger(k) || k < 1 || k > MAX_K) {
    const err = new RangeError(
      `--k must be an integer in 1..${MAX_K} (got ${String(k)}; exact per-task mean sign-flip grids require k <= ${MAX_K})`,
    );
    err.exitCode = 2;
    throw err;
  }
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

  const currentProvenance = {
    beforeSha,
    afterSha,
    model: MODEL,
    claudeFlags: [...CLAUDE_FLAGS],
    claudeVersion,
    evaluatorCommit,
    taskSetSha256: deps.manifest.taskSetSha256,
    seed,
    k,
    taskIds,
  };

  const batchPath = join(outDir, "batch.json");
  if (existsSync(batchPath)) {
    let existingBatch;
    try {
      existingBatch = JSON.parse(readFileSync(batchPath, "utf8"));
    } catch {
      throw new ProvenanceMismatchError(
        `Unable to read or parse existing batch provenance at ${batchPath}`,
        ["batch.json"],
      );
    }
    const diffs = diffBatchProvenance(existingBatch, currentProvenance);
    if (diffs.length > 0) {
      throw new ProvenanceMismatchError(
        `Batch provenance mismatch (${batchPath}); differing fields: ${diffs.join(", ")}`,
        diffs,
      );
    }
  } else {
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

  const runsDir = join(outDir, "runs");
  mkdirSync(runsDir, { recursive: true });

  /** @type {Array<{ item: typeof planned[number], retries: number, isRetry: boolean }>} */
  const pending = [];
  let skipped = 0;
  let malformed = 0;
  for (const item of planned) {
    const runDir = join(runsDir, item.runId);
    const decision = decideRunAction(runDir, retryInvalid, deps.lstatSync);
    if (decision.action === "run") {
      pending.push({ item, retries: decision.retries, isRetry: decision.isRetry });
    } else if (decision.action === "malformed") {
      malformed += 1;
      deps.log(redact(`[eval] skipping malformed run ${item.runId}: ${decision.reason}`));
    } else {
      skipped += 1;
    }
  }

  if (pending.length === 0) {
    deps.log(
      redact(`[eval] 0 runs to execute (${skipped} skipped, ${malformed} malformed).`),
    );
    return {
      batchPath,
      total: planned.length,
      ran: 0,
      skipped,
      malformed,
      publishFailed: 0,
    };
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
  let publishFailed = 0;
  await runWithConcurrency(pending, concurrency, async ({ item, retries, isRetry }) => {
    const task = taskById.get(item.taskId);
    const runDir = join(runsDir, item.runId);
    const nextDir = `${runDir}.next`;
    const workRunDir = isRetry ? nextDir : runDir;
    const retriesJsonPath = join(workRunDir, "retries.json");
    const runJsonPath = join(workRunDir, "run.json");
    const stdoutPath = join(workRunDir, "transcript.jsonl");
    const stderrPath = join(workRunDir, "stderr.txt");
    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    const sandboxRunId = `${item.runId}-${randomBytes(3).toString("hex")}`;

    let sandbox = null;
    let tokenLeaked = false;

    let retryCountCommitted = !isRetry;
    /** @type {number | null} */
    let exitCode = null;
    let timedOut = false;
    let killFailed = false;
    /** @type {number | null} */
    let taskkillStatus = null;
    let strayKilled = 0;
    let swept = false;
    /** @type {string[]} */
    const skippedLinks = [];
    /** @type {string[] | null} */
    let noneRockyHomeEntries = item.arm === "none" ? [] : null;
    /** @type {{ solved: boolean, reason: string } | null} */
    let acceptResult = null;
    /** @type {null | "api_error" | "timeout" | "harness_crash" | "transcript_broken" | "token_leak"} */
    let invalid = null;
    /** @type {string | null} */
    let runError = null;
    /** @type {string | null} */
    let cleanupError = null;

    try {
      if (isRetry) {
        // Persist incremented retry count BEFORE launching the retry so crashes cannot reset the cap.
        writeJsonAtomic(join(runDir, "retries.json"), { count: retries }, secrets);
        retryCountCommitted = true;
        removeTreeWithRetry(workRunDir);
        mkdirSync(workRunDir, { recursive: true });
        writeJsonAtomic(retriesJsonPath, { count: retries }, secrets);
      } else {
        removeTreeWithRetry(runDir);
        mkdirSync(runDir, { recursive: true });
        writeJsonAtomic(retriesJsonPath, { count: retries }, secrets);
      }

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
        stdoutPath,
        stderrPath,
        secrets,
      });
      exitCode = claudeRes.exitCode ?? null;
      timedOut = Boolean(claudeRes.timedOut);
      killFailed = Boolean(claudeRes.killFailed);
      taskkillStatus = typeof claudeRes.taskkillStatus === "number" ? claudeRes.taskkillStatus : null;
      if (claudeRes.streamed === true && claudeRes.tokenLeaked) {
        tokenLeaked = true;
      }

      // Sweep stray descendants right after Claude finishes so locks are released before copy/cleanup.
      swept = true;
      strayKilled = await deps.sweepStrays(sandbox.dir);

      let transcriptSummary;
      if (claudeRes.streamed === true) {
        transcriptSummary = claudeRes.transcript;
      } else {
        const outWriter = createRedactingFileWriter(stdoutPath, secrets);
        const errWriter = createRedactingFileWriter(stderrPath, secrets);
        const parser = createTranscriptParser();
        const rawStdout = String(claudeRes.stdout ?? "");
        const rawStderr = String(claudeRes.stderr ?? "");
        outWriter.write(rawStdout);
        parser.write(rawStdout);
        errWriter.write(rawStderr);
        const [outRes, errRes] = await Promise.all([outWriter.end(), errWriter.end()]);
        transcriptSummary = parser.end();
        if (outRes.leaked || errRes.leaked) {
          tokenLeaked = true;
        }
      }

      const finalDir = join(workRunDir, "final");
      skippedLinks.push(...copyFinalWithoutGit(sandbox.taskDir, finalDir));
      if (item.arm === "none") {
        noneRockyHomeEntries = listNoneRockyHomeEntries(sandbox.rockyHome, deps.lstatSync);
      }
      skippedLinks.push(...copyRockyHomeFiles(sandbox.rockyHome, join(workRunDir, "rocky-home"), item.arm));

      if (await scanRunArtifactsForSecrets(workRunDir, item.arm, secrets)) {
        tokenLeaked = true;
      }

      invalid = classifyOutcome({
        transcript: transcriptSummary,
        tokenLeaked,
        timedOut,
      });

      acceptResult = await deps.accept(task, finalDir, { manifest: deps.manifest });
    } catch (error) {
      if (sandbox && !swept) {
        swept = true;
        try {
          strayKilled = await deps.sweepStrays(sandbox.dir);
        } catch {
          // Best-effort stray sweep during crash cleanup.
        }
      }
      runError = redact(error instanceof Error ? error.message : String(error));
      if (tokenLeaked || invalid === "token_leak") {
        invalid = "token_leak";
      } else {
        invalid = "harness_crash";
      }
    }

    // Always clean up the sandbox BEFORE publishing run.json.
    if (sandbox) {
      try {
        await deps.destroySandbox(sandbox);
      } catch (error) {
        cleanupError = redact(error instanceof Error ? error.message : String(error));
        deps.log(`[eval] warning: destroySandbox failed for ${item.runId}: ${cleanupError}`);
      }
    }

    // Check artifact/retry metadata and publish inside one guard so any metadata or write
    // error logs, increments publishFailed, and never rejects the worker pool.
    try {
      const artifactsExist = hasRunArtifacts(workRunDir, item.arm, deps.lstatSync);
      if (runError === null && !artifactsExist) {
        if (invalid !== "token_leak") {
          invalid = "harness_crash";
        }
        runError = "run artifacts are incomplete";
      }

      const durableRetryInfo = readDurableRetries(retriesJsonPath, deps.lstatSync);
      const recordedRetries = !durableRetryInfo.malformed && durableRetryInfo.present
        ? durableRetryInfo.count
        : retries;

      /** @type {Record<string, unknown>} */
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
        retries: recordedRetries,
        skippedLinks,
        strayKilled,
        killFailed,
        taskkillStatus,
      };
      if (item.arm === "none") {
        record.noneRockyHomeEntries = noneRockyHomeEntries ?? [];
      }
      if (runError !== null) {
        record.error = runError;
      }
      if (cleanupError !== null) {
        record.cleanupError = cleanupError;
      }

      if (isRetry && !retryCountCommitted) {
        throw new Error(`retry count could not be persisted in ${runDir}`);
      }
      mkdirSync(workRunDir, { recursive: true });
      writeJsonAtomic(runJsonPath, record, secrets);
      if (isRetry) {
        swapStagedRunDir(runDir, workRunDir, deps.lstatSync);
      }
      completed += 1;
      if (runError !== null) {
        deps.log(
          redact(
            `[eval ${completed}/${pending.length}] ${item.runId}: invalid=${String(invalid)} (${runError})`,
          ),
        );
      } else {
        deps.log(
          redact(
            `[eval ${completed}/${pending.length}] ${item.runId}: solved=${acceptResult?.solved} invalid=${String(invalid)} (${record.wallMs}ms)`,
          ),
        );
      }
    } catch (publishError) {
      publishFailed += 1;
      const msg = redact(publishError instanceof Error ? publishError.message : String(publishError));
      deps.log(`[eval] error: failed to publish run.json for ${item.runId}: ${msg}`);
    }
  });

  deps.log(
    redact(
      `[eval] summary: total=${planned.length} ran=${completed} skipped=${skipped} malformed=${malformed} publishFailed=${publishFailed}`,
    ),
  );
  return {
    batchPath,
    total: planned.length,
    ran: completed,
    skipped,
    malformed,
    publishFailed,
  };
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

function parseBlockCount(raw) {
  if (!/^-?\d+$/.test(raw)) {
    usageError(`--k must be an integer in 1..${MAX_K} (got ${raw})`);
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_K) {
    usageError(
      `--k must be an integer in 1..${MAX_K} (got ${raw}; exact per-task mean sign-flip grids require k <= ${MAX_K})`,
    );
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
    else if (arg === "--k") opts.k = parseBlockCount(takeValue("--k"));
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

  if (opts.auth === "copy-credentials") {
    process.stderr.write(`Error: ${COPY_CREDENTIALS_DISABLED_MESSAGE}\n`);
    process.exit(2);
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
  if (opts.auth !== "token") {
    usageError("--auth must be 'token'");
  }
  if (opts.from) {
    usageError("--from is not supported: batches use --auth token only");
  }

  const token = process.env.ROCKY_EVAL_OAUTH_TOKEN;
  if (typeof token !== "string" || token.length === 0) {
    process.stderr.write(
      "Error: ROCKY_EVAL_OAUTH_TOKEN is missing or empty in environment (required for --auth token).\n",
    );
    process.exit(2);
  }
  const secrets = [token];
  /** @type {{ kind: "token" }} */
  const auth = { kind: "token" };

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
    if (error && typeof error === "object" && typeof error.exitCode === "number") {
      const msg = redactText(error instanceof Error ? error.message : String(error), secrets);
      process.stderr.write(`Error: ${msg}\n`);
      process.exitCode = error.exitCode;
      return;
    }
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
