/**
 * Listening event-line codec (spec §7). Pure: zero node:fs imports.
 * Shared by the write side (event-log.ts) and the MCP-safe read side
 * (event-log-read.ts) so readers never transitively import a writer.
 */
import type { EventEnvelope } from "./types.js";
import { isHarnessId, isV1LinkBasis, isV1NodeKind } from "./types.js";

/** Parse one durable line; unknown fields survive, forbidden bases drop. */
export function parseListeningEventLine(line: string): EventEnvelope | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const candidate = parsed as Record<string, unknown>;
  if (candidate["v"] !== 1 || typeof candidate["eventId"] !== "string") return undefined;
  const edge = candidate["edge"] as { basis?: unknown } | undefined;
  if (edge !== undefined && edge !== null && typeof edge === "object") {
    if (!isV1LinkBasis(edge.basis)) return undefined;
  }
  const node = candidate["node"] as unknown;
  if (node !== undefined && !isV1NodeKind(node)) return undefined;
  if (candidate["harnessId"] !== undefined && !isHarnessId(candidate["harnessId"])) return undefined;
  return candidate as unknown as EventEnvelope;
}
