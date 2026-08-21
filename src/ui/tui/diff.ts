import type { DashRow, DashEvent } from "./state.js";

export interface DiffLoaderOptions {
  resolve: (query: { ts: number }) => string[];
  debounceMs?: number;
  cacheSize?: number;
}

export function createDiffLoader(options: DiffLoaderOptions): {
  select(row: DashRow | undefined, nowMs: number): void;
  due(nowMs: number): DashEvent | undefined;
} {
  const debounceMs = options.debounceMs ?? 150;
  const cacheSize = options.cacheSize ?? 16;
  const cache = new Map<string, string[]>();

  let pending:
    | {
        row: DashRow;
        at: number;
        announced: boolean;
      }
    | undefined;

  function select(row: DashRow | undefined, nowMs: number): void {
    if (row === undefined) {
      pending = undefined;
      return;
    }
    pending = {
      row,
      at: nowMs,
      announced: false,
    };
  }

  function due(nowMs: number): DashEvent | undefined {
    if (pending === undefined) {
      return undefined;
    }

    const { row, at, announced } = pending;

    if (cache.has(row.id)) {
      const lines = cache.get(row.id)!;
      cache.delete(row.id);
      cache.set(row.id, lines);
      pending = undefined;
      return {
        type: "diff-ready",
        rowId: row.id,
        lines,
      };
    }

    if (nowMs - at < debounceMs) {
      return undefined;
    }

    if (!announced) {
      pending.announced = true;
      return {
        type: "diff-loading",
        rowId: row.id,
      };
    }

    const lines = options.resolve({ ts: row.ts });
    if (cache.has(row.id)) {
      cache.delete(row.id);
    }
    cache.set(row.id, lines);
    if (cache.size > cacheSize) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey !== undefined) {
        cache.delete(oldestKey);
      }
    }

    pending = undefined;
    return {
      type: "diff-ready",
      rowId: row.id,
      lines,
    };
  }

  return {
    select,
    due,
  };
}
