import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  constants as fsConstants,
  copyFileSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { open as openFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { accept as defaultAccept } from "./accept.mjs";
import { getEvalDriver, getEvalToken, savedEvalProvider } from "./drivers/index.mjs";
import { materializeTask as defaultMaterializeTask, renderInstructions } from "./history.mjs";
import {
  ownerBaseline as defaultOwnerBaseline,
  ownerCheck as defaultOwnerCheck,
} from "./owner-guard.mjs";
import {
  assertNoAncestorInstructions,
  assertOutsideWorkspace,
  buildCommandInvocation,
  buildToolEnv,
  createSandbox as defaultCreateSandbox,
  destroySandbox as defaultDestroySandbox,
  packArm as defaultPackArm,
  redactText,
  resolveExecutableOnPath,
  resolveProviderExecutable,
} from "./sandbox.mjs";

const EVAL_DIR = resolve(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = resolve(EVAL_DIR, "..", "..");
const MANIFEST_PATH = join(EVAL_DIR, "tasks", "manifest.json");

export const ARMS = ["none", "before", "after"];
export const TASK_SETS = ["v1", "v2"];
const VALID_SETS = new Set(TASK_SETS);
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
  "Usage: node scripts/eval/runner.mjs --set <v1|v2> --out <dir> --before <sha> --after <sha>",
  "         --auth token [--arms <none,before,after>] [--concurrency <n>] [--root <dir>] [--cache <dir>]",
  "         [--k <n>] [--seed <n>] [--only <id1,id2,...>] [--retry-invalid]",
  "",
  "Options:",
  "  --provider <name>      claude-code (default) or codex",
  "  --set <v1|v2>          Task set to run: 'v1' or 'v2' (required)",
  "  --arms <list>          Comma-separated arms to schedule (subset of none,before,after; default: none,before,after)",
  "  --out <dir>            Output directory (must lie outside repo and enclosing workspace)",
  "  --before <sha>         Git commit/ref for the 'before' Rocky arm",
  "  --after <sha>          Git commit/ref for the 'after' Rocky arm",
  "  --auth token           Claude uses ROCKY_EVAL_OAUTH_TOKEN. Codex uses ROCKY_EVAL_CODEX_API_KEY or ROCKY_EVAL_OPENAI_API_KEY.",
  `  --concurrency <n>      Concurrent runs (default: ${DEFAULT_CONCURRENCY})`,
  "  --root <dir>           Sandbox root directory (default: <os.tmpdir>/rocky-eval)",
  "  --cache <dir>          Tarball pack cache directory (default: <out>/../pack-cache; must be outside workspace)",
  `  --k <n>                Number of randomized blocks (1..${MAX_K}, default: ${DEFAULT_K})`,
  `  --seed <n>             PRNG seed for schedule shuffling (default: ${DEFAULT_SEED})`,
  "  --only <ids>           Comma-separated task IDs to run (default: all manifest tasks in the set except SMOKE)",
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

export class BatchLeakError extends Error {
  /**
   * @param {string} message
   * @param {{ tokenLeakRuns?: string[], ownerCheck?: any, halted?: any, summary?: any }} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = "BatchLeakError";
    this.exitCode = 3;
    this.tokenLeakRuns = details.tokenLeakRuns ?? [];
    this.ownerCheck = details.ownerCheck ?? null;
    this.halted = details.halted ?? null;
    this.summary = details.summary ?? null;
  }
}

export class BatchIncompleteError extends Error {
  /**
   * @param {string} message
   * @param {{ incomplete?: { malformed: number, publishFailed: number, missing: number }, summary?: any }} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = "BatchIncompleteError";
    this.exitCode = 4;
    this.incomplete = details.incomplete ?? null;
    this.summary = details.summary ?? null;
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

export function validateTaskSet(rawSet) {
  if (typeof rawSet !== "string" || rawSet.trim().length === 0) {
    const err = new Error("--set <v1|v2> is required");
    /** @type {any} */ (err).exitCode = 2;
    throw err;
  }
  const trimmed = rawSet.trim();
  if (!VALID_SETS.has(trimmed)) {
    const err = new Error(`--set must be 'v1' or 'v2' (got ${rawSet})`);
    /** @type {any} */ (err).exitCode = 2;
    throw err;
  }
  return trimmed;
}

export function parseArms(rawArms) {
  if (rawArms === undefined || rawArms === null) {
    return [...ARMS];
  }
  if (typeof rawArms === "string" && rawArms.trim().length === 0) {
    const err = new Error(`--arms requires at least one arm (${ARMS.join(", ")})`);
    /** @type {any} */ (err).exitCode = 2;
    throw err;
  }
  const parts = Array.isArray(rawArms)
    ? rawArms.map((item) => (typeof item === "string" ? item.trim() : String(item ?? "").trim()))
    : String(rawArms).split(",").map((item) => item.trim());
  if (parts.length === 0) {
    const err = new Error(`--arms requires at least one arm (${ARMS.join(", ")})`);
    /** @type {any} */ (err).exitCode = 2;
    throw err;
  }
  const selected = [];
  const seen = new Set();
  for (const arm of parts) {
    if (arm.length === 0) {
      const err = new Error(`Empty arm in --arms (expected subset of ${ARMS.join(",")})`);
      /** @type {any} */ (err).exitCode = 2;
      throw err;
    }
    if (!ARMS.includes(arm)) {
      const err = new Error(`Invalid arm in --arms: ${arm} (expected subset of ${ARMS.join(",")})`);
      /** @type {any} */ (err).exitCode = 2;
      throw err;
    }
    if (seen.has(arm)) {
      const err = new Error(`Duplicate arm in --arms: ${arm}`);
      /** @type {any} */ (err).exitCode = 2;
      throw err;
    }
    seen.add(arm);
    selected.push(arm);
  }
  return selected;
}

/**
 * Filter manifest tasks by set (default `"v1"`) and optional `--only` IDs.
 * Defaults to all tasks in the set except `SMOKE`.
 * @param {readonly any[]} manifestTasks
 * @param {readonly string[] | null | undefined} onlyIds
 * @param {string | null | undefined} [setName]
 * @returns {any[]}
 */
export function selectTasks(manifestTasks, onlyIds, setName = "v1") {
  const effectiveSet = setName !== undefined && setName !== null ? validateTaskSet(setName) : null;
  const pool = effectiveSet
    ? manifestTasks.filter((task) => (task.set ?? "v1") === effectiveSet)
    : manifestTasks;
  if (!onlyIds || onlyIds.length === 0) {
    return pool.filter((task) => task.id !== "SMOKE");
  }
  const byId = new Map(pool.map((task) => [task.id, task]));
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

function createStreamSecretScanner(secrets, onLeak) {
  const needles = secrets.map((secret) => Buffer.from(secret, "utf8"));
  const holdback = Math.max(1, ...needles.map((needle) => needle.length)) - 1;
  let tail = Buffer.alloc(0);
  let leaked = false;
  return {
    consume(chunk) {
      if (leaked || needles.length === 0) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      const combined = tail.length > 0 ? Buffer.concat([tail, bytes]) : bytes;
      leaked = containsAnySecretBuffer(combined, needles);
      if (leaked) {
        tail = Buffer.alloc(0);
        onLeak?.();
      } else if (holdback > 0) {
        tail = Buffer.from(combined.subarray(Math.max(0, combined.length - holdback)));
      }
    },
    getLeaked: () => leaked,
  };
}

/**
 * Incremental streaming file writer that redacts secrets split across chunk boundaries
 * by holding back `maxSecretLength - 1` characters between writes, preserving UTF-16
 * surrogate pairs and propagating writable backpressure.
 * @param {string} filePath
 * @param {readonly string[]} [secrets]
 * @param {{ stream?: import("node:stream").Writable, onLeak?: () => void }} [options]
 */
export function createRedactingFileWriter(filePath, secrets = [], options = {}) {
  const normalizedSecrets = normalizeSecrets(secrets);
  const maxSecretLen = normalizedSecrets.reduce((max, s) => Math.max(max, s.length), 0);
  const holdback = maxSecretLen > 1 ? maxSecretLen - 1 : 0;
  const scanner = createStreamSecretScanner(normalizedSecrets, options.onLeak);
  const secretPattern = normalizedSecrets.length > 0
    ? new RegExp(normalizedSecrets.map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g")
    : null;
  const decoder = new StringDecoder("utf8");
  const stream = options.stream ?? createWriteStream(filePath, { encoding: "utf8" });

  let pending = "";
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

  function takeRedactedPrefix(text, end) {
    if (!secretPattern) return { output: text.slice(0, end), end };
    let from = 0;
    let output = "";
    secretPattern.lastIndex = 0;
    for (let match = secretPattern.exec(text); match && match.index < end; match = secretPattern.exec(text)) {
      output += text.slice(from, match.index) + "<redacted>";
      from = secretPattern.lastIndex;
      end = Math.max(end, from);
    }
    return { output: output + text.slice(from, end), end };
  }

  /**
   * @param {Buffer | string} chunk
   * @returns {boolean}
   */
  function write(chunk) {
    if (ended) return true;
    scanner.consume(chunk);
    const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
    if (text.length === 0) return true;
    const combined = pending + text;
    let splitAt = combined.length - holdback;
    if (splitAt <= 0) {
      pending = combined;
      return true;
    }
    // Never split a UTF-16 surrogate pair at the holdback boundary.
    const boundaryCodeUnit = combined.charCodeAt(splitAt - 1);
    if (boundaryCodeUnit >= 0xd800 && boundaryCodeUnit <= 0xdbff) {
      splitAt -= 1;
    }
    if (splitAt <= 0) {
      pending = combined;
      return true;
    }
    const { output: flush, end } = takeRedactedPrefix(combined, splitAt);
    pending = combined.slice(end);
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
      const { output: finalChunk } = takeRedactedPrefix(tail, tail.length);
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
    return { leaked: scanner.getLeaked() };
  }

  return {
    write,
    end,
    onceDrain,
    getLeaked: scanner.getLeaked,
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
export function createTranscriptParser(maxLineBytes = MAX_TRANSCRIPT_LINE_BYTES, provider) {
  const { summarizeResult } = getEvalDriver(provider);
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
    lastResult = summarizeResult(parsed) ?? lastResult;
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
 * Classify a completed provider subprocess run into `invalid` status or `null`.
 * Accepts either streaming summary `{ transcript, tokenLeaked, timedOut }` or raw strings.
 * @param {{
 *   transcript?: { nonEmptyLines: number, malformedLineCount: number, oversizedLineCount: number, lastResult: { subtype: unknown, is_error: unknown } | null },
 *   tokenLeaked?: boolean,
 *   rawStdout?: string,
 *   rawStderr?: string,
 *   exitCode?: number | null,
 *   provider?: import("./drivers/index.mjs").EvalProvider,
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
  provider,
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
    const parser = createTranscriptParser(undefined, provider);
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
 * @param {any} current
 * @returns {string[]}
 */
export function diffBatchProvenance(existing, current) {
  /** @type {string[]} */
  const diffs = [];
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
    return ["batch.json"];
  }
  if (savedEvalProvider(existing) !== savedEvalProvider(current)) return ["provider"];

  const normalize = (data) => data.provider === undefined ? {
    ...data,
    cliVersion: data.cliVersion ?? data.claudeVersion,
    flags: data.flags ?? data.claudeFlags,
    lanes: data.lanes ?? getEvalDriver("claude-code").lanes,
    instructionsSha256: data.instructionsSha256 ?? data.claudeMdSha256,
  } : data;
  const saved = normalize(existing);
  const requested = normalize(current);
  const existingSet = existing.set === undefined ? "v1" : existing.set;
  const currentSet = current.set === undefined ? "v1" : current.set;
  if (existingSet !== currentSet) {
    diffs.push("set");
  }
  const scalarFields = [
    "beforeSha",
    "afterSha",
    "model",
    "cliVersion",
    "evaluatorCommit",
    "taskSetSha256",
    "seed",
    "k",
  ];
  for (const field of scalarFields) {
    if (saved[field] !== requested[field]) {
      diffs.push(field);
    }
  }
  const arrayFields = ["flags", "lanes", "arms", "taskIds"];
  for (const field of arrayFields) {
    const a = saved[field];
    const b = requested[field];
    const same = Array.isArray(a)
      && Array.isArray(b)
      && a.length === b.length
      && a.every((val, idx) => val === b[idx]);
    if (!same) {
      diffs.push(field);
    }
  }
  const savedHashes = saved.instructionsSha256 ?? {};
  const requestedHashes = requested.instructionsSha256 ?? {};
  const hashKeys = new Set([...Object.keys(savedHashes), ...Object.keys(requestedHashes)]);
  if ([...hashKeys].some((key) => savedHashes[key] !== requestedHashes[key])) {
    diffs.push("instructionsSha256");
  }
  return diffs;
}

function readBatchProvenance(batchPath) {
  let data;
  try {
    data = JSON.parse(readFileSync(batchPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new ProvenanceMismatchError(
      `Unable to read or parse existing batch provenance at ${batchPath}`,
      ["batch.json"],
    );
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new ProvenanceMismatchError(
      `Batch provenance mismatch (${batchPath}); differing fields: batch.json`,
      ["batch.json"],
    );
  }
  return data;
}

function assertSavedProvider(existing, provider, batchPath) {
  if (existing && savedEvalProvider(existing) !== provider) {
    throw new ProvenanceMismatchError(
      `Batch provenance mismatch (${batchPath}); differing fields: provider`,
      ["provider"],
    );
  }
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
  provider,
  onLeak,
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
        stdoutWriter = createRedactingFileWriter(stdoutPath, secrets, { onLeak });
        stderrWriter = createRedactingFileWriter(stderrPath, secrets, { onLeak });
        transcriptParser = createTranscriptParser(maxTranscriptLineBytes, provider);
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

function removeFileWithRetry(target, rmFn = rmSync) {
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      rmFn(target, { force: true });
      return;
    } catch (error) {
      lastError = error;
      const code = error && typeof error === "object" ? error.code : undefined;
      if (code !== "EBUSY" && code !== "EPERM" && code !== "EACCES") throw error;
      if (attempt < 5) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 75 * (attempt + 1));
      }
    }
  }
  if (lastError) throw lastError;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
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

function pickUniqueQuarantineTarget(filePath, relPath, lstatFn = lstatSync) {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const suffix = `.quarantined-${process.pid}-${randomBytes(6).toString("hex")}`;
    const candidatePath = `${filePath}${suffix}`;
    if (lstatOrNull(candidatePath, lstatFn) === null) {
      return {
        renamedPath: candidatePath,
        renamedRelPath: `${relPath}${suffix}`,
      };
    }
  }
  throw new Error(`unable to allocate unique quarantine target for ${relPath}`);
}

async function fileContainsAnySecret(filePath, secretBuffers, openFn, onMatch, stage) {
  if (secretBuffers.length === 0) return false;
  const maxSecretLen = secretBuffers.reduce((max, buf) => Math.max(max, buf.length), 0);
  const holdback = maxSecretLen > 1 ? maxSecretLen - 1 : 0;
  const chunkSize = Math.max(64 * 1024, maxSecretLen * 2);
  const readBuf = Buffer.allocUnsafe(chunkSize);
  let tail = Buffer.alloc(0);

  const flags = stage
    ? fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0)
    : "r";
  const fh = await openFn(filePath, flags);
  try {
    let opened;
    if (stage) {
      opened = await fh.stat();
      if (!opened.isFile() || opened.dev !== stage.stat.dev || opened.ino !== stage.stat.ino) {
        throw new Error("artifact source changed before it could be read");
      }
    }
    let scannedBytes = 0;
    while (!opened || scannedBytes < opened.size) {
      const limit = opened ? Math.min(chunkSize, opened.size - scannedBytes) : chunkSize;
      const { bytesRead } = await fh.read(readBuf, 0, limit, null);
      if (bytesRead === 0) break;
      scannedBytes += bytesRead;
      const chunk = readBuf.subarray(0, bytesRead);
      const combined = tail.length > 0 ? Buffer.concat([tail, chunk]) : chunk;
      if (containsAnySecretBuffer(combined, secretBuffers)) {
        if (typeof onMatch === "function") {
          onMatch();
        }
        return true;
      }
      if (stage) await stage.file.writeFile(chunk);
      if (holdback > 0) {
        const keep = Math.min(holdback, combined.length);
        tail = Buffer.from(combined.subarray(combined.length - keep));
      }
    }
    if (opened) {
      const after = await fh.stat();
      if (scannedBytes !== opened.size || after.size !== opened.size
        || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
        throw new Error("artifact source changed during the scan");
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
 * Calls `io.onHit(relPath)` synchronously on the first token match before reading any further
 * file. Every file containing a secret is deleted from `workRunDir` and its POSIX-style
 * relative path is recorded in `quarantined` (never contents). If deletion fails after retries,
 * the file is truncated to zero bytes (or renamed to a fresh unique
 * `<name>.quarantined-<pid>-<random>` path inside the run dir without replacing any existing
 * entry and truncated if direct truncation fails) and recorded in `quarantined` as
 * `{ path, removed: false, error }` (redacted message only).
 * Records unreadable files/directories (or files that could neither be removed nor truncated)
 * as relative paths in `scanErrors` and continues scanning all remaining artifacts.
 * @param {string} workRunDir
 * @param {string} arm
 * @param {readonly string[]} secrets
 * @param {{
 *   lstatSync?: typeof lstatSync,
 *   readdirSync?: typeof readdirSync,
 *   openFile?: typeof openFile,
 *   rmSync?: typeof rmSync,
 *   unlinkSync?: (path: string) => void,
 *   truncateSync?: typeof truncateSync,
 *   renameSync?: typeof renameSync,
 *   onHit?: (relPath: string) => void,
 * }} [io]
 * @returns {Promise<{
 *   leaked: boolean,
 *   quarantined: Array<string | { path: string, removed: false, error: string }>,
 *   scanErrors: string[],
 * }>}
 */
export async function scanRunArtifactsForSecrets(workRunDir, arm, secrets, io = {}) {
  const normalizedSecrets = normalizeSecrets(secrets);
  const secretBuffers = normalizedSecrets.map((s) => Buffer.from(s, "utf8"));
  if (secretBuffers.length === 0) {
    return { leaked: false, quarantined: [], scanErrors: [] };
  }

  const lstatFn = io.lstatSync ?? lstatSync;
  const readdirFn = io.readdirSync ?? readdirSync;
  const openFn = io.openFile ?? openFile;
  const rmFn = io.rmSync ?? io.unlinkSync ?? rmSync;
  const truncateFn = io.truncateSync ?? truncateSync;
  const renameFn = io.renameSync ?? renameSync;
  const onHitFn = typeof io.onHit === "function" ? io.onHit : null;

  let leaked = false;
  let notifiedHit = false;
  /** @type {Array<string | { path: string, removed: false, error: string }>} */
  const quarantined = [];
  /** @type {string[]} */
  const scanErrors = [];

  function notifyHit(relPath) {
    leaked = true;
    if (!notifiedHit) {
      notifiedHit = true;
      if (onHitFn) {
        try {
          onHitFn(relPath);
        } catch {
          // Callback failures must not prevent quarantining or scanning remaining files.
        }
      }
    }
  }

  async function scanAndQuarantineFile(filePath, relPath) {
    let containsSecret = false;
    try {
      containsSecret = await fileContainsAnySecret(
        filePath,
        secretBuffers,
        openFn,
        () => notifyHit(relPath),
      );
    } catch {
      scanErrors.push(relPath);
      return;
    }
    if (!containsSecret) return;
    notifyHit(relPath);
    try {
      removeFileWithRetry(filePath, rmFn);
      quarantined.push(relPath);
      return;
    } catch (rmError) {
      const errorParts = [errorMessage(rmError)];
      let finalRelPath = relPath;
      let neutralized = false;

      // Fallback 1: truncate in place to zero bytes.
      try {
        truncateFn(filePath, 0);
        neutralized = true;
      } catch (truncError) {
        errorParts.push(`truncate failed: ${errorMessage(truncError)}`);

        // Fallback 2: rename to a fresh unique <name>.quarantined-<pid>-<random> target
        // inside the run dir without replacing any existing entry, then truncate to zero bytes.
        try {
          const { renamedPath, renamedRelPath } = pickUniqueQuarantineTarget(filePath, relPath, lstatFn);
          renameFn(filePath, renamedPath);
          finalRelPath = renamedRelPath;
          try {
            truncateFn(renamedPath, 0);
            neutralized = true;
          } catch (postRenameTruncError) {
            errorParts.push(`post-rename truncate failed: ${errorMessage(postRenameTruncError)}`);
          }
        } catch (renameError) {
          errorParts.push(`rename failed: ${errorMessage(renameError)}`);
        }
      }

      if (!neutralized) {
        scanErrors.push(finalRelPath);
      }
      quarantined.push({
        path: finalRelPath,
        removed: false,
        error: redactText(errorParts.join("; "), normalizedSecrets),
      });
    }
  }

  async function scanSingleFile(filePath, relPath) {
    let stat;
    try {
      stat = lstatOrNull(filePath, lstatFn);
    } catch {
      scanErrors.push(relPath);
      return;
    }
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) return;
    await scanAndQuarantineFile(filePath, relPath);
  }

  async function scanTree(dirPath, relPrefix, recursive) {
    let rootStat;
    try {
      rootStat = lstatOrNull(dirPath, lstatFn);
    } catch {
      scanErrors.push(relPrefix);
      return;
    }
    if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) return;

    let entries;
    try {
      entries = readdirFn(dirPath).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    } catch {
      scanErrors.push(relPrefix);
      return;
    }

    for (const name of entries) {
      const fullPath = join(dirPath, name);
      const relPath = `${relPrefix}/${name}`;
      if (containsAnySecret(relPath, normalizedSecrets)) {
        const redactedPath = redactText(relPath, normalizedSecrets);
        notifyHit(redactedPath);
        try {
          rmFn(fullPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 75 });
          quarantined.push(redactedPath);
        } catch (error) {
          scanErrors.push(redactedPath);
          quarantined.push({
            path: redactedPath,
            removed: false,
            error: redactText(errorMessage(error), normalizedSecrets),
          });
        }
        continue;
      }
      let stat;
      try {
        stat = lstatFn(fullPath);
      } catch {
        scanErrors.push(relPath);
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (recursive) {
          await scanTree(fullPath, relPath, true);
        }
      } else if (stat.isFile()) {
        await scanAndQuarantineFile(fullPath, relPath);
      }
    }
  }

  const topLevelTranscripts = new Set(["transcript.jsonl"]);
  const topLevelStderrs = new Set(["stderr.txt"]);
  try {
    const rootStat = lstatOrNull(workRunDir, lstatFn);
    if (rootStat && !rootStat.isSymbolicLink() && rootStat.isDirectory()) {
      for (const name of readdirFn(workRunDir)) {
        if (name.startsWith("transcript.jsonl.quarantined")) {
          topLevelTranscripts.add(name);
        } else if (name.startsWith("stderr.txt.quarantined")) {
          topLevelStderrs.add(name);
        }
      }
    }
  } catch {
    scanErrors.push(".");
    // Still scan canonical top-level stream files if listing workRunDir fails.
  }
  for (const name of [
    ...Array.from(topLevelTranscripts).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    ...Array.from(topLevelStderrs).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  ]) {
    await scanSingleFile(join(workRunDir, name), name);
  }
  await scanTree(join(workRunDir, "final"), "final", true);
  await scanTree(join(workRunDir, "rocky-home"), "rocky-home", false);

  return { leaked, quarantined, scanErrors };
}

/**
 * Publish only checked artifacts. Stage the bytes being scanned outside the
 * output tree so a source edit between the scan and copy cannot leak.
 */
async function publishSandboxArtifacts(sandbox, workRunDir, arm, secrets, deps, handlers) {
  const needles = secrets.map((secret) => Buffer.from(secret, "utf8"));
  let scratch;

  async function publishFile(source, target, relPath, stat) {
    if (needles.length === 0) {
      deps.copyFileSync(source, target);
      return;
    }
    scratch ??= mkdtempSync(join(tmpdir(), "rocky-eval-artifact-"));
    const staged = join(scratch, basename(target));
    try {
      const file = await openFile(staged, "wx", 0o600);
      try {
        if (await fileContainsAnySecret(source, needles, deps.openFile, () => handlers.onLeak(relPath), { file, stat })) {
          return;
        }
        if (process.platform !== "win32") await file.chmod(stat.mode & 0o777);
      } finally {
        await file.close();
      }
      deps.copyFileSync(staged, target);
    } finally {
      rmSync(staged, { force: true });
    }
  }

  async function walk(source, relPath, allowedFiles) {
    try {
      const target = join(workRunDir, relPath);
      mkdirSync(target, { recursive: true });
      const rootStat = lstatOrNull(source, deps.lstatSync);
      if (!rootStat?.isDirectory()) {
        handlers.skippedLinks.push(relPath);
        handlers.onError(relPath);
        return;
      }
      const names = allowedFiles ?? deps.readdirSync(source).sort();
      for (const name of names) {
        if (name === ".git") continue;
        const child = `${relPath}/${name}`;
        if (!allowedFiles && containsAnySecret(child, secrets)) {
          handlers.onLeak(child);
          continue;
        }
        const src = join(source, name);
        try {
          const stat = allowedFiles ? lstatOrNull(src, deps.lstatSync) : deps.lstatSync(src);
          if (!stat) continue;
          if (containsAnySecret(child, secrets)) {
            handlers.onLeak(child);
          } else if (stat.isSymbolicLink()) {
            handlers.skippedLinks.push(child);
          } else if (stat.isDirectory() && !allowedFiles) {
            await walk(src, child);
          } else if (stat.isFile()) {
            await publishFile(src, join(target, name), child, stat);
          }
        } catch (error) {
          handlers.onError(child, error);
        }
      }
    } catch (error) {
      handlers.onError(relPath, error);
    }
  }

  try {
    await walk(sandbox.taskDir, "final");
    if (arm !== "none") await walk(sandbox.rockyHome, "rocky-home", ROCKY_HOME_ALLOWED_FILES);
  } finally {
    if (scratch) removeTreeWithRetry(scratch);
  }
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
  const nextStat = lstatOrNull(nextDir, lstatFn);
  const hasNextDir = nextStat !== null && !nextStat.isSymbolicLink() && nextStat.isDirectory();

  if (!hasRun) {
    if (hasNextDir && lstatOrNull(join(nextDir, "run.json"), lstatFn)?.isFile()) {
      renameDirWithRetry(nextDir, runDir);
      if (hasPrev) {
        removeTreeWithRetry(prevDir);
      }
      return;
    }
    if (hasPrev) {
      renameDirWithRetry(prevDir, runDir);
    }
    return;
  }
  if (hasPrev) {
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

function decideRunAction(runDir, provider, retryInvalid, lstatFn = lstatSync) {
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
    if (savedEvalProvider(existing) !== provider) {
      return { action: "malformed", reason: `run.json provider mismatch (expected ${provider})` };
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

function hasRunArtifacts(workRunDir, arm, lstatFn = lstatSync, quarantinedSet = null) {
  const transcriptOk =
    lstatOrNull(join(workRunDir, "transcript.jsonl"), lstatFn)?.isFile() === true
    || quarantinedSet?.has("transcript.jsonl") === true;
  const stderrOk =
    lstatOrNull(join(workRunDir, "stderr.txt"), lstatFn)?.isFile() === true
    || quarantinedSet?.has("stderr.txt") === true;
  const finalOk = lstatOrNull(join(workRunDir, "final"), lstatFn)?.isDirectory() === true;
  const rockyOk = arm === "none"
    ? true
    : lstatOrNull(join(workRunDir, "rocky-home"), lstatFn)?.isDirectory() === true;
  return transcriptOk && stderrOk && finalOk && rockyOk;
}

function countMissingPublishedRuns(runsDir, planned, provider, lstatFn = lstatSync) {
  let missing = 0;
  for (const item of planned) {
    const runDir = join(runsDir, item.runId);
    let dirStat;
    try {
      dirStat = lstatOrNull(runDir, lstatFn);
    } catch {
      missing += 1;
      continue;
    }
    if (!dirStat || dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      missing += 1;
      continue;
    }
    const runJsonPath = join(runDir, "run.json");
    let fileStat;
    try {
      fileStat = lstatOrNull(runJsonPath, lstatFn);
    } catch {
      missing += 1;
      continue;
    }
    if (!fileStat || fileStat.isSymbolicLink() || !fileStat.isFile()) {
      missing += 1;
      continue;
    }
    try {
      const parsed = JSON.parse(readFileSync(runJsonPath, "utf8"));
      if (
        !isValidRunJson(parsed)
        || savedEvalProvider(parsed) !== provider
        || parsed.runId !== item.runId
        || parsed.taskId !== item.taskId
        || parsed.arm !== item.arm
        || parsed.block !== item.block
      ) {
        missing += 1;
      }
    } catch {
      missing += 1;
    }
  }
  return missing;
}

function findPublishedTokenLeakRuns(runsDir, planned, lstatFn = lstatSync) {
  /** @type {Set<string>} */
  const leakedIds = new Set();
  /** @type {Set<string>} */
  const scheduledIds = new Set();
  for (const item of planned) {
    scheduledIds.add(item.runId);
  }

  for (const runId of Array.from(scheduledIds).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const runDir = join(runsDir, runId);
    for (const candidateDir of [runDir, `${runDir}.prev`, `${runDir}.next`]) {
      try {
        const dirStat = lstatOrNull(candidateDir, lstatFn);
        if (!dirStat || dirStat.isSymbolicLink() || !dirStat.isDirectory()) continue;
        const runJsonPath = join(candidateDir, "run.json");
        const stat = lstatOrNull(runJsonPath, lstatFn);
        if (!stat || stat.isSymbolicLink() || !stat.isFile()) continue;
        const parsed = JSON.parse(readFileSync(runJsonPath, "utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.invalid === "token_leak") {
          leakedIds.add(typeof parsed.runId === "string" && parsed.runId.length > 0 ? parsed.runId : runId);
        }
      } catch {
        // Read-only probe; continue checking sibling candidates and remaining scheduled runs.
      }
    }
  }
  return Array.from(leakedIds);
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

function defaultGetCliVersion(executable, platform) {
  const toolEnv = buildToolEnv(process.env, platform);
  const res = runSyncNoShell(executable, ["--version"], {
    cwd: REPO_ROOT,
    env: toolEnv,
    platform,
    timeout: 30_000,
  });
  if (res.status !== 0) {
    throw new Error(`${executable} --version failed (exit ${res.status}): ${res.stderr.trim() || res.stdout.trim()}`);
  }
  return (res.stdout.trim() || res.stderr.trim() || "(unavailable)");
}

async function defaultRunProvider({ driver, executable, platform, task, sandbox, timeoutMs, stdoutPath, stderrPath, secrets, onLeak }) {
  const { args } = driver.buildCommand(task.prompt, driver.defaultModel, { taskDir: sandbox.taskDir, platform });
  return spawnProcess({
    file: executable,
    args,
    cwd: sandbox.taskDir,
    env: sandbox.env,
    provider: driver.id,
    platform,
    timeoutMs,
    stdoutPath,
    stderrPath,
    secrets,
    onLeak,
  });
}

async function runWithConcurrency(items, concurrency, worker, shouldStop = () => false) {
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      if (shouldStop()) break;
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
 *   provider?: import("./drivers/index.mjs").EvalProvider,
 *   secrets?: readonly string[],
 *   concurrency?: number,
 *   k?: number,
 *   seed?: number,
 *   only?: readonly string[] | null,
 *   retryInvalid?: boolean,
 *   timeoutMs?: number,
 *   platform?: NodeJS.Platform,
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
 *   readdirSync: typeof readdirSync,
 *   copyFileSync: typeof copyFileSync,
 *   openFile: typeof openFile,
 *   rmSync: typeof rmSync,
 *   unlinkSync: (path: string) => void,
 *   truncateSync: typeof truncateSync,
 *   renameSync: typeof renameSync,
 *   writeBatchJson: (targetPath: string, data: any, secrets: readonly string[]) => void,
 *   ownerHome: string,
 *   ownerConfigDir: string | null | undefined,
 *   ownerRockyHome: string | null | undefined,
 *   ownerBaseline: typeof defaultOwnerBaseline,
 *   ownerCheck: typeof defaultOwnerCheck,
 *   log: (line: string) => void,
 * }>} [overrides]
 */
export async function runBatch(options, overrides = {}) {
  const driver = getEvalDriver(options.provider);
  const platform = options.platform ?? process.platform;
  const getVersionOverride = driver.id === "claude-code" ? overrides.getClaudeVersion : undefined;
  const deps = {
    manifest: overrides.manifest ?? JSON.parse(readFileSync(MANIFEST_PATH, "utf8")),
    resolveCommit: overrides.resolveCommit ?? defaultResolveCommit,
    getHeadCommit: overrides.getHeadCommit ?? defaultGetHeadCommit,
    packArm: overrides.packArm ?? defaultPackArm,
    createSandbox: overrides.createSandbox ?? defaultCreateSandbox,
    materializeTask: overrides.materializeTask ?? defaultMaterializeTask,
    runProvider: (driver.id === "claude-code" ? overrides.runClaude : undefined) ?? defaultRunProvider,
    accept: overrides.accept ?? defaultAccept,
    destroySandbox: overrides.destroySandbox ?? defaultDestroySandbox,
    sweepStrays: overrides.sweepStrays ?? ((dir) => sweepWin32Strays(dir)),
    assertRootClean: overrides.assertRootClean ?? ((dir) => assertNoAncestorInstructions(dir)),
    lstatSync: overrides.lstatSync ?? lstatSync,
    readdirSync: overrides.readdirSync ?? readdirSync,
    copyFileSync: overrides.copyFileSync ?? copyFileSync,
    openFile: overrides.openFile ?? openFile,
    rmSync: overrides.rmSync ?? overrides.unlinkSync ?? rmSync,
    truncateSync: overrides.truncateSync ?? truncateSync,
    renameSync: overrides.renameSync ?? renameSync,
    writeBatchJson: overrides.writeBatchJson ?? writeJsonAtomic,
    ownerHome: overrides.ownerHome ?? homedir(),
    ownerConfigDir: overrides.ownerConfigDir !== undefined
      ? overrides.ownerConfigDir
      : (process.env[driver.configEnvName] || undefined),
    ownerRockyHome: overrides.ownerRockyHome !== undefined
      ? overrides.ownerRockyHome
      : (process.env.ROCKY_HOME || undefined),
    ownerBaseline: overrides.ownerBaseline ?? defaultOwnerBaseline,
    ownerCheck: overrides.ownerCheck ?? defaultOwnerCheck,
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
  const setName = validateTaskSet(options.set);
  const arms = parseArms(options.arms);

  const secrets = normalizeSecrets([
    ...(Array.isArray(options.secrets) ? options.secrets : []),
    getEvalToken(driver),
  ]);
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

  const selectedTasks = selectTasks(deps.manifest.tasks, options.only, setName);
  const taskById = new Map(selectedTasks.map((task) => [task.id, task]));
  const taskIds = selectedTasks.map((task) => task.id);
  const planned = schedule(taskIds, arms, k, seed);

  const beforeSha = deps.resolveCommit(options.beforeRef);
  const afterSha = deps.resolveCommit(options.afterRef);
  const evaluatorCommit = deps.getHeadCommit();
  const taskSetSha256 =
    deps.manifest.taskSets?.[setName]
    ?? (setName === "v1" ? deps.manifest.taskSetSha256 : undefined);

  const instructionsSha256 = Object.fromEntries(
    ARMS.map((arm) => [arm, sha256Text(renderInstructions(arm, driver.id))]),
  );

  const currentProvenance = {
    provider: driver.id,
    lanes: [...driver.lanes],
    flags: [...driver.defaultFlags],
    instructionsSha256,
    set: setName,
    beforeSha,
    afterSha,
    model: driver.defaultModel,
    evaluatorCommit,
    taskSetSha256,
    seed,
    k,
    arms: [...arms],
    taskIds,
  };

  let providerExecutable;
  function recordCliVersion() {
    if (!getVersionOverride || deps.runProvider === defaultRunProvider) {
      const { file } = driver.buildCommand("");
      providerExecutable = resolveProviderExecutable(file, buildToolEnv(process.env, platform), platform);
    }
    const cliVersion = redact(getVersionOverride ? getVersionOverride() : defaultGetCliVersion(providerExecutable, platform));
    currentProvenance.cliVersion = cliVersion;
    if (driver.id === "claude-code") {
      // Existing readers use these Claude-specific names.
      currentProvenance.claudeVersion = cliVersion;
      currentProvenance.claudeFlags = currentProvenance.flags;
      currentProvenance.claudeMdSha256 = instructionsSha256;
    }
  }

  const batchPath = join(outDir, "batch.json");
  const runsDir = join(outDir, "runs");

  function persistBatchJson(data) {
    deps.writeBatchJson(batchPath, data, secrets);
  }

  function throwHaltedResume(haltInfo, targetBatch, publishedTokenLeaks) {
    const runSuffix = haltInfo.runId ? ` (runId=${haltInfo.runId})` : "";
    const msg = `Batch is halted (reason=${haltInfo.reason}${runSuffix}); refusing to resume`;
    deps.log(redact(`[eval] abort: ${msg}`));
    throw new BatchLeakError(msg, {
      tokenLeakRuns: publishedTokenLeaks,
      ownerCheck: targetBatch?.ownerCheck ?? null,
      halted: haltInfo,
      summary: {
        batchPath,
        total: planned.length,
        ran: 0,
        skipped: 0,
        malformed: 0,
        publishFailed: 0,
        stopped: true,
        halted: haltInfo,
        tokenLeakRuns: publishedTokenLeaks,
        ownerCheck: targetBatch?.ownerCheck ?? null,
      },
    });
  }

  /** @type {Record<string, any>} */
  let batchData;
  /** @type {any} */
  let baseline;
  const existingBatch = readBatchProvenance(batchPath);
  if (existingBatch) {
    // Check saved halt BEFORE provenance comparison and before any swap recovery.
    const existingHalt =
      existingBatch.halted
      && typeof existingBatch.halted === "object"
      && !Array.isArray(existingBatch.halted)
      && typeof existingBatch.halted.reason === "string"
      && existingBatch.halted.reason.length > 0
        ? existingBatch.halted
        : null;
    if (existingHalt) {
      throwHaltedResume(existingHalt, existingBatch, []);
    }

    const preexistingOwnerLeak =
      existingBatch.ownerLeakLatched === true || existingBatch.ownerCheck?.leak === true;
    if (preexistingOwnerLeak) {
      const haltInfo = {
        reason: "owner_leak",
        at: new Date().toISOString(),
      };
      existingBatch.ownerLeakLatched = true;
      existingBatch.halted = haltInfo;
      delete existingBatch.completedAt;
      try {
        persistBatchJson(existingBatch);
      } catch {
        // Best-effort persistence on halted resume.
      }
      throwHaltedResume(haltInfo, existingBatch, []);
    }

    // Look for published token leaks read-only across scheduled runIds only.
    const publishedTokenLeaks = findPublishedTokenLeakRuns(runsDir, planned, deps.lstatSync);
    if (publishedTokenLeaks.length > 0) {
      const haltInfo = {
        reason: "token_leak",
        runId: publishedTokenLeaks[0],
        at: new Date().toISOString(),
      };
      existingBatch.halted = haltInfo;
      delete existingBatch.completedAt;
      try {
        persistBatchJson(existingBatch);
      } catch {
        // Best-effort persistence on halted resume.
      }
      throwHaltedResume(haltInfo, existingBatch, publishedTokenLeaks);
    }

    assertSavedProvider(existingBatch, driver.id, batchPath);
    recordCliVersion();
    const diffs = diffBatchProvenance(existingBatch, currentProvenance);
    if (diffs.length > 0) {
      throw new ProvenanceMismatchError(
        `Batch provenance mismatch (${batchPath}); differing fields: ${diffs.join(", ")}`,
        diffs,
      );
    }
    if (
      !existingBatch.ownerBaseline
      || typeof existingBatch.ownerBaseline !== "object"
      || Array.isArray(existingBatch.ownerBaseline)
    ) {
      throw new ProvenanceMismatchError(
        `Existing batch provenance at ${batchPath} is missing ownerBaseline`,
        ["ownerBaseline"],
      );
    }
    baseline = existingBatch.ownerBaseline;
    batchData = { ...existingBatch, ...currentProvenance, scheduledRuns: planned.length };
  } else {
    recordCliVersion();
    baseline = deps.ownerBaseline({
      ownerHome: deps.ownerHome,
      ownerConfigDir: deps.ownerConfigDir,
      ownerRockyHome: deps.ownerRockyHome,
      provider: driver.id,
      platform,
    });
    batchData = {
      v: 1,
      startedAt: new Date().toISOString(),
      ...currentProvenance,
      beforeRef: options.beforeRef,
      afterRef: options.afterRef,
      concurrency,
      scheduledRuns: planned.length,
      auth: options.auth.kind,
      ownerBaseline: baseline,
    };
    const publishedTokenLeaks = findPublishedTokenLeakRuns(runsDir, planned, deps.lstatSync);
    if (publishedTokenLeaks.length > 0) {
      const haltInfo = {
        reason: "token_leak",
        runId: publishedTokenLeaks[0],
        at: new Date().toISOString(),
      };
      batchData.halted = haltInfo;
      try {
        persistBatchJson(batchData);
      } catch {
        // Best-effort persistence on halted start.
      }
      throwHaltedResume(haltInfo, batchData, publishedTokenLeaks);
    }
    deps.writeBatchJson(batchPath, batchData, secrets);
  }

  let stopBatch = false;
  let tokenLeakHaltPersisted = false;
  let ownerLeakLatched = false;
  let ownerCheckFailed = false;
  /** @type {string[]} */
  const tokenLeakRuns = [];
  /** @type {any} */
  let latestOwnerCheck = batchData.ownerCheck ?? null;

  function setBatchHalt(reason, runId) {
    stopBatch = true;
    delete batchData.completedAt;
    const existingReason = batchData.halted?.reason;
    const isLeakReason = reason === "token_leak" || reason === "owner_leak";
    const existingIsLeak = existingReason === "token_leak" || existingReason === "owner_leak";
    if (!batchData.halted || (!existingIsLeak && isLeakReason)) {
      /** @type {{ reason: string, runId?: string, at: string }} */
      const nextHalt = {
        reason,
        at: new Date().toISOString(),
      };
      if (typeof runId === "string" && runId.length > 0) {
        nextHalt.runId = runId;
      }
      batchData.halted = nextHalt;
    }
  }

  function persistTokenLeakHalt() {
    if (tokenLeakHaltPersisted) return;
    try {
      persistBatchJson(batchData);
      tokenLeakHaltPersisted = true;
    } catch (error) {
      const msg = redact(error instanceof Error ? error.message : String(error));
      deps.log(`[eval] warning: failed to persist halted state in batch.json: ${msg}`);
    }
  }

  function runAndRecordOwnerCheck(contextLabel, runId) {
    let check;
    try {
      check = deps.ownerCheck(baseline, { evalRoot: rootDir, platform });
    } catch (checkError) {
      const msg = redact(checkError instanceof Error ? checkError.message : String(checkError));
      ownerCheckFailed = true;
      if (!batchData.ownerCheckError) {
        batchData.ownerCheckError = msg;
      }
      setBatchHalt("owner_check_error", runId);
      deps.log(`[eval] abort: owner_check_error (${contextLabel}): ${msg}`);
      try {
        persistBatchJson(batchData);
      } catch (persistError) {
        const persistMsg = redact(
          persistError instanceof Error ? persistError.message : String(persistError),
        );
        deps.log(`[eval] warning: failed to persist batch.json after owner_check_error: ${persistMsg}`);
      }
      return null;
    }

    latestOwnerCheck = check;
    batchData.ownerCheck = check;
    if (check && check.leak === true) {
      ownerLeakLatched = true;
      batchData.ownerLeakLatched = true;
      setBatchHalt("owner_leak", runId);
      deps.log(
        redact(
          `[eval] abort: owner leak detected (${contextLabel}): appendedUnderEvalRoot=${check.appendedUnderEvalRoot ?? 0}, settingsChanged=${Array.isArray(check.settingsChanged) ? check.settingsChanged.length : 0}`,
        ),
      );
    }

    try {
      persistBatchJson(batchData);
    } catch (persistError) {
      const msg = redact(persistError instanceof Error ? persistError.message : String(persistError));
      ownerCheckFailed = true;
      if (!batchData.ownerCheckError) {
        batchData.ownerCheckError = msg;
      }
      setBatchHalt("owner_check_error", runId);
      deps.log(`[eval] abort: owner_check_error (persisting batch.json ${contextLabel}): ${msg}`);
      try {
        persistBatchJson(batchData);
      } catch {
        // Keep halt and exit 3 in memory even if disk persistence remains broken.
      }
    }
    return check;
  }

  function finalizeBatchCompletion(summary) {
    if (stopBatch || batchData.halted) {
      return summary;
    }
    const missing = countMissingPublishedRuns(runsDir, planned, driver.id, deps.lstatSync);
    if (summary.malformed === 0 && summary.publishFailed === 0 && missing === 0) {
      delete batchData.incomplete;
      batchData.completedAt = new Date().toISOString();
      persistBatchJson(batchData);
      return summary;
    }
    const incomplete = {
      malformed: summary.malformed,
      publishFailed: summary.publishFailed,
      missing,
    };
    delete batchData.completedAt;
    batchData.incomplete = incomplete;
    persistBatchJson(batchData);
    const incompleteSummary = { ...summary, incomplete };
    const msg = `Batch incomplete (malformed=${incomplete.malformed}, publishFailed=${incomplete.publishFailed}, missing=${incomplete.missing})`;
    deps.log(redact(`[eval] error: ${msg}`));
    throw new BatchIncompleteError(msg, { incomplete, summary: incompleteSummary });
  }

  mkdirSync(runsDir, { recursive: true });

  /** @type {Array<{ item: typeof planned[number], retries: number, isRetry: boolean }>} */
  const pending = [];
  let skipped = 0;
  let malformed = 0;
  for (const item of planned) {
    const runDir = join(runsDir, item.runId);
    const decision = decideRunAction(runDir, driver.id, retryInvalid, deps.lstatSync);
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
    runAndRecordOwnerCheck("batch-end");
    const emptySummary = {
      batchPath,
      total: planned.length,
      ran: 0,
      skipped,
      malformed,
      publishFailed: 0,
      stopped: stopBatch,
      halted: batchData.halted ?? null,
      tokenLeakRuns,
      ownerCheck: latestOwnerCheck,
    };
    if (ownerLeakLatched || ownerCheckFailed) {
      /** @type {string[]} */
      const reasons = [];
      if (ownerLeakLatched) {
        reasons.push(
          `owner_leak (appendedUnderEvalRoot=${latestOwnerCheck?.appendedUnderEvalRoot ?? 0}, settingsChanged=${latestOwnerCheck?.settingsChanged?.length ?? 0})`,
        );
      }
      if (ownerCheckFailed) {
        reasons.push(`owner_check_error (${batchData.ownerCheckError ?? "unknown error"})`);
      }
      throw new BatchLeakError(`Batch stopped due to ${reasons.join("; ")}`, {
        tokenLeakRuns,
        ownerCheck: latestOwnerCheck,
        halted: batchData.halted ?? null,
        summary: emptySummary,
      });
    }
    deps.log(
      redact(`[eval] 0 runs to execute (${skipped} skipped, ${malformed} malformed).`),
    );
    return finalizeBatchCompletion(emptySummary);
  }

  if (batchData.completedAt !== undefined || batchData.incomplete !== undefined) {
    delete batchData.completedAt;
    delete batchData.incomplete;
    persistBatchJson(batchData);
  }

  // Pack required Rocky arms once, sequentially, before any run starts.
  const beforeTgz = arms.includes("before") ? await deps.packArm(beforeSha, cacheDir) : undefined;
  const afterTgz = arms.includes("after") ? await deps.packArm(afterSha, cacheDir) : undefined;
  const tarballs = {
    none: undefined,
    before: beforeTgz,
    after: afterTgz,
  };

  let completed = 0;
  let publishFailed = 0;
  await runWithConcurrency(
    pending,
    concurrency,
    async ({ item, retries, isRetry }) => {
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
      let providerWallMs = null;
      let tokenLeaked = false;
      const latchTokenLeak = () => {
        if (tokenLeaked) return;
        tokenLeaked = true;
        setBatchHalt("token_leak", item.runId);
        // A hit may be withheld or redacted before this worker publishes run.json.
        persistTokenLeakHalt();
      };

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
      /** @type {Array<string | { path: string, removed: false, error: string }>} */
      const quarantined = [];
      /** @type {Set<string>} */
      const quarantinedSet = new Set();
      /** @type {string[]} */
      const scanErrors = [];
      /** @type {Set<string>} */
      const scanErrorsSet = new Set();
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

      const recordQuarantined = (entry) => {
        if (typeof entry === "string") {
          entry = redact(entry);
          const existingIdx = quarantined.findIndex(
            (itemEntry) => typeof itemEntry === "object" && itemEntry !== null && itemEntry.path === entry,
          );
          if (existingIdx !== -1) {
            quarantined[existingIdx] = entry;
            return;
          }
          if (!quarantinedSet.has(entry)) {
            quarantinedSet.add(entry);
            quarantined.push(entry);
          }
          return;
        }
        if (entry && typeof entry === "object" && typeof entry.path === "string") {
          entry = { ...entry, path: redact(entry.path) };
          if (!quarantinedSet.has(entry.path)) {
            quarantinedSet.add(entry.path);
            const quarantineSuffixMatch = /^(.*)\.quarantined-\d+-[0-9a-f]+$/.exec(entry.path);
            if (quarantineSuffixMatch) {
              quarantinedSet.add(quarantineSuffixMatch[1]);
            }
            quarantined.push({
              path: entry.path,
              removed: false,
              error: redact(entry.error ?? "unable to delete file"),
            });
            deps.log(
              redact(
                `[eval] warning: unable to delete leaking file ${entry.path} (${join(runDir, entry.path)}) in ${item.runId}; please delete it manually (${entry.error ?? "delete failed"})`,
              ),
            );
          }
        }
      };
      const recordScanError = (relPath) => {
        relPath = redact(relPath);
        if (!scanErrorsSet.has(relPath)) {
          scanErrorsSet.add(relPath);
          scanErrors.push(relPath);
        }
      };
      const runArtifactScan = async () => {
        try {
          const scanRes = await scanRunArtifactsForSecrets(workRunDir, item.arm, secrets, {
            lstatSync: deps.lstatSync,
            readdirSync: deps.readdirSync,
            openFile: deps.openFile,
            rmSync: deps.rmSync,
            truncateSync: deps.truncateSync,
            renameSync: deps.renameSync,
            onHit: latchTokenLeak,
          });
          for (const entry of scanRes.quarantined) {
            recordQuarantined(entry);
          }
          for (const errPath of scanRes.scanErrors) {
            recordScanError(errPath);
          }
          if (scanRes.leaked) latchTokenLeak();
        } catch (scanErr) {
          const msg = redact(scanErr instanceof Error ? scanErr.message : String(scanErr));
          recordScanError(".");
          deps.log(`[eval] warning: artifact scan failed for ${item.runId}: ${msg}`);
        }
      };

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
          provider: driver.id,
          providerExecutable,
          tgz: tarballs[item.arm],
          auth: options.auth,
          platform,
        });

        await deps.materializeTask(task, sandbox, item.arm);

        const providerStartedAt = Date.now();
        const result = await deps.runProvider({
          driver,
          executable: providerExecutable,
          platform,
          runId: item.runId,
          task,
          sandbox,
          timeoutMs,
          stdoutPath,
          stderrPath,
          secrets,
          onLeak: latchTokenLeak,
        });
        providerWallMs = Math.max(0, Date.now() - providerStartedAt);
        exitCode = result.exitCode ?? null;
        timedOut = Boolean(result.timedOut);
        killFailed = Boolean(result.killFailed);
        taskkillStatus = typeof result.taskkillStatus === "number" ? result.taskkillStatus : null;
        if (result.streamed === true && result.tokenLeaked) latchTokenLeak();

        // Release locks held by descendants before copying or cleaning up.
        swept = true;
        strayKilled = await deps.sweepStrays(sandbox.dir);

        let transcriptSummary;
        if (result.streamed === true) {
          transcriptSummary = result.transcript;
        } else {
          const outWriter = createRedactingFileWriter(stdoutPath, secrets, { onLeak: latchTokenLeak });
          const errWriter = createRedactingFileWriter(stderrPath, secrets, { onLeak: latchTokenLeak });
          const parser = createTranscriptParser(undefined, driver.id);
          const rawStdout = String(result.stdout ?? "");
          const rawStderr = String(result.stderr ?? "");
          outWriter.write(rawStdout);
          parser.write(rawStdout);
          errWriter.write(rawStderr);
          await Promise.all([outWriter.end(), errWriter.end()]);
          transcriptSummary = parser.end();
        }

        await runArtifactScan();
        await publishSandboxArtifacts(sandbox, workRunDir, item.arm, secrets, deps, {
          skippedLinks,
          onLeak(relPath) {
            latchTokenLeak();
            recordQuarantined(relPath);
          },
          onError(relPath, error) {
            recordScanError(relPath);
            if (error) runError ??= redact(error instanceof Error ? error.message : String(error));
          },
        });
        if (item.arm === "none") {
          noneRockyHomeEntries = listNoneRockyHomeEntries(sandbox.rockyHome, deps.lstatSync).map((name) => {
            if (containsAnySecret(name, secrets)) latchTokenLeak();
            return redact(name);
          });
        }

        invalid = classifyOutcome({
          transcript: transcriptSummary,
          tokenLeaked,
          timedOut,
        });

        if (scanErrors.length === 0) {
          acceptResult = await deps.accept(task, join(workRunDir, "final"), { manifest: deps.manifest });
        }
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
      } finally {
        // Always scan and quarantine whatever artifacts exist, even if copying or grading threw.
        await runArtifactScan();
        if (tokenLeaked) {
          invalid = "token_leak";
        } else if (scanErrors.length > 0) {
          invalid = "harness_crash";
          runError ??= "artifact scan incomplete";
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
      }

      // Check artifact/retry metadata and publish inside one guard so any metadata or write
      // error logs, increments publishFailed, and never rejects the worker pool.
      try {
        const artifactsExist = hasRunArtifacts(workRunDir, item.arm, deps.lstatSync, quarantinedSet);
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
          provider: driver.id,
          taskDir: sandbox?.taskDir ?? null,
          taskId: item.taskId,
          arm: item.arm,
          block: item.block,
          startedAt,
          wallMs: (driver.id === "codex" ? providerWallMs : null) ?? Math.max(0, Date.now() - startMs),
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
        if (quarantined.length > 0) {
          record.quarantined = quarantined;
        }
        if (scanErrors.length > 0) {
          record.scanErrors = scanErrors;
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

      if (invalid === "token_leak") {
        tokenLeakRuns.push(item.runId);
        setBatchHalt("token_leak", item.runId);
        deps.log(
          redact(`[eval] abort: token_leak in ${item.runId}; stopping batch (no new runs will start)`),
        );
        persistTokenLeakHalt();
      }

      runAndRecordOwnerCheck(`after ${item.runId}`, item.runId);
    },
    () => stopBatch,
  );

  runAndRecordOwnerCheck("batch-end");

  deps.log(
    redact(
      `[eval] summary: total=${planned.length} ran=${completed} skipped=${skipped} malformed=${malformed} publishFailed=${publishFailed}`,
    ),
  );
  const summary = {
    batchPath,
    total: planned.length,
    ran: completed,
    skipped,
    malformed,
    publishFailed,
    stopped: stopBatch,
    halted: batchData.halted ?? null,
    tokenLeakRuns,
    ownerCheck: latestOwnerCheck,
  };
  if (tokenLeakRuns.length > 0 || ownerLeakLatched || ownerCheckFailed) {
    /** @type {string[]} */
    const reasons = [];
    if (tokenLeakRuns.length > 0) {
      reasons.push(`token_leak in ${tokenLeakRuns.join(", ")}`);
    }
    if (ownerLeakLatched) {
      reasons.push(
        `owner_leak (appendedUnderEvalRoot=${latestOwnerCheck?.appendedUnderEvalRoot ?? 0}, settingsChanged=${latestOwnerCheck?.settingsChanged?.length ?? 0})`,
      );
    }
    if (ownerCheckFailed) {
      reasons.push(`owner_check_error (${batchData.ownerCheckError ?? "unknown error"})`);
    }
    throw new BatchLeakError(`Batch stopped due to ${reasons.join("; ")}`, {
      tokenLeakRuns,
      ownerCheck: latestOwnerCheck,
      halted: batchData.halted ?? null,
      summary,
    });
  }
  return finalizeBatchCompletion(summary);
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
    provider: "claude-code",
    set: undefined,
    arms: [...ARMS],
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

    if (arg === "--provider") {
      try {
        opts.provider = getEvalDriver(takeValue("--provider")).id;
      } catch (error) {
        usageError(error instanceof Error ? error.message : String(error));
      }
    } else if (arg === "--set") {
      try {
        opts.set = validateTaskSet(takeValue("--set"));
      } catch (error) {
        usageError(error instanceof Error ? error.message : String(error));
      }
    } else if (arg === "--arms") {
      try {
        opts.arms = parseArms(takeValue("--arms"));
      } catch (error) {
        usageError(error instanceof Error ? error.message : String(error));
      }
    } else if (arg === "--out") opts.out = takeValue("--out");
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

  if (opts.out) {
    const checkOutDir = resolve(opts.out);
    try {
      assertOutsideWorkspace(checkOutDir, REPO_ROOT);
    } catch (error) {
      usageError(error instanceof Error ? error.message : String(error));
    }
    const checkCacheDir = opts.cache ? resolve(opts.cache) : resolve(checkOutDir, "..", "pack-cache");
    try {
      assertOutsideWorkspace(checkCacheDir, REPO_ROOT);
    } catch (error) {
      usageError(error instanceof Error ? error.message : String(error));
    }
  }

  if (!opts.set) {
    usageError("--set <v1|v2> is required");
  }
  if (!opts.out) {
    usageError("--out <dir> is required");
  }
  const outDir = resolve(opts.out);
  const cacheDir = opts.cache ? resolve(opts.cache) : resolve(outDir, "..", "pack-cache");

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

  const driver = getEvalDriver(opts.provider);
  const token = getEvalToken(driver);
  const secrets = token ? [token] : [];
  /** @type {{ kind: "token" }} */
  const auth = { kind: "token" };

  try {
    if (!token) {
      // Validate resumability even on hosts without the requested provider's key.
      const batchPath = join(outDir, "batch.json");
      assertSavedProvider(readBatchProvenance(batchPath), driver.id, batchPath);
      process.stderr.write(
        `Error: ${driver.tokenEnvNames.join(" or ")} is missing or empty in environment (required for --auth token).\n`,
      );
      process.exitCode = 2;
      return;
    }

    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
    try {
      selectTasks(manifest.tasks, opts.only, opts.set);
    } catch (error) {
      usageError(error instanceof Error ? error.message : String(error));
    }

    const rootDir = resolve(opts.root);
    try {
      assertNoAncestorInstructions(rootDir);
    } catch (error) {
      usageError(error instanceof Error ? error.message : String(error));
    }

    await runBatch(
      {
        provider: driver.id,
        set: opts.set,
        arms: opts.arms,
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
