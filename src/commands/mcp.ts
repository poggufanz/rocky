import { createOllamaClient } from "../ai/ollama.js";
import { createRecallAiPort, singleFlightRecallAi } from "../ai/recall-ai.js";
import { parseExposure } from "../core/config-read.js";
import { createMemoryQueries } from "../core/memory-query.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../core/package-info.js";
import { safeTerminalBlock, safeTerminalLine } from "../core/terminal-sanitize.js";
import { runMcpStdio } from "../mcp/server.js";
import { createToolRegistry } from "../mcp/tools.js";
import { parseNoArgs, reportCliUsage } from "./cli-args.js";

export const ROCKY_SERVER_INFO = {
  name: PACKAGE_NAME,
  version: PACKAGE_VERSION,
} as const;

export async function mcp(argv: readonly string[] = []): Promise<number> {
  try {
    parseNoArgs(argv, "rocky mcp");
  } catch (error) {
    // MCP stdout is a protocol stream. Usage diagnostics stay on stderr and
    // must happen before the server is constructed or stdin is read.
    const writeStderr = (line: string): void => {
      process.stderr.write(`${safeTerminalLine(safeTerminalBlock(line))}\n`);
    };
    const code = reportCliUsage(error, writeStderr, writeStderr);
    if (code !== undefined) return code;
    throw error;
  }
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
    memory: createMemoryQueries(),
    recallWithAi,
  });
  await runMcpStdio(
    { input: process.stdin, output: process.stdout, diagnostics: process.stderr },
    { tools, serverInfo: ROCKY_SERVER_INFO },
  );
  return 0;
}
