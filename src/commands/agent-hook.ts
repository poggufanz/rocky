import { spawn, spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import { dirname } from "node:path";
import { appendPayload } from "../agent/spool.js";
import { parseClaudeHookPayload, type ParsedHookPayload } from "../agent/adapters/claude-code.js";
import { parseCodexHookPayload } from "../agent/adapters/codex.js";
import { loadConfig } from "../core/config-read.js";
import { redactSecretsAtBoundary, replaceAnsiAndControls } from "../core/redact.js";
import { utf8Prefix } from "../core/utf8.js";
import { resolveRockyPaths, type RockyPaths } from "../core/state-paths.js";
import { canonicalPath } from "../core/memory-read.js";
import { filesystemIdentity, NO_FOLLOW_FLAG, regularDescriptorSafe, sameFilesystemIdentity } from "../core/fs-safety.js";
import { MAX_BASELINE_FILES, type AgentEvent, type IntentEvent, type TurnBaseline } from "../agent/schema.js";

const STDIN_CAP_BYTES = 2 * 1024 * 1024;
const LOG_CAP_BYTES = 64 * 1024;
const LOG_MESSAGE_CAP_BYTES = 2 * 1024;
const LOG_SCAN_BYTES = 8 * 1024;
const ADAPTER_LABEL_CAP_BYTES = 256;
const NO_FOLLOW = NO_FOLLOW_FLAG;

// Internal sentinel: redactSecretsAtBoundary removes it while recording the
// boundary restored by stripping ANSI/C0/C1 controls.
const BOUNDARY_MARKER = "\u2065";

export interface AgentHookDeps {
  stdin?: () => Promise<string>;
  argvPayload?: string;
  spawnAnnotate?: (key: string) => void;
  spawnAmbiguity?: (text: string) => void;
  paths?: RockyPaths;
  now?: () => number;
  /** Test seam for bounded baseline capture; production uses local git only. */
  git?: (args: string[], cwd: string) => string | undefined;
  /** Test seam for append-recovery coverage; production uses the guarded spool writer. */
  appendEvent?: (key: string, event: AgentEvent, paths?: RockyPaths) => boolean;
}

function capUtf8(value: string, maxBytes: number): string {
  return utf8Prefix(value, maxBytes);
}

function sanitizeLogMessage(message: string): string {
  // Strip presentation/control bytes before redaction so a secret adjacent to
  // an ANSI sequence still has the word boundary the redactor expects.
  const bounded = utf8Prefix(message, LOG_SCAN_BYTES);
  const withoutControls = replaceAnsiAndControls(bounded, BOUNDARY_MARKER);
  return capUtf8(redactSecretsAtBoundary(withoutControls, {
    mayBeTruncated: bounded.length < message.length,
  }).replace(/\s+/gu, " ").trim(), LOG_MESSAGE_CAP_BYTES);
}

function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // Logging is a fail-open boundary.
  }
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
    if (written <= 0) throw new Error("log write made no progress");
    offset += written;
  }
}

/** Append one bounded, sanitized diagnostic without ever throwing to the hook caller. */
export function logHookError(message: string, paths?: RockyPaths): void {
  let fd = -1;
  try {
    const targetPaths = paths ?? resolveRockyPaths();
    const target = targetPaths.agentLog;
    if (typeof target !== "string" || target.length === 0) return;

    const safeMessage = sanitizeLogMessage(typeof message === "string" ? message : "");
    const line = Buffer.from(`${new Date().toISOString()} ${safeMessage}\n`, "utf8");
    if (line.byteLength > LOG_CAP_BYTES) return;

    const parent = dirname(target);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const parentStats = lstatSync(parent, { bigint: true });
    if (!parentStats.isDirectory() || parentStats.isSymbolicLink() || filesystemIdentity(parentStats) === undefined) return;
    let listed: BigIntStats | undefined;
    try {
      listed = lstatSync(target, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
    }
    if (listed && (!regularDescriptorSafe(listed) || !sameFilesystemIdentity(listed, listed))) return;

    const create = listed === undefined;
    const parentBeforeOpen = lstatSync(parent, { bigint: true });
    if (!parentBeforeOpen.isDirectory() || parentBeforeOpen.isSymbolicLink()
        || !sameFilesystemIdentity(parentStats, parentBeforeOpen)) return;
    // Recheck parent identity before changing permissions. chmod is a path
    // mutation and must not target a replacement directory.
    try {
      chmodSync(parent, 0o700);
    } catch {
      // Windows and read-only parents may reject chmod.
    }
    fd = openSync(
      target,
      constants.O_WRONLY | constants.O_APPEND | (create ? constants.O_CREAT | constants.O_EXCL : constants.O_CREAT) | NO_FOLLOW,
      0o600,
    );
    const opened = fstatSync(fd, { bigint: true });
    if (!regularDescriptorSafe(opened) || !sameFilesystemIdentity(opened, opened)) return;
    if (listed && !sameFilesystemIdentity(listed, opened)) return;
    try {
      fchmodSync(fd, 0o600);
    } catch {
      // File mode is best effort on platforms without POSIX modes.
    }

    if (opened.size < 0n) return;
    if (opened.size > BigInt(LOG_CAP_BYTES) || opened.size + BigInt(line.byteLength) > BigInt(LOG_CAP_BYTES)) {
      ftruncateSync(fd, 0);
    }
    const ready = fstatSync(fd, { bigint: true });
    if (!regularDescriptorSafe(ready) || !sameFilesystemIdentity(opened, ready)
        || ready.size + BigInt(line.byteLength) > BigInt(LOG_CAP_BYTES)) return;
    writeAll(fd, line);

    // A concurrent writer must not be allowed to leave the diagnostic over the cap.
    const after = fstatSync(fd, { bigint: true });
    if (!regularDescriptorSafe(after) || !sameFilesystemIdentity(opened, after)) return;
    if (after.size > BigInt(LOG_CAP_BYTES)) ftruncateSync(fd, LOG_CAP_BYTES);
    const parentAfter = lstatSync(parent, { bigint: true });
    if (!parentAfter.isDirectory() || parentAfter.isSymbolicLink()
        || !sameFilesystemIdentity(parentStats, parentAfter)) return;
  } catch {
    // A broken log path must never break a vendor hook.
  } finally {
    if (fd >= 0) closeQuietly(fd);
  }
}

class OversizedInputError extends Error {
  constructor() {
    super("hook input exceeds size limit");
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    let bytes: number;
    let buffer: Buffer;
    if (Buffer.isBuffer(chunk)) {
      bytes = chunk.byteLength;
      if (total + bytes > STDIN_CAP_BYTES) throw new OversizedInputError();
      buffer = chunk;
    } else if (typeof chunk === "string") {
      bytes = Buffer.byteLength(chunk, "utf8");
      if (total + bytes > STDIN_CAP_BYTES) throw new OversizedInputError();
      buffer = Buffer.from(chunk, "utf8");
    } else {
      throw new Error("hook input is not text");
    }
    chunks.push(buffer);
    total += bytes;
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function defaultSpawnAnnotate(key: string): void {
  const currentScript = process.argv[1];
  if (!currentScript) throw new Error("current script path unavailable");
  const script = realpathSync(currentScript);
  const child = spawn(process.execPath, [script, "_annotate", key], {
    detached: true,
    stdio: "ignore",
    shell: false,
    windowsHide: true,
  });
  child.once("error", () => {
    // Detached annotation is best effort; never surface its asynchronous error.
  });
  child.unref();
}

function defaultSpawnAmbiguity(text: string): void {
  const currentScript = process.argv[1];
  if (!currentScript) throw new Error("current script path unavailable");
  const script = realpathSync(currentScript);
  const payload = Buffer.from(text, "utf8").toString("base64url");
  const child = spawn(process.execPath, [script, "_ambiguity", payload], {
    detached: true,
    stdio: "ignore",
    shell: false,
    windowsHide: true,
  });
  child.once("error", () => {
    // Detached ambiguity checks are best effort; never surface async errors.
  });
  child.unref();
}

function enabledOllama(paths: RockyPaths): boolean {
  try {
    const result = loadConfig(paths.config);
    return result.status === "valid"
      && result.config.ai.enabled === true
      && result.config.ai.provider === "ollama"
      && typeof result.config.ai.model === "string"
      && result.config.ai.model.trim().length > 0;
  } catch {
    return false;
  }
}

/** Spawn one detached ambiguity check only for an enabled local Ollama setup. */
export function maybeSpawnAmbiguity(text: string, paths: RockyPaths, deps: AgentHookDeps = {}): void {
  try {
    if (typeof text !== "string" || !enabledOllama(paths)) return;
    const spawnAmbiguity = deps.spawnAmbiguity ?? defaultSpawnAmbiguity;
    spawnAmbiguity(text);
  } catch {
    // Ambiguity is advisory and must never affect the agent hook.
  }
}

function safeLogFailure(paths: RockyPaths | undefined): void {
  try {
    logHookError("agent-event hook failed", paths);
  } catch {
    // logHookError itself is best effort; retain the outer fail-open guarantee.
  }
}

function safeAdapterLabel(adapter: unknown): string {
  try {
    return typeof adapter === "string" ? utf8Prefix(adapter, ADAPTER_LABEL_CAP_BYTES) : "unknown";
  } catch {
    return "unknown";
  }
}

function defaultBaselineGit(args: string[], cwd: string): string | undefined {
  try {
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 128 * 1024,
      shell: false,
      windowsHide: true,
    });
    if (result.error || result.status !== 0 || result.signal) return undefined;
    return typeof result.stdout === "string" ? result.stdout.trim() : undefined;
  } catch {
    return undefined;
  }
}

function parseBaselineNumstat(value: string | undefined, cwd?: string): Array<{ path: string; plusMinus: [number, number] }> | undefined {
  if (value === undefined) return undefined;
  const files: Array<{ path: string; plusMinus: [number, number] }> = [];
  const seen = new Set<string>();
  const lines = value.split(/\r?\n/u).filter((line) => line.length > 0);
  for (const line of lines) {
    const match = /^\s*(\d+|-)\t(\d+|-)\t(.+?)\s*$/u.exec(line);
    if (!match) return undefined;
    const rawPath = match[3] === undefined ? "" : match[3];
    if (rawPath.length > 1024) return undefined;
    const identity = canonicalPath(rawPath, { cwd });
    const displayPath = canonicalPath(rawPath);
    if (!identity || !displayPath || displayPath.length > 1024) return undefined;
    if (seen.has(identity)) continue;
    if (match[1] === "-" || match[2] === "-") return undefined;
    const added = match[1] === "-" ? 0 : Number(match[1]);
    const removed = match[2] === "-" ? 0 : Number(match[2]);
    if (!Number.isSafeInteger(added) || added < 0 || !Number.isSafeInteger(removed) || removed < 0) continue;
    seen.add(identity);
    files.push({ path: displayPath, plusMinus: [added, removed] });
    if (files.length > MAX_BASELINE_FILES) return undefined;
  }
  return files;
}

function captureTurnBaseline(cwd: string | undefined, deps: AgentHookDeps): TurnBaseline {
  const target = typeof cwd === "string" && cwd.length > 0 ? cwd : process.cwd();
  const git = deps.git ?? defaultBaselineGit;
  try {
    const head = git(["rev-parse", "HEAD"], target);
    const unstaged = git(["diff", "--numstat"], target);
    const staged = git(["diff", "--cached", "--numstat"], target);
    const untracked = git(["ls-files", "--others", "--exclude-standard"], target);
    const unstagedFiles = parseBaselineNumstat(unstaged, target);
    const stagedFiles = parseBaselineNumstat(staged, target);
    if (!head || unstagedFiles === undefined || stagedFiles === undefined || untracked === undefined) return { status: "unknown" };
    const merged = new Map<string, { path: string; plusMinus: [number, number] }>();
    for (const file of [...unstagedFiles, ...stagedFiles]) {
      const identity = canonicalPath(file.path, { cwd: target });
      if (!identity) continue;
      const previous = merged.get(identity);
      const additions = previous === undefined ? file.plusMinus[0] : previous.plusMinus[0] + file.plusMinus[0];
      const removals = previous === undefined ? file.plusMinus[1] : previous.plusMinus[1] + file.plusMinus[1];
      if (!Number.isSafeInteger(additions) || additions < 0 || !Number.isSafeInteger(removals) || removals < 0) return { status: "unknown" };
      merged.set(identity, previous === undefined
        ? { path: file.path, plusMinus: [...file.plusMinus] as [number, number] }
        : { path: previous.path, plusMinus: [additions, removals] });
    }
    if (merged.size > MAX_BASELINE_FILES) return { status: "unknown" };
    const files = [...merged.values()];
    const seen = new Set(merged.keys());
    for (const path of untracked.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)) {
      if (path.length > 1024) return { status: "unknown" };
      const identity = canonicalPath(path, { cwd: target });
      const displayPath = canonicalPath(path);
      if (!identity || !displayPath || seen.has(identity)) continue;
      seen.add(identity);
      files.push({ path: displayPath, plusMinus: [0, 0] });
      if (files.length > MAX_BASELINE_FILES) return { status: "unknown" };
    }
    return {
      status: "captured",
      head: head.slice(0, 256),
      ...(files.length === 0 ? {} : { files }),
    };
  } catch {
    return { status: "unknown" };
  }
}

interface StdoutLike {
  write: (chunk: string, callback?: (error?: Error) => void) => unknown;
  once?: (event: string, listener: (error: unknown) => void) => unknown;
  removeListener?: (event: string, listener: (error: unknown) => void) => unknown;
}

/** Write the one hook response while containing synchronous and async stream errors. */
function writeEmptyResponse(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let listenerAttached = false;
    const output = process.stdout as unknown as Partial<StdoutLike>;
    const onError = () => settle();
    const cleanup = () => {
      if (listenerAttached && typeof output.removeListener === "function") {
        try {
          output.removeListener("error", onError);
        } catch {
          // Closed streams may reject listener cleanup; resolution remains safe.
        }
      }
      listenerAttached = false;
    };
    const settle = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    try {
      if (typeof output.write !== "function") {
        settle();
        return;
      }
      if (typeof output.once === "function" && typeof output.removeListener === "function") {
        output.once("error", onError);
        listenerAttached = true;
        output.write("{}", () => settle());
      } else {
        output.write("{}");
        settle();
      }
    } catch {
      settle();
    }
  });
}

function applyParsedEvent(parsed: ParsedHookPayload, paths: RockyPaths, deps: AgentHookDeps): void {
  if (!parsed) return;
  if (parsed.action === "append") {
    // Coverage is a turn-level sidecar.  It is written before individual
    // events so a lost first/middle/last append cannot make surviving files
    // look like complete knowledge.
    const firstMechanism = parsed.events.find((event): event is Extract<AgentEvent, { kind: "mechanism" }> => event.kind === "mechanism");
    const intentCwd = parsed.events.find((event): event is IntentEvent => event.kind === "intent")?.cwd;
    const coveragePaths = firstMechanism === undefined ? undefined : parsed.coveragePaths
      ?? parsed.events.filter((event): event is Extract<AgentEvent, { kind: "mechanism" }> => event.kind === "mechanism").map((event) => event.path);
    const coverageInput = firstMechanism === undefined || coveragePaths === undefined ? undefined : {
      agent: firstMechanism.agent,
      paths: coveragePaths,
      candidateCount: parsed.coverageCandidateCount ?? coveragePaths.length,
      candidateCountExact: parsed.coverageCandidateCountExact ?? parsed.coveragePaths !== undefined,
      pathsComplete: parsed.coveragePathsComplete ?? firstMechanism.coveragePathsComplete
        ?? (parsed.coveragePaths === undefined && coveragePaths.length <= 256),
      cwd: parsed.coverageCwd ?? intentCwd,
      platform: parsed.coveragePlatform ?? process.platform,
      payloadDigest: parsed.coverageDigest,
    };
    // Keep overflow metadata attached until one mechanism append succeeds.
    // A transient first-write failure must not let later surviving events
    // silently lose the batch's exact coverage witness.
    let coveragePending = parsed.truncatedFiles !== undefined
      || parsed.coveragePaths !== undefined
      || parsed.coveragePathsComplete !== undefined;
    const preparedEvents: AgentEvent[] = [];
    for (const original of parsed.events) {
      const attachCoverage = original.kind === "mechanism" && coveragePending;
      const event: AgentEvent = original.kind === "intent" && original.baseline === undefined
        ? ({ ...original, baseline: captureTurnBaseline(original.cwd, deps) } satisfies IntentEvent)
        : attachCoverage
          ? {
            ...original,
            ...(parsed.truncatedFiles === undefined ? {} : { truncatedFiles: parsed.truncatedFiles }),
            ...(parsed.coveragePaths === undefined ? {} : { coveragePaths: parsed.coveragePaths }),
            ...(parsed.coveragePathsComplete === undefined ? {} : { coveragePathsComplete: parsed.coveragePathsComplete }),
          }
          : original;
      preparedEvents.push(event);
      // The transactional production path has a durable sidecar, so only one
      // event carries the fallback marker. A replaced append seam keeps the
      // marker pending until a surviving event is known to persist it.
      if (deps.appendEvent === undefined && attachCoverage) coveragePending = false;
    }
    let results: boolean[];
    try {
      results = appendPayload(parsed.key, preparedEvents, coverageInput, paths, deps.appendEvent);
    } catch {
      results = preparedEvents.map(() => false);
      safeLogFailure(paths);
    }
    preparedEvents.forEach((event, index) => {
      if (results[index] === true && event.kind === "intent") maybeSpawnAmbiguity(event.text, paths, deps);
    });
    return;
  }

  // Rationale persistence is intentionally attempted before the one annotate spawn.
  if (parsed.rationale) {
    try {
      appendPayload(parsed.key, [parsed.rationale], undefined, paths);
    } catch {
      safeLogFailure(paths);
    }
  }

  let spawnAnnotate: ((key: string) => void) | undefined;
  try {
    spawnAnnotate = deps.spawnAnnotate ?? defaultSpawnAnnotate;
  } catch {
    safeLogFailure(paths);
  }
  try {
    (spawnAnnotate ?? defaultSpawnAnnotate)(parsed.key);
  } catch {
    safeLogFailure(paths);
  }
}

/**
 * Consume one vendor hook payload. This boundary is deliberately fail-open:
 * every input, dependency, filesystem, and stdout failure still returns zero.
 */
export async function agentEvent(adapter: string, deps: AgentHookDeps = {}): Promise<number> {
  let paths: RockyPaths | undefined;
  const effectiveDeps = (deps && typeof deps === "object" ? deps : {}) as AgentHookDeps;
  try {
    paths = effectiveDeps.paths ?? resolveRockyPaths();
    if (adapter !== "claude-code" && adapter !== "codex") {
      logHookError(`unknown adapter ${safeAdapterLabel(adapter)}`, paths);
    } else {
      const argvPayload = effectiveDeps.argvPayload;
      const hasArgvPayload = adapter === "codex"
        && typeof argvPayload === "string"
        && argvPayload.length > 0;
      const raw = hasArgvPayload ? argvPayload : await (effectiveDeps.stdin ?? readStdin)();
      if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > STDIN_CAP_BYTES) {
        throw new OversizedInputError();
      }
      const payload: unknown = JSON.parse(raw);
      const parsed = adapter === "codex"
        ? parseCodexHookPayload(payload, effectiveDeps.now?.())
        : parseClaudeHookPayload(payload, effectiveDeps.now?.());
      applyParsedEvent(parsed, paths, effectiveDeps);
    }
  } catch {
    safeLogFailure(paths);
  } finally {
    // This is the sole stdout write. A closed pipe/EPIPE is harmless here.
    try {
      await writeEmptyResponse();
    } catch {
      // Vendor hooks must never observe a rejected promise from stdout failure.
    }
  }
  return 0;
}
