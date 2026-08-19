import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolveRockyPaths } from "./state-paths.js";

export const FALLBACK_WINDOW_MS = 86_400_000;

export interface RockyState {
  v: 1;
  lastBriefTs?: number;
  /** Per-path byte offsets for agent log adapters, capped at MAX_LOG_OFFSETS. */
  logOffsets?: Record<string, number>;
}

/** Stored log-offset entries are bounded; oldest insertion order drops first. */
export const MAX_LOG_OFFSETS = 200;

function parseLogOffsets(value: unknown): Record<string, number> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const offsets: Record<string, number> = {};
  for (const [key, offset] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(offsets).length >= MAX_LOG_OFFSETS) break;
    if (typeof offset === "number" && Number.isSafeInteger(offset) && offset >= 0) {
      offsets[key] = offset;
    }
  }
  return Object.keys(offsets).length > 0 ? offsets : undefined;
}

export function readState(path = resolveRockyPaths().state): RockyState {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof value === "object" && value !== null && (value as Record<string, unknown>).v === 1) {
      const record = value as Record<string, unknown>;
      const state: RockyState = { v: 1 };
      const lastBriefTs = record.lastBriefTs;
      if (typeof lastBriefTs === "number" && Number.isSafeInteger(lastBriefTs) && lastBriefTs >= 0) {
        state.lastBriefTs = lastBriefTs;
      }
      const logOffsets = parseLogOffsets(record.logOffsets);
      if (logOffsets !== undefined) state.logOffsets = logOffsets;
      return state;
    }
  } catch {
    // Missing or corrupt state never blocks a brief; fall back to fresh state.
  }
  return { v: 1 };
}

export function writeState(state: RockyState, path = resolveRockyPaths().state): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state)}\n`, "utf8");
}

export function parseSinceDuration(value: string): number | undefined {
  const match = /^(\d{1,4})([mhd])$/.exec(value);
  if (match === null) return undefined;
  const amount = Number(match[1]);
  if (amount === 0) return undefined;
  const unit = match[2];
  const msPerUnit = unit === "h" ? 3_600_000 : unit === "d" ? 86_400_000 : 60_000;
  return amount * msPerUnit;
}
