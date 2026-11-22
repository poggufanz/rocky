import { createHash } from "node:crypto";
import type { AgentStamp } from "./memory-read.js";

export const AGENT_SESSION_ENV = "ROCKY_AGENT_SESSION";

const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** Session ids longer than this get hashed instead of used verbatim as a filename. */
const MAX_RAW_SESSION_ID_LEN = 64;

export function isSafeSessionId(value: unknown): value is string {
  return typeof value === "string" && SAFE_SESSION_ID.test(value);
}

/**
 * `session_id` arrives from untrusted vendor stdin or env and becomes a
 * filename inside `gate-state/`. Allowlist to `[a-zA-Z0-9_-]` so path
 * separators and `..` cannot escape `gate-state/`, and hash overly long ids
 * to bound filename length. Missing/empty/non-string ids return `undefined`
 * so callers stay silent or use an explicit no-session path.
 */
export function sanitizeSessionId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (raw.length === 0) return undefined;
  const sanitized = raw.replace(/[^a-zA-Z0-9_-]/gu, "_");
  if (sanitized.length <= MAX_RAW_SESSION_ID_LEN) return sanitized;
  return `sid-${createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 24)}`;
}

export function agentStampFromEnv(env: NodeJS.ProcessEnv): AgentStamp | undefined {
  const session = env[AGENT_SESSION_ENV];
  if (!isSafeSessionId(session)) return undefined;
  return { vendor: "claude-code", session };
}
