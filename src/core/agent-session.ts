import type { AgentStamp } from "./memory-read.js";

export const AGENT_SESSION_ENV = "ROCKY_AGENT_SESSION";

const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function isSafeSessionId(value: unknown): value is string {
  return typeof value === "string" && SAFE_SESSION_ID.test(value);
}

export function agentStampFromEnv(env: NodeJS.ProcessEnv): AgentStamp | undefined {
  const session = env[AGENT_SESSION_ENV];
  if (!isSafeSessionId(session)) return undefined;
  return { vendor: "claude-code", session };
}
