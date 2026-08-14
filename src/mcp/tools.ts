import { Buffer } from "node:buffer";
import type { Exposure } from "../core/config-read.js";
import type { KnowledgeSearchQuery, MemoryQueries, RecallQuery, RecentFailuresQuery, StatsQuery } from "../core/memory-query.js";
import type { RecallAiOutcome, RecallWithAiPort } from "../ai/port.js";
import {
  MAX_RESPONSE_BYTES,
  projectKnowledgeHits,
  projectMemoryRecord,
  projectRecallHits,
  projectRecentFailures,
  projectTriple,
} from "./privacy.js";

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
      description: "Recent remembered reasons agents changed one file, newest first. Example: {\"path\": \"src/app.css\"}. Reasons are hearsay Rocky heard, not verified facts.",
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
  const text = JSON.stringify(payload);
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
  if (Array.isArray(source.items)) copy.items = [...source.items];
  while (true) {
    const output = buildResult(copy, isError);
    if (Buffer.byteLength(JSON.stringify(output), "utf8") <= RESPONSE_CAP_BYTES) return output;
    const items = copy.items;
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error("response too large");
    }
    const removed = items.pop();
    if (isItem(removed)) pruneRefs(copy, removed.candidateId);
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
            const triples = readMemory(() => options.memory.whyFile(input.path, input.limit));
            return cappedResult({
              exposure: options.exposure,
              items: triples.map((triple) => projectTriple(triple, options.exposure)),
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
