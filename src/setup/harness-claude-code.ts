import { join } from "node:path";
import type {
  InspectionResult,
  McpRegistration,
  SetupClientAdapter,
  SetupResult,
} from "./clients.js";
import type { PlatformServices } from "./platform.js";
import type { ProcessRunner } from "./process.js";
import { readJsonObject } from "./json-config.js";
import { isIdenticalMcpRegistration, isOwnedRockyRegistration } from "./registration.js";
import {
  mergeRockyMcpServer,
  notFoundDetection,
  removeRockyMcpServer,
  resolveCanonicalExecutable,
  verifyMcpAfterWrite,
  writeMergedJsonConfig,
} from "./harness-mcp-shared.js";

export interface HarnessClaudeCodeDeps {
  runner: ProcessRunner;
  platform: PlatformServices;
  env?: NodeJS.ProcessEnv;
  home?: string;
  userConfigPath?: string;
  projectConfigPath?: string;
  scope?: "user" | "project";
}

const MISSING_DETAIL = "Claude Code CLI is not installed";
const VERSION_TIMEOUT_MS = 5_000;
const LIST_TIMEOUT_MS = 10_000;

export function toClaudeEntry(registration: McpRegistration): Record<string, unknown> {
  return {
    type: "stdio",
    command: registration.command,
    args: [...registration.args],
    env: { ...registration.env },
  };
}

function storedRegistration(entry: unknown): McpRegistration | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const record = entry as Record<string, unknown>;
  if (typeof record.command !== "string" || !Array.isArray(record.args)) return undefined;
  if (!record.args.every((a) => typeof a === "string")) return undefined;
  const env: Record<string, string> = {};
  if (record.env !== undefined) {
    if (typeof record.env !== "object" || record.env === null) return undefined;
    for (const [k, v] of Object.entries(record.env as Record<string, unknown>)) {
      if (typeof v !== "string") return undefined;
      env[k] = v;
    }
  }
  return { name: "rocky", command: record.command, args: record.args as string[], env };
}

export function createHarnessClaudeCodeAdapter(deps: HarnessClaudeCodeDeps): SetupClientAdapter {
  const home = deps.home ?? deps.platform.home;
  const env = deps.env ?? process.env;
  const scope = deps.scope ?? "user";
  const configPath = scope === "project"
    ? deps.projectConfigPath
    : (deps.userConfigPath
      ?? (typeof env.CLAUDE_CONFIG_DIR === "string" && env.CLAUDE_CONFIG_DIR.length > 0
        ? join(env.CLAUDE_CONFIG_DIR, "claude.json")
        : join(home, ".claude.json")));

  async function executablePath(): Promise<string | undefined> {
    const { executable } = await resolveCanonicalExecutable({
      runner: deps.runner,
      platform: deps.platform,
      names: ["claude"],
      versionArgs: ["--version"],
      timeoutMs: VERSION_TIMEOUT_MS,
    });
    return executable?.path;
  }

  function readConfig(registration: McpRegistration): InspectionResult {
    if (configPath === undefined) {
      return { state: "unreadable", detail: "Claude Code scope is ambiguous: no User or Project config explicitly resolved" };
    }
    const read = readJsonObject(configPath);
    if (read.status === "missing") return { state: "absent" };
    if (read.status === "invalid") return { state: "unreadable", detail: `Claude Code config is unreadable: ${configPath}` };
    const container = read.value.mcpServers;
    if (container !== undefined
      && (typeof container !== "object" || container === null || Array.isArray(container))) {
      return { state: "unreadable", detail: `Claude Code mcpServers is not an object: ${configPath}` };
    }
    const entry = (read.value.mcpServers as Record<string, unknown> | undefined)?.rocky;
    if (entry === undefined) return { state: "absent" };
    const stored = storedRegistration(entry);
    if (stored !== undefined && isIdenticalMcpRegistration(stored, registration)) return { state: "identical" };
    return { state: "conflict", detail: "Claude Code already has a different rocky registration" };
  }

  async function verify(executable: string | undefined, registration: McpRegistration): Promise<string | undefined> {
    const outcome = await verifyMcpAfterWrite({
      runner: deps.runner,
      registration,
      listCommand: executable === undefined
        ? undefined
        : { command: executable, args: ["mcp", "list", "--scope", scope], timeoutMs: LIST_TIMEOUT_MS },
      mustContain: executable === undefined ? undefined : "rocky",
    });
    return outcome.verified ? undefined : outcome.detail;
  }

  return {
    id: "claude-code",
    async inspect(registration) {
      const exe = await executablePath();
      if (exe === undefined) return { state: "blocked", detail: MISSING_DETAIL };
      return readConfig(registration);
    },
    async configure(registration, replace): Promise<SetupResult> {
      const exe = await executablePath();
      if (exe === undefined) {
        void notFoundDetection("claude-code", ["claude"], configPath ?? "~/.claude.json");
        return { client: "claude-code", status: "skipped", detail: MISSING_DETAIL };
      }
      const inspection = readConfig(registration);
      if (inspection.state === "unreadable") {
        return { client: "claude-code", status: "failed", detail: inspection.detail };
      }
      if (inspection.state === "identical") return { client: "claude-code", status: "already-configured" };
      if (inspection.state === "conflict" && !replace) {
        return {
          client: "claude-code",
          status: "requires-confirmation",
          detail: "Claude Code already has a different rocky registration",
          manualRegistration: registration,
        };
      }
      if (configPath === undefined) {
        return { client: "claude-code", status: "failed", detail: "Claude Code scope is ambiguous; refusing to guess a config path" };
      }
      const prior = readJsonObject(configPath);
      if (prior.status === "invalid") {
        return { client: "claude-code", status: "failed", detail: `Claude Code config is unreadable: ${configPath}` };
      }
      const base = prior.status === "missing" ? {} : prior.value;
      if (inspection.state === "conflict" && replace) {
        const stored = storedRegistration(
          (base.mcpServers as Record<string, unknown> | undefined)?.rocky,
        );
        if (stored === undefined || !isOwnedRockyRegistration(stored, registration)) {
          return { client: "claude-code", status: "failed", detail: "refusing to replace a rocky entry not owned by Rocky; resolve manually" };
        }
      }
      const merged = mergeRockyMcpServer(base, "mcpServers", registration, toClaudeEntry);
      if (!merged.changed) return { client: "claude-code", status: "already-configured" };
      const written = writeMergedJsonConfig(configPath, merged.value, prior);
      if (written.status !== "written") {
        return { client: "claude-code", status: "failed", detail: `Claude Code write stopped before mutation (${written.status}); target unchanged` };
      }
      const problem = await verify(exe, registration);
      if (problem !== undefined) {
        return { client: "claude-code", status: "failed", detail: `configured; MCP unverified: ${problem}` };
      }
      return { client: "claude-code", status: "configured" };
    },
    async remove(registration): Promise<SetupResult> {
      const exe = await executablePath();
      if (exe === undefined) return { client: "claude-code", status: "skipped", detail: MISSING_DETAIL };
      if (configPath === undefined) {
        return { client: "claude-code", status: "failed", detail: "Claude Code scope is ambiguous; refusing to guess a config path" };
      }
      const prior = readJsonObject(configPath);
      if (prior.status === "missing") return { client: "claude-code", status: "not-configured" };
      if (prior.status === "invalid") {
        return { client: "claude-code", status: "failed", detail: `Claude Code config is unreadable: ${configPath}` };
      }
      const pruned = removeRockyMcpServer(prior.value, "mcpServers", registration);
      if (!pruned.changed) {
        return pruned.owned === false
          && (prior.value.mcpServers as Record<string, unknown> | undefined)?.rocky !== undefined
          ? { client: "claude-code", status: "failed", detail: "refusing to remove a rocky entry not owned by Rocky" }
          : { client: "claude-code", status: "not-configured" };
      }
      const written = writeMergedJsonConfig(configPath, pruned.value, prior);
      if (written.status !== "written") {
        return { client: "claude-code", status: "failed", detail: `Claude Code removal stopped before mutation (${written.status}); target unchanged` };
      }
      void exe;
      return { client: "claude-code", status: "removed" };
    },
    async check(registration): Promise<SetupResult> {
      const exe = await executablePath();
      if (exe === undefined) return { client: "claude-code", status: "skipped", detail: MISSING_DETAIL };
      const inspection = readConfig(registration);
      if (inspection.state === "identical") {
        return { client: "claude-code", status: "healthy", healthRegistration: registration };
      }
      if (inspection.state === "absent") return { client: "claude-code", status: "not-configured" };
      return { client: "claude-code", status: "failed", detail: inspection.detail ?? "Claude Code rocky registration differs" };
    },
  };
}
