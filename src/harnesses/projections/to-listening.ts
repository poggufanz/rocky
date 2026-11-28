import { randomUUID } from "node:crypto";
import { canonicalPath } from "../../core/memory-read.js";
import type { EventEnvelope } from "../../listening/types.js";
import type { DecodedHookInput } from "../types.js";

export interface ListeningProjectionContext {
  hostConsent: boolean;
  repoConsent?: boolean;
  surface: NonNullable<EventEnvelope["surface"]>;
  now?: number;
  eventId?: string;
}

export function projectToListening(decoded: DecodedHookInput, ctx: ListeningProjectionContext): EventEnvelope | undefined {
  if (ctx.hostConsent !== true) return undefined;
  const { nativeId, sessionId, episode, fileRel, summaryRef, repoRoot, ts } = decoded.listening;
  const root = ctx.repoConsent === true && repoRoot ? canonicalPath(repoRoot) : "";
  const rel = root && fileRel ? canonicalPath(fileRel) : "";
  const isRelative = rel.length > 0 && !rel.startsWith("..") && !rel.startsWith("/") && !/^[a-z]:/iu.test(rel);

  // Hook metadata alone does not witness a file version write. In particular,
  // PreToolUse target paths are intent and never enter this envelope.
  return {
    v: 1,
    eventId: ctx.eventId ?? randomUUID(),
    source: "hook",
    harnessId: decoded.harnessId,
    surface: ctx.surface,
    ts: ts ?? ctx.now ?? Date.now(),
    adapterVersion: "listening-hook-ingress/1",
    ...(nativeId !== undefined ? { nativeId } : {}),
    ...(sessionId !== undefined ? { node: "agent_session", nodeId: sessionId } : {}),
    ...(root ? { repoRoot: root } : {}),
    consent: { host: true, repo: root.length > 0, rawTrace: false },
    redaction: { applied: false, truncated: false },
    coverage: "partial",
    refs: {
      ...(sessionId !== undefined ? { session: sessionId } : {}),
      ...(episode !== undefined ? { episode } : {}),
      ...(isRelative ? { fileRel: rel.slice(0, 1024) } : {}),
      ...(summaryRef !== undefined ? { summaryRef } : {}),
    },
  };
}
