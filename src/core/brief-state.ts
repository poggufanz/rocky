import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolveRockyPaths } from "./state-paths.js";

export const FALLBACK_WINDOW_MS = 86_400_000;

export interface RockyState {
  v: 1;
  lastBriefTs?: number;
}

export function readState(path = resolveRockyPaths().state): RockyState {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof value === "object" && value !== null && (value as Record<string, unknown>).v === 1) {
      const lastBriefTs = (value as Record<string, unknown>).lastBriefTs;
      if (lastBriefTs === undefined) return { v: 1 };
      if (typeof lastBriefTs === "number" && Number.isSafeInteger(lastBriefTs) && lastBriefTs >= 0) {
        return { v: 1, lastBriefTs };
      }
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
