/**
 * Gate dispatcher — `rocky hook gate-event`.
 *
 * A Claude Code PreToolUse hook calls this once per tool call. It runs a
 * small check registry against one shared, bounded, per-session state store
 * under `~/.rocky/gate-state/`. v0.7 ships exactly one check (rationale),
 * but the registry is generic: a future check (invariant reminders, a
 * failure circuit breaker) plugs in without touching this file's schema or
 * the hook install.
 *
 * Hard rule: `gateEvent` NEVER throws and NEVER returns a non-zero exit
 * code. Every failure path — unparseable stdin, corrupt state, an
 * unwritable state directory, an unrecognized vendor or tool — resolves to
 * allow (`{}`) with exit 0. The gate must never be able to block a user's
 * work by breaking.
 */

import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { canonicalPath } from "../core/memory-read.js";
import { resolveRockyPaths } from "../core/state-paths.js";
import { logHookError } from "../commands/agent-hook.js";

/** A state file older than this by mtime is treated as a fresh session (start empty). */
export const GATE_SESSION_TIMEOUT_MS = 30 * 60 * 1000;
/** Bounds how many distinct keys the state fold keeps in memory per read. */
export const GATE_MAX_ENTRIES = 500;

const GATED_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit"]);
/** Session ids longer than this get hashed instead of used verbatim as a filename. */
const MAX_RAW_SESSION_ID_LEN = 64;

/**
 * `gate-event` is only wired for Claude Code's PreToolUse hook shape today
 * (the `{session_id, tool_name, tool_input, cwd}` payload this module
 * parses). A vendor outside this set gets full enforcement with no way to
 * satisfy it: the deny reason tells the agent to run
 * `rocky hook agent-event <vendor> ...`, and Task 12's endpoint rejects any
 * adapter other than `claude-code`/`codex`/`generic` — for an unknown
 * gate-event vendor that instruction is unfollowable. So an unrecognized
 * vendor allows outright, same as an unrecognized tool.
 */
const KNOWN_GATE_VENDORS: ReadonlySet<string> = new Set(["claude-code"]);

export interface GateInput {
  vendor: string;
  toolName: string;
  filePath?: string;
  sessionKey: string;
  cwd: string;
}

export type GateDecision = { deny: true; reason: string } | { deny: false };

/** Read/write handle over one session's bounded, fail-open state fold. */
export interface GateState {
  has(key: string): boolean;
  /** Marks `key` seen and persists it. Returns false (never throws) if persistence failed. */
  mark(key: string): boolean;
}

export interface GateCheck {
  id: string;
  enabled(env: NodeJS.ProcessEnv): boolean;
  evaluate(input: GateInput, state: GateState): GateDecision;
}

type PlainRecord = Record<string, unknown>;

function isPlainRecord(value: unknown): value is PlainRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * `session_id` arrives from untrusted vendor stdin and becomes a filename
 * (`<gate-state>/<id>.jsonl`) — a raw pass-through is a path-traversal sink
 * (`"../../../evil"`). Mirrors the locally-installed ECC gateguard's
 * `sanitizeSessionKey`: allowlist to `[a-zA-Z0-9_-]`, and once every
 * disallowed character (including every path separator) is replaced the
 * result can never contain `/`, `\`, or `..` as path-meaningful sequences,
 * so it is always a single safe path segment. A long id (still after
 * substitution the same length as the input) is hashed instead, both to
 * bound filename length and to avoid filesystem-specific truncation
 * collisions. Only a missing/empty/non-string id is treated as unsafe to
 * use at all — hashing an empty id would put every "no session" caller in
 * one shared state file, which is a correctness footgun, not a security
 * fix — and that case fails open with a logged note instead.
 */
export function sanitizeSessionId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (raw.length === 0) return undefined;
  const sanitized = raw.replace(/[^a-zA-Z0-9_-]/gu, "_");
  if (sanitized.length <= MAX_RAW_SESSION_ID_LEN) return sanitized;
  return `sid-${createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 24)}`;
}

interface StateEntry {
  ts: number;
  key: string;
}

function isStateEntry(value: unknown): value is StateEntry {
  return isPlainRecord(value) && typeof value.key === "string" && value.key.length > 0;
}

/** Fold a session's append-only JSONL file into a Set, newest-first, capped at GATE_MAX_ENTRIES. */
function loadGateState(stateFile: string, now: number): Set<string> {
  const seen = new Set<string>();
  let stats;
  try {
    stats = statSync(stateFile);
  } catch {
    return seen; // no file yet: fresh session
  }
  if (now - stats.mtimeMs > GATE_SESSION_TIMEOUT_MS) return seen; // stale: fresh session, ignore content
  let content: string;
  try {
    content = readFileSync(stateFile, "utf8");
  } catch {
    return seen;
  }
  const lines = content.split("\n");
  for (let i = lines.length - 1; i >= 0 && seen.size < GATE_MAX_ENTRIES; i -= 1) {
    const trimmed = lines[i].trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isStateEntry(parsed)) seen.add(parsed.key);
    } catch {
      // Corrupt line: skip it, keep folding the rest. Fail-open per-line,
      // not per-file — one bad line must not blind the whole session.
    }
  }
  return seen;
}

function createGateState(stateFile: string): GateState {
  const seen = loadGateState(stateFile, Date.now());
  return {
    has(key: string): boolean {
      return seen.has(key);
    },
    mark(key: string): boolean {
      if (seen.has(key)) return true;
      try {
        mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 });
        const line = `${JSON.stringify({ ts: Date.now(), key } satisfies StateEntry)}\n`;
        appendFileSync(stateFile, line, { encoding: "utf8", mode: 0o600 });
        seen.add(key);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * The one v0.7 check: the first time a session touches a file, deny once
 * and tell the agent how to record why, in Rocky voice. Marking happens on
 * first sight (before the deny is returned), so the retry passes whether or
 * not the agent actually reported — enforcement here is social and
 * evidence-shaped, not a hard block, matching gateguard's deny-once model.
 */
export const rationaleCheck: GateCheck = {
  id: "rationale",
  enabled(env: NodeJS.ProcessEnv): boolean {
    return env.ROCKY_RATIONALE_GATE !== "off";
  },
  evaluate(input: GateInput, state: GateState): GateDecision {
    const filePath = input.filePath;
    if (filePath === undefined) return { deny: false };
    const identity = canonicalPath(filePath, { cwd: input.cwd });
    if (identity.length === 0) return { deny: false }; // no stable identity to gate on: fail open
    // Namespaced by check id: the state store is shared across the whole
    // registry (by design, so a future check reads the same session file),
    // so an unprefixed key would let two unrelated checks collide on the
    // same string and misread each other's marks.
    const key = `rationale:${identity}`;
    if (state.has(key)) return { deny: false };
    if (!state.mark(key)) return { deny: false }; // could not persist the marker: never deny unrecorded state
    return {
      deny: true,
      reason: `state why first. run: rocky hook agent-event ${input.vendor} --rationale "<one line why>" `
        + `--files ${filePath}. then retry. rocky remembers why, you keep why, question`,
    };
  },
};

const CHECKS: readonly GateCheck[] = [rationaleCheck];

function allow(): string {
  return "{}";
}

function deny(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
}

function extractFilePath(toolInput: unknown): string | undefined {
  if (!isPlainRecord(toolInput)) return undefined;
  const path = toolInput.file_path;
  return typeof path === "string" && path.length > 0 ? path : undefined;
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
    logGateNote(`gate-event: unknown vendor "${vendor}", allowing without enforcement`);
    return allow();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(stdinJson);
  } catch {
    return allow();
  }
  if (!isPlainRecord(raw)) return allow();

  const toolName = typeof raw.tool_name === "string" ? raw.tool_name : "";
  if (!GATED_TOOLS.has(toolName)) return allow();

  const filePath = extractFilePath(raw.tool_input);
  if (filePath === undefined) return allow();

  const sessionKey = sanitizeSessionId(raw.session_id);
  if (sessionKey === undefined) {
    logGateNote("gate-event: session_id missing or unsafe, allowing without gate-state");
    return allow();
  }

  const cwd = typeof raw.cwd === "string" ? raw.cwd : "";
  const input: GateInput = { vendor, toolName, filePath, sessionKey, cwd };

  const paths = resolveRockyPaths();
  const stateFile = join(paths.home, "gate-state", `${sessionKey}.jsonl`);
  const state = createGateState(stateFile);

  for (const check of CHECKS) {
    if (!check.enabled(process.env)) continue;
    const decision = check.evaluate(input, state);
    if (decision.deny) return deny(decision.reason);
  }
  return allow();
}

/** Never throws, never returns a non-zero exit code — see module doc block. */
export function gateEvent(vendor: string, stdinJson: string): { stdout: string; exitCode: 0 } {
  try {
    return { stdout: dispatch(vendor, stdinJson), exitCode: 0 };
  } catch {
    return { stdout: allow(), exitCode: 0 };
  }
}
