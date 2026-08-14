import { Buffer } from "node:buffer";
import type { Exposure } from "../core/config-read.js";
import type { KnowledgeCoverageSummary, KnowledgeSearchQuery, MemoryQueries, RecallQuery, RecentFailuresQuery, StatsQuery, WhyFileEvidence } from "../core/memory-query.js";
import type { RecallAiOutcome, RecallWithAiPort } from "../ai/port.js";
import {
  MAX_RESPONSE_BYTES,
  projectKnowledgeHits,
  projectMemoryRecord,
  projectRecallHits,
  projectRecentFailures,
  projectWhyPossible,
  projectTriple,
} from "./privacy.js";
import { boundTripleRecord, canonicalPath, isKnownPathPlatform, isSafeNonNegativeInteger } from "../core/memory-read.js";
import type { TripleRecord } from "../core/memory-read.js";

export interface McpToolDefinition {
  name: "recall" | "recent_failures" | "stats" | "recall_with_ai" | "search_knowledge" | "fetch_record" | "why_file";
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
const MAX_WHY_EVIDENCE_INPUTS = 20_000;
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
  return [
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
  const arrayPriority = Array.isArray(copy.possible) && copy.possible.length > 0
    ? ["possible", "items", "rankedCandidateIds", "evidenceRefs"]
    : ["items", "possible", "rankedCandidateIds", "evidenceRefs"];
  const arrayKeys = [
    ...arrayPriority.filter((key) => Array.isArray(copy[key])),
    ...Object.keys(copy).filter((key) => Array.isArray(copy[key]) && !arrayPriority.includes(key)).sort(),
  ];
  while (true) {
    const output = buildResult(copy, isError);
    if (Buffer.byteLength(JSON.stringify(output), "utf8") <= RESPONSE_CAP_BYTES) return output;
    const key = arrayKeys.find((candidate) => {
      const values = copy[candidate];
      return Array.isArray(values) && values.length > 0;
    });
    if (key === undefined) {
      throw new Error("response too large");
    }
    const values = copy[key] as unknown[];
    const removed = values.pop();
    if (key === "items" && isItem(removed)) pruneRefs(copy, removed.candidateId);
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

function safeTripleRecord(value: unknown): TripleRecord | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const raw = value as Record<string, unknown>;
    const ts = raw.ts;
    if (raw.kind !== "triple" || typeof raw.id !== "string" || typeof ts !== "number" || !Number.isSafeInteger(ts) ||
        typeof raw.cwd !== "string" || raw.agent !== "claude-code" && raw.agent !== "codex") return undefined;
    const bounded = boundTripleRecord(raw as unknown as TripleRecord);
    const platform = isKnownPathPlatform(raw.platform) ? raw.platform : undefined;
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
      if (typeof candidate.text === "string" && Array.isArray(candidate.tags) &&
          candidate.tags.every((tag) => typeof tag === "string") &&
          (candidate.source === "transcript" || candidate.source === "notify")) {
        safe.rationale = {
          text: candidate.text,
          tags: [...candidate.tags] as string[],
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
  if (!targetDisplay || !targetIdentity) return { exact: false, suffix: false, suffixIdentities: [] };
  const suffixIdentities = new Set<string>();
  for (const file of candidate.mechanism.files) {
    const candidateDisplay = canonicalPath(file.path, { platform });
    const candidateIdentity = canonicalPath(file.path, { platform, cwd: candidate.cwd });
    if (!candidateDisplay || !candidateIdentity) continue;
    if (candidateDisplay === targetDisplay || candidateIdentity === targetIdentity) {
      return { exact: true, suffix: false, suffixIdentities: [] };
    }
    if (candidateDisplay.endsWith(`/${targetDisplay}`)) suffixIdentities.add(candidateIdentity);
  }
  return { exact: false, suffix: suffixIdentities.size > 0, suffixIdentities: [...suffixIdentities] };
}

interface WhyCandidate {
  candidate: TripleRecord;
  relation: WhyPathRelation;
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
    const incomplete = candidate.mechanism.coverageStatus !== "complete" || candidate.mechanism.truncatedFiles > 0;
    const exactOrUnambiguousSuffix = relation.exact || (
      !hasExact && !ambiguousSuffix && relation.suffix && !incomplete
    );
    if (exactOrUnambiguousSuffix) {
      if (matches.length < limit) matches.push(candidate);
    } else if (incomplete && possible.length < limit) {
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
  let boundedRawMatches: readonly unknown[] = [];
  try {
    boundedRawMatches = Array.isArray(rawMatches) ? rawMatches.slice(0, MAX_WHY_EVIDENCE_INPUTS) : [];
  } catch {
    boundedRawMatches = [];
  }
  const candidates = boundedRawMatches
    .map((value) => safeTripleRecord(value))
    .filter((value): value is TripleRecord => value !== undefined);
  const selected = selectWhyCandidates(candidates, path, limit);
  const coverage = coverageForTriples(candidates);
  const incomplete = !coverage.complete || selected.possible.length > 0 || selected.ambiguousSuffix;
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
    const candidates = (Array.isArray(raw.matches) ? raw.matches.slice(0, MAX_WHY_EVIDENCE_INPUTS) : [])
      .map((entry) => safeTripleRecord(entry))
      .filter((entry): entry is TripleRecord => entry !== undefined);
    const selected = selectWhyCandidates(candidates, path, limit);
    const derived = coverageForTriples(selected.matches);
    const possible = [
      ...selected.possible,
      ...(Array.isArray(raw.possible) ? raw.possible as WhyFileEvidence["possible"] : []),
    ].slice(0, limit);
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
    if (raw.coverageIncomplete === true) coverage = { ...coverage, status: "unknown", complete: false };
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
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && (MEMORY_OPERATIONAL_CODES as readonly string[]).includes(code);
}

function readMemory<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (hasOperationalCode(error)) throw new ToolExecutionError("memory_unavailable", "memory unavailable");
    throw error;
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
  return {
    list: () => definitions,
    async call(name, args, signal) {
      if (!definitions.some((definition) => definition.name === name)) throw new McpInvalidParamsError("unknown tool");
      try {
        switch (name) {
          case "recall": {
            const input = parseRecallArgs(args, options.exposure);
            return cappedResult(projectRecallHits(readMemory(() => options.memory.recall(input)), options.exposure));
          }
          case "recent_failures": {
            const input = parseRecentArgs(args, options.exposure);
            return cappedResult(projectRecentFailures(readMemory(() => options.memory.recentFailures(input)), options.exposure));
          }
          case "stats": {
            const input = parseStatsArgs(args, options.exposure);
            const stats = readMemory(() => options.memory.stats(input));
            return cappedResult({
              exposure: options.exposure,
              ...stats,
              confirmedFixes: stats.confirmedFixes ?? stats.fixEvents,
              possibleFixes: stats.possibleFixes ?? 0,
              triples: stats.triples ?? 0,
              notes: stats.notes ?? 0,
              total: stats.total ?? stats.failures + stats.fixEvents + (stats.possibleFixes ?? 0) +
                (stats.triples ?? 0) + (stats.notes ?? 0),
            });
          }
          case "search_knowledge": {
            const input = parseKnowledgeArgs(args);
            const hits = readMemory(() => options.memory.searchKnowledge(input));
            return cappedResult(projectKnowledgeHits(hits, options.exposure));
          }
          case "fetch_record": {
            const id = parseFetchArgs(args);
            const record = readMemory(() => options.memory.fetchRecord(id));
            if (record === undefined || record.kind === "note") return notFoundResult();
            const projected = projectMemoryRecord(record, options.exposure);
            if (projected === undefined) return notFoundResult();
            return boundedSingleResult(
              { exposure: options.exposure, record: projected, truncated: false },
              { exposure: options.exposure, record: null, truncated: true },
            );
          }
          case "why_file": {
            const input = parseWhyFileArgs(args);
            let fallback: WhyFileEvidence | undefined;
            const getFallback = (): WhyFileEvidence => fallback ??= fallbackWhyEvidence(options, input.path, input.limit);
            const customEvidence = options.memory.whyFileEvidence;
            const rawEvidence = readMemory(() => customEvidence
              ? customEvidence(input.path, input.limit)
              : getFallback());
            const evidence = customEvidence === undefined
              ? rawEvidence
              : normalizeWhyEvidence(rawEvidence, getFallback(), input.path, input.limit);
            const possible = projectWhyPossible(evidence.possible, input.limit, options.exposure);
            return cappedResult({
              exposure: options.exposure,
              items: evidence.matches.map((triple) => projectTriple(triple, options.exposure)),
              possible,
              coverage: evidence.coverage,
              coverageStatus: evidence.coverage.status,
              coverageIncomplete: evidence.coverageIncomplete,
              truncated: false,
            });
          }
          case "recall_with_ai": {
            const input = parseRecallArgs(args, options.exposure, 10);
            const hits = readMemory(() => options.memory.recall(input));
            const projected = projectRecallHits(hits, options.exposure);
            const ai = await runAi(() => options.recallWithAi.run(
              { query: input.query, hits: hits.slice(0, 5), exposure: options.exposure }, signal,
            ));
            const aiCandidateIds = hits.slice(0, 5).map((_, index) => `c${index + 1}`);
            return cappedResult(mergeAi(projected, ai, aiCandidateIds));
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
