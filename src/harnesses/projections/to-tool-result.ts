import { isAbsolute } from "node:path";
import { isSafeSessionId } from "../../core/agent-session.js";
import type { AgentStamp } from "../../core/memory-read.js";
import type { ToolResultEvent } from "../../core/tool-result.js";
import type { DecodedHookInput, HarnessDecoder } from "../types.js";

export function projectToToolResult(decoded: DecodedHookInput): ToolResultEvent | undefined {
  if (decoded.eventName !== "PostToolUse" && decoded.eventName !== "PostToolUseFailure") return undefined;
  if (decoded.shellTool !== true) return undefined;
  const vendor = decoded.harnessId;
  if (vendor !== "claude-code" && vendor !== "codex") return undefined;

  const outcome = decoded.outcome;
  const session = decoded.sessionId;
  if (!outcome || !isSafeSessionId(session)) return undefined;
  const { command: cmd, cwd, exitCode, exitCodeSource, toolUseId, agentId } = outcome;
  if (!cmd || !cwd || !isAbsolute(cwd) || /\p{Cc}/u.test(cwd)) return undefined;

  const reason = outcome.skipReason
    ?? (outcome.interrupted ? "interrupt" : undefined)
    ?? (outcome.background ? "background" : undefined);
  if (reason) return { kind: "skip", reason };
  if (exitCodeSource === "unknown" || exitCode === undefined) return { kind: "skip", reason: "no-exit-header" };

  const agent: AgentStamp = { vendor, session };
  if (isSafeSessionId(agentId)) agent.agentId = agentId;
  if (isSafeSessionId(toolUseId)) agent.toolUseId = toolUseId;
  return exitCode === 0
    ? { kind: "pass", cmd, cwd, agent }
    : { kind: "failure", cmd, cwd, exitCode, body: outcome.output ?? "", agent };
}

export function capSyncResponse(response: string): string {
  return Buffer.byteLength(response, "utf8") < 2 * 1024 ? response : "{}";
}

export function renderSyncResponse(decoder: HarnessDecoder, noteText: string): string {
  return capSyncResponse(decoder.renderSyncResponse?.(noteText) ?? "{}");
}
