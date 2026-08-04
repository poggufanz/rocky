import type {
  InspectionResult,
  McpRegistration,
  SetupClientAdapter,
  SetupResult,
} from "./clients.js";
import { atomicWriteJson, BackupFileError, backupFile, readJsonObject } from "./json-config.js";
import type { JsonReadResult } from "./json-config.js";
import type { ProcessResult, ProcessRunner } from "./process.js";
import { isIdenticalMcpRegistration, isOwnedRockyRegistration } from "./registration.js";

const MISSING_DETAIL = "Claude Code CLI is not installed";
const CLAUDE_COMMAND_TIMEOUT_MS = 10_000;
const REMOVE_ARGS = ["mcp", "remove", "--scope", "user", "rocky"] as const;

export interface ClaudeCodeAdapterDependencies {
  runner: ProcessRunner;
  userConfigPath: string;
  executable?: string;
}

interface JsonObject {
  [key: string]: unknown;
}

interface ConfigInspection {
  public: InspectionResult;
  read: JsonReadResult;
  snapshot?: unknown;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isStringMap(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function parseRegistration(value: unknown): McpRegistration | undefined {
  if (!isObject(value)
    || value.type !== "stdio"
    || typeof value.command !== "string"
    || value.command.length === 0
    || !isStringArray(value.args)
    || !isStringMap(value.env)) {
    return undefined;
  }
  return {
    name: "rocky",
    command: value.command,
    args: [...value.args],
    env: { ...value.env },
  };
}
function inspectUserConfig(path: string, registration: McpRegistration): ConfigInspection {
  const read = readJsonObject(path);
  if (read.status === "invalid") {
    return {
      read,
      public: { state: "unreadable", detail: "Unable to read Claude Code user config" },
    };
  }
  const servers = read.value.mcpServers;
  if (servers === undefined) return { read, public: { state: "absent" } };
  if (!isObject(servers)) {
    return {
      read,
      public: { state: "unreadable", detail: "Unable to read Claude Code user config" },
    };
  }
  if (!hasOwn(servers, "rocky")) return { read, public: { state: "absent" } };

  const snapshot = servers.rocky;
  const stored = parseRegistration(snapshot);
  return stored !== undefined && isIdenticalMcpRegistration(stored, registration)
    ? { read, snapshot, public: { state: "identical", snapshot } }
    : { read, snapshot, public: { state: "conflict", snapshot } };
}

function succeeded(result: ProcessResult): boolean {
  return result.status === 0 && result.error === undefined;
}

function isPolicyRefusal(result: ProcessResult): boolean {
  return /enterprise|managed|policy|administrator|not allowed|disabled by/i.test(
    `${result.stdout}\n${result.stderr}\n${result.error?.message ?? ""}`,
  );
}

function addArguments(registration: McpRegistration): string[] {
  const args = ["mcp", "add", "--scope", "user", "--transport", "stdio"];
  for (const [name, value] of Object.entries(registration.env)) {
    args.push("--env", `${name}=${value}`);
  }
  args.push(registration.name, "--", registration.command, ...registration.args);
  return args;
}

function skipped(): SetupResult {
  return { client: "claude-code", status: "skipped", detail: MISSING_DETAIL };
}

function failed(detail: string, manualRegistration?: McpRegistration): SetupResult {
  const output: SetupResult = { client: "claude-code", status: "failed", detail };
  if (manualRegistration !== undefined) output.manualRegistration = manualRegistration;
  return output;
}

function blocked(detail: string, manualRegistration?: McpRegistration): SetupResult {
  const output: SetupResult = { client: "claude-code", status: "blocked-by-policy", detail };
  if (manualRegistration !== undefined) output.manualRegistration = manualRegistration;
  return output;
}

function backupDetail(prefix: string, backupPath: string): string {
  return `${prefix}; backup: ${backupPath}`;
}

function restoreSnapshot(
  path: string,
  originalRead: JsonReadResult,
  snapshot: unknown,
  backupPath: string,
  policyRefused: boolean,
  registration: McpRegistration,
): SetupResult {
  const current = readJsonObject(path);
  if (current.status === "invalid") {
    return failed(backupDetail("Claude Code update failed and current config cannot be read", backupPath));
  }

  const existingServers = current.value.mcpServers;
  if (existingServers !== undefined && !isObject(existingServers)) {
    return failed(backupDetail("Claude Code update failed and rollback requires manual recovery", backupPath));
  }
  const servers = existingServers === undefined ? {} : existingServers;
  if (hasOwn(servers, "rocky")) {
    return failed(backupDetail("Claude Code update failed and concurrent rocky registration was preserved", backupPath));
  }

  const restored = {
    ...current.value,
    mcpServers: { ...servers, rocky: snapshot },
  };
  const priorMode = current.status === "valid"
    ? current.mode
    : originalRead.status === "valid" ? originalRead.mode : undefined;
  try {
    atomicWriteJson(path, restored, { mode: priorMode });
  } catch {
    return failed(backupDetail("Claude Code update failed and rollback requires manual recovery", backupPath));
  }
  const detail = backupDetail(
    policyRefused
      ? "Claude Code policy refused registration update; previous registration was restored"
      : "Claude Code registration update failed; previous registration was restored",
    backupPath,
  );
  return policyRefused ? blocked(detail, registration) : failed(detail);
}

export function createClaudeCodeAdapter(
  dependencies: ClaudeCodeAdapterDependencies,
): SetupClientAdapter {
  const { runner, executable, userConfigPath } = dependencies;

  async function add(registration: McpRegistration): Promise<ProcessResult> {
    if (executable === undefined) {
      return { status: null, stdout: "", stderr: "", error: new Error(MISSING_DETAIL) };
    }
    return runner.run(executable, addArguments(registration), { timeoutMs: CLAUDE_COMMAND_TIMEOUT_MS });
  }

  return {
    id: "claude-code",

    async inspect(registration) {
      if (executable === undefined) return { state: "blocked", detail: MISSING_DETAIL };
      return inspectUserConfig(userConfigPath, registration).public;
    },

    async configure(registration, replace) {
      if (executable === undefined) return skipped();
      const inspection = inspectUserConfig(userConfigPath, registration);
      if (inspection.public.state === "absent") {
        const added = await add(registration);
        if (succeeded(added)) return { client: "claude-code", status: "configured" };
        return isPolicyRefusal(added)
          ? blocked("Claude Code policy refused user registration", registration)
          : failed("Unable to add Claude Code registration", registration);
      }
      if (inspection.public.state === "identical") {
        return { client: "claude-code", status: "already-configured" };
      }
      if (inspection.public.state === "unreadable") {
        return failed("Unable to read Claude Code user config", registration);
      }
      if (!replace) {
        return {
          client: "claude-code",
          status: "requires-confirmation",
          detail: "Claude Code already has a different rocky registration",
          manualRegistration: registration,
        };
      }

      let backupPath: string;
      try {
        backupPath = backupFile(userConfigPath);
      } catch (error) {
        const detail = error instanceof BackupFileError && error.recoveryPath !== undefined
          ? `Unable to back up Claude Code user config; manual recovery: ${error.recoveryPath}`
          : "Unable to back up Claude Code user config";
        return failed(detail, registration);
      }
      const removed = await runner.run(executable, REMOVE_ARGS, { timeoutMs: CLAUDE_COMMAND_TIMEOUT_MS });
      if (!succeeded(removed)) {
        const detail = backupDetail("Unable to remove existing Claude Code registration", backupPath);
        return isPolicyRefusal(removed) ? blocked(detail, registration) : failed(detail, registration);
      }
      const added = await add(registration);
      if (succeeded(added)) {
        return {
          client: "claude-code",
          status: "configured",
          detail: `Claude Code config backup: ${backupPath}`,
        };
      }
      return restoreSnapshot(
        userConfigPath,
        inspection.read,
        inspection.snapshot,
        backupPath,
        isPolicyRefusal(added),
        registration,
      );
    },

    async remove(registration) {
      if (executable === undefined) return skipped();
      const inspection = inspectUserConfig(userConfigPath, registration);
      if (inspection.public.state === "absent") {
        return { client: "claude-code", status: "not-configured" };
      }
      if (inspection.public.state === "unreadable") {
        return failed("Unable to read Claude Code user config");
      }
      const stored = parseRegistration(inspection.snapshot);
      if (stored === undefined || !isOwnedRockyRegistration(stored, registration)) {
        return failed("Claude Code rocky registration is not owned by Rocky");
      }
      const removed = await runner.run(executable, REMOVE_ARGS, { timeoutMs: CLAUDE_COMMAND_TIMEOUT_MS });
      if (succeeded(removed)) return { client: "claude-code", status: "removed" };
      return isPolicyRefusal(removed)
        ? blocked("Claude Code policy refused registration removal")
        : failed("Unable to remove Claude Code registration");
    },

    async check(registration) {
      if (executable === undefined) return skipped();
      const inspection = inspectUserConfig(userConfigPath, registration).public;
      if (inspection.state === "identical") return { client: "claude-code", status: "healthy" };
      if (inspection.state === "absent") return { client: "claude-code", status: "not-configured" };
      if (inspection.state === "conflict") {
        return failed("Claude Code has a different rocky registration", registration);
      }
      return failed("Unable to read Claude Code user config", registration);
    },
  };
}
