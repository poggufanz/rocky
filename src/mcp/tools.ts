import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { Exposure } from "../core/config-read.js";
import { hasCanonicalMemoryQueries, hasDurableMemoryQueries, loadDurableMemorySnapshot, queryStats, whyFilePathRelation } from "../core/memory-query.js";
import type { DurableMemorySnapshot, KnowledgeCoverageSummary, KnowledgeSearchQuery, MemoryQueries, RecallHit, RecallQuery, RecentFailuresQuery, StatsQuery, WhyFileEvidence, WhyFilePathRelation } from "../core/memory-query.js";
import type { RecallAiOutcome, RecallWithAiPort } from "../ai/port.js";
import {
  MAX_FIELD_BYTES,
  MAX_RESPONSE_BYTES,
  isRecallCandidateId,
  projectKnowledgeHits,
  projectMemoryRecord,
  projectRecallHits,
  projectRecallHitsForAi,
  projectRecentFailures,
  projectWhyPossible,
  projectTriple,
  safeOpaqueIdentifier,
  validateRecallCandidateIds,
} from "./privacy.js";
import { boundTripleRecord, isBoundedLinkBasis, isConfirmableLinkBasis, isKnownPathPlatform, isSafeNonNegativeInteger, MAX_MEMORY_FILE_BYTES, MAX_SUPPORTED_MEMORY_RECORDS, parseMemoryRecord } from "../core/memory-read.js";
import type { FailureRecord, FixRecord, LinkConfidence, MemoryCoverage, TripleRecord } from "../core/memory-read.js";

/** Versioned read-only catalog used by MCP discovery and setup health. */
const MCP_TOOL_NAMES = [
  "recall",
  "recent_failures",
  "stats",
  "recall_with_ai",
  "search_knowledge",
  "fetch_record",
  "why_file",
] as const;
const MCP_TOOL_NAMES_FROZEN = Object.freeze(MCP_TOOL_NAMES);
export const MCP_TOOL_CATALOG_CONTRACT = Object.freeze({
  version: 1 as const,
  tools: MCP_TOOL_NAMES_FROZEN,
});
/** Backward-compatible aliases for callers that consumed the original exports. */
export const MCP_TOOL_CATALOG = MCP_TOOL_CATALOG_CONTRACT.tools;
export const MCP_TOOL_CATALOG_VERSION = MCP_TOOL_CATALOG_CONTRACT.version;
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
  if (typeof value.path !== "string" || Buffer.byteLength(value.path, "utf8") > MAX_FIELD_BYTES) {
    throw new McpInvalidParamsError("invalid params");
  }
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
      name: "stats", title: "Memory statistics", description: "Read bounded memory statistics and coverage metadata: scanned, skipped, truncated, and memory version.",
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
        path: { type: "string", maxLength: MAX_FIELD_BYTES },
        limit: { type: "integer", minimum: 1, maximum: 10 },
      }, ["path"]), annotations: ANNOTATIONS,
    },
  ];
  const byName = new Map(definitions.map((definition) => [definition.name, definition] as const));
  const catalog = MCP_TOOL_CATALOG_CONTRACT.tools;
  if (byName.size !== catalog.length || catalog.some((name) => !byName.has(name))) {
    throw new Error("MCP tool catalog and descriptors are out of sync");
  }
  return catalog.map((name) => byName.get(name)!);
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
    isRecallCandidateId(id) && itemIds.includes(id) && value.indexOf(id) === index,
  );
}

function validEvidenceRefs(
  value: readonly string[],
  items: readonly { candidateId: string; hasFix?: unknown }[],
  allowedCandidateIds: readonly string[] = items.map((item) => item.candidateId),
): boolean {
  const allowed = new Set(allowedCandidateIds);
  return value.every((ref, index) => {
    const match = /^([^.]*)\.(failure|fix)$/.exec(ref);
    if (match === null || value.indexOf(ref) !== index) return false;
    const item = items.find((candidate) => candidate.candidateId === match[1]);
    return item !== undefined && allowed.has(match[1]) && (match[2] === "failure" || item.hasFix === true);
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

function notFoundResult(coverage?: MemoryCoverage): ToolCallResult {
  return cappedResult({
    error: { code: "not_found", message: "record not found" },
    ...memoryCoveragePayload(coverage),
  }, true);
}

function unknownCoverage(): KnowledgeCoverageSummary {
  return { status: "unknown", complete: false, filesCovered: 0, truncatedFiles: 0 };
}

function boundedProviderArray(value: unknown, maximum = MAX_PROVIDER_NESTED_ITEMS): { values: unknown[]; truncated: boolean; valid: boolean; length: number; omitted: number } {
  try {
    if (!Array.isArray(value)) return { values: [], truncated: false, valid: false, length: 0, omitted: 0 };
    const length = value.length;
    if (!Number.isSafeInteger(length) || length < 0) return { values: [], truncated: true, valid: false, length: 0, omitted: 0 };
    const values: unknown[] = [];
    const bound = Math.min(length, maximum);
    for (let index = 0; index < bound; index += 1) values.push(value[index]);
    return { values, truncated: length > maximum, valid: true, length, omitted: Math.max(0, length - maximum) };
  } catch {
    return { values: [], truncated: true, valid: false, length: 0, omitted: 0 };
  }
}

function boundedProviderStrings(value: unknown): { values: string[]; valid: boolean } {
  const bounded = boundedProviderArray(value);
  if (!bounded.valid || bounded.truncated) return { values: [], valid: false };
  const values: string[] = [];
  let bytes = 0;
  try {
    for (const item of bounded.values) {
      if (typeof item !== "string") return { values: [], valid: false };
      if (item.length > MAX_FIELD_BYTES * 2) return { values: [], valid: false };
      bytes += Buffer.byteLength(item, "utf8");
      if (bytes > MAX_PROVIDER_NESTED_BYTES) return { values: [], valid: false };
      values.push(item);
    }
  } catch {
    return { values: [], valid: false };
  }
  return { values, valid: true };
}

function boundedProviderText(value: unknown, maximumChars: number, maximumBytes: number): { value: string; valid: true } | { value: undefined; valid: false } {
  if (typeof value !== "string" || value.length > maximumChars) return { value: undefined, valid: false };
  if (Buffer.byteLength(value, "utf8") > maximumBytes) return { value: undefined, valid: false };
  return { value, valid: true };
}

function optionalProviderText(
  value: unknown,
  maximumChars: number,
  maximumBytes: number,
): { value: string | undefined; valid: true } | { value: undefined; valid: false } {
  if (value === undefined) return { value: undefined, valid: true };
  return boundedProviderText(value, maximumChars, maximumBytes);
}

function snapshotProviderFile(value: unknown): TripleRecord["mechanism"]["files"][number] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const pathValue = raw.path;
  const path = boundedProviderText(pathValue, 1_024, MAX_FIELD_BYTES);
  if (!path.valid || path.value.length === 0) return undefined;
  const plusMinusValue = raw.plusMinus;
  const plusMinus = boundedProviderArray(plusMinusValue, 2);
  if (!plusMinus.valid || plusMinus.truncated || plusMinus.values.length !== 2
      || !isSafeNonNegativeInteger(plusMinus.values[0]) || !isSafeNonNegativeInteger(plusMinus.values[1])) return undefined;
  const propsValue = raw.props;
  const props = boundedProviderStrings(propsValue);
  if (!props.valid) return undefined;
  const excerptValue = raw.excerpt;
  const excerpt = optionalProviderText(excerptValue, MAX_FIELD_BYTES * 2, MAX_FIELD_BYTES * 2);
  if (!excerpt.valid) return undefined;
  const provenanceValue = raw.provenance;
  if (provenanceValue !== undefined && provenanceValue !== "tool-observed" &&
      provenanceValue !== "git-diff-inferred" && provenanceValue !== "unknown") return undefined;
  const identityHashValue = raw.identityHash;
  const identityHash = optionalProviderText(identityHashValue, 32, 32);
  if (!identityHash.valid || identityHash.value !== undefined && !/^[0-9a-f]{32}$/u.test(identityHash.value)) return undefined;
  return {
    path: path.value,
    plusMinus: [plusMinus.values[0] as number, plusMinus.values[1] as number],
    props: props.values,
    ...(excerpt.value === undefined ? {} : { excerpt: excerpt.value }),
    ...(provenanceValue === undefined ? {} : { provenance: provenanceValue }),
    ...(identityHash.value === undefined ? {} : { identityHash: identityHash.value }),
  };
}

function snapshotProviderMechanism(value: unknown): TripleRecord["mechanism"] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const headValue = raw.head;
  const head = optionalProviderText(headValue, MAX_FIELD_BYTES * 2, MAX_FIELD_BYTES * 2);
  if (!head.valid) return undefined;
  const filesValue = raw.files;
  const providerFiles = boundedProviderArray(filesValue, MAX_PROVIDER_NESTED_ITEMS);
  if (!providerFiles.valid) return undefined;
  const files: TripleRecord["mechanism"]["files"] = [];
  for (const entry of providerFiles.values) {
    const file = snapshotProviderFile(entry);
    if (file === undefined) return undefined;
    files.push(file);
  }
  const truncatedFilesValue = raw.truncatedFiles;
  const baselineValue = raw.baseline;
  const coverageStatusValue = raw.coverageStatus;
  if (!isSafeNonNegativeInteger(truncatedFilesValue)) return undefined;
  if (baselineValue !== undefined && baselineValue !== "captured" && baselineValue !== "unknown") return undefined;
  if (coverageStatusValue !== undefined && coverageStatusValue !== "complete" &&
      coverageStatusValue !== "truncated" && coverageStatusValue !== "unknown") return undefined;
  if (!Number.isSafeInteger(truncatedFilesValue + providerFiles.omitted)) return undefined;
  const truncatedFiles = truncatedFilesValue + providerFiles.omitted;
  const coverageStatus = coverageStatusValue === "unknown"
    ? "unknown" as const
    : truncatedFiles > 0
    ? "truncated" as const
    : coverageStatusValue;
  return {
    ...(head.value === undefined ? {} : { head: head.value }),
    files,
    truncatedFiles,
    ...(baselineValue === undefined ? {} : { baseline: baselineValue }),
    ...(coverageStatus === undefined ? {} : { coverageStatus }),
  };
}

function snapshotProviderTriple(value: unknown, knownKind?: unknown): TripleRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const kind = knownKind === undefined ? raw.kind : knownKind;
  if (kind !== "triple") return undefined;
  const idValue = raw.id;
  const id = boundedProviderText(idValue, 512, MAX_FIELD_BYTES);
  if (!id.valid || id.value.length === 0 || /[\u0000-\u001f\u007f-\u009f]/u.test(id.value)) return undefined;
  const tsValue = raw.ts;
  if (typeof tsValue !== "number" || !Number.isSafeInteger(tsValue) || tsValue < 0) return undefined;
  const cwdValue = raw.cwd;
  const cwd = boundedProviderText(cwdValue, MAX_FIELD_BYTES * 2, MAX_FIELD_BYTES * 2);
  if (!cwd.valid) return undefined;
  const schemaV = raw.schemaV;
  if (schemaV !== 1) return undefined;
  const agentValue = raw.agent;
  if (agentValue !== "claude-code" && agentValue !== "codex") return undefined;
  const originValue = raw.origin;
  if (originValue !== "agent-hook") return undefined;
  const platformValue = raw.platform;
  const platform = platformValue === undefined ? undefined : isKnownPathPlatform(platformValue) ? platformValue : undefined;
  if (platformValue !== undefined && platform === undefined) return undefined;
  const mechanismValue = raw.mechanism;
  const mechanism = snapshotProviderMechanism(mechanismValue);
  if (mechanism === undefined) return undefined;
  let intent: TripleRecord["intent"] | undefined;
  const intentValue = raw.intent;
  if (intentValue !== undefined) {
    if (typeof intentValue !== "object" || intentValue === null || Array.isArray(intentValue)) return undefined;
    const intentObject = intentValue as Record<string, unknown>;
    const intentText = boundedProviderText(intentObject.text, MAX_FIELD_BYTES * 2, MAX_FIELD_BYTES * 2);
    if (!intentText.valid) return undefined;
    intent = { text: intentText.value };
  }
  let rationale: TripleRecord["rationale"] | undefined;
  const rationaleValue = raw.rationale;
  if (rationaleValue !== undefined) {
    if (typeof rationaleValue !== "object" || rationaleValue === null || Array.isArray(rationaleValue)) return undefined;
    const rationaleObject = rationaleValue as Record<string, unknown>;
    const rationaleText = boundedProviderText(rationaleObject.text, MAX_FIELD_BYTES * 2, MAX_FIELD_BYTES * 2);
    const rationaleTags = boundedProviderStrings(rationaleObject.tags);
    const rationaleSource = rationaleObject.source;
    if (!rationaleText.valid || !rationaleTags.valid ||
        (rationaleSource !== "transcript" && rationaleSource !== "notify")) return undefined;
    rationale = { text: rationaleText.value, tags: rationaleTags.values, source: rationaleSource };
  }
  return {
    kind: "triple",
    id: id.value,
    ts: tsValue,
    cwd: cwd.value,
    schemaV: 1,
    agent: agentValue,
    origin: "agent-hook",
    ...(platform === undefined ? {} : { platform }),
    ...(intent === undefined ? {} : { intent }),
    ...(rationale === undefined ? {} : { rationale }),
    mechanism,
  };
}

function safeTripleRecord(value: unknown, knownKind?: unknown): TripleRecord | undefined {
  try {
    const snapshot = snapshotProviderTriple(value, knownKind);
    if (snapshot === undefined) return undefined;
    const bounded = boundTripleRecord(snapshot);
    const safe: TripleRecord = {
      ...snapshot,
      mechanism: bounded.mechanism,
    };
    return safe;
  } catch {
    return undefined;
  }
}

/** Snapshot a custom failure before the durable parser or projection can reread accessors. */
function safeProviderFailureRecord(
  value: unknown,
  knownKind?: unknown,
  knownOrigin?: unknown,
  originSnapshotted = false,
): FailureRecord | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const raw = value as Record<string, unknown>;
    const kind = knownKind === undefined ? raw.kind : knownKind;
    if (kind !== "failure") return undefined;
    const idValue = boundedProviderText(raw.id, 512, MAX_FIELD_BYTES);
    if (!idValue.valid || idValue.value.length === 0 || /[\u0000-\u001f\u007f-\u009f]/u.test(idValue.value)) return undefined;
    const ts = raw.ts;
    if (!isSafeNonNegativeInteger(ts)) return undefined;
    const cwd = boundedProviderText(raw.cwd, MAX_FIELD_BYTES * 2, MAX_FIELD_BYTES * 2);
    const cmd = boundedProviderText(raw.cmd, MAX_FIELD_BYTES * 2, MAX_FIELD_BYTES * 2);
    const fingerprint = boundedProviderText(raw.fingerprint, MAX_FIELD_BYTES * 2, MAX_FIELD_BYTES * 2);
    const signature = boundedProviderStrings(raw.signature);
    const excerpt = boundedProviderText(raw.excerpt, MAX_FIELD_BYTES * 2, MAX_FIELD_BYTES * 2);
    if (!cwd.valid || !cmd.valid || !fingerprint.valid || !signature.valid || !excerpt.valid) return undefined;
    const exitCode = raw.exitCode;
    if (typeof exitCode !== "number" || !Number.isSafeInteger(exitCode)) return undefined;

    const origin = originSnapshotted ? knownOrigin : raw.origin;
    if (origin !== undefined && origin !== "run" && origin !== "hook" && origin !== "watch") return undefined;
    const fingerprintV = raw.fingerprintV;
    if (fingerprintV !== undefined && fingerprintV !== 1 && fingerprintV !== 2) return undefined;
    const resolvedBy = optionalProviderText(raw.resolvedBy, 512, MAX_FIELD_BYTES);
    if (!resolvedBy.valid) return undefined;

    const commandIdentity = optionalProviderText(raw.commandIdentity, MAX_FIELD_BYTES * 2, MAX_FIELD_BYTES * 2);
    if (!commandIdentity.valid) return undefined;
    const identityV = raw.identityV;
    const identityReliable = raw.identityReliable;
    const platformValue = raw.platform;
    const hasIdentity = commandIdentity.value !== undefined || identityV !== undefined
      || identityReliable !== undefined || platformValue !== undefined;
    if (hasIdentity && (commandIdentity.value === undefined || identityV !== 1
        || typeof identityReliable !== "boolean" || !isKnownPathPlatform(platformValue))) return undefined;

    return {
      kind: "failure",
      id: idValue.value,
      ts,
      cwd: cwd.value,
      cmd: cmd.value,
      exitCode,
      fingerprint: fingerprint.value,
      ...(fingerprintV === undefined ? {} : { fingerprintV }),
      signature: signature.values,
      excerpt: excerpt.value,
      ...(origin === undefined ? {} : { origin }),
      ...(resolvedBy.value === undefined ? {} : { resolvedBy: resolvedBy.value }),
      ...(hasIdentity ? {
        commandIdentity: commandIdentity.value!,
        identityV: 1 as const,
        identityReliable: identityReliable as boolean,
        platform: platformValue as NodeJS.Platform,
      } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Snapshot a custom fix before it reaches the projection boundary. */
function safeProviderFixRecord(value: unknown, knownKind?: unknown): FixRecord | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const raw = value as Record<string, unknown>;
    const kind = knownKind === undefined ? raw.kind : knownKind;
    if (kind !== "fix") return undefined;
    const idValue = boundedProviderText(raw.id, 512, MAX_FIELD_BYTES);
    if (!idValue.valid || idValue.value.length === 0 || /[\u0000-\u001f\u007f-\u009f]/u.test(idValue.value)) return undefined;
    const ts = raw.ts;
    if (!isSafeNonNegativeInteger(ts)) return undefined;
    const cwd = boundedProviderText(raw.cwd, MAX_FIELD_BYTES * 2, MAX_FIELD_BYTES * 2);
    const cmd = boundedProviderText(raw.cmd, MAX_FIELD_BYTES * 2, MAX_FIELD_BYTES * 2);
    if (!cwd.valid || !cmd.valid) return undefined;
    const failureIds = boundedProviderStrings(raw.failureIds);
    if (!failureIds.valid) return undefined;
    const candidateFailureIdsValue = raw.candidateFailureIds;
    const candidateFailureIds = candidateFailureIdsValue === undefined
      ? { values: [] as string[], valid: true }
      : boundedProviderStrings(candidateFailureIdsValue);
    if (!candidateFailureIds.valid) return undefined;
    const linksValue = raw.links;
    let links: FixRecord["links"] | undefined;
    if (linksValue !== undefined) {
      const boundedLinks = boundedProviderArray(linksValue);
      if (!boundedLinks.valid || boundedLinks.truncated) return undefined;
      links = [];
      for (const entry of boundedLinks.values) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
        const link = entry as Record<string, unknown>;
        const linkId = boundedProviderText(link.id, 512, MAX_FIELD_BYTES);
        const basis = link.basis;
        const confidence = link.confidence;
        // A bounded-but-unrecognized basis is weak evidence, not a malformed
        // record: dropping the whole FixRecord here would violate invariant
        // section 2.5/2.7 the same way the durable reader used to. Only a
        // basis that fails the shared bounded-string rule still rejects.
        if (!linkId.valid || linkId.value.length === 0 || /[\u0000-\u001f\u007f-\u009f]/u.test(linkId.value) ||
            !isBoundedLinkBasis(basis) ||
            (confidence !== undefined && confidence !== "confirmed" && confidence !== "possible")) return undefined;
        // An unrecognized or non-confirmable basis can never present as
        // confirmed. Leave an absent confidence undefined; never invent one.
        const normalizedConfidence: LinkConfidence | undefined = confidence === undefined
          ? undefined
          : (!isConfirmableLinkBasis(basis) && confidence === "confirmed" ? "possible" : confidence);
        links.push({
          id: linkId.value,
          basis,
          ...(normalizedConfidence === undefined ? {} : { confidence: normalizedConfidence }),
        });
      }
    }
    const commandIdentity = optionalProviderText(raw.commandIdentity, MAX_FIELD_BYTES * 2, MAX_FIELD_BYTES * 2);
    if (!commandIdentity.valid) return undefined;
    const identityV = raw.identityV;
    const identityReliable = raw.identityReliable;
    const platformValue = raw.platform;
    const hasIdentity = commandIdentity.value !== undefined || identityV !== undefined
      || identityReliable !== undefined || platformValue !== undefined;
    if (hasIdentity && (commandIdentity.value === undefined || identityV !== 1
        || typeof identityReliable !== "boolean" || !isKnownPathPlatform(platformValue))) return undefined;
    return {
      kind: "fix",
      id: idValue.value,
      ts,
      cwd: cwd.value,
      cmd: cmd.value,
      failureIds: failureIds.values,
      ...(candidateFailureIdsValue === undefined ? {} : { candidateFailureIds: candidateFailureIds.values }),
      ...(links === undefined ? {} : { links }),
      ...(hasIdentity ? {
        commandIdentity: commandIdentity.value!,
        identityV: 1 as const,
        identityReliable: identityReliable as boolean,
        platform: platformValue as NodeJS.Platform,
      } : {}),
    };
  } catch {
    return undefined;
  }
}

function boundedProviderTriples(value: ReturnType<typeof boundedProviderArray>): { candidates: TripleRecord[]; malformed: boolean; truncated: boolean } {
  const candidates: TripleRecord[] = [];
  let malformed = !value.valid;
  for (const entry of value.values) {
    const candidate = safeTripleRecord(entry);
    if (candidate === undefined) {
      malformed = true;
      continue;
    }
    candidates.push(candidate);
  }
  return { candidates, malformed, truncated: value.truncated };
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

interface WhyCandidate {
  candidate: TripleRecord;
  relation: WhyFilePathRelation;
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

function projectWhyTriple(candidate: TripleRecord, exposure: Exposure): Record<string, unknown> {
  const complete = whyTripleComplete(candidate);
  return {
    ...projectTriple(candidate, exposure, exposure === "sanitized"),
    confidence: complete ? "confirmed" : "incomplete",
    reason: complete ? "captured file coverage complete" : "file coverage incomplete; Rocky does not know full change",
  };
}

function selectWhyCandidates(
  candidates: readonly TripleRecord[],
  path: string,
  limit: number,
  now = Date.now(),
): { matches: TripleRecord[]; possible: WhyFileEvidence["possible"]; ambiguousSuffix: boolean } {
  const related: WhyCandidate[] = candidates.map((candidate) => ({
    candidate,
    relation: whyFilePathRelation(candidate, path),
  })).filter(({ candidate }) => candidate.ts <= now);
  const hasExact = related.some(({ relation }) => relation.exact);
  const suffixIdentities = new Set(
    related
      .filter(({ relation }) => !relation.exact)
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

function fallbackWhyEvidence(options: CreateToolRegistryOptions, path: string, limit: number, state?: SafeMemoryReadState, now = Date.now()): WhyFileEvidence {
  let rawMatches: unknown;
  try {
    rawMatches = options.memory.whyFile(path, limit);
  } catch {
    if (state !== undefined) state.failed = true;
    rawMatches = [];
  }
  const boundedRawMatches = boundedProviderArray(rawMatches, MAX_WHY_EVIDENCE_INPUTS);
  const normalizedMatches = boundedProviderTriples(boundedRawMatches);
  const selected = selectWhyCandidates(normalizedMatches.candidates, path, limit, now);
  // Coverage belongs to selected exact/unambiguous evidence only. An
  // unrelated complete triple cannot make an empty why-file result complete.
  const matches = normalizedMatches.malformed ? [] : selected.matches;
  const coverage = coverageForTriples(matches);
  const incomplete = normalizedMatches.malformed || normalizedMatches.truncated || matches.length === 0 || !coverage.complete || selected.possible.length > 0
    || selected.ambiguousSuffix;
  return {
    matches,
    possible: selected.possible,
    coverage: incomplete ? { ...coverage, status: "unknown", complete: false } : coverage,
    coverageIncomplete: incomplete,
    ...(selected.ambiguousSuffix ? { ambiguousPath: true } : {}),
  };
}

function normalizeWhyEvidence(value: unknown, fallback: WhyFileEvidence, path: string, limit: number, now = Date.now()): WhyFileEvidence {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return fallback;
    const raw = value as Record<string, unknown>;
    const boundedMatches = boundedProviderArray(raw.matches, MAX_WHY_EVIDENCE_INPUTS);
    const normalizedMatches = boundedProviderTriples(boundedMatches);
    const selected = selectWhyCandidates(normalizedMatches.candidates, path, limit, now);
    const ambiguous = selected.ambiguousSuffix || raw.ambiguousPath === true;
    const boundedPossible = boundedProviderArray(raw.possible, MAX_WHY_EVIDENCE_INPUTS);
    let malformedPossible = !boundedPossible.valid;
    const providerPossible: WhyFileEvidence["possible"] = [];
    for (let index = 0; index < boundedPossible.values.length && providerPossible.length < limit; index += 1) {
      const candidate = boundedPossible.values[index];
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
        malformedPossible = true;
        continue;
      }
      const value = candidate as Record<string, unknown>;
      if (typeof value.id !== "string" || typeof value.ts !== "number" || !Number.isSafeInteger(value.ts) || value.ts < 0 || value.ts > now
          || value.source !== "agent-hook" || value.reason !== "path_may_be_omitted") {
        malformedPossible = true;
        continue;
      }
      providerPossible.push({ id: value.id, ts: value.ts, source: "agent-hook", reason: "path_may_be_omitted" });
    }
    const malformedEvidence = normalizedMatches.malformed || malformedPossible;
    const truncatedEvidence = normalizedMatches.truncated || boundedPossible.truncated;
    const matches = ambiguous || malformedEvidence ? [] : selected.matches;
    const derived = coverageForTriples(matches);
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
    if (raw.coverageIncomplete === true || malformedEvidence || truncatedEvidence) coverage = { ...coverage, status: "unknown", complete: false };
    if (possible.length > 0 || ambiguous) coverage = { ...coverage, status: "unknown", complete: false };
    return {
      matches,
      possible,
      coverage,
      coverageIncomplete: !coverage.complete || possible.length > 0 || raw.coverageIncomplete === true || malformedEvidence || truncatedEvidence,
      ...(ambiguous ? { ambiguousPath: true } : {}),
    };
  } catch {
    return fallback;
  }
}

function safeErrorResult(error: ToolExecutionError, coverage?: MemoryCoverage): ToolCallResult {
  return cappedResult({ error: { code: error.safeCode, message: error.message }, ...memoryCoveragePayload(coverage) }, true);
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
interface SafeMemoryReadState { failed: boolean }

function safeReadMemory<T>(operation: () => T, fallback: T, canonical = false, state?: SafeMemoryReadState): T {
  try {
    return operation();
  } catch (error) {
    if (state !== undefined) state.failed = true;
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

interface SafeStatsSnapshot {
  value: Record<string, unknown>;
  valid: boolean;
}

function emptyStats(): Record<string, unknown> {
  return { failures: 0, fixEvents: 0, resolved: 0, unresolved: 0, confirmedFixes: 0, possibleFixes: 0, triples: 0, notes: 0, total: 0 };
}

function safeMemoryStats(value: unknown, canonical = false): SafeStatsSnapshot {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { value: emptyStats(), valid: false };
    }
    const source = value as Record<string, unknown>;
    const failuresValue = source.failures;
    const fixEventsValue = source.fixEvents;
    const resolvedValue = source.resolved;
    const unresolvedValue = source.unresolved;
    const confirmedFixesValue = source.confirmedFixes;
    const possibleFixesValue = source.possibleFixes;
    const triplesValue = source.triples;
    const notesValue = source.notes;
    const totalValue = source.total;
    const values = [
      failuresValue, fixEventsValue, resolvedValue, unresolvedValue, confirmedFixesValue,
      possibleFixesValue, triplesValue, notesValue, totalValue,
    ];
    if (values.some((entry) => entry !== undefined && !isSafeNonNegativeInteger(entry))) {
      return { value: emptyStats(), valid: false };
    }
    const failures = failuresValue === undefined ? 0 : failuresValue as number;
    const fixEvents = fixEventsValue === undefined ? 0 : fixEventsValue as number;
    const resolved = resolvedValue === undefined ? 0 : resolvedValue as number;
    const unresolved = unresolvedValue === undefined ? 0 : unresolvedValue as number;
    const confirmedFixes = confirmedFixesValue === undefined ? fixEvents : confirmedFixesValue as number;
    const possibleFixes = possibleFixesValue === undefined ? 0 : possibleFixesValue as number;
    const triples = triplesValue === undefined ? 0 : triplesValue as number;
    const notes = notesValue === undefined ? 0 : notesValue as number;
    const base = saturatedAdd(failures, triples, notes);
    const lowerBound = saturatedAdd(base, Math.max(fixEvents, possibleFixes));
    const upperBound = saturatedAdd(base, fixEvents, possibleFixes);
    const suppliedTotal = totalValue === undefined ? undefined : totalValue as number;
    const suppliedFeasible = suppliedTotal !== undefined
      && suppliedTotal >= lowerBound && suppliedTotal <= upperBound;
    const exact = (canonical && suppliedTotal !== undefined) || suppliedFeasible || lowerBound === upperBound;
    // Keep legacy `total` useful as the conservative upper bound while the
    // explicit exactness/range fields tell callers that overlapping fix
    // buckets prevent treating it as an exact record count.
    const total = (canonical && suppliedTotal !== undefined) || suppliedFeasible
      ? suppliedTotal as number
      : upperBound;
    return {
      valid: true,
      value: {
        failures, fixEvents, resolved, unresolved, confirmedFixes, possibleFixes, triples, notes, total,
        ...(exact ? {} : { totalExact: false, totalLowerBound: lowerBound, totalUpperBound: upperBound }),
      },
    };
  } catch {
    return { value: emptyStats(), valid: false };
  }
}

function unknownMemoryCoverage(): MemoryCoverage {
  // Conservative explicit unknown: the marker is a lower bound, not an
  // estimate of how many records were omitted.
  return Object.freeze({
    version: 1 as const,
    scanned: 0,
    skipped: 0,
    truncated: 1,
    bytesScanned: 0,
    bytesTotal: 0,
    complete: false,
    reason: "read-race" as const,
  });
}

function memoryCoverage(
  _memory: MemoryQueries,
  forceUnknown = false,
  coverageReader?: () => unknown,
): MemoryCoverage | undefined {
  if (forceUnknown) return unknownMemoryCoverage();
  try {
    const supplied: unknown = coverageReader === undefined ? undefined : coverageReader();
    if (supplied === undefined) return undefined;
    if (typeof supplied !== "object" || supplied === null || Array.isArray(supplied)) return unknownMemoryCoverage();
    const value = supplied as Record<string, unknown>;
    const version = value.version;
    const scanned = value.scanned;
    const skipped = value.skipped;
    const truncated = value.truncated;
    const bytesScanned = value.bytesScanned;
    const bytesTotal = value.bytesTotal;
    const complete = value.complete;
    const reason = value.reason;
    if (version !== 1 || !isSafeNonNegativeInteger(scanned) ||
        !isSafeNonNegativeInteger(skipped) || !isSafeNonNegativeInteger(truncated) ||
        !isSafeNonNegativeInteger(bytesScanned) || !isSafeNonNegativeInteger(bytesTotal) ||
        typeof complete !== "boolean" ||
        (reason !== undefined && reason !== "file-size-cap" && reason !== "record-cap" && reason !== "read-race")) return unknownMemoryCoverage();
    // `scanned` and `skipped` are independent evidence counters: a provider
    // may count only valid records as scanned while reporting corrupt lines
    // separately. Do not reject a legitimate 0-valid/10-skipped snapshot.
    if (bytesScanned > bytesTotal) return unknownMemoryCoverage();
    if (complete === true && (bytesScanned !== bytesTotal || skipped > 0 || truncated > 0 || reason !== undefined)) return unknownMemoryCoverage();
    if (reason === "read-race" && (complete === true || truncated === 0)) return unknownMemoryCoverage();
    if (reason === "file-size-cap" && (complete === true || truncated === 0 || bytesTotal <= MAX_MEMORY_FILE_BYTES)) return unknownMemoryCoverage();
    if (reason === "record-cap" && (complete === true || truncated === 0 || scanned < MAX_SUPPORTED_MEMORY_RECORDS)) return unknownMemoryCoverage();
    return Object.freeze({
      version: 1 as const,
      scanned, skipped, truncated, bytesScanned, bytesTotal, complete,
      ...(reason === undefined ? {} : { reason }),
    });
  } catch {
    return unknownMemoryCoverage();
  }
}

function memoryCoveragePayload(coverage: MemoryCoverage | undefined): Record<string, unknown> {
  if (coverage === undefined) return {};
  return {
    coverage,
    memoryCoverage: coverage,
    memoryVersion: coverage.version,
    memoryCoverageIncomplete: !coverage.complete || coverage.skipped > 0 || coverage.truncated > 0,
  };
}

const MCP_AI_STATUSES = Object.freeze([
  "used", "disabled", "unavailable", "model_missing", "timeout", "cancelled",
  "invalid_output", "low_confidence", "busy", "no_hits",
] as const);
const MCP_AI_ACTS = Object.freeze(["known_fix", "unresolved", "ambiguous"] as const);

/** Read custom AI output once into bounded plain data before any merge/cap. */
function snapshotRecallAiOutcome(value: unknown): RecallAiOutcome | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const source = value as Record<string, unknown>;
    const aiStatus = source.aiStatus;
    if (typeof aiStatus !== "string" || !MCP_AI_STATUSES.includes(aiStatus as typeof MCP_AI_STATUSES[number])) return undefined;
    const rankedValue = source.rankedCandidateIds;
    if (!Array.isArray(rankedValue)) return undefined;
    const rankedLength = rankedValue.length;
    if (!Number.isSafeInteger(rankedLength) || rankedLength > 5) return undefined;
    const rankedCandidateIds: string[] = [];
    for (let index = 0; index < rankedLength; index += 1) {
      const id = rankedValue[index];
      if (typeof id !== "string" || id.length > MAX_FIELD_BYTES * 2 || Buffer.byteLength(id, "utf8") > MAX_FIELD_BYTES * 2) return undefined;
      rankedCandidateIds.push(id);
    }

    const act = source.act;
    if (act !== undefined && (typeof act !== "string" || !MCP_AI_ACTS.includes(act as typeof MCP_AI_ACTS[number]))) return undefined;

    const evidenceValue = source.evidenceRefs;
    let evidenceRefs: string[] | undefined;
    if (evidenceValue !== undefined) {
      if (!Array.isArray(evidenceValue)) return undefined;
      const evidenceLength = evidenceValue.length;
      if (!Number.isSafeInteger(evidenceLength) || evidenceLength > 10) return undefined;
      evidenceRefs = [];
      for (let index = 0; index < evidenceLength; index += 1) {
        const ref = evidenceValue[index];
        if (typeof ref !== "string" || ref.length > MAX_FIELD_BYTES * 2 || Buffer.byteLength(ref, "utf8") > MAX_FIELD_BYTES * 2) return undefined;
        evidenceRefs.push(ref);
      }
    }

    const confidence = source.confidence;
    if (confidence !== undefined && (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)) return undefined;

    const explanation = source.explanation;
    if (explanation !== undefined) {
      if (typeof explanation !== "string" || explanation.length > 600 || Buffer.byteLength(explanation, "utf8") > MAX_FIELD_BYTES) return undefined;
      let codePoints = 0;
      for (const character of explanation) {
        void character;
        codePoints += 1;
        if (codePoints > 300) return undefined;
      }
    }
    return {
      aiStatus: aiStatus as RecallAiOutcome["aiStatus"],
      rankedCandidateIds,
      ...(act === undefined ? {} : { act: act as RecallAiOutcome["act"] }),
      ...(evidenceRefs === undefined ? {} : { evidenceRefs }),
      ...(confidence === undefined ? {} : { confidence }),
      ...(explanation === undefined ? {} : { explanation }),
    };
  } catch {
    return undefined;
  }
}

async function runAi<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    // Storage/transport failures retain the existing safe-error wire shape;
    // an ordinary provider exception is a bounded AI fallback instead of an
    // uncaught JSON-RPC Internal Error.
    if (hasOperationalCode(error) || error instanceof ToolExecutionError) {
      throw new ToolExecutionError("ai_unavailable", "AI unavailable");
    }
    throw new ToolExecutionError("ai_fallback", "AI unavailable");
  }
}

function mergeAi(
  payload: object,
  ai: RecallAiOutcome | undefined,
  aiCandidateIds: readonly string[],
): Record<string, unknown> {
  const source = payload as Record<string, unknown>;
  const items = Array.isArray(source.items) ? source.items.filter(isItem) : [];
  const itemIds = items.map((item) => item.candidateId);
  if (ai === undefined) {
    return { ...source, aiStatus: "invalid_output", items, rankedCandidateIds: itemIds, truncated: true };
  }
  const rankedValid = validRankedCandidateIds(ai.rankedCandidateIds, aiCandidateIds);
  const evidenceValid = ai.evidenceRefs === undefined || validEvidenceRefs(ai.evidenceRefs, items, aiCandidateIds);
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
    ? ai.rankedCandidateIds.filter((id) => itemIds.includes(id) && aiCandidateIds.includes(id))
    : [];
  for (const id of itemIds) if (!ranked.includes(id)) ranked.push(id);
  const reorderedItems = useAiOrder
    ? ranked.map((id) => items.find((item) => item.candidateId === id)!).filter(isItem)
    : items;
  const safeAi: Record<string, unknown> = { aiStatus: ai.aiStatus };
  if (ai.act !== undefined) safeAi.act = ai.act;
  if (ai.confidence !== undefined) safeAi.confidence = ai.confidence;
  if (ai.explanation !== undefined) safeAi.explanation = ai.explanation;
  const evidenceRefs = ai.evidenceRefs?.filter((ref, index, refs) =>
    refs.indexOf(ref) === index && validEvidenceRefs([ref], items, aiCandidateIds),
  );
  return {
    ...source,
    ...safeAi,
    items: reorderedItems,
    rankedCandidateIds: ranked,
    ...(evidenceRefs === undefined ? {} : { evidenceRefs }),
  };
}

/**
 * Keep only candidates that survive the same final envelope cap used for the
 * returned ToolCallResult. The synthetic used outcome ranks each trial first,
 * so a retained candidate cannot be popped by a smaller real outcome.
 */
interface RetainedAiHit { hit: RecallHit; candidateId: string }

function retainAiHitsForEnvelope(
  payload: object,
  hits: readonly RecallHit[],
  sourceCandidateIds: readonly string[],
): readonly RetainedAiHit[] {
  const source = payload as Record<string, unknown>;
  const items = Array.isArray(source.items) ? source.items.filter(isItem) : [];
  const candidateIds = validateRecallCandidateIds(sourceCandidateIds, hits.length);
  if (candidateIds === undefined || candidateIds.some((id) => !items.some((item) => item.candidateId === id))) return [];
  const candidates = hits.map((hit, index) => ({ hit, candidateId: candidateIds[index]! })).slice(0, 5);
  const retained: RetainedAiHit[] = [];
  for (const candidate of candidates) {
    const trial = [...retained, candidate];
    const trialIds = trial.map((item) => item.candidateId);
    const evidenceRefs: string[] = [];
    for (const candidateId of trialIds) {
      const item = items.find((entry) => entry.candidateId === candidateId);
      if (item === undefined || evidenceRefs.length >= 10) continue;
      evidenceRefs.push(`${candidateId}.failure`);
      if ((item as { hasFix?: unknown }).hasFix === true && evidenceRefs.length < 10) {
        evidenceRefs.push(`${candidateId}.fix`);
      }
    }
    const worstOutcome: RecallAiOutcome = {
      aiStatus: "used",
      act: "unresolved",
      confidence: 2.2250738585072014e-308,
      explanation: "\u0000".repeat(300),
      rankedCandidateIds: trialIds,
      evidenceRefs,
    };
    try {
      const result = cappedResult(mergeAi(payload, worstOutcome, trialIds));
      const resultIds = Array.isArray(result.structuredContent.items)
        ? result.structuredContent.items.filter(isItem).map((item) => item.candidateId)
        : [];
      if (trialIds.every((id) => resultIds.includes(id))) retained.push(candidate);
    } catch {
      // A candidate that cannot fit is omitted from the bounded AI request.
    }
  }
  return retained;
}

function deterministicAiFallback(payload: object, aiStatus: "unavailable" | "invalid_output"): Record<string, unknown> {
  const source = payload as Record<string, unknown>;
  const items = Array.isArray(source.items) ? source.items.filter(isItem) : [];
  return { ...source, aiStatus, items, rankedCandidateIds: items.map((item) => item.candidateId), truncated: true };
}

interface StatsFlightResult {
  stats: Record<string, unknown>;
  coverage: MemoryCoverage | undefined;
  error?: unknown;
}

export function createToolRegistry(options: CreateToolRegistryOptions): McpToolRegistry {
  const definitions = freezeDeep(descriptors(options.exposure));
  // Snapshot optional provider method once. Clean legacy queries without a
  // witness omit coverage; any forced-failure path emits explicit unknown.
  let coverageReader: (() => unknown) | undefined;
  try {
    const coverageMethod = options.memory.coverage;
    if (coverageMethod === undefined) {
      coverageReader = undefined;
    } else if (typeof coverageMethod === "function") {
      coverageReader = () => coverageMethod.call(options.memory);
    } else {
      coverageReader = () => { throw new Error("invalid coverage provider"); };
    }
  } catch {
    coverageReader = () => { throw new Error("coverage provider unavailable"); };
  }
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
  // MCP stats inputs have no clock override, so one active flight can serve
  // every cwd-specific pure projection. Settlement discards it; later calls
  // revalidate the durable content witness.
  let durableSnapshotFlight: Promise<DurableMemorySnapshot | undefined> | undefined;
  const readStatsSnapshot = (input: StatsQuery, canonicalMemory: boolean): StatsFlightResult => {
    const readState: SafeMemoryReadState = { failed: false };
    try {
      const rawStats = safeReadMemory<unknown>(() => options.memory.stats(input), {}, canonicalMemory, readState);
      const snapshot = safeMemoryStats(rawStats, canonicalMemory);
      if (!snapshot.valid) readState.failed = true;
      return { stats: snapshot.value, coverage: memoryCoverage(options.memory, readState.failed, coverageReader) };
    } catch (error) {
      return {
        stats: emptyStats(),
        coverage: memoryCoverage(options.memory, true, coverageReader),
        error,
      };
    }
  };
  const statsFromDurableSnapshot = (snapshot: DurableMemorySnapshot | undefined, input: StatsQuery): StatsFlightResult => snapshot === undefined
    ? { stats: {}, coverage: unknownMemoryCoverage(), error: new ToolExecutionError("memory_unavailable", "memory unavailable") }
    : { stats: queryStats(snapshot.records, input) as unknown as Record<string, unknown>, coverage: snapshot.coverage };
  const readStatsFlight = (input: StatsQuery, canonicalMemory: boolean): Promise<StatsFlightResult> => {
    if (!hasDurableMemoryQueries(options.memory)) return Promise.resolve(readStatsSnapshot(input, canonicalMemory));
    const current = durableSnapshotFlight;
    if (current !== undefined) {
      return current.then((snapshot) => statsFromDurableSnapshot(snapshot, input));
    }
    let flight: Promise<DurableMemorySnapshot | undefined>;
    flight = Promise.resolve().then(() => loadDurableMemorySnapshot(options.memory)).finally(() => {
      if (durableSnapshotFlight === flight) durableSnapshotFlight = undefined;
    });
    durableSnapshotFlight = flight;
    return flight.then((snapshot) => statsFromDurableSnapshot(snapshot, input));
  };
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
      let pairedCoverage: MemoryCoverage | undefined;
      try {
        const canonicalMemory = hasCanonicalMemoryQueries(options.memory);
        switch (name) {
          case "recall": {
            const input = parseRecallArgs(args, options.exposure);
            const readState: SafeMemoryReadState = { failed: false };
            const hits = safeReadMemory(() => options.memory.recall(input), [], canonicalMemory, readState);
            const coverage = memoryCoverage(options.memory, readState.failed, coverageReader);
            pairedCoverage = coverage;
            const projected = safeProjection(
              () => projectRecallHits(hits, options.exposure),
              { exposure: options.exposure, items: [], truncated: true, ...memoryCoveragePayload(coverage) },
            );
            const enriched = {
              ...projected,
              ...memoryCoveragePayload(coverage),
              ...(readState.failed ? { truncated: true } : {}),
            };
            return safeProjection(
              () => cappedResult(enriched),
              cappedResult({ exposure: options.exposure, items: [], truncated: true, ...memoryCoveragePayload(coverage) }),
            );
          }
          case "recent_failures": {
            const input = parseRecentArgs(args, options.exposure);
            const readState: SafeMemoryReadState = { failed: false };
            const hits = safeReadMemory(() => options.memory.recentFailures(input), [], canonicalMemory, readState);
            const coverage = memoryCoverage(options.memory, readState.failed, coverageReader);
            pairedCoverage = coverage;
            const projected = safeProjection(
              () => projectRecentFailures(hits, options.exposure),
              { exposure: options.exposure, items: [], truncated: true, ...memoryCoveragePayload(coverage) },
            );
            const enriched = {
              ...projected,
              ...memoryCoveragePayload(coverage),
              ...(readState.failed ? { truncated: true } : {}),
            };
            return safeProjection(
              () => cappedResult(enriched),
              cappedResult({ exposure: options.exposure, items: [], truncated: true, ...memoryCoveragePayload(coverage) }),
            );
          }
          case "stats": {
            const input = parseStatsArgs(args, options.exposure);
            const flight = await readStatsFlight(input, canonicalMemory);
            const coverage = flight.coverage;
            pairedCoverage = coverage;
            if (flight.error !== undefined) throw flight.error;
            const result = {
              exposure: options.exposure,
              ...flight.stats,
              ...memoryCoveragePayload(coverage),
            };
            return safeProjection(() => cappedResult(result), cappedResult({
              exposure: options.exposure,
              ...emptyStats(),
              ...memoryCoveragePayload(coverage),
            }));
          }
          case "search_knowledge": {
            const input = parseKnowledgeArgs(args);
            const readState: SafeMemoryReadState = { failed: false };
            const hits = safeReadMemory(() => options.memory.searchKnowledge(input), [], canonicalMemory, readState);
            const coverage = memoryCoverage(options.memory, readState.failed, coverageReader);
            pairedCoverage = coverage;
            const { projector, pending } = createPendingKnowledgeIdProjector();
            const projected = safeProjection(
              () => projectKnowledgeHits(hits, options.exposure, projector),
              { exposure: options.exposure, items: [], truncated: true, ...memoryCoveragePayload(coverage) },
            );
            const enriched = {
              ...projected,
              ...memoryCoveragePayload(coverage),
              ...(readState.failed ? { truncated: true } : {}),
            };
            const result = safeProjection(
              () => cappedResult(enriched),
              cappedResult({ exposure: options.exposure, items: [], truncated: true, ...memoryCoveragePayload(coverage) }),
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
            const readState: SafeMemoryReadState = { failed: false };
            const record = safeReadMemory(() => options.memory.fetchRecord(resolveKnowledgeId(id)), undefined, canonicalMemory, readState);
            const coverage = memoryCoverage(options.memory, readState.failed, coverageReader);
            pairedCoverage = coverage;
            try {
              if (record === undefined || typeof record !== "object" || record === null || Array.isArray(record)) return notFoundResult(coverage);
              const recordObject = record as unknown as Record<string, unknown>;
              const recordKind = recordObject.kind;
              if (recordKind === "note") return notFoundResult(coverage);
              const origin = recordKind === "failure" ? recordObject.origin : undefined;
              if (recordKind === "failure" && origin !== undefined &&
                  origin !== "run" && origin !== "hook" && origin !== "watch") return notFoundResult(coverage);
              // Custom providers are untrusted: once the discriminator is
              // read, every supported kind must stay on a bounded snapshot
              // path.  The durable parser may inspect canonical records, but
              // must never reread a changing custom object.
              const normalized = canonicalMemory
                ? parseMemoryRecord(record)
                : recordKind === "triple"
                ? safeTripleRecord(record, recordKind)
                : recordKind === "failure"
                ? safeProviderFailureRecord(record, recordKind, origin, true)
                : recordKind === "fix"
                ? safeProviderFixRecord(record, recordKind)
                : undefined;
              if (normalized === undefined || normalized.kind === "note") return notFoundResult(coverage);
              const projected = projectMemoryRecord(normalized, options.exposure, options.exposure === "sanitized");
              if (projected === undefined) return notFoundResult(coverage);
              return boundedSingleResult(
                { exposure: options.exposure, record: projected, truncated: false, ...memoryCoveragePayload(coverage) },
                { exposure: options.exposure, record: null, truncated: true, ...memoryCoveragePayload(coverage) },
              );
            } catch {
              return notFoundResult(coverage);
            }
          }
          case "why_file": {
            const input = parseWhyFileArgs(args);
            const readState: SafeMemoryReadState = { failed: false };
            let fallback: WhyFileEvidence | undefined;
            const getFallback = (): WhyFileEvidence => fallback ??= fallbackWhyEvidence(options, input.path, input.limit, readState);
            let customEvidence: MemoryQueries["whyFileEvidence"] | undefined;
            let customEvidencePresent = false;
            try {
              const candidate = options.memory.whyFileEvidence;
              customEvidencePresent = candidate !== undefined;
              if (typeof candidate === "function") customEvidence = candidate;
            } catch {
              customEvidencePresent = true;
              readState.failed = true;
            }
            const unknownEvidence: WhyFileEvidence = {
              matches: [], possible: [],
              coverage: { status: "unknown", complete: false, filesCovered: 0, truncatedFiles: 0 },
              coverageIncomplete: true,
            };
            const rawEvidence = safeReadMemory(() => customEvidencePresent
              ? customEvidence === undefined ? unknownEvidence : customEvidence(input.path, input.limit)
              : getFallback(), unknownEvidence, canonicalMemory, readState);
            const evidence = safeProjection(
              () => customEvidencePresent
                ? normalizeWhyEvidence(rawEvidence, unknownEvidence, input.path, input.limit)
                : rawEvidence,
              unknownEvidence,
            );
            const memoryScan = memoryCoverage(options.memory, readState.failed, coverageReader);
            pairedCoverage = memoryScan;
            const projected = safeProjection(() => ({
              exposure: options.exposure,
              ...memoryCoveragePayload(memoryScan),
              items: evidence.matches.map((triple) => projectWhyTriple(triple, options.exposure)),
              possible: projectWhyPossible(evidence.possible, input.limit, options.exposure),
              coverage: evidence.coverage,
              coverageStatus: evidence.coverage.status,
              coverageIncomplete: evidence.coverageIncomplete,
              ...(evidence.ambiguousPath ? { ambiguousPath: true } : {}),
              truncated: false,
            }), { exposure: options.exposure, ...memoryCoveragePayload(memoryScan), items: [], possible: [], coverage: { status: "unknown", complete: false, filesCovered: 0, truncatedFiles: 0 }, coverageStatus: "unknown", coverageIncomplete: true, truncated: true });
            return safeProjection(() => cappedResult(projected), cappedResult({ exposure: options.exposure, ...memoryCoveragePayload(memoryScan), items: [], possible: [], coverage: { status: "unknown", complete: false, filesCovered: 0, truncatedFiles: 0 }, coverageStatus: "unknown", coverageIncomplete: true, truncated: true }));
          }
          case "recall_with_ai": {
            const input = parseRecallArgs(args, options.exposure, 10);
            const readState: SafeMemoryReadState = { failed: false };
            const hits = safeReadMemory(() => options.memory.recall(input), [], canonicalMemory, readState);
            const coverage = memoryCoverage(options.memory, readState.failed, coverageReader);
            pairedCoverage = coverage;
            const aiProjection = safeProjection(
              () => projectRecallHitsForAi(hits, options.exposure),
              { response: { exposure: options.exposure, items: [], truncated: true }, hits: [] as readonly RecallHit[], candidateIds: [] },
            );
            const enriched = { ...aiProjection.response, ...memoryCoveragePayload(coverage) };
            const aiCandidates = retainAiHitsForEnvelope(enriched, aiProjection.hits, aiProjection.candidateIds);
            if (aiCandidates.length === 0) {
              const deterministicItems = Array.isArray(enriched.items) ? enriched.items.filter(isItem) : [];
              const noHits = {
                ...enriched,
                aiStatus: "no_hits",
                items: deterministicItems,
                rankedCandidateIds: deterministicItems.map((item) => item.candidateId),
              };
              return safeProjection(
                () => cappedResult(noHits),
                cappedResult({ ...enriched, aiStatus: "no_hits", items: [], rankedCandidateIds: [], truncated: true }),
              );
            }
            let ai: unknown;
            try {
              ai = await runAi(() => options.recallWithAi.run(
                {
                  query: input.query,
                  hits: aiCandidates.map((candidate) => candidate.hit),
                  candidateIds: aiCandidates.map((candidate) => candidate.candidateId),
                  exposure: options.exposure,
                }, signal,
              ));
            } catch (error) {
              if (error instanceof ToolExecutionError && error.safeCode === "ai_fallback") {
                ai = { aiStatus: "unavailable", rankedCandidateIds: [] } satisfies RecallAiOutcome;
              } else {
                throw error;
              }
            }
            const safeAi = snapshotRecallAiOutcome(ai);
            const aiCandidateIds = aiCandidates.map((candidate) => candidate.candidateId);
            return safeProjection(
              () => cappedResult(mergeAi(enriched, safeAi, aiCandidateIds)),
              cappedResult(deterministicAiFallback(enriched, safeAi !== undefined ? "unavailable" : "invalid_output")),
            );
          }
          default:
            throw new McpInvalidParamsError("unknown tool");
        }
      } catch (error) {
        if (error instanceof McpInvalidParamsError) throw error;
        if (error instanceof ToolExecutionError) return safeErrorResult(error, pairedCoverage ?? unknownMemoryCoverage());
        throw error;
      }
    },
  };
}
