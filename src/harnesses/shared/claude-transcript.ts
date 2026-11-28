import type { CanonicalRationaleEvent } from "../../agent/logs/types.js";
import { asFields, field } from "./field-extract.js";
import { resultText } from "./tool-outcome.js";

export function transcriptOutput(content: unknown): string | undefined {
  if (!Array.isArray(content)) return resultText(content);
  const text = content.flatMap((value) => {
    const part = asFields(value);
    const text = field(part, "type") === "text" ? resultText(field(part, "text")) : undefined;
    return text === undefined ? [] : [text];
  });
  return text.length ? text.join("\n") : undefined;
}

/** Tool names whose `input.file_path` counts as a structural file touch. */
const FILE_TOOL_NAMES: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit"]);

/**
 * Files touched by Edit/Write/MultiEdit tool_use entries in one turn's
 * content array, for structural correlation downstream. Returns undefined
 * (not empty) when the turn touched no files, matching the canonical
 * event's optional field.
 */
function touchedFilesIn(content: readonly Record<string, unknown>[]): string[] | undefined {
  const files: string[] = [];
  for (const entry of content) {
    if (entry.type !== "tool_use") continue;
    if (typeof entry.name !== "string" || !FILE_TOOL_NAMES.has(entry.name)) continue;
    const filePath = field(asFields(entry.input), "file_path");
    if (typeof filePath === "string" && filePath.length > 0) files.push(filePath);
  }
  return files.length > 0 ? files : undefined;
}

export function claudeTranscriptRationales(
  obj: Record<string, unknown>, logPath: string, cwd?: string,
): CanonicalRationaleEvent[] {
  if (obj.type !== "assistant") return [];
  const parts = field(asFields(obj.message), "content");
  if (!Array.isArray(parts)) return [];
  const content = parts.map(asFields).filter((entry) => entry !== undefined);
  const hasThinking = content.some((entry) =>
    entry.type === "thinking" && typeof entry.thinking === "string" && entry.thinking.length > 0);
  const parsedTs = typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : Number.NaN;
  const touchedFiles = touchedFilesIn(content);
  const common = {
    agent: "claude-code" as const,
    sessionId: typeof obj.sessionId === "string" ? obj.sessionId : "",
    turnRef: typeof obj.uuid === "string" ? obj.uuid : "",
    ts: Number.isNaN(parsedTs) ? 0 : parsedTs,
    cwd,
    logPath,
    ...(touchedFiles === undefined ? {} : { touchedFiles }),
  };
  const events: CanonicalRationaleEvent[] = [];
  for (const entry of content) {
    if (entry.type === "thinking" && typeof entry.thinking === "string" && entry.thinking.length > 0) {
      events.push({ ...common, text: entry.thinking, fidelity: "raw", source: "log-thinking" });
    } else if (!hasThinking && entry.type === "text" && typeof entry.text === "string" && entry.text.length > 0) {
      events.push({ ...common, text: entry.text, fidelity: "summary", source: "log-response" });
    }
  }
  return events;
}
