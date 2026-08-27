import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveRockyPaths } from "../core/state-paths.js";

export const PENDING_EXPLAIN_WINDOW_MS = 15 * 60 * 1000;
export const MAX_PENDING_EXPLAIN = 16;

export interface PendingSnippet { path: string; snippet: string; ts: number }

interface PendingExplainEntry { snippet: string; ts: number }

/** Isolated derived-state file in the same directory as state.json; sole owner. */
function pendingExplainPath(): string {
  return join(dirname(resolveRockyPaths().state), "pending-explain.json");
}

function readPendingExplainMap(path = pendingExplainPath()): Record<string, PendingExplainEntry> {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    const map: Record<string, PendingExplainEntry> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (Object.keys(map).length >= MAX_PENDING_EXPLAIN) break;
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
      const entry = value as Record<string, unknown>;
      if (typeof entry.snippet !== "string" || entry.snippet.length === 0) continue;
      if (typeof entry.ts !== "number" || !Number.isSafeInteger(entry.ts) || entry.ts < 0) continue;
      map[key] = { snippet: entry.snippet, ts: entry.ts };
    }
    return map;
  } catch {
    return {};
  }
}

function writePendingExplainMap(map: Record<string, PendingExplainEntry>, path = pendingExplainPath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(map)}\n`, "utf8");
  } catch {
    // Derived state; fail open.
  }
}

export function spoolPendingSnippet(path: string, snippet: string, now?: number): void {
  try {
    if (typeof path !== "string" || path.length === 0 || typeof snippet !== "string" || snippet.length === 0) return;
    const ts = now ?? Date.now();
    const map = readPendingExplainMap();
    map[path] = { snippet, ts };
    const entries = Object.entries(map);
    if (entries.length > MAX_PENDING_EXPLAIN) {
      entries.sort((a, b) => a[1].ts - b[1].ts);
      const kept = entries.slice(entries.length - MAX_PENDING_EXPLAIN);
      const next: Record<string, PendingExplainEntry> = {};
      for (const [key, value] of kept) next[key] = value;
      writePendingExplainMap(next);
      return;
    }
    writePendingExplainMap(map);
  } catch {
    // Spooling is derived state; never throw.
  }
}

export function takePendingSnippet(path: string, now?: number): PendingSnippet | undefined {
  try {
    if (typeof path !== "string" || path.length === 0) return undefined;
    const ts = now ?? Date.now();
    const map = readPendingExplainMap();
    const entry = map[path];
    if (entry === undefined) return undefined;
    delete map[path];
    writePendingExplainMap(map);
    if (ts - entry.ts > PENDING_EXPLAIN_WINDOW_MS) return undefined;
    return { path, snippet: entry.snippet, ts: entry.ts };
  } catch {
    return undefined;
  }
}
