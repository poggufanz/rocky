/**
 * Advisory PreToolUse dispatcher — `rocky hook gate-event`.
 *
 * A Claude Code PreToolUse hook calls this once per tool call. It runs
 * deterministic, local advisory checks (prompt clarity and failure-cycle
 * detection against `<ROCKY_HOME>/gate-state/<session>.cycles.json`) and
 * returns either `{}` when silent or one `additionalContext` note for the
 * agent.
 *
 * Hard rule: `gateEvent` NEVER throws, NEVER denies an edit, and NEVER
 * returns a non-zero exit code. Every failure path — unparseable stdin,
 * corrupt state, an unwritable state directory, an unrecognized vendor or
 * tool — prints `{}` and exits 0.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
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
import { resolveRockyPaths } from "../core/state-paths.js";
import { logHookError } from "../commands/agent-hook.js";

const GATED_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit"]);
/** Session ids longer than this get hashed instead of used verbatim as a filename. */
const MAX_RAW_SESSION_ID_LEN = 64;
/** Known PreToolUse payload shapes accepted by `gate-event`. */
const KNOWN_GATE_VENDORS: ReadonlySet<string> = new Set(["claude-code", "generic"]);
const EXPLICIT_FINGERPRINT = /^[0-9a-f]{16}$/u;

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

/**
 * `session_id` arrives from untrusted vendor stdin and becomes a filename
 * (`<gate-state>/<id>.cycles.json`). Allowlist to `[a-zA-Z0-9_-]` so
 * path separators and `..` cannot escape `gate-state/`, and hash overly
 * long ids to bound filename length. Missing/empty/non-string ids return
 * `undefined` so callers stay silent without sharing one fallback file.
 */
export function sanitizeSessionId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (raw.length === 0) return undefined;
  const sanitized = raw.replace(/[^a-zA-Z0-9_-]/gu, "_");
  if (sanitized.length <= MAX_RAW_SESSION_ID_LEN) return sanitized;
  return `sid-${createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 24)}`;
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
    saveCycleState(stateFile, state);
    const line = cycleNudgeLine(observation.cycle);
    if (line === undefined) return "";
    const clusters = countCycleClusters(state);
    return clusters >= 2 ? `${line} ${cycleClusterLine(clusters)}` : line;
  } catch {
    return "";
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

  const note = [clarityNudge(input, process.env), cycleNudge(input, process.env)]
    .filter((s) => s.length > 0)
    .join(" ");
  return note.length === 0 ? silent() : advise(note);
}

/** Never throws, never denies, never returns a non-zero exit code. */
export function gateEvent(vendor: string, stdinJson: string): { stdout: string; exitCode: 0 } {
  try {
    return { stdout: dispatch(vendor, stdinJson), exitCode: 0 };
  } catch {
    return { stdout: silent(), exitCode: 0 };
  }
}
