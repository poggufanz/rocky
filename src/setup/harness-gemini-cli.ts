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

export interface HarnessGeminiDeps {
  runner: ProcessRunner;
  platform: PlatformServices;
  env?: NodeJS.ProcessEnv;
  home?: string;
  settingsPath?: string;
}

const MISSING_DETAIL = "Gemini CLI is not installed";
const VERSION_TIMEOUT_MS = 5_000;
const LIST_TIMEOUT_MS = 10_000;

export function toGeminiEntry(registration: McpRegistration): Record<string, unknown> {
  return {
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

function resolveSettingsPath(deps: HarnessGeminiDeps): string {
  if (deps.settingsPath !== undefined) return deps.settingsPath;
  const env = deps.env ?? process.env;
  if (typeof env.GEMINI_SETTINGS === "string" && env.GEMINI_SETTINGS.length > 0) return env.GEMINI_SETTINGS;
  const home = deps.home ?? deps.platform.home;
  if (deps.platform.platform === "win32" && typeof deps.platform.appData === "string") {
    return join(deps.platform.appData, "gemini", "settings.json");
  }
  return join(home, ".gemini", "settings.json");
}

export function createHarnessGeminiAdapter(deps: HarnessGeminiDeps): SetupClientAdapter {
  const settingsPath = resolveSettingsPath(deps);

  async function executablePath(): Promise<string | undefined> {
    const { executable } = await resolveCanonicalExecutable({
      runner: deps.runner,
      platform: deps.platform,
      names: ["gemini"],
      versionArgs: ["--version"],
      timeoutMs: VERSION_TIMEOUT_MS,
    });
    return executable?.path;
  }

  function readSettings(registration: McpRegistration): InspectionResult {
    const read = readJsonObject(settingsPath);
    if (read.status === "missing") return { state: "absent" };
    if (read.status === "invalid") return { state: "unreadable", detail: `Gemini settings are unreadable: ${settingsPath}` };
    const container = read.value.mcpServers;
    if (container !== undefined && (typeof container !== "object" || container === null || Array.isArray(container))) {
      return { state: "unreadable", detail: `Gemini mcpServers is not an object: ${settingsPath}` };
    }
    const entry = (container as Record<string, unknown> | undefined)?.rocky;
    if (entry === undefined) return { state: "absent" };
    const stored = storedRegistration(entry);
    if (stored !== undefined && isIdenticalMcpRegistration(stored, registration)) return { state: "identical" };
    return { state: "conflict", detail: "Gemini already has a different rocky registration" };
  }

  return {
    id: "gemini-cli" as SetupClientAdapter["id"],
    async inspect(registration) {
      const exe = await executablePath();
      if (exe === undefined) return { state: "blocked", detail: MISSING_DETAIL };
      return readSettings(registration);
    },
    async configure(registration, replace): Promise<SetupResult> {
      const exe = await executablePath();
      if (exe === undefined) {
        void notFoundDetection("gemini-cli", ["gemini"], settingsPath);
        return { client: "gemini-cli" as SetupResult["client"], status: "skipped", detail: MISSING_DETAIL };
      }
      const inspection = readSettings(registration);
      if (inspection.state === "unreadable") return { client: "gemini-cli" as SetupResult["client"], status: "failed", detail: inspection.detail };
      if (inspection.state === "identical") return { client: "gemini-cli" as SetupResult["client"], status: "already-configured" };
      if (inspection.state === "conflict" && !replace) {
        return { client: "gemini-cli" as SetupResult["client"], status: "requires-confirmation", detail: inspection.detail, manualRegistration: registration };
      }
      const prior = readJsonObject(settingsPath);
      if (prior.status === "invalid") {
        return { client: "gemini-cli" as SetupResult["client"], status: "failed", detail: `Gemini settings are unreadable: ${settingsPath}` };
      }
      const base = prior.status === "missing" ? {} : prior.value;
      if (inspection.state === "conflict" && replace) {
        const stored = storedRegistration((base.mcpServers as Record<string, unknown> | undefined)?.rocky);
        if (stored === undefined || !isOwnedRockyRegistration(stored, registration)) {
          return { client: "gemini-cli" as SetupResult["client"], status: "failed", detail: "refusing to replace a rocky entry not owned by Rocky; resolve manually" };
        }
      }
      const merged = mergeRockyMcpServer(base, "mcpServers", registration, toGeminiEntry);
      if (!merged.changed) return { client: "gemini-cli" as SetupResult["client"], status: "already-configured" };
      const written = writeMergedJsonConfig(settingsPath, merged.value, prior);
      if (written.status !== "written") {
        return { client: "gemini-cli" as SetupResult["client"], status: "failed", detail: `Gemini write stopped before mutation (${written.status}); target unchanged` };
      }
      const outcome = await verifyMcpAfterWrite({
        runner: deps.runner,
        registration,
        listCommand: { command: exe, args: ["mcp", "list"], timeoutMs: LIST_TIMEOUT_MS },
        mustContain: "rocky",
      });
      if (!outcome.verified) {
        return { client: "gemini-cli" as SetupResult["client"], status: "failed", detail: `configured; MCP unverified: ${outcome.detail}` };
      }
      return { client: "gemini-cli" as SetupResult["client"], status: "configured" };
    },
    async remove(registration): Promise<SetupResult> {
      const exe = await executablePath();
      if (exe === undefined) return { client: "gemini-cli" as SetupResult["client"], status: "skipped", detail: MISSING_DETAIL };
      const prior = readJsonObject(settingsPath);
      if (prior.status === "missing") return { client: "gemini-cli" as SetupResult["client"], status: "not-configured" };
      if (prior.status === "invalid") {
        return { client: "gemini-cli" as SetupResult["client"], status: "failed", detail: `Gemini settings are unreadable: ${settingsPath}` };
      }
      const pruned = removeRockyMcpServer(prior.value, "mcpServers", registration);
      if (!pruned.changed) {
        return (prior.value.mcpServers as Record<string, unknown> | undefined)?.rocky !== undefined
          ? { client: "gemini-cli" as SetupResult["client"], status: "failed", detail: "refusing to remove a rocky entry not owned by Rocky" }
          : { client: "gemini-cli" as SetupResult["client"], status: "not-configured" };
      }
      const written = writeMergedJsonConfig(settingsPath, pruned.value, prior);
      if (written.status !== "written") {
        return { client: "gemini-cli" as SetupResult["client"], status: "failed", detail: `Gemini removal stopped before mutation (${written.status}); target unchanged` };
      }
      void exe;
      return { client: "gemini-cli" as SetupResult["client"], status: "removed" };
    },
    async check(registration): Promise<SetupResult> {
      const exe = await executablePath();
      if (exe === undefined) return { client: "gemini-cli" as SetupResult["client"], status: "skipped", detail: MISSING_DETAIL };
      const inspection = readSettings(registration);
      if (inspection.state === "identical") {
        return { client: "gemini-cli" as SetupResult["client"], status: "healthy", healthRegistration: registration };
      }
      if (inspection.state === "absent") return { client: "gemini-cli" as SetupResult["client"], status: "not-configured" };
      return { client: "gemini-cli" as SetupResult["client"], status: "failed", detail: inspection.detail ?? "Gemini rocky registration differs" };
    },
  };
}
