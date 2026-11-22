import { appendFileSync, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import { AGENT_SESSION_ENV, isSafeSessionId } from "../core/agent-session.js";

export const SESSION_START_STDIN_CAP_BYTES = 1024 * 1024;

const EMPTY_RESPONSE = "{}";
const CONTROL_CHAR = /[\x00-\x1f\x7f]/;

function isValidEnvFilePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !CONTROL_CHAR.test(value) && isAbsolute(value);
}

function needsLeadingNewline(filePath: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const { size } = fstatSync(fd);
    if (size === 0) return false;
    const lastByte = Buffer.allocUnsafe(1);
    const bytesRead = readSync(fd, lastByte, 0, 1, size - 1);
    return bytesRead === 1 && lastByte[0] !== 0x0a;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close errors; the hook remains fail-open.
      }
    }
  }
}

/**
 * Private Claude Code SessionStart hook handler.
 * Appends `export ROCKY_AGENT_SESSION='<id>'\n` to `$CLAUDE_ENV_FILE`,
 * always returns `"{}"`, and never throws.
 */
export function sessionStartHook(stdin: Uint8Array, env: NodeJS.ProcessEnv): string {
  try {
    if (stdin.byteLength > SESSION_START_STDIN_CAP_BYTES) return EMPTY_RESPONSE;
    const envFile = env.CLAUDE_ENV_FILE;
    if (!isValidEnvFilePath(envFile)) return EMPTY_RESPONSE;

    const text = Buffer.from(stdin.buffer, stdin.byteOffset, stdin.byteLength).toString("utf8");
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return EMPTY_RESPONSE;

    const payload = parsed as Record<string, unknown>;
    if (payload.hook_event_name !== "SessionStart") return EMPTY_RESPONSE;
    if (!isSafeSessionId(payload.session_id)) return EMPTY_RESPONSE;

    const prefix = needsLeadingNewline(envFile) ? "\n" : "";
    const line = `${prefix}export ${AGENT_SESSION_ENV}='${payload.session_id}'\n`;
    appendFileSync(envFile, line, { flag: "a", encoding: "utf8" });
  } catch {
    // Fail open: SessionStart must never block or fail the host.
  }
  return EMPTY_RESPONSE;
}
