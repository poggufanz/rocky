import { lstatSync, mkdirSync } from "node:fs";
import { posix, win32 } from "node:path";
import type { Exposure } from "../core/config-read.js";
import type {
  InspectionResult,
  McpRegistration,
  SetupClientAdapter,
  SetupResult,
} from "./clients.js";
import {
  atomicWriteJsonIfUnchanged,
  BackupFileError,
  backupFile,
  inspectJsonTransaction,
  readJsonObject,
  recoverJsonTransaction,
} from "./json-config.js";
import type { JsonMutationGuard, JsonReadResult } from "./json-config.js";
import type { PlatformServices } from "./platform.js";
import type { ProcessResult, ProcessRunner } from "./process.js";
import { isIdenticalMcpRegistration, isOwnedRockyRegistration } from "./registration.js";

const WSLPATH_TIMEOUT_MS = 10_000;
const UNRESOLVED_CONFIG_DETAIL = "Claude Desktop config path is unresolved; use manual configuration";
const POLICY_DETAIL = "Claude Desktop policy blocks config mutation";

interface JsonObject {
  [key: string]: unknown;
}

interface ConfigInspection {
  public: InspectionResult;
  read: JsonReadResult;
  servers?: JsonObject;
  snapshot?: unknown;
}

export interface ClaudeDesktopAdapterDependencies {
  configPath?: string;
  prepareConfigParent?: () => JsonMutationGuard | undefined;
  transformRegistration?: (registration: McpRegistration) => McpRegistration;
  mapHealthRegistration?: (stored: McpRegistration) => McpRegistration;
  policyBlocked?: boolean;
}

interface NativeDesktopConfigPlan {
  anchor: string;
  directoryComponents: readonly string[];
  configPath: string;
  pathApi: typeof posix;
}

export interface NativeDesktopConfig {
  configPath: string;
  prepareConfigParent: () => JsonMutationGuard | undefined;
}

export interface WslDesktopRegistrationInput {
  /** Caller supplies paths only after injected discovery has verified they exist. */
  exposure: Exposure;
  windowsConfigPath?: string;
  wslExecutable?: string;
  distro?: string;
  envExecutable?: string;
  nodePath?: string;
  entryPath?: string;
  rockyHome?: string;
}

export interface MountedWindowsPathInput {
  mountedPath?: string;
  wslpathExecutable?: string;
  runner: ProcessRunner;
}

export class WslManualConfigurationError extends Error {
  readonly code = "WSL_MANUAL_CONFIGURATION_REQUIRED";

  constructor() {
    super("WSL Desktop bridge requires manual configuration because discovery is incomplete");
    this.name = "WslManualConfigurationError";
  }
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

function storedRegistration(registration: McpRegistration): JsonObject {
  return {
    type: "stdio",
    command: registration.command,
    args: [...registration.args],
    env: { ...registration.env },
  };
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sameStringMap(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function isWslDesktopRegistration(registration: McpRegistration): boolean {
  return Object.keys(registration.env).length === 0
    && isWindowsAbsolute(registration.command)
    && registration.args.length === 9
    && registration.args[0] === "-d"
    && registration.args[1] !== ""
    && registration.args[2] === "--exec"
    && registration.args[3] === "/usr/bin/env"
    && (registration.args[4] === "ROCKY_MCP_EXPOSURE=sanitized"
      || registration.args[4] === "ROCKY_MCP_EXPOSURE=raw")
    && registration.args[5]?.startsWith("ROCKY_HOME=/") === true
    && posix.isAbsolute(registration.args[6] ?? "")
    && posix.isAbsolute(registration.args[7] ?? "")
    && registration.args[8] === "mcp";
}

function sameWindowsCommand(left: string, right: string): boolean {
  return win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();
}

function isIdenticalDesktopRegistration(
  stored: McpRegistration,
  expected: McpRegistration,
): boolean {
  if (!isWslDesktopRegistration(expected)) {
    return isIdenticalMcpRegistration(stored, expected);
  }
  return sameWindowsCommand(stored.command, expected.command)
    && sameStringArray(stored.args, expected.args)
    && sameStringMap(stored.env, expected.env);
}

function isOwnedDesktopRegistration(
  stored: McpRegistration,
  expected: McpRegistration,
): boolean {
  if (!isWslDesktopRegistration(expected)) {
    return isOwnedRockyRegistration(stored, expected);
  }
  return isWslDesktopRegistration(stored)
    && sameWindowsCommand(stored.command, expected.command)
    && stored.args.every((argument, index) => index === 4 || argument === expected.args[index]);
}

function inspectConfig(path: string, registration: McpRegistration): ConfigInspection {
  const transaction = inspectJsonTransaction(path);
  if (transaction.status === "pending") {
    const detail = transaction.recoveryPath === undefined
      ? "Claude Desktop config update requires manual verification"
      : `Claude Desktop config update requires manual recovery: ${transaction.recoveryPath}`;
    return {
      read: { status: "invalid", error: detail },
      public: { state: "unreadable", detail },
    };
  }
  const read = readJsonObject(path);
  if (read.status === "invalid") {
    return {
      read,
      public: { state: "unreadable", detail: "Unable to read Claude Desktop config" },
    };
  }

  const existingServers = read.value.mcpServers;
  if (existingServers !== undefined && !isObject(existingServers)) {
    return {
      read,
      public: { state: "unreadable", detail: "Unable to read Claude Desktop config" },
    };
  }
  const servers = existingServers ?? {};
  if (!hasOwn(servers, "rocky")) {
    return { read, servers, public: { state: "absent" } };
  }

  const snapshot = servers.rocky;
  const parsed = parseRegistration(snapshot);
  return parsed !== undefined && isIdenticalDesktopRegistration(parsed, registration)
    ? { read, servers, snapshot, public: { state: "identical", snapshot } }
    : { read, servers, snapshot, public: { state: "conflict", snapshot } };
}

function recoverPendingMutation(
  path: string,
  registration: McpRegistration,
  guard?: JsonMutationGuard,
): SetupResult {
  const recovery = recoverJsonTransaction(path, guard);
  const detail = recovery.status === "recovered"
    ? recovery.recoveryPath === undefined
      ? "Claude Desktop config transaction recovered; retry setup"
      : `Claude Desktop config transaction recovered; live recovery: ${recovery.recoveryPath}; retry setup`
    : recovery.status === "manual"
      ? recovery.recoveryPath === undefined
        ? "Claude Desktop config update requires manual verification"
        : `Claude Desktop config update requires manual recovery: ${recovery.recoveryPath}`
      : "Claude Desktop config transaction changed; retry setup";
  return failed(detail, registration);
}

function failed(detail: string, manualRegistration?: McpRegistration): SetupResult {
  const result: SetupResult = { client: "claude-desktop", status: "failed", detail };
  if (manualRegistration !== undefined) result.manualRegistration = manualRegistration;
  return result;
}

function blocked(registration: McpRegistration): SetupResult {
  return {
    client: "claude-desktop",
    status: "blocked-by-policy",
    detail: POLICY_DETAIL,
    manualRegistration: registration,
  };
}

function mutationDetail(prefix: string, backupPath: string | undefined): string {
  return backupPath === undefined ? prefix : `${prefix}; backup: ${backupPath}`;
}

function mutationGuardUnchanged(guard: JsonMutationGuard | undefined): boolean {
  try {
    return guard?.unchanged() ?? true;
  } catch {
    return false;
  }
}

function unsafeTopology(
  registration: McpRegistration,
  backupPath?: string,
): SetupResult {
  return failed(
    mutationDetail(
      "Claude Desktop config parent topology changed; use manual configuration",
      backupPath,
    ),
    registration,
  );
}

function writeMutation(
  path: string,
  inspection: ConfigInspection,
  value: JsonObject,
  status: "configured" | "removed",
  registration: McpRegistration,
  guard?: JsonMutationGuard,
): SetupResult {
  let backupPath: string | undefined;
  let liveRecoveryPath: string | undefined;
  if (inspection.read.status === "valid") {
    if (!mutationGuardUnchanged(guard)) return unsafeTopology(registration);
    try {
      backupPath = backupFile(path, new Date(), guard);
    } catch (error) {
      const detail = error instanceof BackupFileError && error.recoveryPath !== undefined
        ? `Unable to back up Claude Desktop config; manual recovery: ${error.recoveryPath}`
        : "Unable to back up Claude Desktop config";
      return failed(detail, registration);
    }
    if (!mutationGuardUnchanged(guard)) return unsafeTopology(registration);
  }

  try {
    if (!mutationGuardUnchanged(guard)) return unsafeTopology(registration);
    const write = atomicWriteJsonIfUnchanged(path, value, inspection.read, guard);
    if (!mutationGuardUnchanged(guard)) return unsafeTopology(registration);
    if (write.status === "changed") {
      const changeDetail = write.recoveryPath === undefined
        ? "Claude Desktop config changed during setup; retry or use manual configuration"
        : `Claude Desktop config changed during setup; live recovery: ${write.recoveryPath}; retry or use manual configuration`;
      return failed(
        mutationDetail(
          changeDetail,
          backupPath,
        ),
        registration,
      );
    }
    if (write.status === "recovery-required") {
      const recoveryDetail = write.recoveryPath === undefined
        ? "Claude Desktop config update requires manual verification"
        : `Claude Desktop config update requires manual recovery: ${write.recoveryPath}`;
      return failed(
        mutationDetail(
          recoveryDetail,
          backupPath,
        ),
        registration,
      );
    }
    liveRecoveryPath = write.recoveryPath;
  } catch {
    return failed(
      mutationDetail("Unable to write Claude Desktop config", backupPath),
      registration,
    );
  }

  const result: SetupResult = { client: "claude-desktop", status };
  const details: string[] = [];
  if (backupPath !== undefined) details.push(`Claude Desktop config backup: ${backupPath}`);
  if (liveRecoveryPath !== undefined) {
    details.push(`Claude Desktop live recovery: ${liveRecoveryPath}`);
  }
  if (details.length > 0) result.detail = details.join("; ");
  return result;
}

function transformOrError(
  transform: (registration: McpRegistration) => McpRegistration,
  registration: McpRegistration,
): { ok: true; registration: McpRegistration } | { ok: false; detail: string } {
  try {
    return { ok: true, registration: transform(registration) };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof WslManualConfigurationError
        ? error.message
        : "Claude Desktop registration cannot be resolved; use manual configuration",
    };
  }
}

function healthRegistrationOrError(
  stored: McpRegistration,
  map: ((stored: McpRegistration) => McpRegistration) | undefined,
): { ok: true; registration: McpRegistration } | { ok: false } {
  if (map === undefined) return { ok: true, registration: stored };
  try {
    const mapped = map(stored);
    return mapped.name === "rocky"
      && typeof mapped.command === "string"
      && mapped.command.length > 0
      && sameStringArray(mapped.args, stored.args)
      && sameStringMap(mapped.env, stored.env)
      ? { ok: true, registration: mapped }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}

function nativeDesktopConfigPlan(platform: PlatformServices): NativeDesktopConfigPlan | undefined {
  if (platform.platform === "darwin" && posix.isAbsolute(platform.home)) {
    const directoryComponents = ["Library", "Application Support", "Claude"] as const;
    return {
      anchor: platform.home,
      directoryComponents,
      configPath: posix.join(platform.home, ...directoryComponents, "claude_desktop_config.json"),
      pathApi: posix,
    };
  }
  if (platform.platform === "win32" && platform.appData !== undefined) {
    const pathApi = isWindowsAbsolute(platform.appData)
      ? win32
      : posix.isAbsolute(platform.appData)
        ? posix
        : undefined;
    if (pathApi === undefined) return undefined;
    const directoryComponents = ["Claude"] as const;
    return {
      anchor: platform.appData,
      directoryComponents,
      configPath: pathApi.join(platform.appData, ...directoryComponents, "claude_desktop_config.json"),
      pathApi,
    };
  }
  return undefined;
}

function errorCode(error: unknown): string | undefined {
  return isObject(error) && typeof error.code === "string" ? error.code : undefined;
}

function prepareNativeConfigParent(plan: NativeDesktopConfigPlan): JsonMutationGuard | undefined {
  const retained: Array<{ path: string; dev: bigint; ino: bigint }> = [];
  const retainDirectory = (path: string): boolean => {
    try {
      const metadata = lstatSync(path, { bigint: true });
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) return false;
      retained.push({ path, dev: metadata.dev, ino: metadata.ino });
      return true;
    } catch {
      return false;
    }
  };
  const retainedUnchanged = (): boolean => retained.every((expected) => {
    try {
      const metadata = lstatSync(expected.path, { bigint: true });
      return metadata.isDirectory()
        && !metadata.isSymbolicLink()
        && metadata.dev === expected.dev
        && metadata.ino === expected.ino;
    } catch {
      return false;
    }
  });

  if (!plan.pathApi.isAbsolute(plan.anchor) || !retainDirectory(plan.anchor)) return undefined;
  let current = plan.anchor;
  for (const component of plan.directoryComponents) {
    current = plan.pathApi.join(current, component);
    try {
      const metadata = lstatSync(current, { bigint: true });
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) return undefined;
      retained.push({ path: current, dev: metadata.dev, ino: metadata.ino });
    } catch (error) {
      if (errorCode(error) !== "ENOENT") return undefined;
      try {
        mkdirSync(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (errorCode(mkdirError) !== "EEXIST") return undefined;
      }
      if (!retainDirectory(current)) return undefined;
      if (!retainedUnchanged()) return undefined;
    }
  }
  return retainedUnchanged()
    ? Object.freeze({ unchanged: retainedUnchanged })
    : undefined;
}

export function resolveDesktopConfigPath(platform: PlatformServices): string | undefined {
  return nativeDesktopConfigPlan(platform)?.configPath;
}

export function createNativeDesktopConfig(platform: PlatformServices): NativeDesktopConfig | undefined {
  const plan = nativeDesktopConfigPlan(platform);
  return plan === undefined
    ? undefined
    : {
      configPath: plan.configPath,
      prepareConfigParent: () => prepareNativeConfigParent(plan),
    };
}

export function createClaudeDesktopAdapter(
  dependencies: ClaudeDesktopAdapterDependencies,
): SetupClientAdapter {
  const transform = dependencies.transformRegistration ?? ((registration) => registration);

  function prepare(registration: McpRegistration):
    | { ok: true; registration: McpRegistration; path: string }
    | { ok: false; detail: string; manualRegistration?: McpRegistration } {
    const transformed = transformOrError(transform, registration);
    if (!transformed.ok) return transformed;
    if (dependencies.configPath === undefined
      || (!posix.isAbsolute(dependencies.configPath)
        && !isWindowsAbsolute(dependencies.configPath))) {
      return {
        ok: false,
        detail: UNRESOLVED_CONFIG_DETAIL,
        manualRegistration: transformed.registration,
      };
    }
    return { ok: true, registration: transformed.registration, path: dependencies.configPath };
  }

  return {
    id: "claude-desktop",

    async inspect(registration) {
      const prepared = prepare(registration);
      if (!prepared.ok) return { state: "blocked", detail: prepared.detail };
      return inspectConfig(prepared.path, prepared.registration).public;
    },

    async configure(registration, replace) {
      const prepared = prepare(registration);
      if (!prepared.ok) return failed(prepared.detail, prepared.manualRegistration);
      if (inspectJsonTransaction(prepared.path).status === "pending") {
        if (dependencies.policyBlocked === true) return blocked(prepared.registration);
        if (dependencies.prepareConfigParent === undefined) {
          return recoverPendingMutation(prepared.path, prepared.registration);
        }
        const guard = dependencies.prepareConfigParent();
        if (guard === undefined || !mutationGuardUnchanged(guard)) {
          return unsafeTopology(prepared.registration);
        }
        const freshTransaction = inspectJsonTransaction(prepared.path);
        if (!mutationGuardUnchanged(guard)) return unsafeTopology(prepared.registration);
        return freshTransaction.status === "pending"
          ? recoverPendingMutation(prepared.path, prepared.registration, guard)
          : failed("Claude Desktop config transaction changed; retry setup", prepared.registration);
      }
      const inspection = inspectConfig(prepared.path, prepared.registration);
      if (inspection.public.state === "identical") {
        return { client: "claude-desktop", status: "already-configured" };
      }
      if (inspection.public.state === "unreadable") {
        return failed(
          inspection.public.detail ?? "Unable to read Claude Desktop config",
          prepared.registration,
        );
      }
      if (inspection.public.state === "conflict" && !replace) {
        return {
          client: "claude-desktop",
          status: "requires-confirmation",
          detail: "Claude Desktop already has a different rocky registration",
          manualRegistration: prepared.registration,
        };
      }
      if (dependencies.policyBlocked === true) return blocked(prepared.registration);

      let currentInspection = inspection;
      let mutationGuard: JsonMutationGuard | undefined;
      if (dependencies.prepareConfigParent !== undefined) {
        mutationGuard = dependencies.prepareConfigParent();
        if (mutationGuard === undefined || !mutationGuardUnchanged(mutationGuard)) {
          return failed(
            "Claude Desktop config parent topology is unsafe; use manual configuration",
            prepared.registration,
          );
        }
        const freshTransaction = inspectJsonTransaction(prepared.path);
        if (!mutationGuardUnchanged(mutationGuard)) {
          return unsafeTopology(prepared.registration);
        }
        if (freshTransaction.status === "pending") {
          return recoverPendingMutation(prepared.path, prepared.registration, mutationGuard);
        }
        if (!mutationGuardUnchanged(mutationGuard)) return unsafeTopology(prepared.registration);
        currentInspection = inspectConfig(prepared.path, prepared.registration);
        if (!mutationGuardUnchanged(mutationGuard)) return unsafeTopology(prepared.registration);
        if (currentInspection.public.state === "identical") {
          return { client: "claude-desktop", status: "already-configured" };
        }
        if (currentInspection.public.state === "unreadable") {
          return failed(
            currentInspection.public.detail ?? "Unable to read Claude Desktop config",
            prepared.registration,
          );
        }
        if (currentInspection.public.state === "conflict" && !replace) {
          return {
            client: "claude-desktop",
            status: "requires-confirmation",
            detail: "Claude Desktop already has a different rocky registration",
            manualRegistration: prepared.registration,
          };
        }
      }

      const servers = currentInspection.servers ?? {};
      const config = currentInspection.read.status === "invalid" ? {} : currentInspection.read.value;
      return writeMutation(
        prepared.path,
        currentInspection,
        {
          ...config,
          mcpServers: {
            ...servers,
            rocky: storedRegistration(prepared.registration),
          },
        },
        "configured",
        prepared.registration,
        mutationGuard,
      );
    },

    async remove(registration) {
      const prepared = prepare(registration);
      if (!prepared.ok) return failed(prepared.detail, prepared.manualRegistration);
      if (inspectJsonTransaction(prepared.path).status === "pending") {
        if (dependencies.policyBlocked === true) return blocked(prepared.registration);
        return recoverPendingMutation(prepared.path, prepared.registration);
      }
      const inspection = inspectConfig(prepared.path, prepared.registration);
      if (inspection.public.state === "absent") {
        return { client: "claude-desktop", status: "not-configured" };
      }
      if (inspection.public.state === "unreadable") {
        return failed(inspection.public.detail ?? "Unable to read Claude Desktop config");
      }
      const parsed = parseRegistration(inspection.snapshot);
      if (parsed === undefined || !isOwnedDesktopRegistration(parsed, prepared.registration)) {
        return failed("Claude Desktop rocky registration is not owned by Rocky");
      }
      if (dependencies.policyBlocked === true) return blocked(prepared.registration);

      const servers = { ...(inspection.servers ?? {}) };
      delete servers.rocky;
      const config = inspection.read.status === "invalid" ? {} : inspection.read.value;
      return writeMutation(
        prepared.path,
        inspection,
        { ...config, mcpServers: servers },
        "removed",
        prepared.registration,
      );
    },

    async check(registration) {
      const prepared = prepare(registration);
      if (!prepared.ok) return failed(prepared.detail, prepared.manualRegistration);
      const inspection = inspectConfig(prepared.path, prepared.registration);
      if (inspection.public.state === "absent") {
        return { client: "claude-desktop", status: "not-configured" };
      }
      if (inspection.public.state === "identical" || inspection.public.state === "conflict") {
        const stored = parseRegistration(inspection.snapshot);
        if (stored !== undefined && isOwnedDesktopRegistration(stored, prepared.registration)) {
          const health = healthRegistrationOrError(stored, dependencies.mapHealthRegistration);
          return health.ok
            ? { client: "claude-desktop", status: "healthy", healthRegistration: health.registration }
            : failed("Claude Desktop local health registration cannot be resolved");
        }
      }
      if (inspection.public.state === "conflict") {
        return failed("Claude Desktop has a different rocky registration", prepared.registration);
      }
      return failed(inspection.public.detail ?? "Unable to read Claude Desktop config");
    },
  };
}

function manualConfigurationRequired(): never {
  throw new WslManualConfigurationError();
}

function isWindowsAbsolute(value: string): boolean {
  return win32.isAbsolute(value)
    && (/^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value));
}

function requireConfigAbsolute(value: string | undefined): string {
  if (value === undefined || (!posix.isAbsolute(value) && !isWindowsAbsolute(value))) {
    return manualConfigurationRequired();
  }
  return value;
}

function requireWindowsAbsolute(value: string | undefined): string {
  if (value === undefined || !isWindowsAbsolute(value)) {
    return manualConfigurationRequired();
  }
  return value;
}

function requireLinuxAbsolute(value: string | undefined): string {
  if (value === undefined || !posix.isAbsolute(value)) return manualConfigurationRequired();
  return value;
}

export function buildWslDesktopRegistration(input: WslDesktopRegistrationInput): McpRegistration {
  requireConfigAbsolute(input.windowsConfigPath);
  const command = requireWindowsAbsolute(input.wslExecutable);
  if (win32.basename(command).toLowerCase() !== "wsl.exe") return manualConfigurationRequired();
  const distro = input.distro?.trim();
  if (distro === undefined || distro.length === 0) return manualConfigurationRequired();
  const envExecutable = requireLinuxAbsolute(input.envExecutable);
  if (envExecutable !== "/usr/bin/env") return manualConfigurationRequired();
  const nodePath = requireLinuxAbsolute(input.nodePath);
  const entryPath = requireLinuxAbsolute(input.entryPath);
  const rockyHome = requireLinuxAbsolute(input.rockyHome);
  if (input.exposure !== "sanitized" && input.exposure !== "raw") {
    return manualConfigurationRequired();
  }

  return {
    name: "rocky",
    command,
    args: [
      "-d",
      distro,
      "--exec",
      envExecutable,
      `ROCKY_MCP_EXPOSURE=${input.exposure}`,
      `ROCKY_HOME=${rockyHome}`,
      nodePath,
      entryPath,
      "mcp",
    ],
    env: {},
  };
}

export async function convertMountedWindowsPath(
  input: MountedWindowsPathInput,
): Promise<string> {
  const mountedPath = requireLinuxAbsolute(input.mountedPath);
  const wslpathExecutable = requireLinuxAbsolute(input.wslpathExecutable);
  let result: ProcessResult;
  try {
    result = await input.runner.run(
      wslpathExecutable,
      ["-w", mountedPath],
      { timeoutMs: WSLPATH_TIMEOUT_MS },
    );
  } catch {
    return manualConfigurationRequired();
  }
  if (result.status !== 0 || result.error !== undefined) return manualConfigurationRequired();
  const output = result.stdout.trim();
  if (output.length === 0
    || output.split(/\r?\n/).length !== 1
    || !isWindowsAbsolute(output)) {
    return manualConfigurationRequired();
  }
  return output;
}
