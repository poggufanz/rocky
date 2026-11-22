/**
 * State and exposure-log I/O for prior-attempts notes.
 *
 * - Deterministic per-session arm assignment from the first bit of
 *   `sha256(session)` (with an explicit test-only seam gated on
 *   `ROCKY_TEST_SEAMS === "1"`).
 * - Atomic once-per-(session, key) dedup under `gate-state/<sanitized>.attempts.json`,
 *   and a 30-minute per-key cooldown under `gate-state/no-session.cooldown.json`
 *   when no session is present.
 * - Append-only exposure log at `<ROCKY_HOME>/advisories.jsonl`, capped at
 *   `ADVISORY_LOG_MAX_BYTES` (8 MiB), storing only hashed directory and
 *   problem-key identifiers.
 *
 * All I/O paths are strictly fail-open so note bookkeeping never throws or
 * interferes with a wrapped command or hook.
 */

import { createHash } from "node:crypto";
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { sanitizeSessionId } from "./agent-session.js";
import { cwdIdentityKey } from "./memory-read.js";
import { resolveRockyPaths } from "./state-paths.js";

export type AttemptArm = "shown" | "held" | "unassigned" | "human";
export type NoteLane = "run" | "watch" | "hookfail" | "tool-result";

export interface ExposureRow {
  v: 1;
  ts: number;
  session: string | null;
  lane: NoteLane;
  kind: "note" | "skip";
  arm: AttemptArm | null;
  key: string | null;
  cwdHash: string;
  anchorFailureId: string | null;
  latencyMs: number;
  delivered: boolean;
  bytes: number;
  reason?: string;
}

export const ADVISORY_LOG_MAX_BYTES = 8 * 1024 * 1024;

const MAX_DEDUP_KEYS = 500;
const MAX_STATE_FILE_BYTES = 256 * 1024;
const NO_SESSION_COOLDOWN_MS = 30 * 60 * 1000;
const MAX_KEY_CHARS = 512;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function resolveHomeOrUndefined(home: string): string | undefined {
  if (typeof home !== "string" || home.trim().length === 0) return undefined;
  return resolveRockyPaths({ ROCKY_HOME: home }).home;
}

/**
 * Decide the arm for one eligible moment:
 * 1. Test seam `ROCKY_ATTEMPT_ARM=shown|held` only when `ROCKY_TEST_SEAMS === "1"`.
 * 2. With a session id, first bit of `sha256(session)`: 0 -> `shown`, 1 -> `held`.
 * 3. Without a session id and `CLAUDECODE === "1"` -> `unassigned`.
 * 4. Without a session id outside an agent shell -> `human`.
 */
export function attemptArm(session: string | undefined, env: NodeJS.ProcessEnv): AttemptArm {
  if (env.ROCKY_TEST_SEAMS === "1") {
    const forced = env.ROCKY_ATTEMPT_ARM;
    if (forced === "shown" || forced === "held") return forced;
  }
  if (typeof session === "string" && session.trim().length > 0) {
    const firstByte = createHash("sha256").update(session, "utf8").digest()[0]!;
    return (firstByte & 0x80) === 0 ? "shown" : "held";
  }
  return env.CLAUDECODE === "1" ? "unassigned" : "human";
}

/** Disabled only when `ROCKY_ATTEMPT_ADVISORY === "off"`. */
export function noteAdvisoryEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.ROCKY_ATTEMPT_ADVISORY !== "off";
}

function loadDedupState(stateFile: string): Map<string, number> {
  const shown = new Map<string, number>();
  try {
    let stats;
    try {
      stats = statSync(stateFile);
    } catch {
      return shown;
    }
    if (!stats.isFile() || stats.size < 0 || stats.size > MAX_STATE_FILE_BYTES) return shown;
    const parsed: unknown = JSON.parse(readFileSync(stateFile, "utf8"));
    if (!isPlainRecord(parsed) || parsed.v !== 1 || !isPlainRecord(parsed.shown)) return shown;
    for (const [key, ts] of Object.entries(parsed.shown)) {
      if (key.length === 0 || key.length > MAX_KEY_CHARS) continue;
      if (typeof ts !== "number" || !Number.isFinite(ts)) continue;
      shown.set(key, ts);
    }
    return shown;
  } catch {
    return shown;
  }
}

function capNewestEntries(entries: ReadonlyMap<string, number>, maxKeys: number): Record<string, number> {
  const ordered = [...entries.entries()].map(([key, ts], index) => ({ key, ts, index }));
  if (ordered.length > maxKeys) {
    ordered.sort((a, b) => (b.ts - a.ts) || (b.index - a.index));
    ordered.length = maxKeys;
  }
  const plain = Object.create(null) as Record<string, number>;
  for (const item of ordered) plain[item.key] = item.ts;
  return plain;
}

function saveDedupState(stateFile: string, shown: ReadonlyMap<string, number>): void {
  const tmp = `${stateFile}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 });
    const payload = { v: 1, shown: capNewestEntries(shown, MAX_DEDUP_KEYS) };
    writeFileSync(tmp, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, stateFile);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      // Best-effort cleanup; never throw out of dedup bookkeeping.
    }
  }
}

/**
 * Claim the note slot for `(session, key)`.
 * - With a session: returns `true` on the first claim for `(session, key)` and
 *   `false` on all subsequent calls within that session file.
 * - Without a session: enforces a 30-minute per-key cooldown in
 *   `gate-state/no-session.cooldown.json`.
 * - Caps stored keys at 500 keeping the newest timestamps.
 * - Fails open (`true`) on corrupt, oversized, or unwritable state.
 */
export function claimNoteSlot(
  home: string,
  session: string | undefined,
  key: string,
  now: number,
): boolean {
  try {
    const resolvedHome = resolveHomeOrUndefined(home);
    if (resolvedHome === undefined) return true;
    if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY_CHARS) return true;

    const timestamp = typeof now === "number" && Number.isFinite(now) ? now : Date.now();
    const sanitized = sanitizeSessionId(session);
    const isSessionScoped = sanitized !== undefined;
    const fileName = isSessionScoped ? `${sanitized}.attempts.json` : "no-session.cooldown.json";
    const stateFile = join(resolvedHome, "gate-state", fileName);

    const shown = loadDedupState(stateFile);
    const previous = shown.get(key);
    if (isSessionScoped) {
      if (previous !== undefined) return false;
    } else if (previous !== undefined && timestamp - previous < NO_SESSION_COOLDOWN_MS) {
      return false;
    }

    shown.delete(key);
    shown.set(key, timestamp);
    saveDedupState(stateFile, shown);
    return true;
  } catch {
    return true;
  }
}

/** 16-hex sha256 prefix of the canonical platform cwd identity key; never contains the path. */
export function cwdHash(cwd: string): string {
  const identity = cwdIdentityKey(cwd, process.platform);
  return createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 16);
}

/** 16-hex sha256 prefix of a problem key; never contains the directory path. */
export function exposureKeyHash(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 16);
}

/**
 * Append one JSON exposure row to `<home>/advisories.jsonl`.
 * Replaces a non-null `row.key` with `exposureKeyHash(row.key)` before serializing.
 * Stops silently once writing would pass `ADVISORY_LOG_MAX_BYTES`. Never throws.
 */
export function appendExposure(home: string, row: ExposureRow): void {
  try {
    const resolvedHome = resolveHomeOrUndefined(home);
    if (resolvedHome === undefined) return;
    const logFile = join(resolvedHome, "advisories.jsonl");
    const serializedRow: ExposureRow =
      row.key === null ? row : { ...row, key: exposureKeyHash(row.key) };
    const line = `${JSON.stringify(serializedRow)}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (lineBytes > ADVISORY_LOG_MAX_BYTES) return;

    let currentSize = 0;
    try {
      const stats = lstatSync(logFile);
      if (!stats.isFile() || stats.isSymbolicLink()) return;
      currentSize = stats.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
    }
    if (currentSize >= ADVISORY_LOG_MAX_BYTES || currentSize + lineBytes > ADVISORY_LOG_MAX_BYTES) {
      return;
    }

    mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 });
    appendFileSync(logFile, line, { encoding: "utf8", mode: 0o600, flag: "a" });
  } catch {
    // Fail open: exposure logging must never disrupt a command or hook.
  }
}
