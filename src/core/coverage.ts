/**
 * Feature-coverage tracker — deterministic, zero-dependency, no model.
 *
 * A vibe-coding gap from the CHI'26 plan: a session touches files and the
 * intent behind some of them stays unsaid. This module splits one session's
 * file set into tried (rationale evidence or diff hunks heard) versus
 * untried (neither), for the `brief` Untried section and the GUI dash
 * `coverage` payload.
 *
 * Relation to `check/why-coverage.ts`: that surface answers the pre-push
 * question "which changed paths lack fresh why" with a fixed 8-hour window
 * and counts every triple-observed file as covered. This module answers the
 * session question "which files were touched but never tried": the session
 * set comes from the caller (brief's git-log window) or from memory records
 * themselves (dash), the window is the caller's, and a triple file only
 * counts as tried with rationale evidence behind it or real diff hunks (a
 * plusMinus sum above zero) — a bare [0, 0] observation is touched, not
 * tried. No causal claims: untried names where Rocky heard no why, never
 * why the change exists or whether it works.
 *
 * Every export here is pure (no I/O; `now` comes from the caller) and never
 * throws, so `brief` and the dash stay advisory and fail open. Sets are
 * bounded (COVERAGE_MAX_SESSION_FILES named, the rest counted through
 * `truncated`) and paths are secret-scrubbed with the same
 * `redactSecretsAtBoundary` the diff surfaces use.
 */

import { canonicalPath, type MemoryRecord } from "./memory-read.js";
import { redactSecretsAtBoundary } from "./redact.js";

/** How many tried/untried paths one result names before counting the rest. */
export const COVERAGE_MAX_LISTED = 10 as const;
/** Bounds the session file set; beyond it `truncated` discloses the rest. */
export const COVERAGE_MAX_SESSION_FILES = 200 as const;
/** Bounds tried-identity growth against hostile direct input; memory reads are already enveloped. */
const COVERAGE_MAX_TRIED_IDENTITIES = 4096;
/** Longest single path kept; longer names truncate with an ellipsis. */
const COVERAGE_MAX_PATH_CHARS = 512;
/** Voice line for an empty session: honest, never gap-hiding. */
export const COVERAGE_EMPTY_LINE =
  "no files heard this window. nothing untried, nothing tried." as const;

/**
 * Totals count named files only; when `truncated` is true they are a lower
 * bound and the flag — never an exact over-cap count — carries the rest.
 */
export interface CoverageResult {
  tried: string[];
  triedTotal: number;
  untried: string[];
  untriedTotal: number;
  empty: boolean;
  truncated: boolean;
}

export interface CoverageInput {
  /** Caller-owned session set (brief's git-log window). Absent means derive from records. */
  sessionFiles?: readonly unknown[];
  /** Repo root anchoring relative path identity; absent means identity without anchoring. */
  cwd?: string;
  /** Window start (inclusive); absent means no lower bound. */
  sinceTs?: number;
  /** Window end (inclusive); absent means no upper bound. */
  now?: number;
  /** Memory-read truncation disclosed upstream (stats --cycles pattern). */
  memoryTruncated?: boolean;
}

/**
 * A heard-file entry must be a path, not a shell fragment. Same rule as
 * `fileIndex` in compare-data.ts: agents sometimes pass
 * `--files "$(echo src/a.ts | tr / '/')"` through a shell that never
 * expands it, and the dash must never list a file that cannot exist.
 */
const SHELL_FRAGMENT = /[$`()|<>"]|[\u0000-\u001f\u007f-\u009f]/u;

/** Scrub and bound one candidate path. Undefined means "not a nameable file". Never throws. */
function cleanCoveragePath(value: unknown): string | undefined {
  try {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed === "/dev/null") return undefined;
    if (SHELL_FRAGMENT.test(trimmed)) return undefined;
    const scrubbed = redactSecretsAtBoundary(trimmed).replace(/\\/g, "/").trim();
    if (scrubbed.length === 0 || SHELL_FRAGMENT.test(scrubbed)) return undefined;
    const bounded = scrubbed.length > COVERAGE_MAX_PATH_CHARS
      ? `${scrubbed.slice(0, COVERAGE_MAX_PATH_CHARS - 1)}…`
      : scrubbed;
    return bounded.length === 0 ? undefined : bounded;
  } catch {
    return undefined;
  }
}

/** Canonical identity for tried-matching; "" means unmatchable. Never throws. */
function identityOf(displayPath: string, cwd: string | undefined): string {
  try {
    return cwd === undefined ? canonicalPath(displayPath) : canonicalPath(displayPath, { cwd });
  } catch {
    return "";
  }
}

function isRecordInScope(
  record: Record<string, unknown>,
  root: string | undefined,
  normalizedRoot: string,
  sinceTs: number | undefined,
  now: number | undefined,
): boolean {
  try {
    const ts = (record as { ts?: unknown }).ts;
    if (sinceTs !== undefined && (typeof ts !== "number" || ts < sinceTs)) return false;
    if (now !== undefined && (typeof ts !== "number" || ts > now)) return false;
    if (root !== undefined) {
      const cwd = (record as { cwd?: unknown }).cwd;
      const normalizedCwd = canonicalPath(typeof cwd === "string" ? cwd : "");
      if (!(normalizedCwd === normalizedRoot || normalizedCwd.startsWith(`${normalizedRoot}/`))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function tripleFilesOf(record: Record<string, unknown>): Array<Record<string, unknown>> {
  try {
    const mechanism = (record as { mechanism?: unknown }).mechanism;
    if (typeof mechanism !== "object" || mechanism === null) return [];
    const files = (mechanism as { files?: unknown }).files;
    if (!Array.isArray(files)) return [];
    return files.filter((file): file is Record<string, unknown> =>
      typeof file === "object" && file !== null && !Array.isArray(file));
  } catch {
    return [];
  }
}

function stringFilesOf(record: Record<string, unknown>, key: string): string[] {
  try {
    const value = record[key];
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

function emptyResult(truncated: boolean): CoverageResult {
  return { tried: [], triedTotal: 0, untried: [], untriedTotal: 0, empty: true, truncated };
}

/**
 * Split one session's file set into tried versus untried. Tried means the
 * in-scope records carry rationale evidence for the file (a rationale
 * `files` entry, a triple with non-empty rationale text, an explain, a
 * note) or real diff hunks (a triple mechanism file with a plusMinus sum
 * above zero). Never throws; garbage input reads as an honest empty set.
 */
export function coverageFromRecords(records: unknown, options: CoverageInput = {}): CoverageResult {
  try {
    const list: readonly unknown[] = Array.isArray(records) ? records : [];
    const root = typeof options.cwd === "string" && options.cwd.trim().length > 0
      ? options.cwd
      : undefined;
    const normalizedRoot = root === undefined ? "" : canonicalPath(root);
    const sinceTs = typeof options.sinceTs === "number" && Number.isSafeInteger(options.sinceTs)
      ? options.sinceTs
      : undefined;
    const now = typeof options.now === "number" && Number.isSafeInteger(options.now)
      ? options.now
      : undefined;
    const memoryTruncated = options.memoryTruncated === true;

    // One pass: tried identities from in-scope records, plus the
    // record-derived session set used when the caller names no window files.
    // Each session entry keeps the cwd that anchored it (the owning record,
    // or the caller's root for explicit window files) so tried-matching
    // compares like with like on every platform.
    const tried = new Set<string>();
    interface SessionEntry { display: string; anchor: string | undefined }
    const derived: SessionEntry[] = [];
    const derivedSeen = new Set<string>();
    const rememberDerived = (display: string | undefined, anchor: string | undefined): void => {
      if (display === undefined || derived.length >= COVERAGE_MAX_SESSION_FILES) return;
      const identity = identityOf(display, anchor);
      const key = [anchor ?? "", identity || display].join("\u0000");
      if (derivedSeen.has(key)) return;
      derivedSeen.add(key);
      derived.push({ display, anchor });
    };

    for (const entry of list) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      if (!isRecordInScope(record, root, normalizedRoot, sinceTs, now)) continue;
      const kind = record.kind;
      const recordCwd = typeof record.cwd === "string" ? record.cwd : undefined;
      if (kind === "triple") {
        const files = tripleFilesOf(record);
        let rationaleBacked = false;
        try {
          const rationale = (record as { rationale?: unknown }).rationale;
          rationaleBacked = typeof rationale === "object" && rationale !== null
            && typeof (rationale as { text?: unknown }).text === "string"
            && ((rationale as { text: string }).text.trim().length > 0);
        } catch {
          rationaleBacked = false;
        }
        for (const file of files) {
          const display = cleanCoveragePath(file.path);
          if (display === undefined) continue;
          rememberDerived(display, recordCwd);
          if (tried.size >= COVERAGE_MAX_TRIED_IDENTITIES) continue;
          const identity = identityOf(display, recordCwd);
          if (identity.length === 0) continue;
          let hunks = false;
          try {
            const plusMinus = file.plusMinus;
            hunks = Array.isArray(plusMinus) && plusMinus.length === 2
              && typeof plusMinus[0] === "number" && typeof plusMinus[1] === "number"
              && plusMinus[0] >= 0 && plusMinus[1] >= 0
              && plusMinus[0] + plusMinus[1] > 0;
          } catch {
            hunks = false;
          }
          if (hunks || rationaleBacked) tried.add(identity);
        }
      } else if (kind === "rationale") {
        for (const file of stringFilesOf(record, "files")) {
          const display = cleanCoveragePath(file);
          if (display === undefined) continue;
          rememberDerived(display, recordCwd);
          if (tried.size >= COVERAGE_MAX_TRIED_IDENTITIES) continue;
          const identity = identityOf(display, recordCwd);
          if (identity.length > 0) tried.add(identity);
        }
      } else if (kind === "explain") {
        const display = cleanCoveragePath(record.path);
        if (display === undefined) continue;
        rememberDerived(display, recordCwd);
        if (tried.size < COVERAGE_MAX_TRIED_IDENTITIES) {
          const identity = identityOf(display, recordCwd);
          if (identity.length > 0) tried.add(identity);
        }
      } else if (kind === "note") {
        const display = cleanCoveragePath(record.file);
        if (display === undefined) continue;
        rememberDerived(display, recordCwd);
        if (tried.size < COVERAGE_MAX_TRIED_IDENTITIES) {
          const identity = identityOf(display, recordCwd);
          if (identity.length > 0) tried.add(identity);
        }
      }
    }

    // Session set: the caller's window files win; otherwise the heard files.
    let session: SessionEntry[];
    let sessionTruncated = false;
    if (options.sessionFiles !== undefined && Array.isArray(options.sessionFiles)) {
      session = [];
      const seen = new Set<string>();
      let distinct = 0;
      for (const candidate of options.sessionFiles) {
        const display = cleanCoveragePath(candidate);
        if (display === undefined) continue;
        const identity = identityOf(display, root);
        const key = `${root ?? ""}\u0000${identity || display}`;
        if (seen.has(key)) continue;
        seen.add(key);
        distinct += 1;
        if (session.length < COVERAGE_MAX_SESSION_FILES) session.push({ display, anchor: root });
      }
      sessionTruncated = distinct > session.length;
    } else {
      session = derived;
      // Derived collection stops naming at the cap; more distinct heard
      // files may exist past it, so hitting the cap discloses truncation.
      // (Exact over-cap counts are not tracked; the flag is a lower bound.)
      sessionTruncated = derived.length >= COVERAGE_MAX_SESSION_FILES;
    }

    if (session.length === 0) return emptyResult(memoryTruncated || sessionTruncated);

    const triedDisplay: string[] = [];
    const untriedDisplay: string[] = [];
    for (const { display, anchor } of session) {
      const identity = identityOf(display, anchor);
      if (identity.length > 0 && tried.has(identity)) triedDisplay.push(display);
      else untriedDisplay.push(display);
    }
    const triedTotal = triedDisplay.length;
    const untriedTotal = untriedDisplay.length;
    const triedCapped = triedDisplay.length > COVERAGE_MAX_LISTED;
    const untriedCapped = untriedDisplay.length > COVERAGE_MAX_LISTED;
    return {
      tried: triedCapped ? triedDisplay.slice(0, COVERAGE_MAX_LISTED) : triedDisplay,
      triedTotal,
      untried: untriedCapped ? untriedDisplay.slice(0, COVERAGE_MAX_LISTED) : untriedDisplay,
      untriedTotal,
      empty: false,
      truncated: memoryTruncated || sessionTruncated || triedCapped || untriedCapped,
    };
  } catch {
    return emptyResult(false);
  }
}

/**
 * Detail-ready Untried lines: a count line in Rocky voice plus plain paths,
 * never shaming, never a question mark. An empty session stays honest —
 * "nothing untried, nothing tried", never "all covered". Never throws.
 */
export function renderUntriedCard(result: unknown): string[] {
  try {
    if (typeof result !== "object" || result === null || Array.isArray(result)) {
      return [COVERAGE_EMPTY_LINE];
    }
    const { triedTotal, untried, untriedTotal, empty } = result as Partial<CoverageResult>;
    if (empty === true || (triedTotal === 0 && untriedTotal === 0)) {
      return [COVERAGE_EMPTY_LINE];
    }
    const untriedCount = typeof untriedTotal === "number" && Number.isSafeInteger(untriedTotal) && untriedTotal >= 0
      ? untriedTotal
      : 0;
    if (untriedCount === 0) {
      const triedCount = typeof triedTotal === "number" && Number.isSafeInteger(triedTotal) && triedTotal > 0
        ? triedTotal
        : 0;
      return triedCount === 1
        ? ["1 file heard with why. good good."]
        : [`all ${triedCount} heard with why. good good.`];
    }
    const paths = Array.isArray(untried)
      ? untried.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      : [];
    const lines = [`${untriedCount} file${untriedCount === 1 ? "" : "s"} touched but not heard why yet.`, ...paths];
    const extra = untriedCount - paths.length;
    if (extra > 0) lines.push(`and ${extra} more unheard.`);
    return lines;
  } catch {
    return [COVERAGE_EMPTY_LINE];
  }
}
