import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { posix, win32 } from "node:path";
import type { PlatformPath } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  InspectionResult,
  McpRegistration,
  SetupClientAdapter,
  SetupResult,
} from "./clients.js";
import {
  atomicWriteBytesIfUnchanged,
  inspectFileTransaction,
  recoverFileTransaction,
} from "./file-transaction.js";
import type {
  BytesReadResult,
  ConditionalBytesWriteResult,
  FileMutationGuard,
  FileTransactionInspectionResult,
  FileTransactionRecoveryResult,
} from "./file-transaction.js";
import type { ProcessResult, ProcessRunner } from "./process.js";
import { isIdenticalMcpRegistration, isOwnedRockyRegistration } from "./registration.js";

const MISSING_DETAIL = "Claude Code CLI is not installed";
const MANUAL_DETAIL = "Claude Code policy-equivalent automation is unavailable; use manual registration";
const CLAUDE_COMMAND_TIMEOUT_MS = 10_000;
const EXACT_VERSION = "2.1.222";
const ADD_HELP_ARGS = ["mcp", "add", "--help"] as const;
const REMOVE_HELP_ARGS = ["mcp", "remove", "--help"] as const;
const REMOVE_ARGS = ["mcp", "remove", "--scope", "user", "rocky"] as const;
const SUPPRESSION_ENVIRONMENT = Object.freeze({
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  DISABLE_AUTOUPDATER: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
});

interface JsonObject {
  [key: string]: unknown;
}

export interface ClaudePolicyManifest {
  complete: boolean;
  version: string;
  platform: NodeJS.Platform;
  architecture: string;
  configDirRelativePaths: readonly string[];
  independentPaths: readonly string[];
  policyEnvironmentKeys: readonly string[];
  backup: {
    directoryName: string;
    filePrefix: string;
  };
}

export interface ClaudeFileTransactions {
  inspect(path: string): FileTransactionInspectionResult;
  recover(path: string, guard?: FileMutationGuard): FileTransactionRecoveryResult;
  write(
    path: string,
    bytes: Buffer,
    prior: BytesReadResult,
    guard?: FileMutationGuard,
  ): ConditionalBytesWriteResult;
}

export interface ClaudeLifecycleHooks {
  afterPublish?(path: string): void;
}

export interface ClaudeCodeAdapterDependencies {
  runner: ProcessRunner;
  userConfigPath?: string;
  executable?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  cwd?: string;
  platform?: NodeJS.Platform;
  architecture?: string;
  path?: PlatformPath;
  stagingRoot?: string;
  policyManifest?: ClaudePolicyManifest;
  fileTransactions?: ClaudeFileTransactions;
  lifecycle?: ClaudeLifecycleHooks;
}

export interface ResolveClaudeCodeUserConfigOptions {
  home: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  path: PlatformPath;
}

export type ResolvedClaudeCodeUserConfig =
  | { status: "manual" }
  | {
    status: "resolved";
    configPath: string;
    policyRoot: string;
    override: "unset" | "empty" | "absolute";
    mutationSafe: boolean;
  };

interface NodeIdentity {
  kind: "file" | "directory";
  dev: number;
  ino: number;
  nlink: number;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface NamespaceObservation {
  path: string;
  state: "missing" | "present";
  identity?: NodeIdentity;
}

interface SafeFileSnapshot {
  read: BytesReadResult;
  namespace: readonly NamespaceObservation[];
  identity?: NodeIdentity;
}

interface ConfigInspection {
  public: InspectionResult;
  snapshot?: unknown;
  root?: JsonObject;
  file?: SafeFileSnapshot;
}

interface PolicyProof {
  guard: FileMutationGuard;
}

interface PrivateStage {
  path: string;
  rootIdentity: NodeIdentity;
  identity: NodeIdentity;
}

interface AuditedStage {
  bytes: Buffer;
  parsed: JsonObject;
  guard: FileMutationGuard;
}

const fileTransactions: ClaudeFileTransactions = {
  inspect: inspectFileTransaction,
  recover: recoverFileTransaction,
  write: atomicWriteBytesIfUnchanged,
};

const incompleteProductionManifest: ClaudePolicyManifest = Object.freeze({
  complete: false,
  version: EXACT_VERSION,
  platform: process.platform,
  architecture: process.arch,
  configDirRelativePaths: Object.freeze([]),
  independentPaths: Object.freeze([]),
  policyEnvironmentKeys: Object.freeze([]),
  backup: Object.freeze({
    directoryName: "backups",
    filePrefix: ".claude.json.backup.",
  }),
});

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function errorCode(error: unknown): string | undefined {
  return isObject(error) && typeof error.code === "string" ? error.code : undefined;
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
    || !isStringMap(value.env)) return undefined;
  return {
    name: "rocky",
    command: value.command,
    args: [...value.args],
    env: { ...value.env },
  };
}

function cloneJson(value: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function identity(metadata: Stats): NodeIdentity | undefined {
  const kind = metadata.isFile() ? "file" : metadata.isDirectory() ? "directory" : undefined;
  if (kind === undefined || metadata.isSymbolicLink()) return undefined;
  return {
    kind,
    dev: metadata.dev,
    ino: metadata.ino,
    nlink: metadata.nlink,
    mode: metadata.mode & 0o777,
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    ctimeMs: metadata.ctimeMs,
  };
}

function sameIdentity(left: NodeIdentity | undefined, right: NodeIdentity | undefined): boolean {
  return left !== undefined
    && right !== undefined
    && left.kind === right.kind
    && left.dev === right.dev
    && left.ino === right.ino
    && left.nlink === right.nlink
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function sameDirectoryAuthority(
  left: NodeIdentity | undefined,
  right: NodeIdentity | undefined,
): boolean {
  return left?.kind === "directory"
    && right?.kind === "directory"
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode;
}

function observeNamespace(path: string, pathApi: PlatformPath): NamespaceObservation[] | undefined {
  if (!pathApi.isAbsolute(path)) return undefined;
  const root = pathApi.parse(path).root;
  if (root.length === 0) return undefined;
  const suffix = path.slice(root.length);
  const pieces = suffix.split(/[\\/]+/).filter(Boolean);
  const output: NamespaceObservation[] = [];
  let current = root;
  const visit = (candidate: string): boolean => {
    try {
      const metadata = lstatSync(candidate);
      const node = identity(metadata);
      if (node === undefined) return false;
      output.push({ path: candidate, state: "present", identity: node });
      return node.kind === "directory";
    } catch (error) {
      if (errorCode(error) !== "ENOENT") return false;
      output.push({ path: candidate, state: "missing" });
      return false;
    }
  };
  if (!visit(root) && pieces.length > 0) return undefined;
  for (let index = 0; index < pieces.length; index += 1) {
    current = pathApi.join(current, pieces[index]!);
    const canDescend = visit(current);
    const observed = output.at(-1)!;
    if (observed.state === "missing") {
      for (const remainder of pieces.slice(index + 1)) {
        current = pathApi.join(current, remainder);
        output.push({ path: current, state: "missing" });
      }
      break;
    }
    if (!canDescend && index < pieces.length - 1) return undefined;
  }
  return output;
}

function namespaceUnchanged(
  expected: readonly NamespaceObservation[],
  pathApi: PlatformPath,
): boolean {
  const current = observeNamespace(expected.at(-1)?.path ?? "", pathApi);
  return current !== undefined
    && current.length === expected.length
    && current.every((entry, index) => {
      const prior = expected[index]!;
      return entry.path === prior.path
        && entry.state === prior.state
        && (entry.state === "missing"
          || (entry.identity?.kind === "directory"
            ? sameDirectoryAuthority(entry.identity, prior.identity)
            : sameIdentity(entry.identity, prior.identity)));
    });
}

function readFlags(): number {
  const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  const nonblock = process.platform === "win32" ? 0 : fsConstants.O_NONBLOCK;
  return fsConstants.O_RDONLY | noFollow | nonblock;
}

function readSafeFile(path: string, pathApi: PlatformPath): SafeFileSnapshot | undefined {
  const namespace = observeNamespace(path, pathApi);
  if (namespace === undefined) return undefined;
  const final = namespace.at(-1);
  if (final?.state === "missing") return { read: { status: "missing" }, namespace };
  if (final?.identity?.kind !== "file" || final.identity.nlink !== 1) return undefined;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, readFlags());
    const before = identity(fstatSync(descriptor));
    if (!sameIdentity(before, final.identity)) return undefined;
    const bytes = readFileSync(descriptor);
    const after = identity(fstatSync(descriptor));
    const finalPath = identity(lstatSync(path));
    if (!sameIdentity(before, after)
      || !sameIdentity(after, finalPath)
      || bytes.length !== after?.size) return undefined;
    return {
      read: { status: "valid", bytes, mode: after.mode },
      namespace,
      identity: after,
    };
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* read remains failed closed */ }
    }
  }
}

function fileSnapshotUnchanged(snapshot: SafeFileSnapshot, pathApi: PlatformPath): boolean {
  const path = snapshot.namespace.at(-1)?.path;
  if (path === undefined || !namespaceUnchanged(snapshot.namespace, pathApi)) return false;
  const current = readSafeFile(path, pathApi);
  if (current === undefined || current.read.status !== snapshot.read.status) return false;
  if (snapshot.read.status === "missing") return true;
  return current.read.status === "valid"
    && current.read.bytes.equals(snapshot.read.bytes)
    && current.read.mode === snapshot.read.mode;
}

function parseConfig(file: SafeFileSnapshot, registration: McpRegistration): ConfigInspection {
  let root: JsonObject;
  if (file.read.status === "missing") root = {};
  else {
    try {
      const parsed: unknown = JSON.parse(file.read.bytes.toString("utf8"));
      if (!isObject(parsed)) throw new Error("invalid root");
      root = parsed;
    } catch {
      return {
        file,
        public: { state: "unreadable", detail: "Unable to read Claude Code user config" },
      };
    }
  }
  const servers = root.mcpServers;
  if (servers !== undefined && !isObject(servers)) {
    return {
      file,
      root,
      public: { state: "unreadable", detail: "Unable to read Claude Code user config" },
    };
  }
  if (servers === undefined || !hasOwn(servers, "rocky")) {
    return { file, root, public: { state: "absent" } };
  }
  const snapshot = servers.rocky;
  const stored = parseRegistration(snapshot);
  return stored !== undefined && isIdenticalMcpRegistration(stored, registration)
    ? { file, root, snapshot, public: { state: "identical", snapshot } }
    : { file, root, snapshot, public: { state: "conflict", snapshot } };
}

export function resolveClaudeCodeUserConfig(
  options: ResolveClaudeCodeUserConfigOptions,
): ResolvedClaudeCodeUserConfig {
  const configured = options.env.CLAUDE_CONFIG_DIR;
  if (configured === undefined) {
    if (!options.path.isAbsolute(options.home)) return { status: "manual" };
    return {
      status: "resolved",
      configPath: options.path.join(options.home, ".claude.json"),
      policyRoot: options.path.join(options.home, ".claude"),
      override: "unset",
      mutationSafe: true,
    };
  }
  if (configured === "") {
    if (!options.path.isAbsolute(options.home) || !options.path.isAbsolute(options.cwd)) {
      return { status: "manual" };
    }
    return {
      status: "resolved",
      configPath: options.path.join(options.home, ".claude.json"),
      policyRoot: options.path.resolve(options.cwd, ""),
      override: "empty",
      mutationSafe: false,
    };
  }
  if (!options.path.isAbsolute(configured)) return { status: "manual" };
  const normalizedPolicyRoot = configured.normalize("NFC");
  return {
    status: "resolved",
    configPath: options.path.join(configured, ".claude.json"),
    policyRoot: normalizedPolicyRoot,
    override: "absolute",
    mutationSafe: normalizedPolicyRoot === configured,
  };
}

function addArguments(registration: McpRegistration): string[] {
  const args = ["mcp", "add", "--scope", "user", "--transport", "stdio", registration.name];
  for (const [name, value] of Object.entries(registration.env)) {
    args.push("--env", `${name}=${value}`);
  }
  args.push("--", registration.command, ...registration.args);
  return args;
}

function succeeded(result: ProcessResult): boolean {
  return result.status === 0 && result.error === undefined;
}

function isPolicyRefusal(result: ProcessResult): boolean {
  return /enterprise|managed|policy|administrator|not allowed|disabled by/i.test(
    `${result.stdout}\n${result.stderr}\n${result.error?.message ?? ""}`,
  );
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

function manual(registration?: McpRegistration): SetupResult {
  return failed(MANUAL_DETAIL, registration);
}

function withRecovery(prefix: string, recoveryPath: string | undefined): string {
  return recoveryPath === undefined ? prefix : `${prefix}; manual recovery: ${recoveryPath}`;
}

function validManifest(
  manifest: ClaudePolicyManifest,
  platform: NodeJS.Platform,
  architecture: string,
  pathApi: PlatformPath,
): boolean {
  if (!manifest.complete
    || manifest.version !== EXACT_VERSION
    || manifest.platform !== platform
    || manifest.architecture !== architecture
    || manifest.backup.directoryName !== "backups"
    || manifest.backup.filePrefix !== ".claude.json.backup.") return false;
  const relative = new Set<string>();
  for (const path of manifest.configDirRelativePaths) {
    if (path.length === 0
      || pathApi.isAbsolute(path)
      || path.split(/[\\/]+/).some((part) => part === "..")
      || relative.has(path)) return false;
    relative.add(path);
  }
  const independent = new Set<string>();
  for (const path of manifest.independentPaths) {
    if (!pathApi.isAbsolute(path) || independent.has(path)) return false;
    independent.add(path);
  }
  return new Set(manifest.policyEnvironmentKeys).size === manifest.policyEnvironmentKeys.length;
}

function hasUnknownPolicyEnvironment(
  env: NodeJS.ProcessEnv,
  manifest: ClaudePolicyManifest,
): boolean {
  const allowed = new Set([
    "CLAUDE_CONFIG_DIR",
    ...Object.keys(SUPPRESSION_ENVIRONMENT),
    ...manifest.policyEnvironmentKeys,
  ]);
  return Object.keys(env).some((key) => (
    (key.startsWith("CLAUDE_") || key.startsWith("ANTHROPIC_")) && !allowed.has(key)
  ));
}

function capturePolicyProof(
  manifest: ClaudePolicyManifest,
  resolved: Extract<ResolvedClaudeCodeUserConfig, { status: "resolved" }>,
  cwd: string,
  env: NodeJS.ProcessEnv,
  pathApi: PlatformPath,
  parentNamespace: readonly NamespaceObservation[],
): PolicyProof | undefined {
  if (hasUnknownPolicyEnvironment(env, manifest)) return undefined;
  const cwdNamespace = observeNamespace(cwd, pathApi);
  if (cwdNamespace?.at(-1)?.identity?.kind !== "directory") return undefined;
  const snapshots: SafeFileSnapshot[] = [];
  for (const relative of manifest.configDirRelativePaths) {
    const snapshot = readSafeFile(pathApi.join(resolved.policyRoot, relative), pathApi);
    if (snapshot === undefined || snapshot.read.status !== "missing") return undefined;
    snapshots.push(snapshot);
  }
  for (const path of manifest.independentPaths) {
    const snapshot = readSafeFile(path, pathApi);
    if (snapshot === undefined) return undefined;
    snapshots.push(snapshot);
  }
  return {
    guard: {
      unchanged: () => namespaceUnchanged(parentNamespace, pathApi)
        && namespaceUnchanged(cwdNamespace, pathApi)
        && snapshots.every((snapshot) => fileSnapshotUnchanged(snapshot, pathApi)),
    },
  };
}

function createPrivateStage(stagingRoot: string, pathApi: PlatformPath): PrivateStage | undefined {
  if (!pathApi.isAbsolute(stagingRoot)) return undefined;
  try {
    const rootIdentity = identity(lstatSync(stagingRoot));
    if (rootIdentity?.kind !== "directory") return undefined;
    const path = mkdtempSync(pathApi.join(stagingRoot, "rocky-claude-code-"));
    chmodSync(path, 0o700);
    const stageIdentity = identity(lstatSync(path));
    if (stageIdentity?.kind !== "directory"
      || (process.platform !== "win32" && stageIdentity.mode !== 0o700)) return undefined;
    return { path, rootIdentity, identity: stageIdentity };
  } catch {
    return undefined;
  }
}

function stageIdentityUnchanged(stage: PrivateStage, stagingRoot: string): boolean {
  try {
    return sameDirectoryAuthority(identity(lstatSync(stagingRoot)), stage.rootIdentity)
      && sameDirectoryAuthority(identity(lstatSync(stage.path)), stage.identity);
  } catch {
    return false;
  }
}

function removeExactFile(path: string, expected: NodeIdentity): boolean {
  try {
    if (!sameIdentity(identity(lstatSync(path)), expected)) return false;
    rmSync(path);
    return true;
  } catch {
    return false;
  }
}

function cleanupEmptyStage(stage: PrivateStage, stagingRoot: string): boolean {
  try {
    if (!stageIdentityUnchanged(stage, stagingRoot) || readdirSync(stage.path).length !== 0) return false;
    rmdirSync(stage.path);
    return sameDirectoryAuthority(identity(lstatSync(stagingRoot)), stage.rootIdentity);
  } catch {
    return false;
  }
}

function cleanupAuditedStage(
  stage: PrivateStage,
  stagingRoot: string,
  pathApi: PlatformPath,
  configIdentity: NodeIdentity,
  backupDirectoryIdentity: NodeIdentity,
  backupPath: string,
  backupIdentity: NodeIdentity,
): boolean {
  try {
    if (!stageIdentityUnchanged(stage, stagingRoot)) return false;
    const configPath = pathApi.join(stage.path, ".claude.json");
    const backupDirectory = pathApi.dirname(backupPath);
    if (!removeExactFile(configPath, configIdentity)
      || !removeExactFile(backupPath, backupIdentity)
      || !sameDirectoryAuthority(identity(lstatSync(backupDirectory)), backupDirectoryIdentity)
      || readdirSync(backupDirectory).length !== 0) return false;
    rmdirSync(backupDirectory);
    if (!stageIdentityUnchanged(stage, stagingRoot) || readdirSync(stage.path).length !== 0) return false;
    rmdirSync(stage.path);
    return sameDirectoryAuthority(identity(lstatSync(stagingRoot)), stage.rootIdentity);
  } catch {
    return false;
  }
}

function forcedEnvironment(env: NodeJS.ProcessEnv, stage: string): NodeJS.ProcessEnv {
  return {
    ...env,
    ...SUPPRESSION_ENVIRONMENT,
    CLAUDE_CONFIG_DIR: stage,
  };
}

function exactVersion(result: ProcessResult): boolean {
  if (!succeeded(result)) return false;
  return result.stdout.trim() === `${EXACT_VERSION} (Claude Code)`;
}

function addHelpIsExact(result: ProcessResult): boolean {
  return succeeded(result)
    && /Usage:\s+claude mcp add \[options\] <name> <commandOrUrl> \[args\.\.\.\]/.test(result.stdout)
    && /--scope\s+<scope>/.test(result.stdout)
    && /--env\s+<env\.\.\.>/.test(result.stdout)
    && /--transport\s+<transport>/.test(result.stdout);
}

function removeHelpIsExact(result: ProcessResult): boolean {
  return succeeded(result)
    && /Usage:\s+claude mcp remove \[options\] <name>/.test(result.stdout)
    && /--scope\s+<scope>/.test(result.stdout);
}

async function proveCapability(
  runner: ProcessRunner,
  executable: string,
  stage: PrivateStage,
  stagingRoot: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<boolean> {
  const options = {
    timeoutMs: CLAUDE_COMMAND_TIMEOUT_MS,
    env: forcedEnvironment(env, stage.path),
    cwd,
  };
  let capable = false;
  try {
    const version = await runner.run(executable, ["--version"], options);
    if (!exactVersion(version)) return false;
    const addHelp = await runner.run(executable, ADD_HELP_ARGS, options);
    if (!addHelpIsExact(addHelp)) return false;
    const removeHelp = await runner.run(executable, REMOVE_HELP_ARGS, options);
    capable = removeHelpIsExact(removeHelp);
  } catch {
    capable = false;
  } finally {
    if (!cleanupEmptyStage(stage, stagingRoot)) capable = false;
  }
  return capable;
}

function copySnapshotToStage(
  stage: PrivateStage,
  snapshot: SafeFileSnapshot,
  pathApi: PlatformPath,
): boolean {
  if (snapshot.read.status === "missing") return true;
  const configPath = pathApi.join(stage.path, ".claude.json");
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      configPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      snapshot.read.mode ?? 0o600,
    );
    writeFileSync(descriptor, snapshot.read.bytes);
    closeSync(descriptor);
    descriptor = undefined;
    if (snapshot.read.mode !== undefined) chmodSync(configPath, snapshot.read.mode);
    const cloned = readSafeFile(configPath, pathApi);
    return cloned?.read.status === "valid"
      && cloned.read.bytes.equals(snapshot.read.bytes)
      && cloned.read.mode === snapshot.read.mode;
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* stage remains private for recovery */ }
    }
  }
}

function nonRockyState(root: JsonObject): JsonObject {
  const cloned = cloneJson(root);
  if (isObject(cloned.mcpServers)) delete cloned.mcpServers.rocky;
  return cloned;
}

function auditStage(
  stage: PrivateStage,
  stagingRoot: string,
  original: ConfigInspection,
  operation: "configure" | "remove",
  registration: McpRegistration,
  manifest: ClaudePolicyManifest,
  pathApi: PlatformPath,
): AuditedStage | undefined {
  if (!stageIdentityUnchanged(stage, stagingRoot) || original.file === undefined || original.root === undefined) {
    return undefined;
  }
  const configPath = pathApi.join(stage.path, ".claude.json");
  const backupDirectory = pathApi.join(stage.path, manifest.backup.directoryName);
  let rootEntries: string[];
  let backupEntries: string[];
  try {
    rootEntries = readdirSync(stage.path).sort();
    if (!isDeepStrictEqual(rootEntries, [".claude.json", manifest.backup.directoryName].sort())) return undefined;
    const backupDirectoryIdentity = identity(lstatSync(backupDirectory));
    if (backupDirectoryIdentity?.kind !== "directory") return undefined;
    backupEntries = readdirSync(backupDirectory);
    if (backupEntries.length !== 1) return undefined;
    const backupName = backupEntries[0]!;
    if (!backupName.startsWith(manifest.backup.filePrefix)
      || !/^\d+$/.test(backupName.slice(manifest.backup.filePrefix.length))) return undefined;
    const backupPath = pathApi.join(backupDirectory, backupName);
    const backup = readSafeFile(backupPath, pathApi);
    const staged = readSafeFile(configPath, pathApi);
    if (original.file.read.status !== "valid"
      || backup?.read.status !== "valid"
      || staged?.read.status !== "valid"
      || !backup.read.bytes.equals(original.file.read.bytes)
      || backup.read.mode !== original.file.read.mode
      || staged.read.mode !== original.file.read.mode
      || backup.identity === undefined
      || staged.identity === undefined) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(staged.read.bytes.toString("utf8"));
    } catch {
      return undefined;
    }
    if (!isObject(parsed)) return undefined;
    const servers = parsed.mcpServers;
    if (servers !== undefined && !isObject(servers)) return undefined;
    if (operation === "configure") {
      if (!isObject(servers) || !hasOwn(servers, "rocky")) return undefined;
      const stored = parseRegistration(servers.rocky);
      if (stored === undefined || !isIdenticalMcpRegistration(stored, registration)) return undefined;
    } else if (isObject(servers) && hasOwn(servers, "rocky")) return undefined;
    if (!isDeepStrictEqual(nonRockyState(original.root), nonRockyState(parsed))) return undefined;
    const proof = {
      unchanged: () => {
        try {
          return stageIdentityUnchanged(stage, stagingRoot)
            && isDeepStrictEqual(readdirSync(stage.path).sort(), rootEntries)
            && sameDirectoryAuthority(identity(lstatSync(backupDirectory)), backupDirectoryIdentity)
            && isDeepStrictEqual(readdirSync(backupDirectory).sort(), [...backupEntries].sort())
            && fileSnapshotUnchanged(staged, pathApi)
            && fileSnapshotUnchanged(backup, pathApi);
        } catch {
          return false;
        }
      },
    };
    (proof as FileMutationGuard & { cleanup: () => boolean }).cleanup = () => cleanupAuditedStage(
      stage,
      stagingRoot,
      pathApi,
      staged.identity!,
      backupDirectoryIdentity,
      backupPath,
      backup.identity!,
    );
    return { bytes: staged.read.bytes, parsed, guard: proof };
  } catch {
    return undefined;
  }
}

function combineGuards(...guards: readonly FileMutationGuard[]): FileMutationGuard {
  return { unchanged: () => guards.every((guard) => {
    try { return guard.unchanged(); } catch { return false; }
  }) };
}

function auditCleanup(audit: AuditedStage): boolean {
  const cleanup = (audit.guard as FileMutationGuard & { cleanup?: () => boolean }).cleanup;
  return cleanup?.() ?? false;
}

function inspectUserConfig(
  resolved: ResolvedClaudeCodeUserConfig,
  registration: McpRegistration,
  pathApi: PlatformPath,
  transactions: ClaudeFileTransactions,
  inspectTransaction = true,
): ConfigInspection {
  if (resolved.status === "manual") {
    return { public: { state: "unreadable", detail: "Claude Code config path requires manual setup" } };
  }
  if (inspectTransaction && transactions.inspect(resolved.configPath).status === "pending") {
    return {
      public: {
        state: "unreadable",
        detail: "Claude Code config recovery is pending; retry after recovery",
      },
    };
  }
  const parentNamespace = observeNamespace(pathApi.dirname(resolved.configPath), pathApi);
  if (parentNamespace?.at(-1)?.identity?.kind !== "directory") {
    return {
      public: {
        state: "unreadable",
        detail: "Claude Code user config parent topology requires manual setup",
      },
    };
  }
  const file = readSafeFile(resolved.configPath, pathApi);
  if (file === undefined) {
    return {
      public: {
        state: "unreadable",
        detail: "Claude Code user config must be a single-link regular file",
      },
    };
  }
  return parseConfig(file, registration);
}

function recoveryResult(
  result: FileTransactionRecoveryResult,
  registration: McpRegistration | undefined,
): SetupResult | undefined {
  if (result.status === "clear") return undefined;
  if (result.status === "recovered") {
    return failed(withRecovery(
      "Claude Code config recovery completed; retry setup",
      result.recoveryPath,
    ), registration);
  }
  return failed(withRecovery(
    "Claude Code config requires manual recovery",
    result.recoveryPath,
  ), registration);
}

export function createClaudeCodeAdapter(
  dependencies: ClaudeCodeAdapterDependencies,
): SetupClientAdapter {
  const { runner, executable } = dependencies;
  const platform = dependencies.platform ?? process.platform;
  const architecture = dependencies.architecture ?? process.arch;
  const pathApi = dependencies.path ?? (platform === "win32" ? win32 : posix);
  const setupEnv = { ...(dependencies.env ?? process.env) };
  const cwd = dependencies.cwd ?? process.cwd();
  const home = dependencies.home ?? homedir();
  const stagingRoot = dependencies.stagingRoot ?? tmpdir();
  const manifest = dependencies.policyManifest ?? incompleteProductionManifest;
  const transactions = dependencies.fileTransactions ?? fileTransactions;
  const resolved = dependencies.userConfigPath === undefined
    ? resolveClaudeCodeUserConfig({ home, cwd, env: setupEnv, path: pathApi })
    : pathApi.isAbsolute(dependencies.userConfigPath)
      ? {
        status: "resolved" as const,
        configPath: dependencies.userConfigPath,
        policyRoot: pathApi.dirname(dependencies.userConfigPath),
        override: "absolute" as const,
        mutationSafe: dependencies.userConfigPath.normalize("NFC") === dependencies.userConfigPath,
      }
      : { status: "manual" as const };

  async function runMutation(
    operation: "configure" | "remove",
    inspection: ConfigInspection,
    registration: McpRegistration,
    replace: boolean,
  ): Promise<SetupResult> {
    if (resolved.status === "manual"
      || !resolved.mutationSafe
      || inspection.file === undefined
      || inspection.root === undefined
      || !validManifest(manifest, platform, architecture, pathApi)) return manual(operation === "configure" ? registration : undefined);

    const parentNamespace = observeNamespace(pathApi.dirname(resolved.configPath), pathApi);
    if (parentNamespace?.at(-1)?.identity?.kind !== "directory") return manual(operation === "configure" ? registration : undefined);
    const policy = capturePolicyProof(
      manifest,
      resolved,
      cwd,
      setupEnv,
      pathApi,
      parentNamespace,
    );
    if (policy === undefined) return manual(operation === "configure" ? registration : undefined);

    const capabilityStage = createPrivateStage(stagingRoot, pathApi);
    if (capabilityStage === undefined) return manual(operation === "configure" ? registration : undefined);
    if (!await proveCapability(
      runner,
      executable!,
      capabilityStage,
      stagingRoot,
      setupEnv,
      cwd,
    )) return manual(operation === "configure" ? registration : undefined);

    const stage = createPrivateStage(stagingRoot, pathApi);
    if (stage === undefined || !copySnapshotToStage(stage, inspection.file, pathApi)) {
      return failed(withRecovery(
        "Unable to create exact private Claude Code stage",
        stage?.path,
      ), operation === "configure" ? registration : undefined);
    }
    const beforeNames = readdirSync(stage.path).sort();
    const expectedBefore = inspection.file.read.status === "valid" ? [".claude.json"] : [];
    if (!isDeepStrictEqual(beforeNames, expectedBefore)
      || !policy.guard.unchanged()
      || !fileSnapshotUnchanged(inspection.file, pathApi)) {
      if (!cleanupEmptyStage(stage, stagingRoot)) {
        return failed(`Claude Code staging stopped; manual recovery: ${stage.path}`,
          operation === "configure" ? registration : undefined);
      }
      return manual(operation === "configure" ? registration : undefined);
    }

    const run = async (args: readonly string[]): Promise<ProcessResult> => runner.run(
      executable!,
      args,
      {
        timeoutMs: CLAUDE_COMMAND_TIMEOUT_MS,
        env: forcedEnvironment(setupEnv, stage.path),
        cwd,
      },
    );
    const commands = operation === "remove"
      ? [REMOVE_ARGS]
      : replace ? [REMOVE_ARGS, addArguments(registration)] : [addArguments(registration)];
    for (const args of commands) {
      let outcome: ProcessResult;
      try {
        outcome = await run(args);
      } catch {
        return failed(`Claude Code staged transformation failed; manual recovery: ${stage.path}`,
          operation === "configure" ? registration : undefined);
      }
      if (!succeeded(outcome)) {
        const result = isPolicyRefusal(outcome)
          ? blocked("Claude Code policy refused staged registration update",
            operation === "configure" ? registration : undefined)
          : failed("Claude Code staged registration update failed",
            operation === "configure" ? registration : undefined);
        const cleaned = cleanupEmptyStage(stage, stagingRoot);
        return cleaned
          ? result
          : { ...result, detail: withRecovery(result.detail ?? "Claude Code staged update failed", stage.path) };
      }
    }

    const audited = auditStage(
      stage,
      stagingRoot,
      inspection,
      operation,
      registration,
      manifest,
      pathApi,
    );
    if (audited === undefined || !policy.guard.unchanged() || !fileSnapshotUnchanged(inspection.file, pathApi)) {
      return failed(`Claude Code staged audit failed; manual recovery: ${stage.path}`,
        operation === "configure" ? registration : undefined);
    }
    const guard = combineGuards(policy.guard, audited.guard);
    let written: ConditionalBytesWriteResult;
    try {
      written = transactions.write(
        resolved.configPath,
        audited.bytes,
        inspection.file.read,
        guard,
      );
    } catch {
      if (!auditCleanup(audited)) {
        return failed(`Claude Code stage cleanup requires manual recovery: ${stage.path}`,
          operation === "configure" ? registration : undefined);
      }
      return failed("Unable to publish staged Claude Code registration",
        operation === "configure" ? registration : undefined);
    }
    if (written.status !== "written") {
      if (!auditCleanup(audited)) {
        return failed(`Claude Code stage cleanup requires manual recovery: ${stage.path}`,
          operation === "configure" ? registration : undefined);
      }
      return failed(withRecovery(
        written.status === "changed"
          ? "Claude Code config changed before publication"
          : "Claude Code publication requires manual recovery",
        written.recoveryPath,
      ), operation === "configure" ? registration : undefined);
    }
    try { dependencies.lifecycle?.afterPublish?.(resolved.configPath); } catch { /* verification decides */ }
    const verified = readSafeFile(resolved.configPath, pathApi);
    let verifiedRoot: unknown;
    try {
      verifiedRoot = verified?.read.status === "valid"
        ? JSON.parse(verified.read.bytes.toString("utf8"))
        : undefined;
    } catch {
      verifiedRoot = undefined;
    }
    const exact = inspection.file.read.status === "valid"
      && verified?.read.status === "valid"
      && verified.read.bytes.equals(audited.bytes)
      && verified.read.mode === inspection.file.read.mode
      && isObject(verifiedRoot)
      && isDeepStrictEqual(verifiedRoot, audited.parsed);
    if (!auditCleanup(audited)) {
      return failed(`Claude Code stage cleanup requires manual recovery: ${stage.path}`,
        operation === "configure" ? registration : undefined);
    }
    if (!exact) {
      return failed(withRecovery(
        "Claude Code published state could not be verified",
        written.recoveryPath,
      ), operation === "configure" ? registration : undefined);
    }
    const detail = written.recoveryPath === undefined
      ? undefined
      : `Claude Code recovery artifact: ${written.recoveryPath}`;
    return operation === "configure"
      ? { client: "claude-code", status: "configured", ...(detail === undefined ? {} : { detail }) }
      : { client: "claude-code", status: "removed", ...(detail === undefined ? {} : { detail }) };
  }

  return {
    id: "claude-code",

    async inspect(registration) {
      if (executable === undefined) return { state: "blocked", detail: MISSING_DETAIL };
      return inspectUserConfig(resolved, registration, pathApi, transactions).public;
    },

    async configure(registration, replace) {
      if (executable === undefined) return skipped();
      if (resolved.status === "manual") return manual(registration);
      const recovered = recoveryResult(transactions.recover(resolved.configPath), registration);
      if (recovered !== undefined) return recovered;
      const inspection = inspectUserConfig(resolved, registration, pathApi, transactions, false);
      if (inspection.public.state === "identical") {
        return { client: "claude-code", status: "already-configured" };
      }
      if (inspection.public.state === "unreadable") {
        return failed(inspection.public.detail ?? "Unable to read Claude Code user config", registration);
      }
      if (inspection.public.state === "conflict" && !replace) {
        return {
          client: "claude-code",
          status: "requires-confirmation",
          detail: "Claude Code already has a different rocky registration",
          manualRegistration: registration,
        };
      }
      return runMutation("configure", inspection, registration, inspection.public.state === "conflict");
    },

    async remove(registration) {
      if (executable === undefined) return skipped();
      if (resolved.status === "manual") return manual();
      const recovered = recoveryResult(transactions.recover(resolved.configPath), undefined);
      if (recovered !== undefined) return recovered;
      const inspection = inspectUserConfig(resolved, registration, pathApi, transactions, false);
      if (inspection.public.state === "absent") {
        return { client: "claude-code", status: "not-configured" };
      }
      if (inspection.public.state === "unreadable") {
        return failed(inspection.public.detail ?? "Unable to read Claude Code user config");
      }
      const stored = parseRegistration(inspection.snapshot);
      if (stored === undefined || !isOwnedRockyRegistration(stored, registration)) {
        return failed("Claude Code rocky registration is not owned by Rocky");
      }
      return runMutation("remove", inspection, registration, false);
    },

    async check(registration) {
      if (executable === undefined) return skipped();
      const inspection = inspectUserConfig(resolved, registration, pathApi, transactions);
      if (inspection.public.state === "absent") {
        return { client: "claude-code", status: "not-configured" };
      }
      if (inspection.public.state === "identical" || inspection.public.state === "conflict") {
        const stored = parseRegistration(inspection.snapshot);
        if (stored !== undefined && isOwnedRockyRegistration(stored, registration)) {
          return { client: "claude-code", status: "healthy", healthRegistration: stored };
        }
      }
      if (inspection.public.state === "conflict") {
        return failed("Claude Code has a different rocky registration", registration);
      }
      return failed(inspection.public.detail ?? "Unable to read Claude Code user config", registration);
    },
  };
}
