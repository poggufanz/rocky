import type { ListeningHookFields } from "../types.js";

export type Fields = Record<string, unknown>;

const MAX_TRANSCRIPT_LINE_LENGTH = 2 * 1024 * 1024;
export const MAX_PENDING_TOOLS = 1024;

export function asFields(value: unknown): Fields | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as Fields : undefined;
}

export function parseFields(line: string): Fields | undefined {
  if (line.length > MAX_TRANSCRIPT_LINE_LENGTH) return undefined;
  try {
    return asFields(JSON.parse(line));
  } catch {
    return undefined;
  }
}

export function field(raw: Fields | undefined, key: string): unknown {
  return raw === undefined ? undefined : Object.getOwnPropertyDescriptor(raw, key)?.value;
}

export function textField(raw: Fields | undefined, maxLength: number, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = field(raw, key);
    if (typeof value === "string" && value.length <= maxLength && value.trim().length > 0) return value;
  }
  return undefined;
}

export function readListeningFields(raw: Fields, sessionId?: string): ListeningHookFields {
  const bounded = (key: string, limit = 256): string | undefined => {
    const value = field(raw, key);
    return typeof value === "string" && value.length > 0 ? value.slice(0, limit) : undefined;
  };
  const ts = field(raw, "ts");
  return {
    nativeId: bounded("nativeId"),
    sessionId: bounded("sessionId") ?? sessionId?.slice(0, 256),
    toolName: bounded("toolName") ?? bounded("tool_name") ?? bounded("tool"),
    episode: bounded("episode"),
    fileRel: bounded("fileRel", 4096),
    summaryRef: bounded("summaryRef"),
    repoRoot: bounded("repoRoot", 4096),
    ts: typeof ts === "number" && Number.isSafeInteger(ts) && ts > 0 ? ts : undefined,
  };
}

export function transcriptTimestamp(value: unknown): number {
  const ts = typeof value === "string" ? Date.parse(value) : value;
  return typeof ts === "number" && Number.isFinite(ts) ? ts : 0;
}

export function rememberPending<T>(pending: Map<string, T>, key: string, item: T): void {
  if (!pending.has(key) && pending.size >= MAX_PENDING_TOOLS) {
    const oldest = pending.keys().next();
    if (!oldest.done) pending.delete(oldest.value);
  }
  pending.set(key, item);
}
