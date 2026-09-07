/**
 * Gate dispatcher — `rocky hook gate-event`.
 *
 * A Claude Code PreToolUse hook calls this once per tool call. It runs a
 * small check registry against one shared, bounded, per-session state store
 * under `~/.rocky/gate-state/`. v0.7 ships the rationale/explain checks plus
 * one advisory failure-cycle check; the registry stays generic so a future
 * check plugs in without touching this file's schema or the hook install.
 *
 * Hard rule: `gateEvent` NEVER throws and NEVER returns a non-zero exit
 * code. Every failure path — unparseable stdin, corrupt state, an
 * unwritable state directory, an unrecognized vendor or tool — resolves to
 * allow (`{}`) with exit 0. The gate must never be able to block a user's
 * work by breaking.
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { canonicalPath, loadMemory } from "../core/memory-read.js";
import { clarityNudgeLine } from "../core/prompt-clarity.js";
import {
  countCycleClusters,
  cycleNudgeLine,
  loadCycleState,
  observeFailureCycle,
  renderCycleCard,
  saveCycleState,
} from "../core/failure-cycle.js";
import { fingerprint } from "../core/fingerprint.js";
import { resolveRockyPaths } from "../core/state-paths.js";
import { logHookError } from "../commands/agent-hook.js";

/** A state file older than this by mtime is treated as a fresh session (start empty). */
export const GATE_SESSION_TIMEOUT_MS = 30 * 60 * 1000;
/** Bounds how many distinct keys the state fold keeps in memory per read. */
export const GATE_MAX_ENTRIES = 500;

function gateMode(env: NodeJS.ProcessEnv): "nudge" | "strict" {
  return env.ROCKY_GATE_MODE === "strict" ? "strict" : "nudge";
}

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
const KNOWN_GATE_VENDORS: ReadonlySet<string> = new Set(["claude-code", "generic"]);

export interface GateInput {
  vendor: string;
  toolName: string;
  filePath?: string;
  sessionKey: string;
  cwd: string;
  /**
   * Optional rationale draft carried by the hook payload. Scored for an
   * advisory clarity nudge only — it never influences allow/deny.
   */
  rationale?: string;
  /**
   * Optional failure fingerprint carried by the hook payload (explicit
   * 16-hex `fingerprint`, or derived from `stderr`/`cmd`/`exitCode` via
   * `fingerprint()`). Feeds the advisory failure-cycle nudge only — it
   * never influences allow/deny.
   */
  fingerprint?: string;
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
/** How fresh file-linked rationale evidence must be to satisfy the gate. */
const RATIONALE_EVIDENCE_WINDOW_MS = 8 * 60 * 60 * 1000;
/** How fresh file-linked explain evidence must be to satisfy the gate. */
const EXPLAIN_EVIDENCE_WINDOW_MS = 8 * 60 * 60 * 1000;

/** Bounded per-process evidence index keyed by memory file identity. */
interface EvidenceCache {
  memoryPath: string;
  mtimeMs: number;
  size: number;
  rationale: Map<string, number>;
  explain: Map<string, number>;
}

const EVIDENCE_INDEX_CAP = 2000;
let evidenceCache: EvidenceCache | undefined;

function indexEvidence(memoryPath: string): EvidenceCache {
  const rationale = new Map<string, number>();
  const explain = new Map<string, number>();
  try {
    const stats = statSync(memoryPath);
    if (evidenceCache !== undefined
        && evidenceCache.memoryPath === memoryPath
        && evidenceCache.mtimeMs === stats.mtimeMs
        && evidenceCache.size === stats.size) {
      return evidenceCache;
    }
    const now = Date.now();
    const records = loadMemory(memoryPath, now);
    for (let i = records.length - 1; i >= 0; i--) {
      const record = records[i];
      if (record === undefined) continue;
      if (record.kind === "rationale" && rationale.size < EVIDENCE_INDEX_CAP) {
        if (now - record.ts > RATIONALE_EVIDENCE_WINDOW_MS) continue;
        const files = record.files;
        if (files === undefined) continue;
        for (const file of files) {
          const identity = canonicalPath(file, { cwd: record.cwd });
          if (identity.length > 0 && !rationale.has(identity)) rationale.set(identity, record.ts);
        }
      } else if (record.kind === "explain" && explain.size < EVIDENCE_INDEX_CAP) {
        if (now - record.ts > EXPLAIN_EVIDENCE_WINDOW_MS) continue;
        const identity = canonicalPath(record.path, { cwd: record.cwd });
        if (identity.length > 0 && !explain.has(identity)) explain.set(identity, record.ts);
      }
      if (rationale.size >= EVIDENCE_INDEX_CAP && explain.size >= EVIDENCE_INDEX_CAP) break;
    }
    evidenceCache = { memoryPath, mtimeMs: stats.mtimeMs, size: stats.size, rationale, explain };
    return evidenceCache;
  } catch {
    return { memoryPath, mtimeMs: -1, size: -1, rationale, explain };
  }
}

function getEvidenceCache(memoryPath: string): EvidenceCache {
  return indexEvidence(memoryPath);
}

/**
 * True when memory holds a rationale record, fresh within the window, whose
 * `files` list resolves to the same canonical identity as the file being
 * edited. This is what makes the deny message's own instruction
 * (`agent-event ... --files <file>`) actually satisfy the gate instead of
 * relying purely on the deny-once fallback. Any read failure means "no
 * evidence" — never a throw, never a deny on unreadable state.
 */
function hasFreshFileRationale(identity: string, now: number): boolean {
  try {
    return indexEvidence(resolveRockyPaths().memory).rationale.has(identity);
  } catch {
    /* unreadable memory: treated as no evidence, deny-once path decides */
  }
  return false;
}

/**
 * Optional clarity advisory for a rationale draft: appended to an already
 * decided deny reason as text only. Never influences the decision, never
 * throws, silent when the payload carries no rationale, when the draft is
 * already clear, or when ROCKY_CLARITY_ADVISORY=off.
 */
function claritySuffix(input: GateInput): string {
  try {
    if (process.env.ROCKY_CLARITY_ADVISORY === "off") return "";
    if (input.rationale === undefined) return "";
    const line = clarityNudgeLine(input.rationale);
    return line === undefined ? "" : ` ${line}`;
  } catch {
    return "";
  }
}

/**
 * Failure-cycle (circuit breaker) advisory. Today's PreToolUse payloads
 * carry no failure fields, so like the clarity advisory this is API-level
 * until a caller sends `fingerprint` (16 hex chars) or `stderr` with an
 * optional `cmd`/`exitCode` to derive one via `fingerprint()` — all read
 * fail-open. The check itself never denies; it records one observation per
 * gate event and caches that event's nudge so the denying checks below can
 * append it as text only.
 */
const EXPLICIT_FINGERPRINT = /^[0-9a-f]{16}$/u;

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

/** Pending one-line cycle nudge per session for the current gate event only. */
const cycleSuffixBySession = new Map<string, string>();

function cycleCacheKey(home: string, sessionKey: string): string {
  return `${home}\0${sessionKey}`;
}

function rememberCycleSuffix(home: string, sessionKey: string, suffix: string): void {
  try {
    if (cycleSuffixBySession.size >= GATE_MAX_ENTRIES && !cycleSuffixBySession.has(cycleCacheKey(home, sessionKey))) {
      const oldest = cycleSuffixBySession.keys().next();
      if (!oldest.done) cycleSuffixBySession.delete(oldest.value);
    }
    cycleSuffixBySession.set(cycleCacheKey(home, sessionKey), suffix);
  } catch {
    // A broken cache must never break the gate; the suffix just stays silent.
  }
}

/**
 * Advisory-only append for deny reasons, mirroring `claritySuffix`: text
 * only, never a decision. Reads the nudge this event's failure-cycle check
 * already recorded — never touches state itself, so one gate event records
 * exactly one observation no matter how many deny reasons append it.
 */
function cycleSuffix(input: GateInput): string {
  try {
    if (process.env.ROCKY_CYCLE_ADVISORY === "off") return "";
    return cycleSuffixBySession.get(cycleCacheKey(resolveRockyPaths().home, input.sessionKey)) ?? "";
  } catch {
    return "";
  }
}

export const failureCycleCheck: GateCheck = {
  id: "failure-cycle",
  enabled(env: NodeJS.ProcessEnv): boolean {
    return env.ROCKY_CYCLE_ADVISORY !== "off";
  },
  evaluate(input: GateInput): GateDecision {
    try {
      const paths = resolveRockyPaths();
      if (input.fingerprint === undefined || input.rationale === undefined) {
        rememberCycleSuffix(paths.home, input.sessionKey, "");
        return { deny: false };
      }
      const stateFile = join(paths.home, "gate-state", `${input.sessionKey}.cycles.json`);
      const state = loadCycleState(stateFile, Date.now());
      const observation = observeFailureCycle(state, input.fingerprint, input.rationale);
      saveCycleState(stateFile, state);
      const line = cycleNudgeLine(observation.cycle);
      let suffix = line === undefined ? "" : ` ${line}`;
      const clusters = countCycleClusters(state);
      if (suffix.length > 0 && clusters >= 2) {
        // Single-sourced from renderCycleCard so the card and this suffix
        // cannot drift; the emitted string is unchanged.
        const clusterLine = renderCycleCard(observation.count, clusters).find((entry) =>
          entry.includes("count only, no cause named"),
        );
        if (clusterLine !== undefined) suffix += ` ${clusterLine}`;
      }
      rememberCycleSuffix(paths.home, input.sessionKey, suffix);
      return { deny: false };
    } catch {
      return { deny: false };
    }
  },
};

export const rationaleCheck: GateCheck = {
  id: "rationale",
  enabled(env: NodeJS.ProcessEnv): boolean {
    return env.ROCKY_RATIONALE_GATE !== "off";
  },
  evaluate(input: GateInput, state: GateState): GateDecision {    const filePath = input.filePath;
    if (filePath === undefined) return { deny: false };
    const identity = canonicalPath(filePath, { cwd: input.cwd });
    if (identity.length === 0) return { deny: false }; // no stable identity to gate on: fail open
    // Namespaced by check id: the state store is shared across the whole
    // registry (by design, so a future check reads the same session file),
    // so an unprefixed key would let two unrelated checks collide on the
    // same string and misread each other's marks.
    const key = `rationale:${identity}`;
    if (state.has(key)) return { deny: false };
    if (hasFreshFileRationale(identity, Date.now())) {
      state.mark(key); // remember, so later touches skip the memory read
      return { deny: false };
    }
    if (gateMode(process.env) === "strict") return {
      deny: true,
      reason: `state why first. run: rocky hook agent-event ${input.vendor} --rationale "<one line why>" `
        + `--files ${filePath}. then retry. rocky remembers why, you keep why, question${claritySuffix(input)}${cycleSuffix(input)}`,
    };
    if (!state.mark(key)) return { deny: false }; // could not persist the marker: never deny unrecorded state
    return {
      deny: true,
      reason: `state why first. run: rocky hook agent-event ${input.vendor} --rationale "<one line why>" `
        + `--files ${filePath}. then retry. rocky remembers why, you keep why, question${claritySuffix(input)}${cycleSuffix(input)}`,
    };
  },
};

function hasFreshFileExplain(identity: string, now: number): boolean {
  try {
    return indexEvidence(resolveRockyPaths().memory).explain.has(identity);
  } catch {
    /* unreadable memory: treated as no evidence, deny-once path decides */
  }
  return false;
}

export const explainCheck: GateCheck = {
  id: "explain",
  enabled(env: NodeJS.ProcessEnv): boolean {
    return env.ROCKY_RATIONALE_GATE !== "off";
  },
  evaluate(input: GateInput, state: GateState): GateDecision {
    const filePath = input.filePath;
    if (filePath === undefined) return { deny: false };
    const identity = canonicalPath(filePath, { cwd: input.cwd });
    if (identity.length === 0) return { deny: false };
    const key = `explain:${identity}`;
    if (state.has(key)) return { deny: false };
    if (hasFreshFileExplain(identity, Date.now())) {
      state.mark(key);
      return { deny: false };
    }
    if (gateMode(process.env) === "strict") return {
      deny: true,
      reason: `state why first. run: rocky hook agent-event ${input.vendor} --explain-code "<why this code shape>" `
        + `--explain-business "<what concern this serves>" --files ${filePath}. then retry. rocky remembers why, you keep why, question${cycleSuffix(input)}`,
    };
    if (!state.mark(key)) return { deny: false };
    return {
      deny: true,
      reason: `state why first. run: rocky hook agent-event ${input.vendor} --explain-code "<why this code shape>" `
        + `--explain-business "<what concern this serves>" --files ${filePath}. then retry. rocky remembers why, you keep why, question${cycleSuffix(input)}`,
    };
  },
};

/**
 * Registry order matters: the failure-cycle check records this event's
 * observation (and caches its nudge) before the denying checks build their
 * reasons, so `cycleSuffix` below always reads fresh state. The cycle check
 * itself never denies.
 */
const CHECKS: readonly GateCheck[] = [failureCycleCheck, rationaleCheck, explainCheck];

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

const AUDIT_MAX_BYTES = 64 * 1024;

function appendGateAudit(entry: { session: string; vendor: string; tool: string; identity: string; decision: string; evidence: string }): void {
  try {
    const paths = resolveRockyPaths();
    const auditFile = join(paths.home, "gate-state", "audit.jsonl");
    mkdirSync(dirname(auditFile), { recursive: true, mode: 0o700 });
    try {
      const stats = statSync(auditFile);
      if (stats.size > AUDIT_MAX_BYTES) {
        const rotated = join(paths.home, "gate-state", "audit.1.jsonl");
        try { rmSync(rotated, { force: true }); } catch { /* ignore */ }
        try { renameSync(auditFile, rotated); } catch { /* ignore */ }
      }
    } catch {
      // No audit file yet or unreadable: append below creates or skips silently.
    }
    const line = `${JSON.stringify({ ts: Date.now(), ...entry })}\n`;
    appendFileSync(auditFile, line, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Audit is observability; never throw, never deny.
  }
}

function dispatch(vendor: string, stdinJson: string): string {
  if (!KNOWN_GATE_VENDORS.has(vendor)) {
    logGateNote(`gate-event: unknown vendor "${vendor}", allowing without enforcement`);
    return allow();
  }
  if (process.env.ROCKY_GATE_OVERRIDE === "1") {
    appendGateAudit({ session: "override", vendor, tool: "override", identity: "override", decision: "allow", evidence: "override" });
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
  // The generic vendor's caller (a harness plugin) decides which of its own
  // tools to gate, so any non-empty tool name passes; the Claude Code tool
  // whitelist stays exact.
  if (vendor === "generic" ? toolName.length === 0 : !GATED_TOOLS.has(toolName)) return allow();

  const filePath = extractFilePath(raw.tool_input);
  if (filePath === undefined) return allow();

  const sessionKey = sanitizeSessionId(raw.session_id);
  if (sessionKey === undefined) {
    logGateNote("gate-event: session_id missing or unsafe, allowing without gate-state");
    return allow();
  }

  const cwd = typeof raw.cwd === "string" ? raw.cwd : "";
  const rationale = typeof raw.rationale === "string" && raw.rationale.length > 0 ? raw.rationale : undefined;
  const failureFingerprint = readFailureFingerprint(raw);
  const input: GateInput = {
    vendor, toolName, filePath, sessionKey, cwd,
    ...(rationale === undefined ? {} : { rationale }),
    ...(failureFingerprint === undefined ? {} : { fingerprint: failureFingerprint }),
  };

  const paths = resolveRockyPaths();
  const stateFile = join(paths.home, "gate-state", `${sessionKey}.jsonl`);
  const state = createGateState(stateFile);

  for (const check of CHECKS) {
    if (!check.enabled(process.env)) continue;
    const decision = check.evaluate(input, state);
    if (decision.deny) {
      appendGateAudit({ session: sessionKey, vendor, tool: toolName, identity: filePath, decision: "deny", evidence: check.id });
      return deny(decision.reason);
    }
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
