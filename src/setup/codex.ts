import { isDeepStrictEqual } from "node:util";
import type {
  InspectionResult,
  McpRegistration,
  SetupClientAdapter,
  SetupResult,
} from "./clients.js";
import type { ProcessResult, ProcessRunner } from "./process.js";
import { isIdenticalMcpRegistration, isOwnedRockyRegistration } from "./registration.js";

const GET_ARGS = ["mcp", "get", "rocky", "--json"] as const;
const REMOVE_ARGS = ["mcp", "remove", "rocky"] as const;
const MISSING_DETAIL = "Codex CLI is not installed";
const CODEX_COMMAND_TIMEOUT_MS = 10_000;

export interface CodexAdapterDependencies {
  runner: ProcessRunner;
  executable?: string;
}

interface JsonObject {
  [key: string]: unknown;
}

interface ParsedSnapshot {
  snapshot: JsonObject;
  registration: McpRegistration;
}

type ParseResult =
  | { ok: true; value: ParsedSnapshot }
  | { ok: false };

type RestorableResult =
  | { ok: true; registration: McpRegistration }
  | { ok: false; reason: string };

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isStringMap(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function isOptionalStringArray(value: unknown): boolean {
  return value === undefined || value === null || isStringArray(value);
}

function isOptionalTimeout(value: unknown): boolean {
  return value === undefined
    || value === null
    || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function hasEveryKey(value: JsonObject, keys: readonly string[]): boolean {
  return keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function parseSnapshotValue(value: unknown): ParseResult {
  if (!isObject(value)
    || !hasEveryKey(value, [
      "name",
      "enabled",
      "disabled_reason",
      "transport",
      "enabled_tools",
      "disabled_tools",
      "startup_timeout_sec",
      "tool_timeout_sec",
    ])
    || value.name !== "rocky"
    || typeof value.enabled !== "boolean"
    || !isOptionalString(value.disabled_reason)
    || !isOptionalStringArray(value.enabled_tools)
    || !isOptionalStringArray(value.disabled_tools)
    || !isOptionalTimeout(value.startup_timeout_sec)
    || !isOptionalTimeout(value.tool_timeout_sec)
    || !isObject(value.transport)) {
    return { ok: false };
  }

  const transport = value.transport;
  if (!hasEveryKey(transport, ["type", "command", "args", "env", "env_vars", "cwd"])
    || transport.type !== "stdio"
    || typeof transport.command !== "string"
    || transport.command.length === 0
    || !isStringArray(transport.args)
    || !isStringMap(transport.env)
    || (transport.env_vars !== undefined && !isStringArray(transport.env_vars))
    || !isOptionalString(transport.cwd)) {
    return { ok: false };
  }

  return {
    ok: true,
    value: {
      snapshot: value,
      registration: {
        name: "rocky",
        command: transport.command,
        args: [...transport.args],
        env: { ...transport.env },
      },
    },
  };
}

function parseSnapshot(stdout: string): ParseResult {
  try {
    return parseSnapshotValue(JSON.parse(stdout));
  } catch {
    return { ok: false };
  }
}

function succeeded(result: ProcessResult): boolean {
  return result.status === 0 && result.error === undefined;
}

function isNotFound(result: ProcessResult): boolean {
  return typeof result.status === "number"
    && result.status !== 0
    && result.error === undefined
    && /no mcp server named\s+['"]?rocky['"]?\s+found|mcp server\s+['"]?rocky['"]?\s+(?:was\s+)?not found/i
      .test(`${result.stdout}\n${result.stderr}`);
}

function addArguments(registration: McpRegistration): string[] {
  const args = ["mcp", "add"];
  for (const [name, value] of Object.entries(registration.env)) {
    args.push("--env", `${name}=${value}`);
  }
  args.push(
    registration.name,
    "--",
    registration.command,
    ...registration.args,
  );
  return args;
}

function hasOnlyKeys(value: JsonObject, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isDefaultOptional(value: unknown): boolean {
  return value === undefined || value === null;
}

function snapshotToRestorableStdio(snapshot: unknown): RestorableResult {
  if (!isObject(snapshot) || !isObject(snapshot.transport)) {
    return { ok: false, reason: "snapshot is incomplete" };
  }

  const topLevelKeys = new Set([
    "name",
    "enabled",
    "disabled_reason",
    "transport",
    "enabled_tools",
    "disabled_tools",
    "startup_timeout_sec",
    "tool_timeout_sec",
    "default_tools_approval_mode",
  ]);
  const transportKeys = new Set(["type", "command", "args", "env", "env_vars", "cwd"]);
  if (!hasOnlyKeys(snapshot, topLevelKeys) || !hasOnlyKeys(snapshot.transport, transportKeys)) {
    return { ok: false, reason: "snapshot contains unsupported metadata" };
  }
  if (snapshot.name !== "rocky"
    || snapshot.enabled !== true
    || !isDefaultOptional(snapshot.disabled_reason)
    || !isDefaultOptional(snapshot.enabled_tools)
    || !isDefaultOptional(snapshot.disabled_tools)
    || !isDefaultOptional(snapshot.startup_timeout_sec)
    || !isDefaultOptional(snapshot.tool_timeout_sec)
    || !isDefaultOptional(snapshot.default_tools_approval_mode)) {
    return { ok: false, reason: "snapshot contains unsupported server settings" };
  }

  const transport = snapshot.transport;
  if (transport.type !== "stdio"
    || typeof transport.command !== "string"
    || !isStringArray(transport.args)
    || !isStringMap(transport.env)
    || Object.keys(transport.env).length === 0
    || (transport.env_vars !== undefined && (!isStringArray(transport.env_vars) || transport.env_vars.length !== 0))
    || !isDefaultOptional(transport.cwd)) {
    return { ok: false, reason: "snapshot contains unsupported stdio settings" };
  }

  return {
    ok: true,
    registration: {
      name: "rocky",
      command: transport.command,
      args: [...transport.args],
      env: { ...transport.env },
    },
  };
}

function skipped(): SetupResult {
  return { client: "codex", status: "skipped", detail: MISSING_DETAIL };
}

function manualReplacement(reason: string, registration: McpRegistration): SetupResult {
  return {
    client: "codex",
    status: "failed",
    detail: `Codex registration cannot be replaced safely (${reason}); use manual registration`,
    manualRegistration: registration,
  };
}

function failed(detail: string, manualRegistration?: McpRegistration): SetupResult {
  const result: SetupResult = { client: "codex", status: "failed", detail };
  if (manualRegistration !== undefined) result.manualRegistration = manualRegistration;
  return result;
}

export function createCodexAdapter(dependencies: CodexAdapterDependencies): SetupClientAdapter {
  const { runner, executable } = dependencies;

  async function readSnapshot(registration: McpRegistration): Promise<InspectionResult> {
    if (executable === undefined) return { state: "blocked", detail: MISSING_DETAIL };
    const result = await runner.run(executable, GET_ARGS, { timeoutMs: CODEX_COMMAND_TIMEOUT_MS });
    if (!succeeded(result)) {
      if (isNotFound(result)) return { state: "absent" };
      return { state: "unreadable", detail: "Unable to read Codex registration" };
    }
    const parsed = parseSnapshot(result.stdout);
    if (!parsed.ok) return { state: "unreadable", detail: "Unable to read Codex registration" };
    const restorable = snapshotToRestorableStdio(parsed.value.snapshot);
    return isIdenticalMcpRegistration(parsed.value.registration, registration) && restorable.ok
      ? { state: "identical", snapshot: parsed.value.snapshot }
      : { state: "conflict", snapshot: parsed.value.snapshot };
  }

  async function add(registration: McpRegistration): Promise<ProcessResult> {
    if (executable === undefined) {
      return { status: null, stdout: "", stderr: "", error: new Error(MISSING_DETAIL) };
    }
    return runner.run(executable, addArguments(registration), { timeoutMs: CODEX_COMMAND_TIMEOUT_MS });
  }

  return {
    id: "codex",

    inspect(registration) {
      return readSnapshot(registration);
    },

    async configure(registration, replace) {
      if (executable === undefined) return skipped();
      const inspection = await readSnapshot(registration);
      if (inspection.state === "absent") {
        return succeeded(await add(registration))
          ? { client: "codex", status: "configured" }
          : failed("Unable to add Codex registration", registration);
      }
      if (inspection.state === "identical") {
        return { client: "codex", status: "already-configured" };
      }
      if (inspection.state === "blocked") return skipped();
      if (inspection.state === "unreadable") {
        return failed("Unable to read Codex registration", registration);
      }
      if (!replace) {
        return {
          client: "codex",
          status: "requires-confirmation",
          detail: "Codex already has a different rocky registration",
          manualRegistration: registration,
        };
      }

      const rollback = snapshotToRestorableStdio(inspection.snapshot);
      if (!rollback.ok) return manualReplacement(rollback.reason, registration);

      const removed = await runner.run(executable, REMOVE_ARGS, { timeoutMs: CODEX_COMMAND_TIMEOUT_MS });
      if (!succeeded(removed)) {
        return failed("Unable to remove existing Codex registration", registration);
      }
      const added = await add(registration);
      if (succeeded(added)) return { client: "codex", status: "configured" };

      const restored = await add(rollback.registration);
      if (!succeeded(restored)) {
        return failed("Codex registration update and rollback failed; manual recovery is required", registration);
      }
      const verificationResult = await runner.run(executable, GET_ARGS, { timeoutMs: CODEX_COMMAND_TIMEOUT_MS });
      const verification = succeeded(verificationResult) ? parseSnapshot(verificationResult.stdout) : { ok: false as const };
      if (!verification.ok || !isDeepStrictEqual(verification.value.snapshot, inspection.snapshot)) {
        return failed("Codex rollback could not be verified; manual recovery is required", registration);
      }
      return failed("Codex registration update failed; previous registration was restored");
    },

    async remove(registration) {
      if (executable === undefined) return skipped();
      const inspection = await readSnapshot(registration);
      if (inspection.state === "absent") return { client: "codex", status: "not-configured" };
      if (inspection.state === "blocked") return skipped();
      if (inspection.state === "unreadable") return failed("Unable to read Codex registration");
      const parsed = parseSnapshotValue(inspection.snapshot);
      if (!parsed.ok || !isOwnedRockyRegistration(parsed.value.registration, registration)) {
        return failed("Codex rocky registration is not owned by Rocky");
      }
      return succeeded(await runner.run(executable, REMOVE_ARGS, { timeoutMs: CODEX_COMMAND_TIMEOUT_MS }))
        ? { client: "codex", status: "removed" }
        : failed("Unable to remove Codex registration");
    },

    async check(registration) {
      if (executable === undefined) return skipped();
      const inspection = await readSnapshot(registration);
      if (inspection.state === "absent") return { client: "codex", status: "not-configured" };
      if (inspection.state === "blocked") return skipped();
      if (inspection.state === "identical" || inspection.state === "conflict") {
        const parsed = parseSnapshotValue(inspection.snapshot);
        const restorable = snapshotToRestorableStdio(inspection.snapshot);
        if (parsed.ok
          && restorable.ok
          && isOwnedRockyRegistration(parsed.value.registration, registration)) {
          return {
            client: "codex",
            status: "healthy",
            healthRegistration: parsed.value.registration,
          };
        }
        if (inspection.state === "conflict") {
          return failed("Codex has a different rocky registration", registration);
        }
      }
      return failed("Unable to read Codex registration", registration);
    },
  };
}
