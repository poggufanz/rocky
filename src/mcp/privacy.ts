import { Buffer } from "node:buffer";
import { homedir } from "node:os";
import type { Exposure } from "../core/config-read.js";
import { boundTripleRecord, isSafeNonNegativeInteger, MAX_TRIPLE_FILES } from "../core/memory-read.js";
import { canonicalPath } from "../core/memory-read.js";
import type { FailureOrigin, FailureRecord, FixRecord, MemoryRecord, TripleRecord } from "../core/memory-read.js";
import { hasCanonicalKnowledgeProof } from "../core/memory-query.js";
import type { KnowledgeSearchHit, RecallHit, RecentFailureHit, WhyFilePossible } from "../core/memory-query.js";
import { redactSecretsAtBoundary, replaceAnsiAndControls, stripInvisibleControls } from "../core/redact.js";

export const MAX_FIELD_BYTES = 16 * 1024;
export const MAX_RESPONSE_BYTES = 512 * 1024;
/** Keep forged direct projections bounded while preserving the documented 20k probe. */
const MAX_KNOWLEDGE_FILE_INPUTS = 20_000;
const MAX_KNOWLEDGE_HIT_INPUTS = 20_000;
const MAX_NESTED_ITEMS = 256;
const MAX_NESTED_BYTES = 64 * 1024;

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

export interface ProjectedTriple {
  id: string;
  timestamp: number;
  agent: "claude-code" | "codex";
  source: "agent-hook";
  intent?: string;
  rationale?: { text: string; tags: readonly string[] };
  files: readonly {
    path: string;
    plusMinus: [number, number];
    props: readonly string[];
    excerpt?: string;
    provenance?: "tool-observed" | "git-diff-inferred" | "unknown";
  }[];
  filesCovered: readonly string[];
  truncatedFiles: number;
  complete: boolean;
  baseline?: "captured" | "unknown";
  coverageStatus?: "complete" | "truncated" | "unknown";
  cwd?: string;
  truncatedFields: readonly string[];
}

export interface ProjectedKnowledgeHit {
  id: string;
  ts: number;
  kind: "failure" | "fix" | "triple" | "note";
  snippet: string;
  score: number;
  agent?: "claude-code" | "codex";
  source?: string;
  filesCovered?: readonly string[];
  truncatedFiles?: number;
  complete?: boolean;
  coverageStatus?: "complete" | "truncated" | "unknown";
  truncatedFields: readonly string[];
}

export interface ProjectedKnowledgeResponse {
  exposure: Exposure;
  items: readonly ProjectedKnowledgeHit[];
  truncated: boolean;
}

export type KnowledgeIdProjector = (value: string) => string | undefined;

export interface ProjectedWhyPossible {
  id: string;
  ts: number;
  source: "agent-hook";
  reason: "path_may_be_omitted";
}

type SourceHit = Pick<RecallHit, "failure" | "fix"> | Pick<RecentFailureHit, "failure" | "fix">;
type Truncation = { fields: string[] };

export function strictestExposure(a: Exposure, b: Exposure): Exposure {
  return a === "raw" && b === "raw" ? "raw" : "sanitized";
}

export function normalizeOutputText(value: string): string {
  return stripInvisibleControls(replaceAnsiAndControls(value, "", " "))
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
  let output = normalizeOutputText(redactSecretsAtBoundary(value))
    .replace(/\[redacted (?!ambiguous continuation\])[^\]]+\]/g, "[redacted]");
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

function boundProjectionInput(value: string): string {
  return value.length > MAX_FIELD_BYTES * 2 ? value.slice(0, MAX_FIELD_BYTES * 2) : value;
}

function projectText(value: string, exposure: Exposure, path: string, truncation: Truncation): string {
  const boundedInput = boundProjectionInput(value);
  if (boundedInput.length !== value.length) truncation.fields.push(path);
  const normalized = exposure === "sanitized" ? redactText(boundedInput) : normalizeOutputText(boundedInput);
  const clipped = truncateUtf8(normalized, MAX_FIELD_BYTES);
  if (clipped.truncated) truncation.fields.push(path);
  return clipped.value;
}

const ROCKY_ID = /^(?:[0-9a-f]{16,64}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|(?:triple|failure|fix|association|note)-[A-Za-z0-9._-]{1,96})$/iu;
const SENSITIVE_ID_WORD = /(?:password|passwd|secret|token|credential|authorization|api[-_]?key|gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|glpat-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|(?:AKIA|ASIA)[0-9A-Z]{16})/iu;

export function safeOpaqueIdentifier(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
    && !SENSITIVE_ID_WORD.test(value)
    && (ROCKY_ID.test(value) || (value.length <= 64 && /^[A-Za-z][A-Za-z0-9._:-]*$/u.test(value)));
}

function projectSignature(
  signature: readonly string[],
  exposure: Exposure,
  path: string,
  truncation: Truncation,
): string[] {
  const normalized: string[] = [];
  let bytes = 0;
  let boundedLength = 0;
  let sourceLength = 0;
  try {
    const length = Number.isSafeInteger(signature.length) && signature.length >= 0 ? signature.length : 0;
    sourceLength = length;
    const bound = Math.min(length, MAX_NESTED_ITEMS);
    if (length > bound) truncation.fields.push(path);
    for (let index = 0; index < bound; index += 1) {
      const line = signature[index];
      if (typeof line !== "string") {
        truncation.fields.push(path);
        continue;
      }
      const boundedLine = boundProjectionInput(line);
      if (boundedLine.length !== line.length) truncation.fields.push(path);
      const normalizedLine = exposure === "sanitized" ? redactText(boundedLine) : normalizeOutputText(boundedLine);
      const lineBytes = Buffer.byteLength(normalizedLine, "utf8");
      if (bytes + lineBytes > MAX_NESTED_BYTES) {
        truncation.fields.push(path);
        break;
      }
      bytes += lineBytes;
      normalized.push(normalizedLine);
      boundedLength += 1;
    }
  } catch {
    truncation.fields.push(path);
  }
  if (sourceLength > boundedLength) truncation.fields.push(path);
  if (normalized.length === 0) return [];
  const clipped = truncateUtf8(normalized.join("\n"), MAX_FIELD_BYTES);
  if (clipped.truncated) truncation.fields.push(path);
  return clipped.value.split("\n");
}

function projectStringArray(
  values: readonly string[],
  exposure: Exposure,
  path: string,
  truncation: Truncation,
): string[] {
  let wasTruncated = false;
  const output: string[] = [];
  let bytes = 0;
  try {
    const length = Number.isSafeInteger(values.length) && values.length >= 0 ? values.length : 0;
    const bound = Math.min(length, MAX_NESTED_ITEMS);
    if (length > bound) wasTruncated = true;
    for (let index = 0; index < bound; index += 1) {
      const value = values[index];
      if (typeof value !== "string") {
        wasTruncated = true;
        continue;
      }
      const boundedValue = boundProjectionInput(value);
      if (boundedValue.length !== value.length) wasTruncated = true;
      const normalized = exposure === "sanitized" ? redactText(boundedValue) : normalizeOutputText(boundedValue);
      const clipped = truncateUtf8(normalized, MAX_FIELD_BYTES);
      if (clipped.truncated) wasTruncated = true;
      const itemBytes = Buffer.byteLength(clipped.value, "utf8");
      if (bytes + itemBytes > MAX_NESTED_BYTES) {
        wasTruncated = true;
        break;
      }
      bytes += itemBytes;
      output.push(clipped.value);
    }
  } catch {
    wasTruncated = true;
  }
  if (wasTruncated) truncation.fields.push(path);
  return output;
}

function projectOpaqueId(value: string, path: string, truncation: Truncation, sanitize = false): string {
  const boundedInput = boundProjectionInput(value);
  if (boundedInput.length !== value.length) truncation.fields.push(path);
  const safe = sanitize && safeOpaqueIdentifier(boundedInput)
    ? boundedInput
    : sanitize ? "[redacted]" : normalizeOutputText(boundedInput);
  const clipped = truncateUtf8(safe, MAX_FIELD_BYTES);
  if (clipped.truncated) truncation.fields.push(path);
  return clipped.value;
}

function projectOpaqueIds(values: readonly string[], path: string, truncation: Truncation, sanitize = false): string[] {
  let wasTruncated = false;
  const output: string[] = [];
  let bytes = 0;
  try {
    const length = Number.isSafeInteger(values.length) && values.length >= 0 ? values.length : 0;
    const bounded = Math.min(length, MAX_NESTED_ITEMS);
    if (length > bounded) wasTruncated = true;
    for (let index = 0; index < bounded; index += 1) {
      const value = values[index];
      if (typeof value !== "string") {
        wasTruncated = true;
        continue;
      }
      const boundedInput = boundProjectionInput(value);
      if (boundedInput.length !== value.length) wasTruncated = true;
      const safe = sanitize
        ? (safeOpaqueIdentifier(boundedInput) ? boundedInput : "[redacted]")
        : normalizeOutputText(boundedInput);
      const clipped = truncateUtf8(safe, MAX_FIELD_BYTES);
      if (clipped.truncated) wasTruncated = true;
      const itemBytes = Buffer.byteLength(clipped.value, "utf8");
      if (bytes + itemBytes > MAX_NESTED_BYTES) {
        wasTruncated = true;
        break;
      }
      bytes += itemBytes;
      output.push(clipped.value);
    }
  } catch {
    wasTruncated = true;
  }
  if (wasTruncated) truncation.fields.push(path);
  return output;
}

function safePlusMinus(value: number): number {
  return isSafeNonNegativeInteger(value) ? value : 0;
}

function projectTripleFile(
  file: TripleRecord["mechanism"]["files"][number],
  index: number,
  exposure: Exposure,
  truncation: Truncation,
): ProjectedTriple["files"][number] {
  const projected: ProjectedTriple["files"][number] = {
    path: projectText(file.path, exposure, `files[${index}].path`, truncation),
    plusMinus: [safePlusMinus(file.plusMinus[0]), safePlusMinus(file.plusMinus[1])],
    props: projectStringArray(file.props, exposure, `files[${index}].props`, truncation),
  };
  if (file.provenance !== undefined) projected.provenance = file.provenance;
  if (exposure === "raw" && file.excerpt !== undefined) {
    projected.excerpt = projectText(file.excerpt, exposure, `files[${index}].excerpt`, truncation);
  }
  return projected;
}

export function projectTriple(triple: TripleRecord, exposure: Exposure, sanitizeIds = false): ProjectedTriple {
  const bounded = boundTripleRecord(triple);
  const truncation: Truncation = { fields: [] };
  const projected: ProjectedTriple = {
    id: projectOpaqueId(bounded.id, "id", truncation, sanitizeIds),
    timestamp: bounded.ts,
    agent: bounded.agent,
    source: bounded.origin,
    files: bounded.mechanism.files.map((file, index) => projectTripleFile(file, index, exposure, truncation)),
    filesCovered: bounded.mechanism.files.map((file, index) => projectText(file.path, exposure, `filesCovered[${index}]`, truncation)),
    truncatedFiles: bounded.mechanism.truncatedFiles,
    complete: bounded.mechanism.coverageStatus === "complete"
      && bounded.mechanism.truncatedFiles === 0
      && bounded.mechanism.baseline === "captured"
      && bounded.mechanism.files.length > 0
      && bounded.mechanism.files.every((file) => file.provenance === "tool-observed" || file.provenance === "git-diff-inferred"),
    truncatedFields: truncation.fields,
  };
  if (bounded.mechanism.baseline !== undefined) projected.baseline = bounded.mechanism.baseline;
  if (bounded.mechanism.coverageStatus !== undefined) projected.coverageStatus = bounded.mechanism.coverageStatus;
  if (bounded.intent !== undefined) {
    projected.intent = projectText(bounded.intent.text, exposure, "intent", truncation);
  }
  if (bounded.rationale !== undefined) {
    projected.rationale = {
      text: projectText(bounded.rationale.text, exposure, "rationale.text", truncation),
      tags: projectStringArray(bounded.rationale.tags, exposure, "rationale.tags", truncation),
    };
  }
  if (exposure === "raw") projected.cwd = projectText(bounded.cwd, exposure, "cwd", truncation);
  return projected;
}

/** Normalize custom why-file evidence before it reaches the MCP response cap. */
export function projectWhyPossible(
  values: readonly WhyFilePossible[],
  limit: number,
  exposure: Exposure = "sanitized",
): ProjectedWhyPossible[] {
  const output: ProjectedWhyPossible[] = [];
  const maximum = Math.min(10, Math.max(0, Number.isSafeInteger(limit) ? limit : 0));
  let inputLength = 0;
  try {
    if (!Array.isArray(values)) return output;
    inputLength = Math.min(values.length, MAX_NESTED_ITEMS);
  } catch {
    return output;
  }
  for (let index = 0; index < inputLength && output.length < maximum; index += 1) {
    try {
      const value = values[index] as unknown as Record<string, unknown>;
      const ts = value.ts;
      if (typeof value !== "object" || value === null || Array.isArray(value) ||
          typeof value.id !== "string" || typeof ts !== "number" || !Number.isSafeInteger(ts) || ts < 0 ||
          value.source !== "agent-hook" || value.reason !== "path_may_be_omitted") continue;
      if (/[\u0000-\u001f\u007f-\u009f]/u.test(value.id)) continue;
      const truncation: Truncation = { fields: [] };
      output.push({
        id: projectOpaqueId(value.id, "possible.id", truncation, exposure === "sanitized"),
        ts,
        source: "agent-hook",
        reason: "path_may_be_omitted",
      });
    } catch {
      // A hostile custom MemoryQueries implementation cannot break MCP.
    }
  }
  return output;
}

function safeKnowledgeString(value: unknown, maximum = MAX_FIELD_BYTES): string | undefined {
  if (typeof value !== "string") return undefined;
  const boundedInput = value.length > maximum * 2 ? value.slice(0, maximum * 2) : value;
  return truncateUtf8(boundedInput, maximum).value;
}

function safeKnowledgeId(value: unknown): string | undefined {
  const id = safeKnowledgeString(value);
  return id !== undefined && id.trim().length > 0 && !/[\u0000-\u001f\u007f-\u009f]/u.test(id) ? id : undefined;
}

function normalizeKnowledgeHit(value: unknown, now = Date.now()): KnowledgeSearchHit | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const raw = value as Record<string, unknown>;
    const id = safeKnowledgeId(raw.id);
    const ts = typeof raw.ts === "number" && Number.isSafeInteger(raw.ts) && raw.ts >= 0 ? raw.ts : undefined;
    const kind = raw.kind === "failure" || raw.kind === "fix" || raw.kind === "triple" || raw.kind === "note"
      ? raw.kind
      : undefined;
    const snippet = safeKnowledgeString(raw.snippet);
    if (id === undefined || ts === undefined || ts > now || kind === undefined || snippet === undefined) return undefined;

    const score = typeof raw.score === "number" && Number.isFinite(raw.score)
      ? Math.min(1, Math.max(0, raw.score))
      : 0;
    const agent = raw.agent === "claude-code" || raw.agent === "codex" ? raw.agent : undefined;
    const sourceValue = safeKnowledgeString(raw.source);
    const source = sourceValue !== undefined && (
      (kind === "failure" && (sourceValue === "run" || sourceValue === "hook" || sourceValue === "watch"))
      || (kind === "fix" && sourceValue === "fix")
      || (kind === "triple" && sourceValue === "agent-hook")
      || (kind === "note" && sourceValue === "note")
    ) ? sourceValue : undefined;
    if ((raw.agent !== undefined && agent === undefined) || (raw.source !== undefined && source === undefined)) {
      return undefined;
    }
    const rawComplete = typeof raw.complete === "boolean" ? raw.complete : undefined;
    const coverageProof = hasCanonicalKnowledgeProof(value);
    const coverageStatus = raw.coverageStatus === "complete" || raw.coverageStatus === "truncated" || raw.coverageStatus === "unknown"
      ? raw.coverageStatus
      : raw.coverageStatus === undefined ? undefined : "unknown";
    const rawTruncatedFiles = raw.truncatedFiles;
    const truncatedValid = rawTruncatedFiles === undefined || isSafeNonNegativeInteger(rawTruncatedFiles);
    const truncatedFiles: number = truncatedValid && typeof rawTruncatedFiles === "number" ? rawTruncatedFiles : 0;
    const rawFilesCovered = raw.filesCovered;
    let filesCovered: string[] | undefined;
    let filesCoveredLength = 0;
    let filesCoveredTruncated = false;
    let filesCoveredMalformed = false;
    if (rawFilesCovered !== undefined) {
      if (!Array.isArray(rawFilesCovered)) {
        filesCovered = [];
        filesCoveredMalformed = true;
      } else {
        let length = 0;
        try {
          length = rawFilesCovered.length;
          if (!Number.isSafeInteger(length) || length < 0) {
            filesCovered = [];
            filesCoveredMalformed = true;
            length = 0;
          }
        } catch {
          filesCovered = [];
          filesCoveredMalformed = true;
        }
        filesCoveredLength = length;
        const bound = Math.min(length, MAX_KNOWLEDGE_FILE_INPUTS);
        filesCoveredTruncated = length > bound;
        const normalized: string[] = [];
        for (let index = 0; index < bound; index += 1) {
          let file: unknown;
          try { file = rawFilesCovered[index]; } catch { filesCoveredMalformed = true; break; }
          if (typeof file !== "string" || file.length > MAX_FIELD_BYTES * 2) {
            filesCoveredMalformed = true;
            continue;
          }
          normalized.push(file);
        }
        filesCovered = normalized;
      }
    }
    const malformedCoverage = filesCoveredMalformed
      || filesCoveredTruncated
      || !truncatedValid
      || (raw.coverageStatus !== undefined && coverageStatus === "unknown" && raw.coverageStatus !== "unknown");
    let normalizedStatus: KnowledgeSearchHit["coverageStatus"] = coverageStatus;
    let normalizedComplete = rawComplete;
    if (kind !== "triple" && (rawFilesCovered !== undefined || rawTruncatedFiles !== undefined
      || raw.coverageStatus !== undefined || rawComplete !== undefined)) {
      normalizedStatus = "unknown";
      normalizedComplete = false;
    }
    if (malformedCoverage || (truncatedFiles > 0 && normalizedStatus === "complete")) {
      normalizedStatus = malformedCoverage ? "unknown" : "truncated";
      normalizedComplete = false;
    }
    if (normalizedComplete === true && (kind !== "triple" || normalizedStatus !== "complete" || filesCovered === undefined)) {
      normalizedComplete = false;
    }
    // KnowledgeSearchHit intentionally carries only bounded file names, not
    // baseline/provenance proof.  The canonical in-process query marks its
    // complete result explicitly; custom providers cannot upgrade a hit by
    // merely setting `complete` or `coverageStatus` to a strong value.
    const provenComplete = kind === "triple"
      && coverageProof
      && normalizedComplete === true
      && normalizedStatus === "complete"
      && filesCovered !== undefined;
    if (kind === "triple" && normalizedStatus === "complete" && !provenComplete) {
      normalizedComplete = false;
      normalizedStatus = filesCoveredTruncated || filesCoveredLength > MAX_TRIPLE_FILES
        ? "truncated"
        : "unknown";
    }
    return {
      id,
      ts,
      kind,
      snippet,
      score,
      ...(agent === undefined ? {} : { agent }),
      ...(source === undefined ? {} : { source }),
      ...(filesCovered === undefined ? {} : { filesCovered }),
      ...(rawTruncatedFiles === undefined || !truncatedValid ? {} : { truncatedFiles }),
      ...(normalizedComplete === undefined ? {} : { complete: normalizedComplete }),
      ...(normalizedStatus === undefined ? {} : { coverageStatus: normalizedStatus }),
    };
  } catch {
    return undefined;
  }
}

export function projectKnowledgeHits(
  hits: readonly KnowledgeSearchHit[],
  exposure: Exposure,
  idProjector?: KnowledgeIdProjector,
): ProjectedKnowledgeResponse {
  const project = (hit: KnowledgeSearchHit, preserveCanonicalMultiplicity = false): ProjectedKnowledgeHit => {
    const truncation: Truncation = { fields: [] };
    let filesCovered: string[] | undefined;
    let truncatedFiles: number | undefined;
    let coverageStatus: ProjectedKnowledgeHit["coverageStatus"] = hit.coverageStatus;
    let complete = hit.complete;
    if (hit.filesCovered !== undefined || hit.kind === "triple") {
      const sourceFiles = Array.isArray(hit.filesCovered) ? hit.filesCovered : [];
      const inputBounded = sourceFiles.length > MAX_KNOWLEDGE_FILE_INPUTS
        ? sourceFiles.slice(0, MAX_KNOWLEDGE_FILE_INPUTS)
        : sourceFiles;
      const unique = new Map<string, string>();
      let invalid = !Array.isArray(hit.filesCovered) && hit.filesCovered !== undefined;
      let hasAbsolute = false;
      let hasRelative = false;
      if (hit.kind === "triple" && sourceFiles.length === 0) invalid = true;
      if (sourceFiles.length > MAX_KNOWLEDGE_FILE_INPUTS) invalid = true;
      for (const value of inputBounded) {
        if (typeof value !== "string") {
          invalid = true;
          continue;
        }
        // A projected hit has no durable origin/cwd metadata. Preserve case
        // instead of consulting reader process.platform, which could collapse
        // distinct POSIX paths after cross-platform reload.
        const path = canonicalPath(value, { platform: "unknown" });
        if (!path) {
          invalid = true;
          continue;
        }
        if (/^(?:\/|[A-Za-z]:\/)/u.test(path)) hasAbsolute = true;
        else hasRelative = true;
        if (preserveCanonicalMultiplicity) unique.set(`${path}\u0000${unique.size}`, path);
        else if (!unique.has(path)) unique.set(path, path);
      }
      // Hits do not carry cwd/origin metadata. Mixed absolute and relative
      // spellings cannot be proven to identify one file, so never claim
      // complete coverage for that ambiguous projection.
      if (hasAbsolute && hasRelative) invalid = true;
      const allCount = unique.size;
      const bounded = [...unique.values()].slice(0, MAX_TRIPLE_FILES);
      const omitted = Math.max(0, allCount - bounded.length);
      const declaredValid = hit.truncatedFiles === undefined || isSafeNonNegativeInteger(hit.truncatedFiles);
      if (!declaredValid) invalid = true;
      const declared = declaredValid && hit.truncatedFiles !== undefined ? hit.truncatedFiles : 0;
      const total = declared + omitted;
      if (!Number.isSafeInteger(total)) invalid = true;
      truncatedFiles = Number.isSafeInteger(total) ? total : 0;
      if (omitted > 0 && coverageStatus === "complete") coverageStatus = "truncated";
      if (coverageStatus !== "complete" && coverageStatus !== "truncated") coverageStatus = "unknown";
      if (invalid) coverageStatus = "unknown";
      complete = coverageStatus === "complete" && truncatedFiles === 0 && complete === true;
      filesCovered = projectStringArray(bounded, exposure, "filesCovered", truncation);
      if (omitted > 0 || sourceFiles.length > inputBounded.length || (hit.filesCovered?.length ?? 0) > bounded.length) {
        truncation.fields.push("filesCovered");
      }
    }
    if (truncatedFiles !== undefined && truncatedFiles > 0 && coverageStatus === "complete") {
      coverageStatus = "truncated";
      complete = false;
    }
    const projected: ProjectedKnowledgeHit = {
      id: idProjector?.(hit.id)
        ?? projectOpaqueId(hit.id, "id", truncation, exposure === "sanitized"),
      ts: hit.ts,
      kind: hit.kind,
      snippet: projectText(hit.snippet, exposure, "snippet", truncation),
      score: Number.isFinite(hit.score) ? hit.score : 0,
      ...(hit.agent === undefined ? {} : { agent: hit.agent }),
      ...(hit.source === undefined ? {} : { source: projectText(hit.source, exposure, "source", truncation) }),
      ...(filesCovered === undefined ? {} : { filesCovered }),
      ...(truncatedFiles === undefined ? {} : { truncatedFiles }),
      ...(complete === undefined ? {} : { complete }),
      ...(coverageStatus === undefined ? {} : { coverageStatus }),
      truncatedFields: truncation.fields,
    };
    return projected;
  };
  const items: ProjectedKnowledgeHit[] = [];
  let serializedItemBytes = 0;
  const responsePrefix = Buffer.byteLength(JSON.stringify({ exposure, items: [] }).replace("[]}", "["), "utf8");
  const responseBytes = (truncatedValue: boolean, additional = 0, includeComma = false): number => {
    const suffix = `],"truncated":${truncatedValue ? "true" : "false"}}`;
    return responsePrefix + serializedItemBytes + additional + (includeComma ? 1 : 0) + Buffer.byteLength(suffix, "utf8");
  };
  const sourceHits: unknown[] = [];
  let inputTruncated = false;
  try {
    if (Array.isArray(hits)) {
      const length = hits.length;
      if (!Number.isSafeInteger(length) || length < 0) return { exposure, items, truncated: true };
      inputTruncated = length > MAX_KNOWLEDGE_HIT_INPUTS;
      const bound = Math.min(length, MAX_KNOWLEDGE_HIT_INPUTS);
      for (let index = 0; index < bound; index += 1) {
        try { sourceHits.push(hits[index]); } catch { inputTruncated = true; break; }
      }
    } else {
      inputTruncated = true;
    }
  } catch {
    inputTruncated = true;
  }
  let truncated = inputTruncated;
  for (let index = 0; index < sourceHits.length; index += 1) {
    const candidate = sourceHits[index];
    const hit = normalizeKnowledgeHit(candidate);
    if (hit === undefined) {
      truncated = true;
      continue;
    }
    const item = project(hit, hasCanonicalKnowledgeProof(candidate));
    let serialized: string;
    try {
      serialized = JSON.stringify(item);
    } catch {
      truncated = true;
      continue;
    }
    const itemBytes = Buffer.byteLength(serialized, "utf8");
    if (responseBytes(truncated, itemBytes, items.length > 0) > MAX_RESPONSE_BYTES) {
      truncated = true;
      continue;
    }
    items.push(item);
    serializedItemBytes += itemBytes + (items.length > 1 ? 1 : 0);
  }
  return { exposure, items, truncated };
}

function projectFailureRecord(failure: FailureRecord, exposure: Exposure, sanitizeIds = false): Record<string, unknown> {
  const truncation: Truncation = { fields: [] };
  const projected: Record<string, unknown> = {
    kind: "failure",
    id: projectOpaqueId(failure.id, "record.id", truncation, sanitizeIds),
    ts: failure.ts,
    cmd: projectText(failure.cmd, exposure, "record.cmd", truncation),
    exitCode: failure.exitCode,
    fingerprint: projectText(failure.fingerprint, exposure, "record.fingerprint", truncation),
    signature: projectSignature(failure.signature, exposure, "record.signature", truncation),
    truncatedFields: truncation.fields,
  };
  if (failure.origin !== undefined) projected.origin = failure.origin;
  if (failure.resolvedBy !== undefined) projected.resolvedBy = projectOpaqueId(failure.resolvedBy, "record.resolvedBy", truncation, sanitizeIds);
  if (exposure === "raw") {
    projected.cwd = projectText(failure.cwd, exposure, "record.cwd", truncation);
    projected.excerpt = projectText(failure.excerpt, exposure, "record.excerpt", truncation);
  }
  return projected;
}

function projectFixRecord(fix: FixRecord, exposure: Exposure, sanitizeIds = false): Record<string, unknown> {
  const truncation: Truncation = { fields: [] };
  const projected: Record<string, unknown> = {
    kind: "fix",
    id: projectOpaqueId(fix.id, "record.id", truncation, sanitizeIds),
    ts: fix.ts,
    cmd: projectText(fix.cmd, exposure, "record.cmd", truncation),
    failureIds: projectOpaqueIds(fix.failureIds, "record.failureIds", truncation, sanitizeIds),
    truncatedFields: truncation.fields,
  };
  if (fix.links !== undefined) {
    const links: FixRecord["links"] = [];
    try {
      const length = Number.isSafeInteger(fix.links.length) && fix.links.length >= 0 ? fix.links.length : 0;
      const bound = Math.min(length, MAX_NESTED_ITEMS);
      if (length > bound) truncation.fields.push("record.links");
      for (let index = 0; index < bound; index += 1) {
        const link = fix.links[index];
        if (!link || typeof link.id !== "string"
            || (link.basis !== "identity" && link.basis !== "signature" && link.basis !== "program")
            || (link.confidence !== undefined && link.confidence !== "confirmed" && link.confidence !== "possible")) {
          truncation.fields.push("record.links");
          continue;
        }
        links.push({ id: link.id, basis: link.basis, ...(link.confidence === undefined ? {} : { confidence: link.confidence }) });
      }
    } catch {
      truncation.fields.push("record.links");
    }
    projected.links = links.map((link, index) => ({
      id: projectOpaqueId(link.id, `record.links[${index}].id`, truncation, sanitizeIds),
      basis: link.basis,
      ...(link.confidence === undefined ? {} : { confidence: link.confidence }),
    }));
  }
  if (fix.candidateFailureIds !== undefined) {
    projected.candidateFailureIds = projectOpaqueIds(fix.candidateFailureIds, "record.candidateFailureIds", truncation, sanitizeIds);
  }
  if (exposure === "raw") projected.cwd = projectText(fix.cwd, exposure, "record.cwd", truncation);
  return projected;
}

export function projectMemoryRecord(record: MemoryRecord, exposure: Exposure, sanitizeIds = false): Record<string, unknown> | undefined {
  if (record.kind === "failure") return projectFailureRecord(record, exposure, sanitizeIds);
  if (record.kind === "fix") return projectFixRecord(record, exposure, sanitizeIds);
  if (record.kind === "triple") return projectTriple(record, exposure, sanitizeIds) as unknown as Record<string, unknown>;
  return undefined;
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
    id: projectOpaqueId(allowed.id, "rawRecord.failure.id", truncation),
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
    candidateFailureIds: fix.candidateFailureIds,
    links: fix.links,
  };
  const projected: FixRecord = {
    kind: "fix",
    id: projectOpaqueId(allowed.id, "rawRecord.fix.id", truncation),
    ts: allowed.ts,
    cwd: projectText(allowed.cwd, exposure, "rawRecord.fix.cwd", truncation),
    cmd: projectText(allowed.cmd, exposure, "rawRecord.fix.cmd", truncation),
    failureIds: projectOpaqueIds(allowed.failureIds, "rawRecord.fix.failureIds", truncation),
  };
  if (allowed.links !== undefined) {
    projected.links = allowed.links.map((link, index) => ({
      id: projectOpaqueId(link.id, `rawRecord.fix.links[${index}].id`, truncation),
      basis: link.basis,
      ...(link.confidence === undefined ? {} : { confidence: link.confidence }),
    }));
  }
  if (allowed.candidateFailureIds !== undefined) {
    projected.candidateFailureIds = projectOpaqueIds(
      allowed.candidateFailureIds,
      "rawRecord.fix.candidateFailureIds",
      truncation,
    );
  }
  return projected;
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

function boundedStringArray(value: unknown, maximum = MAX_NESTED_ITEMS): string[] | undefined {
  try {
    if (!Array.isArray(value)) return undefined;
    const length = value.length;
    if (!Number.isSafeInteger(length) || length < 0) return undefined;
    if (length > maximum) return undefined;
    const output: string[] = [];
    let bytes = 0;
    for (let index = 0; index < length; index += 1) {
      const item = value[index];
      if (typeof item !== "string") return undefined;
      if (item.length > MAX_FIELD_BYTES * 2) return undefined;
      const boundedItem = item.length > MAX_FIELD_BYTES
        ? truncateUtf8(item, MAX_FIELD_BYTES * 2).value
        : item;
      const itemBytes = Buffer.byteLength(boundedItem, "utf8");
      if (bytes + itemBytes > MAX_NESTED_BYTES) return undefined;
      bytes += itemBytes;
      output.push(boundedItem);
    }
    return output;
  } catch {
    return undefined;
  }
}

function boundedSourceString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length > MAX_FIELD_BYTES * 2) return undefined;
  if (Buffer.byteLength(value, "utf8") > MAX_FIELD_BYTES * 2) return undefined;
  return value;
}

function snapshotSourceFailure(value: unknown, now: number): FailureRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const kind = raw.kind;
  if (kind !== "failure") return undefined;
  const id = boundedSourceString(raw.id);
  if (id === undefined || id.length === 0 || /[\u0000-\u001f\u007f-\u009f]/u.test(id)) return undefined;
  const ts = raw.ts;
  if (!isSafeNonNegativeInteger(ts) || ts > now) return undefined;
  const cwd = boundedSourceString(raw.cwd);
  if (cwd === undefined) return undefined;
  const cmd = boundedSourceString(raw.cmd);
  if (cmd === undefined) return undefined;
  const exitCode = raw.exitCode;
  if (typeof exitCode !== "number" || !Number.isSafeInteger(exitCode)) return undefined;
  const fingerprint = boundedSourceString(raw.fingerprint);
  if (fingerprint === undefined) return undefined;
  const signature = boundedStringArray(raw.signature);
  if (signature === undefined) return undefined;
  const excerpt = boundedSourceString(raw.excerpt);
  if (excerpt === undefined) return undefined;
  const origin = raw.origin;
  if (origin !== undefined && origin !== "run" && origin !== "hook" && origin !== "watch") return undefined;
  return {
    kind: "failure", id, ts, cwd, cmd, exitCode, fingerprint, signature, excerpt,
    ...(origin === undefined ? {} : { origin: origin as FailureOrigin }),
  };
}

function snapshotSourceFix(value: unknown, now: number): FixRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const kind = raw.kind;
  if (kind !== "fix") return undefined;
  const id = boundedSourceString(raw.id);
  if (id === undefined || id.length === 0 || /[\u0000-\u001f\u007f-\u009f]/u.test(id)) return undefined;
  const ts = raw.ts;
  if (!isSafeNonNegativeInteger(ts) || ts > now) return undefined;
  const cwd = boundedSourceString(raw.cwd);
  if (cwd === undefined) return undefined;
  const cmd = boundedSourceString(raw.cmd);
  if (cmd === undefined) return undefined;
  const failureIds = boundedStringArray(raw.failureIds);
  if (failureIds === undefined) return undefined;
  return { kind: "fix", id, ts, cwd, cmd, failureIds };
}

function snapshotSourceHit(value: unknown, now: number): SourceHit | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const failure = snapshotSourceFailure(raw.failure, now);
  if (failure === undefined) return undefined;
  const fixValue = raw.fix;
  if (fixValue === undefined) return { failure };
  const fix = snapshotSourceFix(fixValue, now);
  if (fix === undefined) return undefined;
  return { failure, fix };
}

function normalizeSourceHit(value: unknown, now: number): SourceHit | undefined {
  try {
    return snapshotSourceHit(value, now);
  } catch {
    return undefined;
  }
}

function projectHits(hits: readonly SourceHit[], exposure: Exposure, now: number): { items: ProjectedRecallHit[]; truncated: boolean } {
  const items: ProjectedRecallHit[] = [];
  let truncated = false;
  let serializedItemBytes = 0;
  const responsePrefix = Buffer.byteLength(JSON.stringify({ exposure, items: [] }).replace("[]}", "["), "utf8");
  const responseBytes = (truncatedValue: boolean, additional = 0, includeComma = false): number => {
    const suffix = `],"truncated":${truncatedValue ? "true" : "false"}}`;
    return responsePrefix + serializedItemBytes + additional + (includeComma ? 1 : 0) + Buffer.byteLength(suffix, "utf8");
  };
  const source: unknown[] = [];
  try {
    if (!Array.isArray(hits) || !Number.isSafeInteger(hits.length) || hits.length < 0) return { items, truncated: true };
    if (hits.length > MAX_KNOWLEDGE_HIT_INPUTS) truncated = true;
    const bound = Math.min(hits.length, MAX_KNOWLEDGE_HIT_INPUTS);
    for (let index = 0; index < bound; index += 1) {
      try { source.push(hits[index]); } catch { truncated = true; break; }
    }
  } catch {
    return { items, truncated: true };
  }
  for (let index = 0; index < source.length; index += 1) {
    try {
      const hit = normalizeSourceHit(source[index], now);
      if (hit === undefined) {
        truncated = true;
        continue;
      }
      const item = projectHit(hit, exposure, `c${index + 1}`);
      const serialized = JSON.stringify(item);
      const itemBytes = Buffer.byteLength(serialized, "utf8");
      if (responseBytes(truncated, itemBytes, items.length > 0) > MAX_RESPONSE_BYTES) {
        truncated = true;
        continue;
      }
      items.push(item);
      serializedItemBytes += itemBytes + (items.length > 1 ? 1 : 0);
    } catch {
      // Custom MemoryQueries are untrusted at the MCP boundary.
      truncated = true;
    }
  }
  return { items, truncated };
}

export function projectRecallHits(hits: readonly RecallHit[], exposure: Exposure, now = Date.now()): ProjectedRecallResponse {
  const items = projectHits(hits, exposure, now);
  return { exposure, items: items.items, truncated: items.truncated };
}

export function projectRecentFailures(hits: readonly RecentFailureHit[], exposure: Exposure, now = Date.now()): ProjectedRecentResponse {
  const items = projectHits(hits, exposure, now);
  return { exposure, items: items.items, truncated: items.truncated };
}
