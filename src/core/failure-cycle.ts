/**
 * Failure-cycle / circuit breaker — deterministic, zero-dependency, no model.
 *
 * A vibe-coding failure mode from the CHI'26 gaps plan: the same trouble
 * returns and the words around it do not change either. This module names
 * that loop from two local signals only — a repeated failure fingerprint
 * (see `core/fingerprint.ts`) and near-identical rationale drafts scored
 * with the same `tokens()`/`similarity()` recall already uses.
 *
 * Detection rule: the same fingerprint observed >= FAILURE_CYCLE_COUNT
 * times in one session, with Jaccard similarity > FAILURE_CYCLE_SIMILARITY
 * between the last two rationales and no new content tokens (the current
 * token set minus the previous set is empty; `tokens()` already drops
 * stopwords) — that observation emits the `cycle` nudge. Counts are
 * reported only; a repeated loop is never presented as proof of cause.
 *
 * Session state is a small fingerprint -> {count, lastRationaleHash,
 * lastTokens} map in its own `<session>.cycles.json` file next to the
 * gate-state fold. It honors the same envelope as the fold
 * (FAILURE_CYCLE_MAX_KEYS mirrors GATE_MAX_ENTRIES, CYCLE_STATE_TIMEOUT_MS
 * mirrors GATE_SESSION_TIMEOUT_MS) and writes atomically (tmp file +
 * rename, the same pattern hook speech publishing uses). Any unreadable or
 * corrupt state reads as empty — the gate stays fail-open. A same-file
 * JSONL fold cannot hold this shape: the fold only stores bare key
 * strings, and encoding token arrays into keys would grow them without a
 * bound, so the separate bounded JSON file is deliberate, not drift.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { similarity, tokens } from "./fingerprint.js";

/** Same trouble seen this many times in one session before it can be a cycle. */
export const FAILURE_CYCLE_COUNT = 3 as const;
/** Jaccard similarity above this between the last two rationales counts as same words. */
export const FAILURE_CYCLE_SIMILARITY = 0.8 as const;
/** Bounds distinct fingerprints kept per session; mirrors GATE_MAX_ENTRIES. */
export const FAILURE_CYCLE_MAX_KEYS = 500 as const;
/** A state file older than this by mtime reads as a fresh session; mirrors GATE_SESSION_TIMEOUT_MS. */
export const CYCLE_STATE_TIMEOUT_MS = 30 * 60 * 1000;
/** Advisory nudge text, Rocky voice: a question ends with `, question`, never `?`. */
export const CYCLE_NUDGE = "same trouble, same words. add new info, question" as const;
/** How many top fingerprints `stats --cycles` lists. */
export const CYCLES_TOP = 10 as const;

/** Rationale text longer than this is truncated before tokenizing; bounds one observation's work. */
const MAX_RATIONALE_CHARS = 8 * 1024;
/** Stored token witnesses per fingerprint; bounds the state file without changing the rule. */
const MAX_STORED_TOKENS = 256;
/** A state file above this size reads as corrupt (fail-open empty). */
const MAX_STATE_FILE_BYTES = 256 * 1024;
/** Longest single token witness kept; longer raw tokens cannot occur from `tokens()` output anyway. */
const MAX_TOKEN_CHARS = 256;

export interface CycleEntry {
  count: number;
  lastRationaleHash: string;
  lastTokens: string[];
}

export interface CycleObservation {
  count: number;
  cycle: boolean;
}

/** Short stable witness for "same words" comparisons; never throws. */
export function hashRationale(text: unknown): string {
  try {
    return createHash("sha1").update(typeof text === "string" ? text : "", "utf8").digest("hex").slice(0, 16);
  } catch {
    return "unhashed";
  }
}

/** Content tokens of a rationale draft; `tokens()` already drops stopwords. Never throws. */
export function rationaleTokens(text: unknown): Set<string> {
  try {
    if (typeof text !== "string" || text.trim().length === 0) return new Set();
    return tokens(text.slice(0, MAX_RATIONALE_CHARS));
  } catch {
    return new Set();
  }
}

/** True when the current draft adds no token the previous draft did not already hold. */
export function hasNewContentTokens(previous: ReadonlySet<string>, current: ReadonlySet<string>): boolean {
  try {
    for (const token of current) if (!previous.has(token)) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Same-words repeat: high Jaccard similarity and nothing new. Empty drafts
 * never count — `similarity()` reports 0 when either side is empty, so a
 * missing rationale stays silent instead of fabricating a loop.
 */
export function isSameWordsRepeat(previous: ReadonlySet<string>, current: ReadonlySet<string>): boolean {
  try {
    return similarity(previous, current) > FAILURE_CYCLE_SIMILARITY
      && !hasNewContentTokens(previous, current);
  } catch {
    return false;
  }
}

function storedTokens(entry: CycleEntry): Set<string> {
  return new Set(Array.isArray(entry.lastTokens) ? entry.lastTokens : []);
}

function boundTokenList(current: ReadonlySet<string>): string[] {
  const kept: string[] = [];
  for (const token of current) {
    if (kept.length >= MAX_STORED_TOKENS) break;
    if (typeof token === "string" && token.length > 0 && token.length <= MAX_TOKEN_CHARS) kept.push(token);
  }
  return kept;
}

/**
 * Fold one observation into session state. Pure except for the passed-in
 * map, which is updated in place. An empty fingerprint records nothing and
 * never triggers. Never throws.
 */
export function observeFailureCycle(
  state: Map<string, CycleEntry>,
  fingerprint: unknown,
  rationale: unknown,
): CycleObservation {
  try {
    if (typeof fingerprint !== "string" || fingerprint.length === 0) return { count: 0, cycle: false };
    if (!(state instanceof Map)) return { count: 0, cycle: false };
    const current = rationaleTokens(rationale);
    const previous = state.get(fingerprint);
    const count = (previous?.count ?? 0) + 1;
    let cycle = false;
    if (previous !== undefined) {
      cycle = count >= FAILURE_CYCLE_COUNT && isSameWordsRepeat(storedTokens(previous), current);
    }
    if (previous === undefined && state.size >= FAILURE_CYCLE_MAX_KEYS) {
      const oldest = state.keys().next();
      if (!oldest.done) state.delete(oldest.value);
    }
    state.set(fingerprint, {
      count,
      lastRationaleHash: hashRationale(typeof rationale === "string" ? rationale : ""),
      lastTokens: boundTokenList(current),
    });
    return { count, cycle };
  } catch {
    return { count: 0, cycle: false };
  }
}

/** How many distinct fingerprints in this session reached loop volume. Count only, no cause named. */
export function countCycleClusters(state: ReadonlyMap<string, CycleEntry>): number {
  try {
    let clusters = 0;
    for (const entry of state.values()) {
      if (typeof entry?.count === "number" && entry.count >= FAILURE_CYCLE_COUNT) clusters += 1;
    }
    return clusters;
  } catch {
    return 0;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isValidEntry(value: unknown): value is CycleEntry {
  if (!isPlainRecord(value)) return false;
  if (typeof value.count !== "number" || !Number.isSafeInteger(value.count) || value.count < 0) return false;
  if (typeof value.lastRationaleHash !== "string" || value.lastRationaleHash.length > 128) return false;
  if (!Array.isArray(value.lastTokens) || value.lastTokens.length > MAX_STORED_TOKENS) return false;
  return value.lastTokens.every((token) => typeof token === "string" && token.length <= MAX_TOKEN_CHARS);
}

/**
 * Read one session's cycle file. Stale (mtime older than the session
 * timeout), oversized, corrupt, or missing state reads as empty — the gate
 * treats that as "no loop heard", never as an error. Never throws.
 */
export function loadCycleState(stateFile: string, now: number = Date.now()): Map<string, CycleEntry> {
  const state = new Map<string, CycleEntry>();
  try {
    if (typeof stateFile !== "string" || stateFile.length === 0) return state;
    let stats;
    try {
      stats = statSync(stateFile);
    } catch {
      return state; // no file yet: fresh session
    }
    if (typeof now !== "number" || Number.isNaN(now)) now = Date.now();
    if (now - stats.mtimeMs > CYCLE_STATE_TIMEOUT_MS) return state; // stale: fresh session
    if (stats.size < 0 || stats.size > MAX_STATE_FILE_BYTES) return state;
    const parsed: unknown = JSON.parse(readFileSync(stateFile, "utf8"));
    if (!isPlainRecord(parsed)) return state;
    for (const [key, value] of Object.entries(parsed)) {
      if (state.size >= FAILURE_CYCLE_MAX_KEYS) break;
      if (key.length === 0 || key.length > 256) continue;
      if (isValidEntry(value)) {
        state.set(key, { count: value.count, lastRationaleHash: value.lastRationaleHash, lastTokens: [...value.lastTokens] });
      }
    }
    return state;
  } catch {
    return state;
  }
}

/**
 * Persist one session's cycle file atomically (tmp file + rename), capped
 * at FAILURE_CYCLE_MAX_KEYS. Returns false instead of throwing when the
 * directory cannot be made or the file cannot be written. Never throws.
 */
export function saveCycleState(stateFile: string, state: ReadonlyMap<string, CycleEntry>): boolean {
  try {
    if (typeof stateFile !== "string" || stateFile.length === 0) return false;
    if (!(state instanceof Map)) return false;
    mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 });
    const plain: Record<string, CycleEntry> = {};
    let kept = 0;
    for (const [key, value] of state) {
      if (kept >= FAILURE_CYCLE_MAX_KEYS) break;
      if (typeof key !== "string" || key.length === 0 || key.length > 256) continue;
      if (!isValidEntry(value)) continue;
      plain[key] = { count: value.count, lastRationaleHash: value.lastRationaleHash, lastTokens: [...value.lastTokens] };
      kept += 1;
    }
    const tmp = `${stateFile}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(plain)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, stateFile);
    return true;
  } catch {
    return false;
  }
}

/**
 * One-line gate/CLI nudge, or undefined when there is no loop to name.
 * Never throws, never returns a question mark. Mirrors the
 * `clarityNudgeLine` advisory rendering pattern from Task 1.
 */
export function cycleNudgeLine(detected: unknown): string | undefined {
  try {
    if (detected !== true) return undefined;
    return `${CYCLE_NUDGE}. try rocky recall, rocky teach <file>, rocky why --diff`;
  } catch {
    return undefined;
  }
}

/**
 * Detail lines for CLI output; the advisory rendering pattern Task 1's
 * `renderClarityCard` established. The cluster line is a count only — it
 * names no cause for the repeats. Never throws, never emits `?`.
 */
export function renderCycleCard(count: number, clusters: number): string[] {
  try {
    const lines: string[] = [CYCLE_NUDGE];
    if (typeof count === "number" && Number.isSafeInteger(count) && count > 0) {
      lines.push(`heard ${count} times this session.`);
    }
    lines.push("try: rocky recall");
    lines.push("try: rocky teach <file>");
    lines.push("try: rocky why --diff");
    if (typeof clusters === "number" && Number.isSafeInteger(clusters) && clusters >= 2) {
      lines.push(`${clusters} repeats heard this session. count only, no cause named.`);
    }
    return lines;
  } catch {
    return [CYCLE_NUDGE];
  }
}
