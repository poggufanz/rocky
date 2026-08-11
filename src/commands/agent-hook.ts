import { spawn } from "node:child_process";
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
} from "node:fs";
import { dirname } from "node:path";
import { appendEvent } from "../agent/spool.js";
import { parseClaudeHookPayload, type ParsedHookPayload } from "../agent/adapters/claude-code.js";
import { redactSecrets } from "../core/redact.js";
import { resolveRockyPaths, type RockyPaths } from "../core/state-paths.js";

const STDIN_CAP_BYTES = 2 * 1024 * 1024;
const LOG_CAP_BYTES = 64 * 1024;
const LOG_MESSAGE_CAP_BYTES = 2 * 1024;
const NO_FOLLOW = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;

const ANSI_ESCAPE = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\)|[@-_])/g;
const BIDI_CONTROL = /[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

export interface AgentHookDeps {
  stdin?: () => Promise<string>;
  spawnAnnotate?: (key: string) => void;
  paths?: RockyPaths;
  now?: () => number;
}

function capUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  return bytes.byteLength <= maxBytes ? value : bytes.subarray(0, maxBytes).toString("utf8");
}

function sanitizeLogMessage(message: string): string {
  // Strip presentation/control bytes before redaction so a secret adjacent to
  // an ANSI sequence still has the word boundary the redactor expects.
  const withoutEscapes = message.replace(ANSI_ESCAPE, "");
  const withoutControls = withoutEscapes.replace(BIDI_CONTROL, "").replace(CONTROL, "");
  const oneLine = withoutControls.replace(/\s+/gu, " ").trim();
  return capUtf8(redactSecrets(oneLine), LOG_MESSAGE_CAP_BYTES);
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

    const safeMessage = sanitizeLogMessage(typeof message === "string" ? message : String(message));
    const line = Buffer.from(`${new Date().toISOString()} ${safeMessage}\n`, "utf8");
    if (line.byteLength > LOG_CAP_BYTES) return;

    const parent = dirname(target);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const parentStats = lstatSync(parent);
    if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) return;
    // mkdir's mode is the creation default; chmod is best effort for existing private dirs.
    try {
      chmodSync(parent, 0o700);
    } catch {
      // Windows and read-only parents may reject chmod.
    }

    let listed;
    try {
      listed = lstatSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
    }
    if (listed && (!listed.isFile() || listed.isSymbolicLink())) return;

    fd = openSync(
      target,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | NO_FOLLOW,
      0o600,
    );
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.isSymbolicLink()) return;
    try {
      fchmodSync(fd, 0o600);
    } catch {
      // File mode is best effort on platforms without POSIX modes.
    }

    if (!Number.isSafeInteger(opened.size) || opened.size < 0) return;
    if (opened.size > LOG_CAP_BYTES || opened.size + line.byteLength > LOG_CAP_BYTES) {
      ftruncateSync(fd, 0);
    }
    const ready = fstatSync(fd);
    if (!ready.isFile() || ready.size + line.byteLength > LOG_CAP_BYTES) return;
    writeAll(fd, line);

    // A concurrent writer must not be allowed to leave the diagnostic over the cap.
    const after = fstatSync(fd);
    if (after.size > LOG_CAP_BYTES) ftruncateSync(fd, LOG_CAP_BYTES);
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
  child.unref();
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
    return typeof adapter === "string" ? adapter : String(adapter);
  } catch {
    return "unknown";
  }
}

function applyParsedEvent(parsed: ParsedHookPayload, paths: RockyPaths, deps: AgentHookDeps): void {
  if (!parsed) return;
  if (parsed.action === "append") {
    try {
      appendEvent(parsed.key, parsed.event, paths);
    } catch {
      safeLogFailure(paths);
    }
    return;
  }

  // Rationale persistence is intentionally attempted before the one annotate spawn.
  if (parsed.rationale) {
    try {
      appendEvent(parsed.key, parsed.rationale, paths);
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
    if (adapter === "codex") {
      logHookError("codex adapter not wired yet", paths);
    } else if (adapter !== "claude-code") {
      logHookError(`unknown adapter ${safeAdapterLabel(adapter)}`, paths);
    } else {
      const raw = await (effectiveDeps.stdin ?? readStdin)();
      if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > STDIN_CAP_BYTES) {
        throw new OversizedInputError();
      }
      const payload: unknown = JSON.parse(raw);
      const parsed = parseClaudeHookPayload(payload, effectiveDeps.now?.());
      applyParsedEvent(parsed, paths, effectiveDeps);
    }
  } catch {
    safeLogFailure(paths);
  } finally {
    // This is the sole stdout write. A closed pipe/EPIPE is harmless here.
    try {
      const output = process.stdout as unknown as { write?: (chunk: string) => unknown };
      if (typeof output.write === "function") output.write("{}");
    } catch {
      // Vendor hooks must never observe a rejected promise from stdout failure.
    }
  }
  return 0;
}
