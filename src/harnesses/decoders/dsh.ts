import { basename, dirname } from "node:path";
import { dshRationaleEvent, looksLikeDshHeader } from "../../agent/logs/dsh.js";
import { parseFields, textField } from "../shared/field-extract.js";
import type { HarnessDecoder, TranscriptContext, TranscriptReducer } from "../types.js";

function createTranscriptReducer(ctx: TranscriptContext = {}): TranscriptReducer {
  const logPath = ctx.logPath ?? "";
  let sessionId = ctx.sessionId ?? (logPath ? basename(dirname(logPath)) : "");
  let firstLine = true;
  return {
    consume(line) {
      const row = parseFields(line);
      if (!row) return [];
      const header = firstLine && looksLikeDshHeader(row);
      firstLine = false;
      if (header) {
        sessionId = textField(row, 256, "session") ?? sessionId;
        return [];
      }
      const event = dshRationaleEvent(row, sessionId, logPath);
      return event ? [{ kind: "rationale", ...event }] : [];
    },
    finish() { return []; },
  };
}

export const dshDecoder: HarnessDecoder = {
  id: "dsh",
  decodeHook: () => undefined,
  createTranscriptReducer,
};
