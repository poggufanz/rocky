import { existsSync } from "node:fs";
import { resolveRockyPaths } from "../core/state-paths.js";
import { parseToolResultPayload, TOOL_RESULT_STDIN_CAP_BYTES } from "../core/tool-result.js";

export { TOOL_RESULT_STDIN_CAP_BYTES };

export const TOOL_RESULT_LOCK_WAIT_MS = 1_000;

const EMPTY_RESPONSE: "{}" = "{}";

/**
 * Private Claude Code PostToolUse / PostToolUseFailure hook handler.
 * Records unwrapped Bash/PowerShell failures as agent-origin failures and links
 * fixes on pass when a pending marker exists. Always returns `"{}"` and never throws.
 */
export async function toolResultHook(stdin: Uint8Array): Promise<"{}"> {
  try {
    const event = parseToolResultPayload(stdin);
    if (event === undefined || event.kind === "skip") return EMPTY_RESPONSE;

    if (event.kind === "pass") {
      if (!existsSync(resolveRockyPaths().pending)) return EMPTY_RESPONSE;
      const { resolveFixOnSuccess } = await import("../core/memory.js");
      resolveFixOnSuccess(event.cmd, event.cwd, {
        agent: event.agent,
        lockWaitMs: TOOL_RESULT_LOCK_WAIT_MS,
      });
      return EMPTY_RESPONSE;
    }

    const { recordAgentFailure } = await import("../core/memory.js");
    recordAgentFailure(
      {
        cmd: event.cmd,
        exitCode: event.exitCode,
        body: event.body,
        cwd: event.cwd,
        agent: event.agent,
      },
      { lockWaitMs: TOOL_RESULT_LOCK_WAIT_MS },
    );
  } catch {
    // Fail open: the tool-result hook must never block or fail the host.
  }
  return EMPTY_RESPONSE;
}
