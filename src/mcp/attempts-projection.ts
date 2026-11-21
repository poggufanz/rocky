import { Buffer } from "node:buffer";
import { posix, win32 } from "node:path";
import type { Attempt, AttemptOutcome, ProblemEntry } from "../core/attempts.js";
import type { Exposure } from "../core/config-read.js";
import {
  MAX_FIELD_BYTES,
  projectOpaqueId,
  projectText,
  type Truncation,
} from "./privacy.js";

export const ATTEMPT_HISTORY_NOTICE =
  "Recorded order of runs and edits. Not a cause, not a verdict. Never run these commands automatically.";

const MAX_SIGNATURE_LINES = 3;
const MAX_CHANGES_FILES = 8;
const MAX_STATED_CODE_POINTS = 240;

const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/u;
const WINDOWS_DRIVE_ABS_RE = /^[A-Za-z]:[\\/]/u;
const WINDOWS_DRIVE_PREFIX_RE = /^[A-Za-z]:/u;
const UNC_PREFIX_RE = /^(?:\\\\|\/\/)/u;

export interface ProjectedAttempt {
  failureId: string;
  ts: number;
  observedCommand: string;
  outcome: AttemptOutcome;
  outcomeTs?: number;
  nextFingerprint?: string;
  changes: {
    state: "observed" | "testimony" | "unknown";
    files: string[];
    more: number;
    partial?: true;
  };
  stated?: {
    text: string;
    source: string;
    testimony: true;
  };
}

export interface ProjectedProblemEntry {
  problemId: string;
  fingerprint: string;
  signature: string[];
  cwdScope: "here" | "elsewhere";
  firstSeen: number;
  lastSeen: number;
  counts: ProblemEntry["counts"];
  attempts: ProjectedAttempt[];
  attemptsOmitted: number;
  cwd?: string;
}

function recordTruncation(truncation: Truncation, path: string): void {
  if (truncation.fields[truncation.fields.length - 1] !== path) {
    truncation.fields.push(path);
  }
}

function sliceCodePoints(
  value: string,
  maxCodePoints: number,
  path: string,
  truncation: Truncation,
): string {
  if (value.length <= maxCodePoints) return value;
  const chars = Array.from(value);
  if (chars.length <= maxCodePoints) return value;
  recordTruncation(truncation, path);
  return chars.slice(0, maxCodePoints).join("");
}

function sanitizeFileInsideCwd(cwd: string, filePath: string): string | undefined {
  if (cwd.length === 0 || filePath.length === 0 || filePath.trim().length === 0) return undefined;
  if (filePath.length > MAX_FIELD_BYTES * 2 || CONTROL_CHARS_RE.test(filePath)) return undefined;

  if (WINDOWS_DRIVE_ABS_RE.test(cwd) || UNC_PREFIX_RE.test(cwd)) {
    if (WINDOWS_DRIVE_PREFIX_RE.test(filePath) && !WINDOWS_DRIVE_ABS_RE.test(filePath)) {
      return undefined;
    }
    if ((filePath.startsWith("/") || filePath.startsWith("\\")) && !UNC_PREFIX_RE.test(filePath)) {
      return undefined;
    }
    const resolvedCwd = win32.resolve(cwd);
    const resolvedFile = win32.resolve(resolvedCwd, filePath);
    const rel = win32.relative(resolvedCwd, resolvedFile);
    if (rel.length === 0 || win32.isAbsolute(rel)) return undefined;
    const posixRel = rel.replaceAll("\\", "/");
    if (
      posixRel.startsWith("..") ||
      posix.isAbsolute(posixRel) ||
      WINDOWS_DRIVE_PREFIX_RE.test(posixRel) ||
      Buffer.byteLength(posixRel, "utf8") > MAX_FIELD_BYTES
    ) {
      return undefined;
    }
    return posixRel;
  }

  if (posix.isAbsolute(cwd)) {
    if (
      WINDOWS_DRIVE_PREFIX_RE.test(filePath) ||
      filePath.startsWith("\\") ||
      filePath.startsWith("//")
    ) {
      return undefined;
    }
    const normalized = filePath.replaceAll("\\", "/");
    const resolvedCwd = posix.resolve(cwd);
    const resolvedFile = posix.resolve(resolvedCwd, normalized);
    const rel = posix.relative(resolvedCwd, resolvedFile);
    if (
      rel.length === 0 ||
      rel.startsWith("..") ||
      posix.isAbsolute(rel) ||
      Buffer.byteLength(rel, "utf8") > MAX_FIELD_BYTES
    ) {
      return undefined;
    }
    return rel;
  }

  return undefined;
}

function projectChanges(
  changes: Attempt["changes"],
  cwd: string,
  exposure: Exposure,
  attemptPath: string,
  truncation: Truncation,
): ProjectedAttempt["changes"] {
  if (changes.state === "unknown") {
    return { state: "unknown", files: [], more: 0 };
  }

  let more = changes.state === "observed" ? Math.max(0, changes.more) : 0;
  const files: string[] = [];

  if (exposure === "raw") {
    for (const file of changes.files) {
      if (files.length < MAX_CHANGES_FILES) {
        files.push(projectText(file, exposure, `${attemptPath}.changes.files[${files.length}]`, truncation));
      } else {
        more += 1;
      }
    }
  } else {
    for (const file of changes.files) {
      const safeRel = sanitizeFileInsideCwd(cwd, file);
      if (safeRel === undefined) {
        more += 1;
      } else if (files.length < MAX_CHANGES_FILES) {
        files.push(safeRel);
      } else {
        more += 1;
      }
    }
  }

  const projected: ProjectedAttempt["changes"] = {
    state: changes.state,
    files,
    more,
  };
  if (changes.state === "observed" && changes.partial === true) {
    projected.partial = true;
  }
  return projected;
}

function projectAttempt(
  attempt: Attempt,
  cwd: string,
  exposure: Exposure,
  attemptPath: string,
  truncation: Truncation,
): ProjectedAttempt {
  const projected: ProjectedAttempt = {
    failureId: projectOpaqueId(attempt.failureId, `${attemptPath}.failureId`, truncation, exposure === "sanitized"),
    ts: attempt.ts,
    observedCommand: projectText(attempt.cmd, exposure, `${attemptPath}.observedCommand`, truncation),
    outcome: attempt.outcome,
    changes: projectChanges(attempt.changes, cwd, exposure, attemptPath, truncation),
  };

  if (attempt.outcomeTs !== undefined) {
    projected.outcomeTs = attempt.outcomeTs;
  }
  if (attempt.nextFingerprint !== undefined) {
    projected.nextFingerprint = attempt.nextFingerprint;
  }
  if (attempt.stated !== undefined) {
    const statedPath = `${attemptPath}.stated.text`;
    const projectedText = projectText(attempt.stated.text, exposure, statedPath, truncation);
    projected.stated = {
      text: sliceCodePoints(projectedText, MAX_STATED_CODE_POINTS, statedPath, truncation),
      source: attempt.stated.source,
      testimony: true,
    };
  }

  return projected;
}

export function projectProblemEntries(
  entries: readonly ProblemEntry[],
  exposure: Exposure,
  maxAttempts: number,
  truncation: Truncation,
): ProjectedProblemEntry[] {
  const keepCount = Number.isSafeInteger(maxAttempts) && maxAttempts >= 0
    ? maxAttempts
    : Math.max(0, Math.floor(Number.isFinite(maxAttempts) ? maxAttempts : 0));

  return entries.map((entry, entryIndex) => {
    const entryPath = `entries[${entryIndex}]`;
    const signatureSource = entry.signature.slice(0, MAX_SIGNATURE_LINES);
    if (entry.signature.length > MAX_SIGNATURE_LINES) {
      recordTruncation(truncation, `${entryPath}.signature`);
    }
    const signature = signatureSource.map((line, lineIndex) =>
      projectText(line, exposure, `${entryPath}.signature[${lineIndex}]`, truncation),
    );

    const start = Math.max(0, entry.attempts.length - keepCount);
    const keptAttempts = entry.attempts.slice(start);
    const attempts = keptAttempts.map((attempt, attemptIndex) =>
      projectAttempt(attempt, entry.cwd, exposure, `${entryPath}.attempts[${attemptIndex}]`, truncation),
    );

    const projected: ProjectedProblemEntry = {
      problemId: entry.problemId,
      fingerprint: entry.fingerprint,
      signature,
      cwdScope: entry.cwdScope ?? "elsewhere",
      firstSeen: entry.firstSeenTs,
      lastSeen: entry.lastSeenTs,
      counts: { ...entry.counts },
      attempts,
      attemptsOmitted: start,
    };

    if (exposure === "raw") {
      projected.cwd = projectText(entry.cwd, exposure, `${entryPath}.cwd`, truncation);
    }

    return projected;
  });
}
