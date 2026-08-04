import { Buffer } from "node:buffer";
import type { Exposure } from "../core/config.js";
import type { MemoryQueries, RecallQuery, RecentFailuresQuery, StatsQuery } from "../core/memory-query.js";
import type { RecallAiOutcome, RecallWithAiPort } from "../ai/port.js";
import { MAX_RESPONSE_BYTES, projectRecallHits, projectRecentFailures } from "./privacy.js";

export interface McpToolDefinition {
  name: "recall" | "recent_failures" | "stats" | "recall_with_ai";
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
      name: "stats", title: "Memory statistics", description: "Read remembered failure statistics.",
      inputSchema: schema(withCwd(exposure, {})), annotations: ANNOTATIONS,
    },
    {
      name: "recall_with_ai", title: "Recall with AI", description: "Search remembered failures with optional AI ranking.",
      inputSchema: schema(withCwd(exposure, {
        query: { type: "string", minLength: 1, maxLength: 500 },
        limit: { type: "integer", minimum: 1, maximum: 10 },
      }), ["query"]), annotations: ANNOTATIONS,
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

function mergeAi(payload: object, ai: RecallAiOutcome): Record<string, unknown> {
  const source = payload as Record<string, unknown>;
  const itemIds = Array.isArray(source.items) ? source.items.filter(isItem).map((item) => item.candidateId) : [];
  const ranked = [...ai.rankedCandidateIds.filter((id) => itemIds.includes(id))];
  for (const id of itemIds) if (!ranked.includes(id)) ranked.push(id);
  const evidenceRefs = ai.evidenceRefs?.filter((ref) => itemIds.includes(candidateIdForRef(ref) ?? ""));
  return { ...source, ...ai, rankedCandidateIds: ranked, ...(evidenceRefs === undefined ? {} : { evidenceRefs }) };
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
            return cappedResult({ exposure: options.exposure, ...readMemory(() => options.memory.stats(input)) });
          }
          case "recall_with_ai": {
            const input = parseRecallArgs(args, options.exposure, 10);
            const hits = readMemory(() => options.memory.recall(input));
            const projected = projectRecallHits(hits, options.exposure);
            const ai = await runAi(() => options.recallWithAi.run(
              { query: input.query, hits: hits.slice(0, 5), exposure: options.exposure }, signal,
            ));
            return cappedResult(mergeAi(projected, ai));
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
