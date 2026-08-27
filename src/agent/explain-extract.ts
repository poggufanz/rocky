// src/agent/explain-extract.ts
/**
 * Extract the written hunk from a Claude Code file-tool payload.
 * Write -> content, Edit -> new_string, MultiEdit -> edits[].new_string
 * joined. This is the "MultiEdit edits[] extractor" the teach spec names
 * as prerequisite: the transcript adapter only reads file_path
 * (src/agent/logs/claude-code.ts touchedFilesIn) and drops edits[].
 */
export const MAX_EXPLAIN_SNIPPET_BYTES = 2048;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateBytes(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_EXPLAIN_SNIPPET_BYTES) return text;
  const buf = Buffer.from(text, "utf8").subarray(0, MAX_EXPLAIN_SNIPPET_BYTES);
  return buf.toString("utf8").replace(/\uFFFD+$/u, "");
}

export function snippetFromToolInput(toolName: string, toolInput: unknown): string | undefined {
  if (!isRecord(toolInput)) return undefined;
  if (toolName === "Write") {
    return typeof toolInput.content === "string" && toolInput.content.length > 0
      ? truncateBytes(toolInput.content) : undefined;
  }
  if (toolName === "Edit") {
    return typeof toolInput.new_string === "string" && toolInput.new_string.length > 0
      ? truncateBytes(toolInput.new_string) : undefined;
  }
  if (toolName === "MultiEdit") {
    if (!Array.isArray(toolInput.edits)) return undefined;
    const parts: string[] = [];
    for (const edit of toolInput.edits) {
      if (isRecord(edit) && typeof edit.new_string === "string" && edit.new_string.length > 0) {
        parts.push(edit.new_string);
      }
    }
    return parts.length > 0 ? truncateBytes(parts.join("\n")) : undefined;
  }
  return undefined;
}
