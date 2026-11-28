import { sameCwd, type MemoryRecord, type RationaleLinks } from "../core/memory-read.js";

/** Maximum distance between an event and its same-directory evidence. */
export const WEAK_LINK_WINDOW_MS = 10 * 60 * 1000;

/**
 * Nearest failure/fix in `cwd`, within `WEAK_LINK_WINDOW_MS` of `ts`, using
 * only evidence at or before `now`. Exported so the notify lane
 * reuses this exact window rule instead of re-deriving it.
 */
export function weakLinkFor(
  records: readonly MemoryRecord[],
  ts: number,
  cwd: string,
  now: number = Date.now(),
): RationaleLinks | undefined {
  let best: { link: RationaleLinks; distance: number } | undefined;
  for (const record of records) {
    if (record.kind !== "failure" && record.kind !== "fix") continue;
    if (!sameCwd(record.cwd, cwd, process.platform) || record.ts > now) continue;
    const distance = Math.abs(record.ts - ts);
    if (distance > WEAK_LINK_WINDOW_MS) continue;
    if (best === undefined || distance < best.distance) {
      best = { link: record.kind === "failure" ? { failureId: record.id } : { fixId: record.id }, distance };
    }
  }
  return best?.link;
}
