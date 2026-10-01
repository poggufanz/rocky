import type { DiffRow } from "./compare-data.js";
import { enclosingFunction } from "./teach-ladder.js";

export type ContextWhy = "hunk" | "function" | "window";

export interface ContextSpan {
  start: number;
  end: number;
  why: ContextWhy;
}

export const CONTEXT_WINDOW_PAD = 3;

/**
 * Pure deterministic context resolver for GUI context-select.
 *
 * Precedence:
 * 1. Hunk: if diff rows are provided, the first hunk whose new range
 *    [n, n + len - 1] contains line wins.
 * 2. Function: enclosingFunction (brace balance, clamped) wrapping line.
 * 3. Window: fallback ±CONTEXT_WINDOW_PAD clamped to file boundaries.
 */
export function resolveContext(args: {
  fileText: string;
  line: number;
  rows?: DiffRow[];
}): ContextSpan {
  const lines = args.fileText.length === 0 ? [] : args.fileText.split(/\r?\n/);
  const total = lines.length;
  if (total === 0) {
    return { start: 1, end: 1, why: "window" };
  }

  const rawLine = Number.isFinite(args.line) ? Math.floor(args.line) : 1;
  const line = Math.max(1, Math.min(total, rawLine));

  if (args.rows !== undefined) {
    for (const row of args.rows) {
      if (row.k !== "@") continue;
      const m = /@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(row.t);
      if (!m) continue;
      const n = Number(m[1]);
      const count = m[2] !== undefined ? Number(m[2]) : 1;
      const end = n + (count > 0 ? count - 1 : 0);
      if (line >= n && line <= end) {
        return { start: n, end, why: "hunk" };
      }
    }
  }

  const fn = enclosingFunction(lines, line);
  if (fn !== undefined) {
    return { start: fn.start, end: fn.end, why: "function" };
  }

  return {
    start: Math.max(1, line - CONTEXT_WINDOW_PAD),
    end: Math.min(total, line + CONTEXT_WINDOW_PAD),
    why: "window",
  };
}
