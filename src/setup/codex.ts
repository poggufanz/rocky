import { isDeepStrictEqual } from "node:util";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type {
  InspectionResult,
  McpRegistration,
  SetupClientAdapter,
  SetupResult,
} from "./clients.js";
import type { ProcessResult, ProcessRunner } from "./process.js";
import { isIdenticalMcpRegistration, isOwnedRockyRegistration } from "./registration.js";
import { directorySyncCapability } from "./directory-sync.js";

const GET_ARGS = ["mcp", "get", "rocky", "--json"] as const;
const REMOVE_ARGS = ["mcp", "remove", "rocky"] as const;
const MISSING_DETAIL = "Codex CLI is not installed";
const CODEX_COMMAND_TIMEOUT_MS = 10_000;

export interface CodexAdapterDependencies {
  runner: ProcessRunner;
  executable?: string;
  recoveryBaseDirectory?: string;
}

interface RecoveryArtifact {
  path: string;
  directory: string;
  dev: number;
  ino: number;
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

function syncDirectory(path: string): void {
  directorySyncCapability.sync(path);
}

function safeBaseDirectory(path: string): boolean {
  try {
    const metadata = lstatSync(path);
    return metadata.isDirectory() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

function privateDirectory(path: string): boolean {
  if (!safeBaseDirectory(path)) return false;
  return process.platform === "win32" || (lstatSync(path).mode & 0o077) === 0;
}

function persistRecoveryArtifact(baseDirectory: string, snapshot: unknown): RecoveryArtifact {
  if (!isAbsolute(baseDirectory) || !safeBaseDirectory(baseDirectory)) {
    throw new Error("unsafe recovery base");
  }
  const directory = join(baseDirectory, ".rocky-setup-recovery");
  try {
    mkdirSync(directory, { mode: 0o700 });
    syncDirectory(baseDirectory);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code !== "EEXIST" || !privateDirectory(directory)) {
      throw new Error("unsafe recovery directory");
    }
  }
  if (!privateDirectory(directory)) throw new Error("unsafe recovery directory");

  const path = join(directory, `codex-rocky-${randomBytes(16).toString("hex")}.json`);
  let descriptor: number | undefined;
  let identity: { dev: number; ino: number } | undefined;
  try {
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    descriptor = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
    );
    const opened = fstatSync(descriptor);
    identity = { dev: opened.dev, ino: opened.ino };
    writeFileSync(descriptor, `${JSON.stringify(snapshot)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    syncDirectory(directory);
    const stored = lstatSync(path);
    if (!stored.isFile()
      || stored.isSymbolicLink()
      || stored.nlink !== 1
      || stored.dev !== identity.dev
      || stored.ino !== identity.ino
      || (process.platform !== "win32" && (stored.mode & 0o077) !== 0)) {
      throw new Error("unsafe recovery artifact");
    }
    return { path, directory, dev: stored.dev, ino: stored.ino };
  } catch {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* preserve secret-free failure */ }
    }
    if (identity !== undefined) {
      try {
        const stored = lstatSync(path);
        if (stored.isFile() && stored.dev === identity.dev && stored.ino === identity.ino) {
          rmSync(path);
          syncDirectory(directory);
        }
      } catch {
        // Preparation failed before destructive mutation; never report an unverified path.
      }
    }
    throw new Error("Unable to persist Codex recovery artifact");
  }
}

function removeRecoveryArtifact(artifact: RecoveryArtifact): boolean {
  try {
    const stored = lstatSync(artifact.path);
    if (!stored.isFile()
      || stored.isSymbolicLink()
      || stored.nlink !== 1
      || stored.dev !== artifact.dev
      || stored.ino !== artifact.ino) return false;
    rmSync(artifact.path);
    syncDirectory(artifact.directory);
    return true;
  } catch {
    return false;
  }
}

function recoveryFailure(
  prefix: string,
  artifact: RecoveryArtifact,
  desired: McpRegistration,
): SetupResult {
  try {
    const stored = lstatSync(artifact.path);
    if (stored.isFile()
      && !stored.isSymbolicLink()
      && stored.nlink === 1
      && stored.dev === artifact.dev
      && stored.ino === artifact.ino
      && (process.platform === "win32" || (stored.mode & 0o077) === 0)) {
      return failed(`${prefix}; manual recovery: ${artifact.path}`, desired);
    }
  } catch {
    // Never report a recovery path that no longer exists.
  }
  return failed(`${prefix}; recovery artifact is unavailable`, desired);
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

      const rockyHome = registration.env.ROCKY_HOME;
      const recoveryBase = dependencies.recoveryBaseDirectory
        ?? (rockyHome === undefined ? undefined : dirname(rockyHome));
      let recovery: RecoveryArtifact;
      try {
        if (recoveryBase === undefined) throw new Error("missing recovery base");
        recovery = persistRecoveryArtifact(recoveryBase, inspection.snapshot);
      } catch {
        return failed(
          "Unable to create private Codex recovery artifact; replacement stopped",
          registration,
        );
      }

      const removed = await runner.run(executable, REMOVE_ARGS, { timeoutMs: CODEX_COMMAND_TIMEOUT_MS });
      if (!succeeded(removed)) {
        const current = await runner.run(executable, GET_ARGS, { timeoutMs: CODEX_COMMAND_TIMEOUT_MS });
        const verified = succeeded(current) ? parseSnapshot(current.stdout) : { ok: false as const };
        if (verified.ok && isDeepStrictEqual(verified.value.snapshot, inspection.snapshot)) {
          return removeRecoveryArtifact(recovery)
            ? failed("Unable to remove existing Codex registration", registration)
            : recoveryFailure("Codex recovery artifact cleanup failed", recovery, registration);
        }
        return recoveryFailure(
          "Unable to remove existing Codex registration and prior state could not be verified",
          recovery,
          registration,
        );
      }
      const added = await add(registration);
      if (succeeded(added)) {
        const current = await runner.run(executable, GET_ARGS, { timeoutMs: CODEX_COMMAND_TIMEOUT_MS });
        const verified = succeeded(current) ? parseSnapshot(current.stdout) : { ok: false as const };
        if (!verified.ok
          || !isIdenticalMcpRegistration(verified.value.registration, registration)
          || !snapshotToRestorableStdio(verified.value.snapshot).ok) {
          return recoveryFailure(
            "Codex registration update could not be verified",
            recovery,
            registration,
          );
        }
        return removeRecoveryArtifact(recovery)
          ? { client: "codex", status: "configured" }
          : recoveryFailure("Codex recovery artifact cleanup failed", recovery, registration);
      }

      const restored = await add(rollback.registration);
      if (!succeeded(restored)) {
        return recoveryFailure(
          "Codex registration update and rollback failed",
          recovery,
          registration,
        );
      }
      const verificationResult = await runner.run(executable, GET_ARGS, { timeoutMs: CODEX_COMMAND_TIMEOUT_MS });
      const verification = succeeded(verificationResult) ? parseSnapshot(verificationResult.stdout) : { ok: false as const };
      if (!verification.ok || !isDeepStrictEqual(verification.value.snapshot, inspection.snapshot)) {
        return recoveryFailure("Codex rollback could not be verified", recovery, registration);
      }
      return removeRecoveryArtifact(recovery)
        ? failed("Codex registration update failed; previous registration was restored")
        : recoveryFailure("Codex recovery artifact cleanup failed", recovery, registration);
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
