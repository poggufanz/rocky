import { Buffer } from "node:buffer";
import { homedir } from "node:os";
import type { Exposure } from "../core/config-read.js";
import type { FailureOrigin, FailureRecord, FixRecord } from "../core/memory-read.js";
import type { RecallHit, RecentFailureHit } from "../core/memory-query.js";

export const MAX_FIELD_BYTES = 16 * 1024;
export const MAX_RESPONSE_BYTES = 512 * 1024;

export interface ProjectedRecallHit {
  candidateId: string;
  fingerprint: string;
  timestamp: number;
  exitCode: number;
  origin: FailureOrigin;
  signature: readonly string[];
  hasFix: boolean;
  command: string;
  fixCommand?: string;
  cwd?: string;
  excerpt?: string;
  rawRecord?: { failure: FailureRecord; fix?: FixRecord };
  truncatedFields: readonly string[];
}

export interface ProjectedRecallResponse {
  exposure: Exposure;
  items: readonly ProjectedRecallHit[];
  truncated: boolean;
}

export interface ProjectedRecentResponse {
  exposure: Exposure;
  items: readonly ProjectedRecallHit[];
  truncated: boolean;
}

type SourceHit = Pick<RecallHit, "failure" | "fix"> | Pick<RecentFailureHit, "failure" | "fix">;
type Truncation = { fields: string[] };

export function strictestExposure(a: Exposure, b: Exposure): Exposure {
  return a === "raw" && b === "raw" ? "raw" : "sanitized";
}

export function normalizeOutputText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return { value, truncated: false };
  const output: string[] = [];
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    output.push(character);
    bytes += characterBytes;
  }
  return { value: output.join(""), truncated: true };
}

export function redactText(value: string, rockyHome = process.env.ROCKY_HOME ?? homedir()): string {
  let output = normalizeOutputText(value);
  const home = normalizeOutputText(rockyHome);
  if (home) output = output.replaceAll(home, "[redacted]");

  return redactHighEntropy(
    output
      .replace(/\b(?:https?|ftp):\/\/[^\s'"`]+/gi, "[redacted]")
      .replace(/(["'])(?:\/[^\r\n]*?|[A-Za-z]:\\[^\r\n]*?|\\\\[^\r\n]*?)\1/g, "[redacted]")
      .replace(/\\\\[^\\\s]+\\[^\s'"`]+/g, "[redacted]")
      .replace(/(?<![A-Za-z0-9])\/(?:[^\s'"`]+)/g, "[redacted]")
      .replace(/\b[A-Za-z]:\\(?:[^\s'"`\\]+\\)*[^\s'"`]*/g, "[redacted]")
      .replace(/\b(Bearer)\s+(?:"[^"]*"|'[^']*'|\S+)/gi, "$1 [redacted]")
      .replace(/\b(authorization|proxy-authorization)\s*:\s*(?:(?:Basic|Bearer|Token)\s+)?(?:"[^"]*"|'[^']*'|\S+)/gi, "$1: [redacted]")
      .replace(/(^|[^A-Za-z0-9_])([A-Za-z0-9_]*(?:key|token|secret|password|passwd|authorization|credential)[A-Za-z0-9_]*)\s*=\s*(?:"[^"]*"|'[^']*'|\S+)/gi, "$1$2=[redacted]")
      .replace(/(--[A-Za-z0-9_-]*(?:key|token|secret|password|passwd|authorization|auth|credential)[A-Za-z0-9_-]*|-[pkt])(?:=(?:"[^"]*"|'[^']*'|\S+)|\s+(?:"[^"]*"|'[^']*'|\S+))/gi, "$1 [redacted]")
      .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|(?:AKIA|ASIA)[0-9A-Z]{16})\b/g, "[redacted]"),
  );
}

function redactHighEntropy(value: string): string {
  // `=` is deliberately absent from the lookbehind. Keeping it there meant a
  // long token sitting immediately after `=` was skipped by the entropy
  // fallback — precisely the shape a leaked credential takes — so any key name
  // the named-key rule above does not recognise leaked in full.
  return value.replace(/(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{32,}={0,2}(?![A-Za-z0-9+/_=-])/g, "[redacted]");
}

function projectText(value: string, exposure: Exposure, path: string, truncation: Truncation): string {
  const normalized = exposure === "sanitized" ? redactText(value) : normalizeOutputText(value);
  const clipped = truncateUtf8(normalized, MAX_FIELD_BYTES);
  if (clipped.truncated) truncation.fields.push(path);
  return clipped.value;
}

function projectSignature(
  signature: readonly string[],
  exposure: Exposure,
  path: string,
  truncation: Truncation,
): string[] {
  const normalized = signature.map((line) => exposure === "sanitized" ? redactText(line) : normalizeOutputText(line));
  if (normalized.length === 0) return [];
  const clipped = truncateUtf8(normalized.join("\n"), MAX_FIELD_BYTES);
  if (clipped.truncated) truncation.fields.push(path);
  return clipped.value.split("\n");
}

function cloneFailure(failure: FailureRecord, exposure: Exposure, truncation: Truncation): FailureRecord {
  const allowed = {
    kind: "failure" as const,
    id: failure.id,
    ts: failure.ts,
    cwd: failure.cwd,
    cmd: failure.cmd,
    exitCode: failure.exitCode,
    fingerprint: failure.fingerprint,
    signature: failure.signature,
    excerpt: failure.excerpt,
    origin: failure.origin,
  };
  const clone: FailureRecord = {
    kind: "failure",
    id: projectText(allowed.id, exposure, "rawRecord.failure.id", truncation),
    ts: allowed.ts,
    cwd: projectText(allowed.cwd, exposure, "rawRecord.failure.cwd", truncation),
    cmd: projectText(allowed.cmd, exposure, "rawRecord.failure.cmd", truncation),
    exitCode: allowed.exitCode,
    fingerprint: projectText(allowed.fingerprint, exposure, "rawRecord.failure.fingerprint", truncation),
    signature: projectSignature(allowed.signature, exposure, "rawRecord.failure.signature", truncation),
    excerpt: projectText(allowed.excerpt, exposure, "rawRecord.failure.excerpt", truncation),
  };
  if (allowed.origin !== undefined) clone.origin = allowed.origin;
  return clone;
}

function cloneFix(fix: FixRecord, exposure: Exposure, truncation: Truncation): FixRecord {
  const allowed = {
    kind: "fix" as const,
    id: fix.id,
    ts: fix.ts,
    cwd: fix.cwd,
    cmd: fix.cmd,
    failureIds: fix.failureIds,
  };
  return {
    kind: "fix",
    id: projectText(allowed.id, exposure, "rawRecord.fix.id", truncation),
    ts: allowed.ts,
    cwd: projectText(allowed.cwd, exposure, "rawRecord.fix.cwd", truncation),
    cmd: projectText(allowed.cmd, exposure, "rawRecord.fix.cmd", truncation),
    failureIds: projectSignature(allowed.failureIds, exposure, "rawRecord.fix.failureIds", truncation),
  };
}

function projectHit(hit: SourceHit, exposure: Exposure, candidateId: string): ProjectedRecallHit {
  const truncation: Truncation = { fields: [] };
  const failure = hit.failure;
  const allowed = {
    candidateId,
    fingerprint: failure.fingerprint,
    timestamp: failure.ts,
    exitCode: failure.exitCode,
    origin: failure.origin ?? "run",
    signature: failure.signature,
    hasFix: hit.fix !== undefined,
    command: failure.cmd,
    ...(hit.fix === undefined ? {} : { fixCommand: hit.fix.cmd }),
    cwd: failure.cwd,
    excerpt: failure.excerpt,
  };
  const projected: ProjectedRecallHit = {
    candidateId: allowed.candidateId,
    fingerprint: projectText(allowed.fingerprint, exposure, "fingerprint", truncation),
    timestamp: allowed.timestamp,
    exitCode: allowed.exitCode,
    origin: allowed.origin,
    signature: projectSignature(allowed.signature, exposure, "signature", truncation),
    hasFix: allowed.hasFix,
    command: projectText(allowed.command, exposure, "command", truncation),
    truncatedFields: truncation.fields,
  };
  if (allowed.fixCommand !== undefined) projected.fixCommand = projectText(allowed.fixCommand, exposure, "fixCommand", truncation);
  if (exposure === "raw") {
    projected.cwd = projectText(allowed.cwd, exposure, "cwd", truncation);
    projected.excerpt = projectText(allowed.excerpt, exposure, "excerpt", truncation);
    projected.rawRecord = {
      failure: cloneFailure(failure, exposure, truncation),
      ...(hit.fix === undefined ? {} : { fix: cloneFix(hit.fix, exposure, truncation) }),
    };
  }
  return projected;
}

function projectHits(hits: readonly SourceHit[], exposure: Exposure): { items: ProjectedRecallHit[]; truncated: boolean } {
  const items: ProjectedRecallHit[] = [];
  let truncated = false;
  for (const [index, hit] of hits.entries()) {
    const item = projectHit(hit, exposure, `c${index + 1}`);
    const prospective = { exposure, items: [...items, item], truncated };
    if (Buffer.byteLength(JSON.stringify(prospective), "utf8") > MAX_RESPONSE_BYTES) {
      truncated = true;
      continue;
    }
    items.push(item);
  }
  return { items, truncated };
}

export function projectRecallHits(hits: readonly RecallHit[], exposure: Exposure): ProjectedRecallResponse {
  const items = projectHits(hits, exposure);
  return { exposure, items: items.items, truncated: items.truncated };
}

export function projectRecentFailures(hits: readonly RecentFailureHit[], exposure: Exposure): ProjectedRecentResponse {
  const items = projectHits(hits, exposure);
  return { exposure, items: items.items, truncated: items.truncated };
}
