import { basename, dirname } from "node:path";
import type { CanonicalRationaleEvent } from "../../agent/logs/types.js";
import { asFields, parseFields, textField, type Fields } from "../shared/field-extract.js";
import type { HarnessDecoder, TranscriptContext, TranscriptEvent, TranscriptReducer } from "../types.js";

/**
 * A first line is a SessionHeader only when it looks like one: it carries
 * `session`/`header`/`version` fields, or neither `type` nor `seq`. Anything
 * else is a real event and must not be swallowed by header handling.
 */
function looksLikeDshHeader(obj: Record<string, unknown>): boolean {
  if ("session" in obj || "header" in obj || "version" in obj) return true;
  return obj.type === undefined && obj.seq === undefined;
}

function dshRationaleEvent(
  obj: Record<string, unknown>, seq: number, sessionId: string, logPath: string,
): CanonicalRationaleEvent | undefined {
  const data = asFields(obj.data);
  const text = data && typeof data.text === "string" && data.text.length > 0 ? data.text
    : data && typeof data.reasoning === "string" ? data.reasoning
    : undefined;
  const isReasoning = obj.type === "reasoning" || (data !== undefined && typeof data.reasoning === "string");
  if (!isReasoning || text === undefined || text.length === 0) return undefined;
  return {
    agent: "dsh",
    sessionId,
    turnRef: String(seq),
    ts: typeof obj.time === "number" && Number.isFinite(obj.time) ? obj.time : 0,
    text,
    fidelity: "raw",
    source: "log-thinking",
    logPath,
  };
}

export function createDshTranscriptReducer(
  ctx: TranscriptContext = {},
  readHeaderSession = (row: Fields) => textField(row, 256, "session"),
): TranscriptReducer & {
  consumeRecord(value: unknown, afterSeq?: number): { events: TranscriptEvent[]; seq?: number };
} {
  const logPath = ctx.logPath ?? "";
  let sessionId = ctx.sessionId ?? (logPath ? basename(dirname(logPath)) : "");
  let firstLine = true;
  function consumeRecord(value: unknown, afterSeq = -Infinity): { events: TranscriptEvent[]; seq?: number } {
    const row = asFields(value);
    const header = firstLine && row !== undefined && looksLikeDshHeader(row);
    firstLine = false;
    if (header) {
      sessionId = readHeaderSession(row) ?? sessionId;
      return { events: [] };
    }
    const seq = row?.seq;
    if (row === undefined || typeof seq !== "number" || !Number.isFinite(seq)) return { events: [] };
    const event = seq > afterSeq ? dshRationaleEvent(row, seq, sessionId, logPath) : undefined;
    return { seq, events: event ? [{ kind: "rationale", ...event }] : [] };
  }
  return {
    consume(line) {
      const row = parseFields(line);
      return row === undefined ? [] : consumeRecord(row).events;
    },
    consumeRecord,
    finish() { return []; },
  };
}

export const dshDecoder: HarnessDecoder = {
  id: "dsh",
  decodeHook: () => undefined,
  createTranscriptReducer: createDshTranscriptReducer,
};
