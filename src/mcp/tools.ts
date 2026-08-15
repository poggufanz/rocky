import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { Exposure } from "../core/config-read.js";
import { hasCanonicalMemoryQueries } from "../core/memory-query.js";
import type { KnowledgeCoverageSummary, KnowledgeSearchQuery, MemoryQueries, RecallHit, RecallQuery, RecentFailuresQuery, StatsQuery, WhyFileEvidence } from "../core/memory-query.js";
import type { RecallAiOutcome, RecallWithAiPort } from "../ai/port.js";
import {
  MAX_RESPONSE_BYTES,
  projectKnowledgeHits,
  projectMemoryRecord,
  projectRecallHits,
  projectRecentFailures,
  projectWhyPossible,
  projectTriple,
  safeOpaqueIdentifier,
} from "./privacy.js";
import { boundTripleRecord, canonicalPath, isKnownPathPlatform, isSafeNonNegativeInteger, parseMemoryRecord, pathIdentityHash } from "../core/memory-read.js";
import type { TripleRecord } from "../core/memory-read.js";

/** Versioned read-only catalog used by MCP discovery and setup health. */
export const MCP_TOOL_CATALOG_VERSION = 1 as const;
export const MCP_TOOL_CATALOG = Object.freeze([
  "recall",
  "recent_failures",
  "stats",
  "recall_with_ai",
  "search_knowledge",
  "fetch_record",
  "why_file",
] as const);
export type McpToolName = typeof MCP_TOOL_CATALOG[number];

export interface McpToolDefinition {
  name: McpToolName;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: true;
    destructiveHint: false;
    idempotentHint: true;
    openWorldHint: false;
  };
}

export interface ToolCallResult {
  content: readonly [{ type: "text"; text: string }];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}

export interface McpToolRegistry {
  list(): readonly McpToolDefinition[];
  call(name: string, args: unknown, signal: AbortSignal): Promise<ToolCallResult>;
}

export const TOOL_ENVELOPE_RESERVE_BYTES = 4 * 1024;

export class McpInvalidParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpInvalidParamsError";
  }
}

export class ToolExecutionError extends Error {
  constructor(public readonly safeCode: string, safeMessage: string) {
    super(safeMessage);
    this.name = "ToolExecutionError";
  }
}

export interface CreateToolRegistryOptions {
  exposure: Exposure;
  memory: MemoryQueries;
  recallWithAi: RecallWithAiPort;
}

const ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const RESPONSE_CAP_BYTES = MAX_RESPONSE_BYTES - TOOL_ENVELOPE_RESERVE_BYTES;
const MAX_WHY_EVIDENCE_INPUTS = 256;
const MAX_PROVIDER_NESTED_ITEMS = 256;
const MAX_PROVIDER_NESTED_BYTES = 64 * 1024;
const MEMORY_OPERATIONAL_CODES = Object.freeze([
  "EACCES", "EPERM", "ENOENT", "EIO", "EMFILE", "ENFILE", "ENOSPC", "EROFS", "EISDIR", "ENOTDIR",
] as const);

function objectArgs(args: unknown): Record<string, unknown> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) throw new McpInvalidParamsError("invalid params");
  return args as Record<string, unknown>;
}

function rejectUnknown(args: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(args).some((key) => !allowed.includes(key))) throw new McpInvalidParamsError("invalid params");
}

function parseCwd(args: Record<string, unknown>, exposure: Exposure): string | undefined {
  if (exposure !== "raw") return undefined;
  if (args.cwd === undefined) return undefined;
  if (typeof args.cwd !== "string") throw new McpInvalidParamsError("invalid params");
  return args.cwd;
}

function parseLimit(value: unknown, minimum: number, maximum: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new McpInvalidParamsError("invalid params");
  }
  return value;
}

function parseRecallArgs(args: unknown, exposure: Exposure, defaultLimit = 3): RecallQuery {
  const value = objectArgs(args);
  rejectUnknown(value, exposure === "raw" ? ["query", "limit", "cwd"] : ["query", "limit"]);
  if (typeof value.query !== "string" || [...value.query].length < 1 || [...value.query].length > 500) {
    throw new McpInvalidParamsError("invalid params");
  }
  const cwd = parseCwd(value, exposure);
  return { query: value.query, limit: parseLimit(value.limit, 1, 10, defaultLimit), ...(cwd === undefined ? {} : { cwd }) };
}

function parseRecentArgs(args: unknown, exposure: Exposure): RecentFailuresQuery {
  const value = objectArgs(args);
  rejectUnknown(value, exposure === "raw" ? ["limit", "cwd", "unresolvedOnly"] : ["limit", "unresolvedOnly"]);
  if (value.unresolvedOnly !== undefined && typeof value.unresolvedOnly !== "boolean") throw new McpInvalidParamsError("invalid params");
  const cwd = parseCwd(value, exposure);
  return {
    limit: parseLimit(value.limit, 1, 50, 10),
    ...(cwd === undefined ? {} : { cwd }),
    ...(value.unresolvedOnly === undefined ? {} : { unresolvedOnly: value.unresolvedOnly }),
  };
}

function parseStatsArgs(args: unknown, exposure: Exposure): StatsQuery {
  const value = objectArgs(args);
  rejectUnknown(value, exposure === "raw" ? ["cwd"] : []);
  const cwd = parseCwd(value, exposure);
  return cwd === undefined ? {} : { cwd };
}

function parseKnowledgeArgs(args: unknown): KnowledgeSearchQuery {
  const value = objectArgs(args);
  rejectUnknown(value, ["query", "kind", "limit"]);
  if (typeof value.query !== "string" || [...value.query].length < 1 || [...value.query].length > 500) {
    throw new McpInvalidParamsError("invalid params");
  }
  if (value.kind !== undefined && value.kind !== "failure" && value.kind !== "fix" && value.kind !== "triple" && value.kind !== "note") {
    throw new McpInvalidParamsError("invalid params");
  }
  return {
    query: value.query,
    ...(value.kind === undefined ? {} : { kind: value.kind }),
    limit: parseLimit(value.limit, 1, 20, 10),
  };
}

function parseFetchArgs(args: unknown): string {
  const value = objectArgs(args);
  rejectUnknown(value, ["id"]);
  if (typeof value.id !== "string") throw new McpInvalidParamsError("invalid params");
  return value.id;
}

function parseWhyFileArgs(args: unknown): { path: string; limit: number } {
  const value = objectArgs(args);
  rejectUnknown(value, ["path", "limit"]);
  if (typeof value.path !== "string") throw new McpInvalidParamsError("invalid params");
  return { path: value.path, limit: parseLimit(value.limit, 1, 10, 5) };
}

function schema(properties: Record<string, unknown>, required?: readonly string[]): Record<string, unknown> {
  return { type: "object", additionalProperties: false, ...(required === undefined ? {} : { required }), properties };
}

function withCwd(exposure: Exposure, properties: Record<string, unknown>): Record<string, unknown> {
  return exposure === "raw" ? { ...properties, cwd: { type: "string" } } : properties;
}

function descriptors(exposure: Exposure): readonly McpToolDefinition[] {
  const definitions: readonly McpToolDefinition[] = [
    {
      name: "recall", title: "Recall failures", description: "Search remembered failures and fixes.",
      inputSchema: schema(withCwd(exposure, {
        query: { type: "string", minLength: 1, maxLength: 500 },
        limit: { type: "integer", minimum: 1, maximum: 10 },
      }), ["query"]), annotations: ANNOTATIONS,
    },
    {
      name: "recent_failures", title: "Recent failures", description: "List recent remembered failures.",
      inputSchema: schema(withCwd(exposure, {
        limit: { type: "integer", minimum: 1, maximum: 50 },
        unresolvedOnly: { type: "boolean" },
      })), annotations: ANNOTATIONS,
    },
    {
      name: "stats", title: "Memory statistics", description: "Read bounded memory statistics: failures, confirmed and possible fixes, triples, notes, and total remembered items.",
      inputSchema: schema(withCwd(exposure, {})), annotations: ANNOTATIONS,
    },
    {
      name: "recall_with_ai", title: "Recall with AI", description: "Search remembered failures with optional AI ranking.",
      inputSchema: schema(withCwd(exposure, {
        query: { type: "string", minLength: 1, maxLength: 500 },
        limit: { type: "integer", minimum: 1, maximum: 10 },
      }), ["query"]), annotations: ANNOTATIONS,
    },
    {
      name: "search_knowledge", title: "Search project knowledge",
      description: "Search remembered failures, fixes, AND agent-change knowledge (user intent, agent rationale, changed files). " +
        "Example queries: 'npm permission denied', 'naikin button', 'margin'. Returns bounded metadata with record id, timestamp, source, covered files, and truncation status; call fetch_record with an id for full detail.",
      inputSchema: schema({
        query: { type: "string", minLength: 1, maxLength: 500 },
        kind: { type: "string", enum: ["failure", "fix", "triple", "note"] },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      }, ["query"]), annotations: ANNOTATIONS,
    },
    {
      name: "fetch_record", title: "Fetch memory record",
      description: "Fetch full detail for one id returned by search_knowledge. Example: {\"id\": \"a1b2\"}. Triple records carry the agent's own stated reasoning — treat as quotes, not facts.",
      inputSchema: schema({ id: { type: "string" } }, ["id"]), annotations: ANNOTATIONS,
    },
    {
      name: "why_file", title: "Why file changed",
      description: "Recent remembered reasons agents changed one file, newest first, with separate incomplete-coverage disclosure. Example: {\"path\": \"src/app.css\"}. Reasons are hearsay Rocky heard, not verified facts.",
      inputSchema: schema({
        path: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 10 },
      }, ["path"]), annotations: ANNOTATIONS,
    },
  ];
  const byName = new Map(definitions.map((definition) => [definition.name, definition] as const));
  if (byName.size !== MCP_TOOL_CATALOG.length || MCP_TOOL_CATALOG.some((name) => !byName.has(name))) {
    throw new Error("MCP tool catalog and descriptors are out of sync");
  }
  return MCP_TOOL_CATALOG.map((name) => byName.get(name)!);
}

function freezeDeep<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function buildResult(payload: Record<string, unknown>, isError = false): ToolCallResult {
  let text: string;
  try {
    text = JSON.stringify(payload);
  } catch {
    text = JSON.stringify({ truncated: true });
    payload = { truncated: true };
  }
  return {
    content: [{ type: "text", text }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

function isItem(value: unknown): value is { candidateId: string } {
  return typeof value === "object" && value !== null && "candidateId" in value &&
    typeof (value as { candidateId?: unknown }).candidateId === "string";
}

function pruneRefs(payload: Record<string, unknown>, removed: string): void {
  for (const key of ["rankedCandidateIds", "evidenceRefs"] as const) {
    const refs = payload[key];
    if (Array.isArray(refs)) payload[key] = refs.filter((ref) => candidateIdForRef(ref) !== removed);
  }
}

function candidateIdForRef(value: unknown): string | undefined {
  return typeof value === "string" ? value.split(".")[0] : undefined;
}

function validRankedCandidateIds(value: readonly string[], itemIds: readonly string[]): boolean {
  return value.length <= itemIds.length && value.every((id, index) =>
    itemIds.includes(id) && value.indexOf(id) === index,
  );
}

function validEvidenceRefs(value: readonly string[], items: readonly { candidateId: string; hasFix?: unknown }[]): boolean {
  return value.every((ref, index) => {
    const match = /^([^.]*)\.(failure|fix)$/.exec(ref);
    if (match === null || value.indexOf(ref) !== index) return false;
    const item = items.find((candidate) => candidate.candidateId === match[1]);
    return item !== undefined && (match[2] === "failure" || item.hasFix === true);
  });
}

function cappedResult(payload: object, isError = false): ToolCallResult {
  const source = payload as Record<string, unknown>;
  const copy: Record<string, unknown> = { ...source };
  for (const [key, value] of Object.entries(source)) {
    if (Array.isArray(value)) copy[key] = [...value];
  }
  const arrayBytes = new Map<string, number>();
  const refreshArrayBytes = (key: string): void => {
    const values = copy[key];
    if (!Array.isArray(values)) return;
    let total = 2;
    for (let index = 0; index < values.length; index += 1) {
      let encoded: string;
      try { encoded = JSON.stringify(values[index]); } catch { encoded = "null"; }
      total += Buffer.byteLength(encoded, "utf8") + (index === 0 ? 0 : 1);
    }
    arrayBytes.set(key, total);
  };
  const estimatePayloadBytes = (): number => {
    let total = 2;
    for (const [key, value] of Object.entries(copy)) {
      let encoded: string | undefined;
      if (Array.isArray(value)) {
        if (!arrayBytes.has(key)) refreshArrayBytes(key);
        total += Buffer.byteLength(JSON.stringify(key), "utf8") + 1 + (arrayBytes.get(key) ?? 2);
      } else {
        try { encoded = JSON.stringify(value); } catch { encoded = "null"; }
        total += Buffer.byteLength(JSON.stringify(key), "utf8") + 1 + Buffer.byteLength(encoded ?? "null", "utf8");
      }
      total += 1;
    }
    return total;
  };
  const arrayPriority = Array.isArray(copy.possible) && copy.possible.length > 0
    ? ["possible", "items", "rankedCandidateIds", "evidenceRefs"]
    : ["items", "possible", "rankedCandidateIds", "evidenceRefs"];
  const arrayKeys = [
    ...arrayPriority.filter((key) => Array.isArray(copy[key])),
    ...Object.keys(copy).filter((key) => Array.isArray(copy[key]) && !arrayPriority.includes(key)).sort(),
  ];
  while (true) {
    // The wire envelope contains both structuredContent and its serialized
    // text. A conservative 2x payload estimate avoids repeatedly stringifying
    // a growing object while still checking the exact final envelope once.
    if (estimatePayloadBytes() * 2 + 1024 <= RESPONSE_CAP_BYTES) {
      const output = buildResult(copy, isError);
      if (Buffer.byteLength(JSON.stringify(output), "utf8") <= RESPONSE_CAP_BYTES) return output;
    }
    const key = arrayKeys.find((candidate) => {
      const values = copy[candidate];
      return Array.isArray(values) && values.length > 0;
    });
    if (key === undefined) {
      throw new Error("response too large");
    }
    const values = copy[key] as unknown[];
    const removed = values.pop();
    // Decrement the cached array total instead of re-serializing the whole
    // remaining array each pop; a delete-and-refresh loop is O(N^2) and hands
    // hostile providers seconds of CPU per call.
    const cached = arrayBytes.get(key);
    if (cached !== undefined) {
      let encoded: string;
      try { encoded = JSON.stringify(removed) ?? "null"; } catch { encoded = "null"; }
      arrayBytes.set(key, Math.max(2, cached - Buffer.byteLength(encoded, "utf8") - (values.length > 0 ? 1 : 0)));
    }
    if (key === "items" && isItem(removed)) {
      pruneRefs(copy, removed.candidateId);
      arrayBytes.delete("rankedCandidateIds");
      arrayBytes.delete("evidenceRefs");
    }
    copy.truncated = true;
  }
}

function boundedSingleResult(
  payload: Record<string, unknown>,
  fallback: Record<string, unknown>,
  isError = false,
): ToolCallResult {
  const result = buildResult(payload, isError);
  if (Buffer.byteLength(JSON.stringify(result), "utf8") <= RESPONSE_CAP_BYTES) return result;
  return buildResult(fallback, isError);
}

function notFoundResult(): ToolCallResult {
  return cappedResult({ error: { code: "not_found", message: "record not found" } }, true);
}

function unknownCoverage(): KnowledgeCoverageSummary {
  return { status: "unknown", complete: false, filesCovered: 0, truncatedFiles: 0 };
}

function boundedProviderArray(value: unknown, maximum = MAX_PROVIDER_NESTED_ITEMS): { values: unknown[]; truncated: boolean; valid: boolean } {
  try {
    if (!Array.isArray(value)) return { values: [], truncated: false, valid: false };
    const length = value.length;
    if (!Number.isSafeInteger(length) || length < 0) return { values: [], truncated: true, valid: false };
    const values: unknown[] = [];
    const bound = Math.min(length, maximum);
    for (let index = 0; index < bound; index += 1) values.push(value[index]);
    return { values, truncated: length > maximum, valid: true };
  } catch {
    return { values: [], truncated: true, valid: false };
  }
}

function boundedProviderStrings(value: unknown): { values: string[]; valid: boolean } {
  const bounded = boundedProviderArray(value);
  if (!bounded.valid) return { values: [], valid: false };
  const values: string[] = [];
  let bytes = 0;
  try {
    for (const item of bounded.values) {
      if (typeof item !== "string") return { values: [], valid: false };
      bytes += Buffer.byteLength(item, "utf8");
      if (bytes > MAX_PROVIDER_NESTED_BYTES) return { values: [], valid: false };
      values.push(item);
    }
  } catch {
    return { values: [], valid: false };
  }
  return { values, valid: true };
}

function safeTripleRecord(value: unknown): TripleRecord | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const raw = value as Record<string, unknown>;
    const ts = raw.ts;
    if (raw.kind !== "triple" || raw.schemaV !== 1 || raw.origin !== "agent-hook" ||
        typeof raw.id !== "string" || raw.id.length === 0 || raw.id.length > 512 ||
        /[\u0000-\u001f\u007f-\u009f]/u.test(raw.id) || typeof ts !== "number" || !Number.isSafeInteger(ts) || ts < 0 ||
        typeof raw.cwd !== "string" || raw.agent !== "claude-code" && raw.agent !== "codex") return undefined;
    const bounded = boundTripleRecord(raw as unknown as TripleRecord);
    const platform = isKnownPathPlatform(raw.platform) ? raw.platform : undefined;
    if (raw.platform !== undefined && platform === undefined) return undefined;
    const safe: TripleRecord = {
      kind: "triple", id: raw.id, ts, cwd: raw.cwd, schemaV: 1,
      agent: raw.agent, origin: "agent-hook", mechanism: bounded.mechanism,
      ...(platform === undefined ? {} : { platform }),
    };
    const intent = raw.intent;
    if (typeof intent === "object" && intent !== null && !Array.isArray(intent) &&
        typeof (intent as Record<string, unknown>).text === "string") {
      safe.intent = { text: (intent as Record<string, unknown>).text as string };
    }
    const rationale = raw.rationale;
    if (typeof rationale === "object" && rationale !== null && !Array.isArray(rationale)) {
      const candidate = rationale as Record<string, unknown>;
      const tags = boundedProviderStrings(candidate.tags);
      if (typeof candidate.text === "string" && tags.valid &&
          (candidate.source === "transcript" || candidate.source === "notify")) {
        safe.rationale = {
          text: candidate.text,
          tags: tags.values,
          source: candidate.source,
        };
      }
    }
    return safe;
  } catch {
    return undefined;
  }
}

function coverageForTriples(matches: readonly TripleRecord[]): KnowledgeCoverageSummary {
  if (matches.length === 0) return unknownCoverage();
  let status: KnowledgeCoverageSummary["status"] = "complete";
  let filesCovered = 0;
  let truncatedFiles = 0;
  let allComplete = true;
  for (const match of matches) {
    try {
      const projected = projectTriple(match, "sanitized");
      const current = projected.coverageStatus === "complete" && projected.complete
        ? "complete" as const
        : projected.coverageStatus === "truncated" ? "truncated" as const : "unknown" as const;
      if (current === "unknown") status = "unknown";
      else if (current === "truncated" && status === "complete") status = "truncated";
      filesCovered = Math.max(filesCovered, Math.min(8, projected.filesCovered.length));
      if (isSafeNonNegativeInteger(projected.truncatedFiles) && Number.isSafeInteger(truncatedFiles + projected.truncatedFiles)) {
        truncatedFiles += projected.truncatedFiles;
      } else {
        status = "unknown";
        allComplete = false;
      }
      if (!projected.complete) allComplete = false;
    } catch {
      status = "unknown";
      allComplete = false;
    }
  }
  const complete = status === "complete" && truncatedFiles === 0 && allComplete;
  return { status: complete ? "complete" : status, complete, filesCovered, truncatedFiles };
}

interface WhyPathRelation {
  exact: boolean;
  suffix: boolean;
  suffixIdentities: readonly string[];
}

function whyPathRelation(candidate: TripleRecord, path: string): WhyPathRelation {
  const platform = candidate.platform ?? "unknown";
  const targetDisplay = canonicalPath(path, { platform });
  const targetIdentity = canonicalPath(path, { platform, cwd: candidate.cwd });
  const targetHash = targetIdentity.length > 0
    ? pathIdentityHash(targetIdentity, { platform, canonical: true })
    : undefined;
  if (!targetDisplay || !targetIdentity) return { exact: false, suffix: false, suffixIdentities: [] };
  const suffixIdentities = new Set<string>();
  for (const file of candidate.mechanism.files) {
    const candidateDisplay = canonicalPath(file.path, { platform });
    const candidateIdentity = canonicalPath(file.path, { platform, cwd: candidate.cwd });
    if (!candidateDisplay || !candidateIdentity) continue;
    const hashExact = targetHash !== undefined && file.identityHash !== undefined
      && /^[0-9a-f]{32}$/u.test(file.identityHash) && file.identityHash === targetHash;
    const hashValid = typeof file.identityHash === "string" && /^[0-9a-f]{32}$/u.test(file.identityHash);
    const hashMismatch = hashValid && targetHash !== undefined && file.identityHash !== targetHash;
    if (hashExact || (!hashMismatch && (candidateDisplay === targetDisplay || candidateIdentity === targetIdentity))) {
      return { exact: true, suffix: false, suffixIdentities: [] };
    }
    const knownRoot = canonicalPath(candidate.cwd, { platform });
    const rootAbsolute = /^\/(?:|[^/])/u.test(knownRoot) || /^[A-Za-z]:\//u.test(knownRoot);
    const trustedRoot = candidate.platform !== undefined && rootAbsolute;
    const relativeEscapesRoot = !candidateDisplay.startsWith("/") && !/^[A-Za-z]:\//u.test(candidateDisplay)
      && (candidateDisplay === ".." || candidateDisplay.startsWith("../"));
    const candidateWithinRoot = !relativeEscapesRoot && (!rootAbsolute || candidateIdentity === knownRoot
      || candidateIdentity.startsWith(`${knownRoot}/`));
    const targetWithinRoot = !rootAbsolute || targetIdentity === knownRoot
      || targetIdentity.startsWith(`${knownRoot}/`);
    if (!trustedRoot && candidateWithinRoot && targetWithinRoot && candidateDisplay.endsWith(`/${targetDisplay}`)) {
      suffixIdentities.add(hashMismatch ? `hash:${file.identityHash}` : candidateIdentity);
    }
  }
  return { exact: false, suffix: suffixIdentities.size > 0, suffixIdentities: [...suffixIdentities] };
}

interface WhyCandidate {
  candidate: TripleRecord;
  relation: WhyPathRelation;
}

function whyTripleComplete(candidate: TripleRecord): boolean {
  try {
    const mechanism = candidate.mechanism;
    return mechanism.coverageStatus === "complete"
      && mechanism.truncatedFiles === 0
      && mechanism.baseline === "captured"
      && mechanism.files.length > 0
      && mechanism.files.every((file) => file.provenance === "tool-observed" || file.provenance === "git-diff-inferred");
  } catch {
    return false;
  }
}

function selectWhyCandidates(
  candidates: readonly TripleRecord[],
  path: string,
  limit: number,
): { matches: TripleRecord[]; possible: WhyFileEvidence["possible"]; ambiguousSuffix: boolean } {
  const related: WhyCandidate[] = candidates.map((candidate) => ({
    candidate,
    relation: whyPathRelation(candidate, path),
  }));
  const hasExact = related.some(({ relation }) => relation.exact);
  const suffixIdentities = new Set(
    related
      .filter(({ relation }) => !relation.exact && relation.suffix)
      .flatMap(({ relation }) => relation.suffixIdentities),
  );
  const ambiguousSuffix = !hasExact && suffixIdentities.size > 1;
  const matches: TripleRecord[] = [];
  const possible: WhyFileEvidence["possible"] = [];
  for (const { candidate, relation } of related) {
    const incomplete = !whyTripleComplete(candidate);
    const exactOrUnambiguousSuffix = relation.exact || (
      !hasExact && !ambiguousSuffix && relation.suffix && !incomplete
    );
    if (exactOrUnambiguousSuffix) {
      if (matches.length < limit) matches.push(candidate);
    } else if (incomplete && (relation.suffix || candidate.mechanism.truncatedFiles > 0) && possible.length < limit) {
      possible.push({ id: candidate.id, ts: candidate.ts, source: candidate.origin, reason: "path_may_be_omitted" });
    }
  }
  return { matches, possible, ambiguousSuffix };
}

function fallbackWhyEvidence(options: CreateToolRegistryOptions, path: string, limit: number): WhyFileEvidence {
  let rawMatches: unknown;
  try {
    rawMatches = options.memory.whyFile(path, limit);
  } catch {
    rawMatches = [];
  }
  const boundedRawMatches = boundedProviderArray(rawMatches, MAX_WHY_EVIDENCE_INPUTS);
  const candidates = boundedRawMatches.values
    .map((value) => safeTripleRecord(value))
    .filter((value): value is TripleRecord => value !== undefined);
  const selected = selectWhyCandidates(candidates, path, limit);
  // Coverage belongs to selected exact/unambiguous evidence only. An
  // unrelated complete triple cannot make an empty why-file result complete.
  const coverage = coverageForTriples(selected.matches);
  const incomplete = selected.matches.length === 0 || !coverage.complete || selected.possible.length > 0
    || selected.ambiguousSuffix || boundedRawMatches.truncated;
  return {
    matches: selected.matches,
    possible: selected.possible,
    coverage: incomplete ? { ...coverage, status: "unknown", complete: false } : coverage,
    coverageIncomplete: incomplete,
  };
}

function normalizeWhyEvidence(value: unknown, fallback: WhyFileEvidence, path: string, limit: number): WhyFileEvidence {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return fallback;
    const raw = value as Record<string, unknown>;
    const boundedMatches = boundedProviderArray(raw.matches, MAX_WHY_EVIDENCE_INPUTS);
    const candidates = boundedMatches.values
      .map((entry) => safeTripleRecord(entry))
      .filter((entry): entry is TripleRecord => entry !== undefined);
    const selected = selectWhyCandidates(candidates, path, limit);
    const derived = coverageForTriples(selected.matches);
    const boundedPossible = boundedProviderArray(raw.possible, MAX_WHY_EVIDENCE_INPUTS);
    const providerPossible: WhyFileEvidence["possible"] = [];
    for (let index = 0; index < boundedPossible.values.length && providerPossible.length < limit; index += 1) {
      const candidate = boundedPossible.values[index];
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
      const value = candidate as Record<string, unknown>;
      if (typeof value.id !== "string" || typeof value.ts !== "number" || !Number.isSafeInteger(value.ts) || value.ts < 0
          || value.source !== "agent-hook" || value.reason !== "path_may_be_omitted") continue;
      providerPossible.push({ id: value.id, ts: value.ts, source: "agent-hook", reason: "path_may_be_omitted" });
    }
    const possible = [...selected.possible, ...providerPossible].slice(0, limit);
    const supplied = raw.coverage;
    const suppliedObject = typeof supplied === "object" && supplied !== null && !Array.isArray(supplied)
      ? supplied as Record<string, unknown>
      : undefined;
    const suppliedStatus = suppliedObject?.status === "complete" || suppliedObject?.status === "truncated" || suppliedObject?.status === "unknown"
      ? suppliedObject.status
      : undefined;
    const suppliedComplete = suppliedObject?.complete === true && suppliedStatus === "complete" && suppliedObject.truncatedFiles === 0;
    let coverage = derived;
    if (suppliedStatus !== undefined) {
      if (suppliedStatus === "unknown" || suppliedComplete === false && suppliedStatus === "complete") {
        coverage = { ...derived, status: "unknown", complete: false };
      } else if (derived.status === "truncated" || suppliedStatus === "truncated") {
        coverage = { ...derived, status: "truncated", complete: false };
      }
    }
    if (raw.coverageIncomplete === true || boundedMatches.truncated || boundedPossible.truncated) coverage = { ...coverage, status: "unknown", complete: false };
    if (possible.length > 0 || selected.ambiguousSuffix) coverage = { ...coverage, status: "unknown", complete: false };
    return {
      matches: selected.matches,
      possible,
      coverage,
      coverageIncomplete: !coverage.complete || possible.length > 0 || raw.coverageIncomplete === true,
    };
  } catch {
    return fallback;
  }
}

function safeErrorResult(error: ToolExecutionError): ToolCallResult {
  return cappedResult({ error: { code: error.safeCode, message: error.message } }, true);
}

function hasOperationalCode(error: unknown): boolean {
  try {
    if (typeof error !== "object" || error === null || !("code" in error)) return false;
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" && (MEMORY_OPERATIONAL_CODES as readonly string[]).includes(code);
  } catch {
    return false;
  }
}

/** Third-party MemoryQueries are an untrusted read boundary. */
function safeReadMemory<T>(operation: () => T, fallback: T, canonical = false): T {
  try {
    return operation();
  } catch (error) {
    if (canonical && error instanceof ToolExecutionError) throw error;
    if (canonical && hasOperationalCode(error)) throw new ToolExecutionError("memory_unavailable", "memory unavailable");
    return fallback;
  }
}

function safeProjection<T>(operation: () => T, fallback: T): T {
  try { return operation(); } catch { return fallback; }
}

function saturatedAdd(...values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    if (!isSafeNonNegativeInteger(value)) return Number.MAX_SAFE_INTEGER;
    if (total > Number.MAX_SAFE_INTEGER - value) return Number.MAX_SAFE_INTEGER;
    total += value;
  }
  return total;
}

function safeMemoryStats(value: unknown, canonical = false): Record<string, unknown> {
  try {
    const source = typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    const count = (key: string): number => isSafeNonNegativeInteger(source[key]) ? source[key] as number : 0;
    const failures = count("failures");
    const fixEvents = count("fixEvents");
    const resolved = count("resolved");
    const unresolved = count("unresolved");
    const confirmedFixes = source.confirmedFixes !== undefined ? count("confirmedFixes") : fixEvents;
    const possibleFixes = count("possibleFixes");
    const triples = count("triples");
    const notes = count("notes");
    const base = saturatedAdd(failures, triples, notes);
    const lowerBound = saturatedAdd(base, Math.max(fixEvents, possibleFixes));
    const upperBound = saturatedAdd(base, fixEvents, possibleFixes);
    const suppliedTotal = source.total;
    const suppliedFeasible = isSafeNonNegativeInteger(suppliedTotal)
      && suppliedTotal >= lowerBound && suppliedTotal <= upperBound;
    const exact = (canonical && isSafeNonNegativeInteger(suppliedTotal)) || suppliedFeasible || lowerBound === upperBound;
    // Keep legacy `total` useful as the conservative upper bound while the
    // explicit exactness/range fields tell callers that overlapping fix
    // buckets prevent treating it as an exact record count.
    // Coincident bounds prove the exact total themselves; a supplied total is
    // only ever trusted when it is canonical or independently feasible.
    const total = (canonical && isSafeNonNegativeInteger(suppliedTotal)) || suppliedFeasible
      ? suppliedTotal as number
      : upperBound;
    return {
      failures, fixEvents, resolved, unresolved, confirmedFixes, possibleFixes, triples, notes, total,
      ...(exact ? {} : { totalExact: false, totalLowerBound: lowerBound, totalUpperBound: upperBound }),
    };
  } catch {
    return { failures: 0, fixEvents: 0, resolved: 0, unresolved: 0, confirmedFixes: 0, possibleFixes: 0, triples: 0, notes: 0, total: 0 };
  }
}

async function runAi<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (hasOperationalCode(error)) throw new ToolExecutionError("ai_unavailable", "AI unavailable");
    throw error;
  }
}

function mergeAi(
  payload: object,
  ai: RecallAiOutcome,
  aiCandidateIds: readonly string[],
): Record<string, unknown> {
  const source = payload as Record<string, unknown>;
  const items = Array.isArray(source.items) ? source.items.filter(isItem) : [];
  const itemIds = items.map((item) => item.candidateId);
  const rankedValid = validRankedCandidateIds(ai.rankedCandidateIds, aiCandidateIds);
  const evidenceValid = ai.evidenceRefs === undefined || validEvidenceRefs(ai.evidenceRefs, items);
  if (ai.aiStatus === "used" && (!rankedValid || !evidenceValid)) {
    return {
      ...source,
      aiStatus: "invalid_output",
      items,
      rankedCandidateIds: itemIds,
    };
  }

  const useAiOrder = ai.aiStatus === "used";
  const ranked = useAiOrder
    ? ai.rankedCandidateIds.filter((id) => itemIds.includes(id))
    : [];
  for (const id of itemIds) if (!ranked.includes(id)) ranked.push(id);
  const reorderedItems = useAiOrder
    ? ranked.map((id) => items.find((item) => item.candidateId === id)!).filter(isItem)
    : items;
  const { rankedCandidateIds: _rankedCandidateIds, evidenceRefs: _evidenceRefs, ...safeAi } = ai;
  const evidenceRefs = ai.evidenceRefs?.filter((ref, index, refs) =>
    refs.indexOf(ref) === index && validEvidenceRefs([ref], items),
  );
  return {
    ...source,
    ...safeAi,
    items: reorderedItems,
    rankedCandidateIds: ranked,
    ...(evidenceRefs === undefined ? {} : { evidenceRefs }),
  };
}

export function createToolRegistry(options: CreateToolRegistryOptions): McpToolRegistry {
  const definitions = freezeDeep(descriptors(options.exposure));
  // Sanitized ID handles: sha256 handles are computed statelessly during
  // projection and committed to the bounded registry only for hits that
  // survive the response cap.  Registering during projection would let a
  // hostile provider evict the handles of returned items with dropped ones,
  // breaking the documented search-then-fetch_record flow.
  const knowledgeHandles = new Map<string, { raw: string; bytes: number }>();
  let knowledgeHandleBytes = 0;
  const maxKnowledgeHandles = 8192;
  const maxKnowledgeHandleBytes = 4 * 1024 * 1024;
  const maxKnowledgeHandleRawBytes = 1024;
  const maxPendingHandleEntries = 20_000;
  const maxPendingHandleBytes = 8 * 1024 * 1024;
  // One shared allowlist with the privacy layer prevents silent drift.
  const safeDirectKnowledgeId = safeOpaqueIdentifier;
  const createPendingKnowledgeIdProjector = (): {
    projector: (value: string) => string | undefined;
    pending: Map<string, { raw: string; bytes: number }>;
  } => {
    const pending = new Map<string, { raw: string; bytes: number }>();
    let pendingBytes = 0;
    const projector = (value: string): string | undefined => {
      if (options.exposure !== "sanitized" || safeDirectKnowledgeId(value)) return undefined;
      const rawBytes = Buffer.byteLength(value, "utf8");
      if (rawBytes > maxKnowledgeHandleRawBytes) return undefined;
      const handle = `rk-h-${createHash("sha256").update(value, "utf8").digest("hex")}`;
      if (pending.has(handle)) return handle;
      const bytes = rawBytes + Buffer.byteLength(handle, "utf8");
      if (pending.size >= maxPendingHandleEntries || pendingBytes + bytes > maxPendingHandleBytes) return undefined;
      pending.set(handle, { raw: value, bytes });
      pendingBytes += bytes;
      return handle;
    };
    return { projector, pending };
  };
  const commitKnowledgeHandles = (
    itemIds: readonly string[],
    pending: ReadonlyMap<string, { raw: string; bytes: number }>,
  ): void => {
    const current = new Set(itemIds.filter((id) => pending.has(id)));
    for (const handle of current) {
      const entry = pending.get(handle)!;
      if (knowledgeHandles.has(handle)) continue;
      let admissible = true;
      while (knowledgeHandles.size >= maxKnowledgeHandles || knowledgeHandleBytes + entry.bytes > maxKnowledgeHandleBytes) {
        // Evict the oldest handles first, but never one returned by this call.
        let evicted = false;
        for (const oldest of knowledgeHandles.keys()) {
          if (current.has(oldest)) continue;
          const old = knowledgeHandles.get(oldest)!;
          knowledgeHandles.delete(oldest);
          knowledgeHandleBytes -= old.bytes;
          evicted = true;
          break;
        }
        if (!evicted) {
          admissible = false;
          break;
        }
      }
      if (!admissible) break;
      knowledgeHandles.set(handle, entry);
      knowledgeHandleBytes += entry.bytes;
    }
  };
  const resolveKnowledgeId = (value: string): string => knowledgeHandles.get(value)?.raw ?? value;
  return {
    list: () => definitions,
    async call(name, args, signal) {
      if (!definitions.some((definition) => definition.name === name)) throw new McpInvalidParamsError("unknown tool");
      try {
        const canonicalMemory = hasCanonicalMemoryQueries(options.memory);
        switch (name) {
          case "recall": {
            const input = parseRecallArgs(args, options.exposure);
            const hits = safeReadMemory(() => options.memory.recall(input), [], canonicalMemory);
            const projected = safeProjection(
              () => projectRecallHits(hits, options.exposure),
              { exposure: options.exposure, items: [], truncated: true },
            );
            return safeProjection(
              () => cappedResult(projected),
              cappedResult({ exposure: options.exposure, items: [], truncated: true }),
            );
          }
          case "recent_failures": {
            const input = parseRecentArgs(args, options.exposure);
            const hits = safeReadMemory(() => options.memory.recentFailures(input), [], canonicalMemory);
            const projected = safeProjection(
              () => projectRecentFailures(hits, options.exposure),
              { exposure: options.exposure, items: [], truncated: true },
            );
            return safeProjection(
              () => cappedResult(projected),
              cappedResult({ exposure: options.exposure, items: [], truncated: true }),
            );
          }
          case "stats": {
            const input = parseStatsArgs(args, options.exposure);
            const stats = safeReadMemory<unknown>(() => options.memory.stats(input), {}, canonicalMemory);
            const result = {
              exposure: options.exposure,
              ...safeMemoryStats(stats, canonicalMemory),
            };
            return safeProjection(() => cappedResult(result), cappedResult({ exposure: options.exposure, ...safeMemoryStats({}) }));
          }
          case "search_knowledge": {
            const input = parseKnowledgeArgs(args);
            const hits = safeReadMemory(() => options.memory.searchKnowledge(input), [], canonicalMemory);
            const { projector, pending } = createPendingKnowledgeIdProjector();
            const projected = safeProjection(
              () => projectKnowledgeHits(hits, options.exposure, projector),
              { exposure: options.exposure, items: [], truncated: true },
            );
            const result = safeProjection(
              () => cappedResult(projected),
              cappedResult({ exposure: options.exposure, items: [], truncated: true }),
            );
            safeProjection(() => {
              const items = (result.structuredContent as { items?: unknown[] } | undefined)?.items;
              const returnedIds = Array.isArray(items)
                ? items.map((item) => (typeof item === "object" && item !== null && typeof (item as { id?: unknown }).id === "string"
                  ? (item as { id: string }).id
                  : ""))
                : [];
              commitKnowledgeHandles(returnedIds, pending);
            }, undefined);
            return result;
          }
          case "fetch_record": {
            const id = parseFetchArgs(args);
            const record = safeReadMemory(() => options.memory.fetchRecord(resolveKnowledgeId(id)), undefined, canonicalMemory);
            try {
              if (record === undefined || typeof record !== "object" || record === null || Array.isArray(record) || record.kind === "note") return notFoundResult();
              if (record.kind === "failure" && record.origin !== undefined &&
                  record.origin !== "run" && record.origin !== "hook" && record.origin !== "watch") return notFoundResult();
              const normalized = parseMemoryRecord(record);
              if (normalized === undefined || normalized.kind === "note") return notFoundResult();
              const projected = projectMemoryRecord(normalized, options.exposure, options.exposure === "sanitized");
              if (projected === undefined) return notFoundResult();
              return boundedSingleResult(
                { exposure: options.exposure, record: projected, truncated: false },
                { exposure: options.exposure, record: null, truncated: true },
              );
            } catch {
              return notFoundResult();
            }
          }
          case "why_file": {
            const input = parseWhyFileArgs(args);
            let fallback: WhyFileEvidence | undefined;
            const getFallback = (): WhyFileEvidence => fallback ??= fallbackWhyEvidence(options, input.path, input.limit);
            let customEvidence: MemoryQueries["whyFileEvidence"] | undefined;
            try { customEvidence = options.memory.whyFileEvidence; } catch { customEvidence = undefined; }
            const unknownEvidence: WhyFileEvidence = {
              matches: [], possible: [],
              coverage: { status: "unknown", complete: false, filesCovered: 0, truncatedFiles: 0 },
              coverageIncomplete: true,
            };
            const rawEvidence = safeReadMemory(() => customEvidence
              ? customEvidence(input.path, input.limit)
              : getFallback(), unknownEvidence, canonicalMemory);
            const evidence = safeProjection(
              () => customEvidence === undefined
                ? rawEvidence
                : normalizeWhyEvidence(rawEvidence, getFallback(), input.path, input.limit),
              unknownEvidence,
            );
            const projected = safeProjection(() => ({
              exposure: options.exposure,
              items: evidence.matches.map((triple) => projectTriple(triple, options.exposure, options.exposure === "sanitized")),
              possible: projectWhyPossible(evidence.possible, input.limit, options.exposure),
              coverage: evidence.coverage,
              coverageStatus: evidence.coverage.status,
              coverageIncomplete: evidence.coverageIncomplete,
              truncated: false,
            }), { exposure: options.exposure, items: [], possible: [], coverage: { status: "unknown", complete: false, filesCovered: 0, truncatedFiles: 0 }, coverageStatus: "unknown", coverageIncomplete: true, truncated: true });
            return safeProjection(() => cappedResult(projected), cappedResult({ exposure: options.exposure, items: [], possible: [], coverage: { status: "unknown", complete: false, filesCovered: 0, truncatedFiles: 0 }, coverageStatus: "unknown", coverageIncomplete: true, truncated: true }));
          }
          case "recall_with_ai": {
            const input = parseRecallArgs(args, options.exposure, 10);
            const hits = safeReadMemory(() => options.memory.recall(input), [], canonicalMemory);
            const projected = safeProjection(
              () => projectRecallHits(hits, options.exposure),
              { exposure: options.exposure, items: [], truncated: true },
            );
            // Materialize only a bounded indexed prefix before any later map,
            // serialization, or model inspection. A custom provider may hand
            // us a Proxy array whose iterator/slice throws or never ends.
            const aiHits = safeProjection<readonly RecallHit[]>(
              () => boundedProviderArray(hits, 5).values as RecallHit[],
              [],
            );
            const ai = await runAi(() => options.recallWithAi.run(
              { query: input.query, hits: aiHits, exposure: options.exposure }, signal,
            ));
            const aiCandidateIds = aiHits.map((_, index) => `c${index + 1}`);
            return safeProjection(
              () => cappedResult(mergeAi(projected, ai, aiCandidateIds)),
              cappedResult({ exposure: options.exposure, items: [], truncated: true }),
            );
          }
          default:
            throw new McpInvalidParamsError("unknown tool");
        }
      } catch (error) {
        if (error instanceof McpInvalidParamsError) throw error;
        if (error instanceof ToolExecutionError) return safeErrorResult(error);
        throw error;
      }
    },
  };
}
