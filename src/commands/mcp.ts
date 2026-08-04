import { disabledRecallWithAi } from "../ai/port.js";
import { parseExposure } from "../core/config.js";
import { createMemoryQueries } from "../core/memory-query.js";
import { loadMemory } from "../core/memory-read.js";
import { runMcpStdio } from "../mcp/server.js";
import { createToolRegistry } from "../mcp/tools.js";

export const ROCKY_SERVER_INFO = {
  name: "@poggufanz/rocky-cli",
  version: "0.2.1-beta.0",
} as const;

export async function mcp(): Promise<number> {
  let exposure;
  try {
    exposure = parseExposure(process.env.ROCKY_MCP_EXPOSURE, "sanitized");
  } catch (error) {
    process.stderr.write(`[Rocky MCP] ${String(error)}\n`);
    return 1;
  }

  const tools = createToolRegistry({
    exposure,
    memory: createMemoryQueries(loadMemory),
    recallWithAi: disabledRecallWithAi,
  });
  await runMcpStdio(
    { input: process.stdin, output: process.stdout, diagnostics: process.stderr },
    { tools, serverInfo: ROCKY_SERVER_INFO },
  );
  return 0;
}
