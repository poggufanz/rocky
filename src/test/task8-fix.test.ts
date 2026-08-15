import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { disabledRecallWithAi } from "../ai/port.js";
import {
  MCP_TOOL_CATALOG,
  MCP_TOOL_CATALOG_VERSION,
  createToolRegistry,
} from "../mcp/tools.js";
import { MODERN_PROTOCOL_VERSION } from "../mcp/protocol.js";
import type { MemoryQueries } from "../core/memory-query.js";
import type { McpRegistration } from "../setup/clients.js";
import { checkMcpRegistration } from "../setup/health.js";
import { processRunner, type ProcessResult, type ProcessRunner, type ProcessSession } from "../setup/process.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const expectedCatalog = [
  "recall",
  "recent_failures",
  "stats",
  "recall_with_ai",
  "search_knowledge",
  "fetch_record",
  "why_file",
] as const;

class ModernHealthSession implements ProcessSession {
  private readonly lines: string[] = [];

  constructor(private readonly tools: readonly string[]) {}

  async writeLine(line: string): Promise<void> {
    const message = JSON.parse(line) as { id?: string | number; method: string };
    if (message.method === "server/discover") {
      this.lines.push(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          supportedVersions: [MODERN_PROTOCOL_VERSION],
          capabilities: { tools: { listChanged: false } },
        },
      }));
      return;
    }
    if (message.method === "tools/list") {
      this.lines.push(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: { tools: this.tools.map((name) => ({ name })) },
      }));
      return;
    }
    throw new Error(`unexpected health method: ${message.method}`);
  }

  async readLine(): Promise<string | undefined> {
    return this.lines.shift();
  }

  end(): void {
  }

  kill(): void {
  }

  async wait(): Promise<ProcessResult> {
    return { status: 0, stdout: "", stderr: "" };
  }
}

function fakeModernRunner(tools: readonly string[]): ProcessRunner & { session: ModernHealthSession } {
  const session = new ModernHealthSession(tools);
  return {
    session,
    async run() {
      throw new Error("batch runner must not be used for protocol health");
    },
    async openSession() {
      return session;
    },
  };
}

const registration: McpRegistration = {
  name: "rocky",
  command: process.execPath,
  args: [join(packageRoot, "dist", "index.js"), "mcp"],
  env: { ROCKY_MCP_EXPOSURE: "sanitized" },
};

test("MCP catalog exports one versioned seven-tool source and registry order follows it", () => {
  // These exports intentionally do not come from setup: health consumes the
  // read-only MCP catalog without importing any setup writer.
  assert.equal(MCP_TOOL_CATALOG_VERSION, 1);
  assert.deepEqual([...MCP_TOOL_CATALOG], expectedCatalog);
  const registry = createToolRegistry({
    exposure: "sanitized",
    memory: {} as MemoryQueries,
    recallWithAi: disabledRecallWithAi,
  });
  assert.deepEqual(registry.list().map((definition) => definition.name), expectedCatalog);
});

test("health rejects legacy four-tool servers and accepts exact seven plus foreign extras", async () => {
  const old = fakeModernRunner(expectedCatalog.slice(0, 4));
  const oldResult = await checkMcpRegistration(registration, old, 250);
  assert.equal(oldResult.healthy, false);
  assert.match(oldResult.detail, /incomplete|upgrade/i);

  const modern = fakeModernRunner([...expectedCatalog, "foreign_tool"]);
  const modernResult = await checkMcpRegistration(registration, modern, 250);
  assert.equal(modernResult.healthy, true);
  assert.equal(modernResult.era, "modern");
});

test("setup status contract names host/MCP registration and agent-hook scope, not spool or model health", () => {
  const indexSource = readFileSync(join(packageRoot, "src", "index.ts"), "utf8");
  const setupSource = readFileSync(join(packageRoot, "src", "commands", "setup.ts"), "utf8");
  const readme = readFileSync(join(packageRoot, "README.md"), "utf8");
  const design = readFileSync(join(packageRoot, "..", "docs", "superpowers", "specs", "2026-08-09-v050-nervous-system-dictionary-design.md"), "utf8");
  const scope = /host\/MCP registration via rocky setup --check\s+and\s+agent-hook state\/capability/u;
  for (const [label, value] of [["help source", indexSource], ["setup output", setupSource], ["README", readme], ["design", design]] as const) {
    assert.match(value, scope, `${label} must state the same setup status scope`);
    assert.match(value, /spool and Ollama\/model health\s+are not\s+checked/iu, `${label} must disclose excluded health`);
  }
  const help = spawnSync(process.execPath, [join(packageRoot, "dist", "index.js"), "--help"], {
    cwd: packageRoot,
    encoding: "utf8",
    env: { ...process.env, NODE_TEST_CONTEXT: undefined },
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(`${help.stdout}${help.stderr}`, scope);
  assert.match(`${help.stdout}${help.stderr}`, /spool and Ollama\/model health\s+are not\s+checked/iu);
});

test("isolated real Rocky MCP child process passes versioned seven-tool health", { timeout: 10_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rocky-task8-mcp-health-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = await checkMcpRegistration({
    ...registration,
    env: { ...registration.env, ROCKY_HOME: join(root, ".rocky") },
  }, {
    ...processRunner,
    async openSession(command, args, options) {
      assert.equal(command, process.execPath);
      assert.deepEqual(args, registration.args);
      return processRunner.openSession!(command, args, options);
    },
  }, 3_000);
  assert.equal(result.healthy, true, result.detail);
  assert.equal(result.era, "modern");
});
