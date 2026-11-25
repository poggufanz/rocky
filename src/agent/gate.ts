/**
 * Advisory PreToolUse dispatcher — `rocky hook gate-event`.
 *
 * A Claude Code PreToolUse hook calls this once per tool call. It runs
 * deterministic, local advisory checks for prompt clarity and failure cycles
 * (against `<ROCKY_HOME>/gate-state/<session>.cycles.json`). Fix-touch checks
 * the derived cache for edits between failing and passing runs when enabled
 * by `<ROCKY_HOME>/fixtouch-on`.
 * The hook returns `{}` when silent or one `additionalContext` advisory.
 *
 * Hard rule: `gateEvent` NEVER throws, NEVER denies an edit, and NEVER
 * returns a non-zero exit code. Unparseable stdin, an unrecognized vendor
 * or tool, or a missing file path or session id print `{}` and exit 0.
 * Corrupt or stale cycle state reads as a fresh session, and a failed
 * cycle-state save keeps only the cycle note silent, so a prompt-clarity
 * note can still print.
 */

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { sanitizeSessionId } from "../core/agent-session.js";
import { clarityNudgeLine } from "../core/prompt-clarity.js";
import {
  countCycleClusters,
  cycleClusterLine,
  cycleNudgeLine,
  loadCycleState,
  observeFailureCycle,
  saveCycleState,
} from "../core/failure-cycle.js";
import { fingerprint } from "../core/fingerprint.js";
import {
  FIXTOUCH_CMD_MAX, FIXTOUCH_PATH_MAX, FIXTOUCH_SIGNATURE_MAX,
  fileGitRoot, findFixTouchEntry, fixTouchCachePath, fixTouchEnabled,
  fixTouchPathKey, readFixTouchCache, rootKey, sanitizeField,
} from "../core/fixtouch-cache.js";
import { resolveRockyPaths } from "../core/state-paths.js";
import { logHookError } from "../commands/agent-hook.js";

export { sanitizeSessionId };

const GATED_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit"]);
/** Known PreToolUse payload shapes accepted by `gate-event`. */
const KNOWN_GATE_VENDORS: ReadonlySet<string> = new Set(["claude-code", "generic"]);
const EXPLICIT_FINGERPRINT = /^[0-9a-f]{16}$/u;
const MAX_GATE_STDOUT_BYTES = 1024;
const MAX_FIXTOUCH_SHOWN_KEYS = 256;
// Allows all 256 keys even when cache roots and paths need JSON escapes.
const MAX_FIXTOUCH_STATE_BYTES = 2 * 1024 * 1024;

export interface GateInput {
  vendor: string;
  toolName: string;
  filePath?: string;
  sessionKey: string;
  cwd: string;
  /** Optional rationale draft carried by the hook payload for the clarity advisory. */
  rationale?: string;
  /**
   * Optional failure fingerprint carried by the hook payload (explicit
   * 16-hex `fingerprint`, or derived from `stderr`/`cmd`/`exitCode` via
   * `fingerprint()`). Feeds the failure-cycle advisory.
   */
  fingerprint?: string;
}

type PlainRecord = Record<string, unknown>;

function isPlainRecord(value: unknown): value is PlainRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readFailureFingerprint(raw: PlainRecord): string | undefined {
  try {
    const explicit = raw.fingerprint;
    if (typeof explicit === "string" && EXPLICIT_FINGERPRINT.test(explicit)) return explicit;
    const stderr = raw.stderr;
    if (typeof stderr !== "string") return undefined;
    const cmd = raw.cmd ?? raw.command;
    const exitCode = raw.exitCode;
    return fingerprint(
      stderr,
      typeof cmd === "string" ? cmd : "",
      typeof exitCode === "number" && Number.isSafeInteger(exitCode) ? exitCode : 1,
    );
  } catch {
    return undefined;
  }
}

/**
 * Advisory clarity check for an optional rationale draft. Never throws;
 * returns `""` when silent (absent rationale, clear draft, or
 * `ROCKY_CLARITY_ADVISORY=off`).
 */
export function clarityNudge(input: GateInput, env: NodeJS.ProcessEnv): string {
  try {
    if (env.ROCKY_CLARITY_ADVISORY === "off") return "";
    if (input.rationale === undefined) return "";
    return clarityNudgeLine(input.rationale) ?? "";
  } catch {
    return "";
  }
}

/**
 * Advisory failure-cycle check. Records one observation into
 * `<ROCKY_HOME>/gate-state/<sessionKey>.cycles.json` when both `fingerprint`
 * and `rationale` are present, and returns the nudge line (plus
 * `cycleClusterLine` when 2 or more clusters exist) or `""` when silent or
 * opted out via `ROCKY_CYCLE_ADVISORY=off`. Never throws.
 */
export function cycleNudge(input: GateInput, env: NodeJS.ProcessEnv): string {
  try {
    if (env.ROCKY_CYCLE_ADVISORY === "off") return "";
    if (input.fingerprint === undefined || input.rationale === undefined) return "";
    const paths = resolveRockyPaths();
    const stateFile = join(paths.home, "gate-state", `${input.sessionKey}.cycles.json`);
    const state = loadCycleState(stateFile, Date.now());
    const observation = observeFailureCycle(state, input.fingerprint, input.rationale);
    if (!saveCycleState(stateFile, state)) return "";
    const line = cycleNudgeLine(observation.cycle);
    if (line === undefined) return "";
    const clusters = countCycleClusters(state);
    return clusters >= 2 ? `${line} ${cycleClusterLine(clusters)}` : line;
  } catch {
    return "";
  }
}

function readShownFixTouches(stateFile: string): string[] | undefined {
  const stat = statSync(stateFile, { throwIfNoEntry: false });
  if (stat === undefined) return [];
  if (!stat.isFile() || stat.size > MAX_FIXTOUCH_STATE_BYTES) return undefined;
  const shown: unknown = JSON.parse(readFileSync(stateFile, "utf8"));
  return Array.isArray(shown) && shown.every((key) => typeof key === "string")
    ? shown.slice(-MAX_FIXTOUCH_SHOWN_KEYS)
    : undefined;
}

function markFixTouchShown(stateFile: string, key: string): boolean {
  const temp = `${stateFile}.tmp`;
  let ownsTemp = false;
  try {
    mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 });
    // The exclusive temp file serializes same-session updates without waiting.
    const fd = openSync(temp, "wx", 0o600);
    ownsTemp = true;
    try {
      const shown = readShownFixTouches(stateFile);
      if (shown === undefined || shown.includes(key)) return false;
      const next = [...shown, key].slice(-MAX_FIXTOUCH_SHOWN_KEYS);
      writeFileSync(fd, JSON.stringify(next), "utf8");
    } finally {
      closeSync(fd);
    }
    renameSync(temp, stateFile);
    ownsTemp = false;
    return true;
  } catch {
    return false;
  } finally {
    if (ownsTemp) {
      try { unlinkSync(temp); } catch { /* Best effort after an unsuccessful update. */ }
    }
  }
}

function fixTouchNote(
  input: GateInput, env: NodeJS.ProcessEnv, now: number,
): { text: string; markShown: () => boolean } | undefined {
  try {
    const { home } = resolveRockyPaths(env);
    if (!fixTouchEnabled(home)) return undefined;
    const { filePath, cwd, sessionKey } = input;
    if (filePath === undefined) return undefined;
    const abs = isAbsolute(filePath) ? filePath : resolve(cwd || process.cwd(), filePath);
    const root = fileGitRoot(abs) ?? (cwd ? resolve(cwd) : undefined);
    if (root === undefined) return undefined;
    const rel = relative(root, abs).replaceAll("\\", "/");
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;

    const cache = readFixTouchCache(fixTouchCachePath(home), now);
    const entry = findFixTouchEntry(cache, root, rel, process.platform);
    if (entry === undefined) return undefined;
    const key = `${rootKey(root, process.platform)}\n${fixTouchPathKey(rel, process.platform)}`;
    const stateFile = join(home, "gate-state", `${sessionKey}.fixtouch.json`);
    const shown = readShownFixTouches(stateFile);
    if (shown === undefined || shown.includes(key)) return undefined;

    const path = sanitizeField(rel, FIXTOUCH_PATH_MAX);
    const cmd = sanitizeField(entry.cmd, FIXTOUCH_CMD_MAX);
    const signature = sanitizeField(entry.signature, FIXTOUCH_SIGNATURE_MAX);
    const date = new Date(entry.ts).toISOString().slice(0, 10);
    const text = `Earlier record for ${path}: edited between a failing and a passing run of ${cmd} (${date}, error "${signature}"). Rocky records order, not cause.`;
    return { text, markShown: () => markFixTouchShown(stateFile, key) };
  } catch {
    return undefined;
  }
}

function silent(): string {
  return "{}";
}

function advise(text: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: `rocky: ${text}`,
    },
  });
}

function extractFilePath(toolInput: unknown): string | undefined {
  if (!isPlainRecord(toolInput)) return undefined;
  const filePath = toolInput.file_path;
  if (typeof filePath === "string" && filePath.length > 0) return filePath;
  const altPath = toolInput.path;
  return typeof altPath === "string" && altPath.length > 0 ? altPath : undefined;
}

function logGateNote(message: string): void {
  try {
    logHookError(message);
  } catch {
    // logHookError is already a fail-open sink; a throw here still must not escape.
  }
}

function dispatch(vendor: string, stdinJson: string): string {
  if (!KNOWN_GATE_VENDORS.has(vendor)) {
    logGateNote(`gate-event: unknown vendor "${vendor}", ignoring`);
    return silent();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(stdinJson);
  } catch {
    return silent();
  }
  if (!isPlainRecord(raw)) return silent();

  const toolName = typeof raw.tool_name === "string" ? raw.tool_name : "";
  if (vendor === "generic" ? toolName.length === 0 : !GATED_TOOLS.has(toolName)) return silent();

  const filePath = extractFilePath(raw.tool_input);
  if (filePath === undefined) return silent();

  const sessionKey = sanitizeSessionId(raw.session_id);
  if (sessionKey === undefined) {
    logGateNote("gate-event: session_id missing or unsafe, ignoring without gate-state");
    return silent();
  }

  const cwd = typeof raw.cwd === "string" ? raw.cwd : "";
  const rationale = typeof raw.rationale === "string" && raw.rationale.length > 0 ? raw.rationale : undefined;
  const failureFingerprint = readFailureFingerprint(raw);
  const input: GateInput = {
    vendor, toolName, filePath, sessionKey, cwd,
    ...(rationale === undefined ? {} : { rationale }),
    ...(failureFingerprint === undefined ? {} : { fingerprint: failureFingerprint }),
  };

  const base = [clarityNudge(input, process.env), cycleNudge(input, process.env)].filter((s) => s.length > 0);
  const baseOut = base.length === 0 ? silent() : advise(base.join(" "));
  const touch = fixTouchNote(input, process.env, Date.now());
  if (touch === undefined) return baseOut;
  const withTouch = advise([...base, touch.text].join(" "));
  if (Buffer.byteLength(withTouch, "utf8") > MAX_GATE_STDOUT_BYTES) return baseOut;
  return touch.markShown() ? withTouch : baseOut;
}

/** Never throws, never denies, never returns a non-zero exit code. */
export function gateEvent(vendor: string, stdinJson: string): { stdout: string; exitCode: 0 } {
  try {
    return { stdout: dispatch(vendor, stdinJson), exitCode: 0 };
  } catch {
    return { stdout: silent(), exitCode: 0 };
  }
}
