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
import {
  mergeRockyMcpServer,
  notFoundDetection,
  resolveCanonicalExecutable,
  verifyMcpAfterWrite,
  writeMergedJsonConfig,
} from "./harness-mcp-shared.js";

export interface HarnessOpencodeDeps {
  runner: ProcessRunner;
  platform: PlatformServices;
  env?: NodeJS.ProcessEnv;
  home?: string;
  configPath?: string;
}

const MISSING_DETAIL = "OpenCode CLI is not installed";
const VERSION_TIMEOUT_MS = 5_000;

export function toOpencodeEntry(registration: McpRegistration): Record<string, unknown> {
  return {
    type: "local",
    command: [registration.command, ...registration.args],
    environment: { ...registration.env },
  };
}

function storedRegistration(entry: unknown): McpRegistration | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const record = entry as Record<string, unknown>;
  if (!Array.isArray(record.command) || !record.command.every((a) => typeof a === "string")) return undefined;
  const [command, ...args] = record.command as string[];
  if (command === undefined) return undefined;
  const env: Record<string, string> = {};
  if (record.environment !== undefined) {
    if (typeof record.environment !== "object" || record.environment === null) return undefined;
    for (const [k, v] of Object.entries(record.environment as Record<string, unknown>)) {
      if (typeof v !== "string") return undefined;
      env[k] = v;
    }
  }
  return { name: "rocky", command, args, env };
}

function sameRegistration(left: McpRegistration, right: McpRegistration): boolean {
  return left.command === right.command
    && JSON.stringify(left.args) === JSON.stringify(right.args)
    && JSON.stringify(left.env) === JSON.stringify(right.env);
}

function resolveConfigPath(deps: HarnessOpencodeDeps): string {
  if (deps.configPath !== undefined) return deps.configPath;
  const env = deps.env ?? process.env;
  if (typeof env.OPENCODE_CONFIG === "string" && env.OPENCODE_CONFIG.length > 0) return env.OPENCODE_CONFIG;
  const home = deps.home ?? deps.platform.home;
  if (deps.platform.platform === "win32" && typeof deps.platform.appData === "string") {
    return join(deps.platform.appData, "opencode", "opencode.json");
  }
  return join(home, ".config", "opencode", "opencode.json");
}

export function createHarnessOpencodeAdapter(deps: HarnessOpencodeDeps): SetupClientAdapter {
  const configPath = resolveConfigPath(deps);

  async function executablePath(): Promise<string | undefined> {
    const { executable } = await resolveCanonicalExecutable({
      runner: deps.runner,
      platform: deps.platform,
      names: ["opencode"],
      versionArgs: ["--version"],
      timeoutMs: VERSION_TIMEOUT_MS,
    });
    return executable?.path;
  }

  function readConfig(registration: McpRegistration): InspectionResult {
    const read = readJsonObject(configPath);
    if (read.status === "missing") return { state: "absent" };
    if (read.status === "invalid") return { state: "unreadable", detail: `OpenCode config is unreadable: ${configPath}` };
    const container = read.value.mcp;
    if (container !== undefined && (typeof container !== "object" || container === null || Array.isArray(container))) {
      return { state: "unreadable", detail: `OpenCode mcp container is not an object: ${configPath}` };
    }
    const entry = (container as Record<string, unknown> | undefined)?.rocky;
    if (entry === undefined) return { state: "absent" };
    const stored = storedRegistration(entry);
    if (stored !== undefined && sameRegistration(stored, registration)) {
      return { state: "identical" };
    }
    return { state: "conflict", detail: "OpenCode already has a different rocky registration" };
  }

  function prunedValue(base: Record<string, unknown>): { value: Record<string, unknown>; owned: boolean } {
    const container = base.mcp;
    if (container === undefined) {
      return { value: { ...base, mcp: {} }, owned: false };
    }
    if (typeof container !== "object" || container === null || Array.isArray(container)) {
      throw new Error("OpenCode mcp container is not an object");
    }
    const copy = { ...(container as Record<string, unknown>) };
    if (copy.rocky === undefined) {
      return { value: { ...base, mcp: copy }, owned: false };
    }
    const { rocky: _removed, ...rest } = copy;
    void _removed;
    return { value: { ...base, mcp: rest }, owned: true };
  }

  return {
    id: "opencode" as SetupClientAdapter["id"],
    async inspect(registration) {
      const exe = await executablePath();
      if (exe === undefined) return { state: "blocked", detail: MISSING_DETAIL };
      return readConfig(registration);
    },
    async configure(registration, replace): Promise<SetupResult> {
      const exe = await executablePath();
      if (exe === undefined) {
        void notFoundDetection("opencode", ["opencode"], configPath);
        return { client: "opencode" as SetupResult["client"], status: "skipped", detail: MISSING_DETAIL };
      }
      const inspection = readConfig(registration);
      if (inspection.state === "unreadable") return { client: "opencode" as SetupResult["client"], status: "failed", detail: inspection.detail };
      if (inspection.state === "identical") return { client: "opencode" as SetupResult["client"], status: "already-configured" };
      if (inspection.state === "conflict" && !replace) {
        return { client: "opencode" as SetupResult["client"], status: "requires-confirmation", detail: inspection.detail, manualRegistration: registration };
      }
      const prior = readJsonObject(configPath);
      if (prior.status === "invalid") {
        return { client: "opencode" as SetupResult["client"], status: "failed", detail: `OpenCode config is unreadable: ${configPath}` };
      }
      const base = prior.status === "missing" ? {} : prior.value;
      if (inspection.state === "conflict" && replace) {
        const stored = storedRegistration((base.mcp as Record<string, unknown> | undefined)?.rocky);
        if (stored === undefined || stored.command !== registration.command) {
          return { client: "opencode" as SetupResult["client"], status: "failed", detail: "refusing to replace a rocky entry not owned by Rocky; resolve manually" };
        }
      }
      const merged = mergeRockyMcpServer(base, "mcp", registration, toOpencodeEntry);
      if (!merged.changed) return { client: "opencode" as SetupResult["client"], status: "already-configured" };
      const written = writeMergedJsonConfig(configPath, merged.value, prior);
      if (written.status !== "written") {
        return { client: "opencode" as SetupResult["client"], status: "failed", detail: `OpenCode write stopped before mutation (${written.status}); target unchanged` };
      }
      const outcome = await verifyMcpAfterWrite({ runner: deps.runner, registration });
      if (!outcome.verified) {
        return { client: "opencode" as SetupResult["client"], status: "failed", detail: `configured; MCP unverified: ${outcome.detail}` };
      }
      void exe;
      return { client: "opencode" as SetupResult["client"], status: "configured" };
    },
    async remove(registration): Promise<SetupResult> {
      const exe = await executablePath();
      if (exe === undefined) return { client: "opencode" as SetupResult["client"], status: "skipped", detail: MISSING_DETAIL };
      const prior = readJsonObject(configPath);
      if (prior.status === "missing") return { client: "opencode" as SetupResult["client"], status: "not-configured" };
      if (prior.status === "invalid") {
        return { client: "opencode" as SetupResult["client"], status: "failed", detail: `OpenCode config is unreadable: ${configPath}` };
      }
      const stored = storedRegistration((prior.value.mcp as Record<string, unknown> | undefined)?.rocky);
      if (stored === undefined) {
        return (prior.value.mcp as Record<string, unknown> | undefined)?.rocky !== undefined
          ? { client: "opencode" as SetupResult["client"], status: "failed", detail: "refusing to remove a rocky entry not owned by Rocky" }
          : { client: "opencode" as SetupResult["client"], status: "not-configured" };
      }
      if (!sameRegistration(stored, registration) && stored.command !== registration.command) {
        return { client: "opencode" as SetupResult["client"], status: "failed", detail: "refusing to remove a rocky entry not owned by Rocky" };
      }
      const pruned = prunedValue(prior.value);
      const written = writeMergedJsonConfig(configPath, pruned.value, prior);
      if (written.status !== "written") {
        return { client: "opencode" as SetupResult["client"], status: "failed", detail: `OpenCode removal stopped before mutation (${written.status}); target unchanged` };
      }
      void exe;
      void registration;
      return { client: "opencode" as SetupResult["client"], status: "removed" };
    },
    async check(registration): Promise<SetupResult> {
      const exe = await executablePath();
      if (exe === undefined) return { client: "opencode" as SetupResult["client"], status: "skipped", detail: MISSING_DETAIL };
      const inspection = readConfig(registration);
      if (inspection.state === "identical") {
        return { client: "opencode" as SetupResult["client"], status: "healthy", healthRegistration: registration };
      }
      if (inspection.state === "absent") return { client: "opencode" as SetupResult["client"], status: "not-configured" };
      return { client: "opencode" as SetupResult["client"], status: "failed", detail: inspection.detail ?? "OpenCode rocky registration differs" };
    },
  };
}
