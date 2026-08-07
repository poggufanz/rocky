import { createOllamaClient } from "../ai/ollama.js";
import { createRecallAiPort, singleFlightRecallAi } from "../ai/recall-ai.js";
import { parseExposure } from "../core/config-read.js";
import { createMemoryQueries } from "../core/memory-query.js";
import { loadMemory } from "../core/memory-read.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../core/package-info.js";
import { runMcpStdio } from "../mcp/server.js";
import { createToolRegistry } from "../mcp/tools.js";

export const ROCKY_SERVER_INFO = {
  name: PACKAGE_NAME,
  version: PACKAGE_VERSION,
} as const;

export async function mcp(): Promise<number> {
  let exposure;
  try {
    exposure = parseExposure(process.env.ROCKY_MCP_EXPOSURE, "sanitized");
  } catch (error) {
    process.stderr.write(`[Rocky MCP] ${String(error)}\n`);
    return 1;
  }

  const recallWithAi = singleFlightRecallAi(createRecallAiPort({ ollama: createOllamaClient() }));
  const tools = createToolRegistry({
    exposure,
    memory: createMemoryQueries(loadMemory),
    recallWithAi,
  });
  await runMcpStdio(
    { input: process.stdin, output: process.stdout, diagnostics: process.stderr },
    { tools, serverInfo: ROCKY_SERVER_INFO },
  );
  return 0;
}
