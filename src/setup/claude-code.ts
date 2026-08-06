import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
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
const MANUAL_CONFIGURE_DETAIL = "Claude Code policy-equivalent automation is unavailable; use manual registration";
const MANUAL_REMOVE_DETAIL = "Claude Code automated removal is unavailable; remove Rocky manually from Claude Code user MCP configuration";
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
  rootNamespace: readonly NamespaceObservation[];
  identity: NodeIdentity;
}

interface AuditedStage {
  bytes: Buffer;
  parsed: JsonObject;
  guard: FileMutationGuard;
}

interface TargetTransactionGuard extends FileMutationGuard {
  authoritativeRecoveryPath(path: string | undefined): string | undefined;
  finalAuthority(
    path: string | undefined,
    interveningGuard: FileMutationGuard,
  ): { status: "authoritative"; recoveryPath: string } | { status: "changed" };
}

interface HeldFileObservation {
  descriptor: number;
  identity: NodeIdentity;
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
    || !isDeepStrictEqual(Object.keys(value).sort(), ["args", "command", "env", "type"])
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
  const visit = (
    candidate: string,
  ): "directory" | "terminal" | "missing" | "invalid" => {
    try {
      const metadata = lstatSync(candidate);
      const node = identity(metadata);
      if (node === undefined) return "invalid";
      output.push({ path: candidate, state: "present", identity: node });
      return node.kind === "directory" ? "directory" : "terminal";
    } catch (error) {
      if (errorCode(error) !== "ENOENT") return "invalid";
      output.push({ path: candidate, state: "missing" });
      return "missing";
    }
  };
  if (visit(root) !== "directory") return undefined;
  for (let index = 0; index < pieces.length; index += 1) {
    current = pathApi.join(current, pieces[index]!);
    const state = visit(current);
    if (state === "invalid") return undefined;
    if (state === "missing") {
      for (const remainder of pieces.slice(index + 1)) {
        current = pathApi.join(current, remainder);
        output.push({ path: current, state: "missing" });
      }
      break;
    }
    if (state === "terminal" && index < pieces.length - 1) return undefined;
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

function pathMissing(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    return errorCode(error) === "ENOENT";
  }
}

function exactObservedFile(
  path: string,
  expectedBytes: Buffer,
  expectedMode: number | undefined,
  expectedIdentity?: Pick<NodeIdentity, "dev" | "ino">,
): NodeIdentity | undefined {
  let descriptor: number | undefined;
  try {
    const before = identity(lstatSync(path));
    if (before?.kind !== "file"
      || (expectedMode !== undefined && before.mode !== expectedMode)
      || (expectedIdentity !== undefined
        && (before.dev !== expectedIdentity.dev || before.ino !== expectedIdentity.ino))) {
      return undefined;
    }
    descriptor = openSync(path, readFlags());
    const opened = identity(fstatSync(descriptor));
    if (!sameIdentity(before, opened)) return undefined;
    const bytes = readFileSync(descriptor);
    const after = identity(fstatSync(descriptor));
    const finalPath = identity(lstatSync(path));
    return bytes.equals(expectedBytes)
      && sameIdentity(opened, after)
      && sameIdentity(after, finalPath)
      ? after
      : undefined;
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* failed closed */ }
    }
  }
}

function readDescriptorExactly(descriptor: number, length: number): Buffer | undefined {
  if (!Number.isSafeInteger(length) || length < 0) return undefined;
  const bytes = Buffer.alloc(length);
  let offset = 0;
  try {
    while (offset < length) {
      const count = readSync(descriptor, bytes, offset, length - offset, offset);
      if (count <= 0) return undefined;
      offset += count;
    }
    return bytes;
  } catch {
    return undefined;
  }
}

function openHeldExactFile(
  path: string,
  expectedBytes: Buffer,
  expectedMode: number | undefined,
  expectedIdentity: Pick<NodeIdentity, "dev" | "ino"> | undefined,
  expectedLinks: number,
): HeldFileObservation | undefined {
  let descriptor: number | undefined;
  let retained = false;
  try {
    const before = identity(lstatSync(path));
    if (before?.kind !== "file"
      || before.nlink !== expectedLinks
      || before.size !== expectedBytes.length
      || (expectedMode !== undefined && before.mode !== expectedMode)
      || (expectedIdentity !== undefined
        && (before.dev !== expectedIdentity.dev || before.ino !== expectedIdentity.ino))) {
      return undefined;
    }
    descriptor = openSync(path, readFlags());
    const opened = identity(fstatSync(descriptor));
    if (!sameIdentity(before, opened)) return undefined;
    const bytes = readDescriptorExactly(descriptor, expectedBytes.length);
    const after = identity(fstatSync(descriptor));
    const observedPath = identity(lstatSync(path));
    if (bytes === undefined
      || after === undefined
      || observedPath === undefined
      || !bytes.equals(expectedBytes)
      || !sameIdentity(opened, after)
      || !sameIdentity(after, observedPath)) return undefined;
    retained = true;
    return { descriptor, identity: after };
  } catch {
    return undefined;
  } finally {
    if (!retained && descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* failed closed */ }
    }
  }
}

function rereadHeldExactFile(
  held: HeldFileObservation,
  expectedBytes: Buffer,
  expectedMode: number | undefined,
  expectedIdentity: Pick<NodeIdentity, "dev" | "ino"> | undefined,
  expectedLinks: number,
): NodeIdentity | undefined {
  const bytes = readDescriptorExactly(held.descriptor, expectedBytes.length);
  const observed = identity(fstatSync(held.descriptor));
  if (bytes === undefined || observed === undefined) return undefined;
  return bytes.equals(expectedBytes)
    && sameIdentity(held.identity, observed)
    && observed.nlink === expectedLinks
    && observed.size === expectedBytes.length
    && (expectedMode === undefined || observed.mode === expectedMode)
    && (expectedIdentity === undefined
      || (observed.dev === expectedIdentity.dev && observed.ino === expectedIdentity.ino))
    ? observed
    : undefined;
}

function closeHeldFile(held: HeldFileObservation | undefined): void {
  if (held === undefined) return;
  try { closeSync(held.descriptor); } catch { /* authority already failed closed */ }
}

function transactionManifestState(
  transactionDirectory: string,
  target: string,
  pathApi: PlatformPath,
): "prepared" | "displaced" | "published" | "committed" | undefined {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(pathApi.join(transactionDirectory, "manifest.json"), "utf8"),
    );
    if (!isObject(parsed)
      || parsed.version !== 1
      || parsed.target !== target
      || (parsed.state !== "prepared"
        && parsed.state !== "displaced"
        && parsed.state !== "published"
        && parsed.state !== "committed")) return undefined;
    return parsed.state;
  } catch {
    return undefined;
  }
}

function transactionManifestBytes(
  target: string,
  state: "prepared" | "displaced" | "published" | "committed",
): Buffer {
  return Buffer.from(`${JSON.stringify({ version: 1, state, target })}\n`, "utf8");
}

function createTargetTransactionGuard(
  target: string,
  original: SafeFileSnapshot,
  publishedBytes: Buffer,
  pathApi: PlatformPath,
): TargetTransactionGuard {
  const parent = pathApi.dirname(target);
  const prefix = `.${pathApi.basename(target)}.transaction-`;
  let transactionPath: string | undefined;
  let transactionIdentity: NodeIdentity | undefined;
  let publishedIdentity: Pick<NodeIdentity, "dev" | "ino"> | undefined;

  const transactionCandidates = (): string[] => {
    try {
      return readdirSync(parent)
        .filter((name) => name.startsWith(prefix))
        .map((name) => pathApi.join(parent, name));
    } catch {
      return [];
    }
  };

  const transactionObservation = (
    candidate: string,
  ): { publication?: NodeIdentity } | undefined => {
    const directory = identity(lstatSync(candidate));
    if (directory?.kind !== "directory") return undefined;
    const displacedPath = pathApi.join(candidate, "displaced");
    const preparedPath = pathApi.join(candidate, "prepared");
    const state = transactionManifestState(candidate, target, pathApi);
    if (state === undefined) return undefined;

    if (original.read.status === "valid") {
      if (original.identity === undefined
        || exactObservedFile(
          displacedPath,
          original.read.bytes,
          original.read.mode,
          original.identity,
        ) === undefined) return undefined;
      const prepared = exactObservedFile(preparedPath, publishedBytes, original.read.mode);
      if (pathMissing(target)) {
        return prepared?.nlink === 1 && (state === "prepared" || state === "displaced")
          ? {}
          : undefined;
      }
      const targetFile = exactObservedFile(target, publishedBytes, original.read.mode);
      if (targetFile === undefined) return undefined;
      if (pathMissing(preparedPath)) {
        return targetFile.nlink === 1 && (state === "published" || state === "committed")
          ? { publication: targetFile }
          : undefined;
      }
      return prepared !== undefined
        && targetFile.dev === prepared.dev
        && targetFile.ino === prepared.ino
        && targetFile.nlink === 2
        && prepared.nlink === 2
        && (state === "displaced" || state === "published")
        ? { publication: targetFile }
        : undefined;
    }

    const targetFile = exactObservedFile(target, publishedBytes, 0o600);
    const prepared = exactObservedFile(preparedPath, publishedBytes, 0o600);
    if (prepared === undefined && targetFile?.nlink === 1
      && (state === "published" || state === "committed")) {
      return { publication: targetFile };
    }
    return targetFile !== undefined
      && prepared !== undefined
      && targetFile.dev === prepared.dev
      && targetFile.ino === prepared.ino
      && targetFile.nlink === 2
      && prepared.nlink === 2
      && (state === "prepared" || state === "published")
      ? { publication: targetFile }
      : undefined;
  };

  const acceptObservation = (
    observation: { publication?: NodeIdentity } | undefined,
  ): boolean => {
    if (observation === undefined) return false;
    if (observation.publication === undefined) return publishedIdentity === undefined;
    if (observation.publication.nlink === 1 && publishedIdentity === undefined) return false;
    if (publishedIdentity === undefined) {
      publishedIdentity = {
        dev: observation.publication.dev,
        ino: observation.publication.ino,
      };
      return true;
    }
    return observation.publication.dev === publishedIdentity.dev
      && observation.publication.ino === publishedIdentity.ino;
  };

  const committedManifestBytes = transactionManifestBytes(target, "committed");

  const recoveryAuthorityInputs = (
    candidate: string | undefined,
  ): {
    transaction: string;
    transactionIdentity: NodeIdentity;
    manifest: string;
    displaced: string;
    originalIdentity: NodeIdentity;
    originalBytes: Buffer;
    originalMode: number | undefined;
  } | undefined => {
    if (candidate === undefined
      || transactionPath === undefined
      || transactionIdentity === undefined
      || original.read.status !== "valid"
      || original.identity === undefined
      || candidate !== pathApi.join(transactionPath, "displaced")) return undefined;
    return {
      transaction: transactionPath,
      transactionIdentity,
      manifest: pathApi.join(transactionPath, "manifest.json"),
      displaced: candidate,
      originalIdentity: original.identity,
      originalBytes: original.read.bytes,
      originalMode: original.read.mode,
    };
  };

  const authoritativeRecoveryPath = (candidate: string | undefined): string | undefined => {
    const inputs = recoveryAuthorityInputs(candidate);
    if (inputs === undefined) return undefined;
    let manifest: HeldFileObservation | undefined;
    let displaced: HeldFileObservation | undefined;
    let prepared: HeldFileObservation | undefined;
    let publication: HeldFileObservation | undefined;
    try {
      const transactionBefore = identity(lstatSync(inputs.transaction));
      const entriesBefore = readdirSync(inputs.transaction).sort();
      const hasPrepared = isDeepStrictEqual(
        entriesBefore,
        ["displaced", "manifest.json", "prepared"],
      );
      const publishedOnly = isDeepStrictEqual(entriesBefore, ["displaced", "manifest.json"]);
      if (!sameDirectoryAuthority(transactionBefore, inputs.transactionIdentity)
        || (!hasPrepared && !publishedOnly)) return undefined;
      const allowedStates = hasPrepared
        ? ["displaced", "published"] as const
        : ["committed", "published"] as const;
      let state: "displaced" | "published" | "committed" | undefined;
      let manifestBytes: Buffer | undefined;
      for (const candidateState of allowedStates) {
        const candidateBytes = transactionManifestBytes(target, candidateState);
        const candidateManifest = openHeldExactFile(
          inputs.manifest,
          candidateBytes,
          undefined,
          undefined,
          1,
        );
        if (candidateManifest !== undefined) {
          state = candidateState;
          manifestBytes = candidateBytes;
          manifest = candidateManifest;
          break;
        }
      }
      if (state === undefined || manifestBytes === undefined || manifest === undefined) return undefined;
      displaced = openHeldExactFile(
        inputs.displaced,
        inputs.originalBytes,
        inputs.originalMode,
        inputs.originalIdentity,
        inputs.originalIdentity.nlink,
      );
      if (displaced === undefined) return undefined;

      let targetMustBeMissing = false;
      if (state !== "committed" && hasPrepared) {
        const preparedPath = pathApi.join(inputs.transaction, "prepared");
        if (state === "displaced" && pathMissing(target)) {
          targetMustBeMissing = true;
          prepared = openHeldExactFile(
            preparedPath,
            publishedBytes,
            inputs.originalMode,
            undefined,
            1,
          );
        } else {
          if (state === "published" && publishedIdentity === undefined) return undefined;
          publication = openHeldExactFile(
            target,
            publishedBytes,
            inputs.originalMode,
            state === "displaced" ? undefined : publishedIdentity,
            2,
          );
          if (publication !== undefined) {
            prepared = openHeldExactFile(
              preparedPath,
              publishedBytes,
              inputs.originalMode,
              publication.identity,
              2,
            );
          }
        }
        if (prepared === undefined) return undefined;
      } else if (state === "published") {
        if (publishedIdentity === undefined) return undefined;
        publication = openHeldExactFile(
          target,
          publishedBytes,
          inputs.originalMode,
          publishedIdentity,
          1,
        );
        if (publication === undefined) return undefined;
      }

      const manifestDescriptor = rereadHeldExactFile(
        manifest,
        manifestBytes,
        undefined,
        manifest.identity,
        1,
      );
      const displacedDescriptor = rereadHeldExactFile(
        displaced,
        inputs.originalBytes,
        inputs.originalMode,
        inputs.originalIdentity,
        inputs.originalIdentity.nlink,
      );
      const preparedDescriptor = prepared === undefined ? undefined : rereadHeldExactFile(
        prepared,
        publishedBytes,
        inputs.originalMode,
        prepared.identity,
        prepared.identity.nlink,
      );
      const publicationDescriptor = publication === undefined ? undefined : rereadHeldExactFile(
        publication,
        publishedBytes,
        inputs.originalMode,
        publication.identity,
        publication.identity.nlink,
      );
      const closingTarget = publication === undefined ? undefined : identity(lstatSync(target));
      const closingTargetMissing = targetMustBeMissing && pathMissing(target);
      const closingPrepared = prepared === undefined
        ? undefined
        : identity(lstatSync(pathApi.join(inputs.transaction, "prepared")));
      const manifestPath = identity(lstatSync(inputs.manifest));
      const closingEntries = readdirSync(inputs.transaction).sort();
      const closingTransaction = identity(lstatSync(inputs.transaction));
      const displacedPath = identity(lstatSync(inputs.displaced));
      return manifestDescriptor !== undefined
        && displacedDescriptor !== undefined
        && (prepared === undefined
          || (preparedDescriptor !== undefined
            && sameIdentity(preparedDescriptor, closingPrepared)))
        && (state === "committed"
          || (publication === undefined
            ? closingTargetMissing
            : publicationDescriptor !== undefined
              && sameIdentity(publicationDescriptor, closingTarget)))
        && sameIdentity(manifestDescriptor, manifestPath)
        && isDeepStrictEqual(closingEntries, entriesBefore)
        && sameDirectoryAuthority(closingTransaction, inputs.transactionIdentity)
        && sameIdentity(displacedDescriptor, displacedPath)
        ? inputs.displaced
        : undefined;
    } catch {
      return undefined;
    } finally {
      closeHeldFile(publication);
      closeHeldFile(prepared);
      closeHeldFile(displaced);
      closeHeldFile(manifest);
    }
  };

  const finalAuthority = (
    candidate: string | undefined,
    interveningGuard: FileMutationGuard,
  ): { status: "authoritative"; recoveryPath: string } | { status: "changed" } => {
    const inputs = recoveryAuthorityInputs(candidate);
    if (inputs === undefined || publishedIdentity === undefined) return { status: "changed" };
    let manifest: HeldFileObservation | undefined;
    let displaced: HeldFileObservation | undefined;
    let publication: HeldFileObservation | undefined;
    try {
      const transactionBefore = identity(lstatSync(inputs.transaction));
      const entriesBefore = readdirSync(inputs.transaction).sort();
      if (!sameDirectoryAuthority(transactionBefore, inputs.transactionIdentity)
        || !isDeepStrictEqual(entriesBefore, ["displaced", "manifest.json"])
        || transactionManifestState(inputs.transaction, target, pathApi) !== "committed") {
        return { status: "changed" };
      }
      manifest = openHeldExactFile(
        inputs.manifest,
        committedManifestBytes,
        undefined,
        undefined,
        1,
      );
      if (manifest === undefined) return { status: "changed" };
      displaced = openHeldExactFile(
        inputs.displaced,
        inputs.originalBytes,
        inputs.originalMode,
        inputs.originalIdentity,
        inputs.originalIdentity.nlink,
      );
      if (displaced === undefined) return { status: "changed" };
      publication = openHeldExactFile(
        target,
        publishedBytes,
        inputs.originalMode,
        publishedIdentity,
        1,
      );
      if (publication === undefined) return { status: "changed" };

      let guardUnchanged = false;
      try { guardUnchanged = interveningGuard.unchanged(); } catch { /* failed closed */ }
      const publicationDescriptor = rereadHeldExactFile(
        publication,
        publishedBytes,
        inputs.originalMode,
        publishedIdentity,
        1,
      );
      const manifestDescriptor = rereadHeldExactFile(
        manifest,
        committedManifestBytes,
        undefined,
        manifest.identity,
        1,
      );
      const displacedDescriptor = rereadHeldExactFile(
        displaced,
        inputs.originalBytes,
        inputs.originalMode,
        inputs.originalIdentity,
        inputs.originalIdentity.nlink,
      );

      // Keep all descriptors live through one closing namespace sweep. Recovery
      // is observed last, after target, manifest, topology, and transaction dir.
      const publicationPath = identity(lstatSync(target));
      const manifestPath = identity(lstatSync(inputs.manifest));
      const closingEntries = readdirSync(inputs.transaction).sort();
      const closingTransaction = identity(lstatSync(inputs.transaction));
      const displacedPath = identity(lstatSync(inputs.displaced));
      const unchanged = guardUnchanged
        && publicationDescriptor !== undefined
        && manifestDescriptor !== undefined
        && displacedDescriptor !== undefined
        && sameIdentity(publicationDescriptor, publicationPath)
        && sameIdentity(manifestDescriptor, manifestPath)
        && isDeepStrictEqual(closingEntries, ["displaced", "manifest.json"])
        && sameDirectoryAuthority(closingTransaction, inputs.transactionIdentity)
        && sameIdentity(displacedDescriptor, displacedPath);
      return unchanged
        ? { status: "authoritative", recoveryPath: inputs.displaced }
        : { status: "changed" };
    } catch {
      return { status: "changed" };
    } finally {
      closeHeldFile(publication);
      closeHeldFile(displaced);
      closeHeldFile(manifest);
    }
  };

  return {
    authoritativeRecoveryPath,
    finalAuthority,
    unchanged: () => {
      if (transactionPath === undefined && fileSnapshotUnchanged(original, pathApi)) return true;
      if (transactionPath === undefined) {
        const candidates = transactionCandidates().flatMap((candidate) => {
          try {
            const observation = transactionObservation(candidate);
            return observation === undefined ? [] : [{ candidate, observation }];
          } catch {
            return [];
          }
        });
        if (candidates.length !== 1) return false;
        transactionPath = candidates[0]!.candidate;
        transactionIdentity = identity(lstatSync(transactionPath));
        return sameDirectoryAuthority(identity(lstatSync(transactionPath)), transactionIdentity)
          && acceptObservation(candidates[0]!.observation);
      }
      return sameDirectoryAuthority(identity(lstatSync(transactionPath)), transactionIdentity)
        && acceptObservation(transactionObservation(transactionPath));
    },
  };
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
  if (!isCanonicalAbsoluteDirectory(configured, options.path)) return { status: "manual" };
  const normalizedPolicyRoot = configured.normalize("NFC");
  return {
    status: "resolved",
    configPath: options.path.join(configured, ".claude.json"),
    policyRoot: normalizedPolicyRoot,
    override: "absolute",
    mutationSafe: normalizedPolicyRoot === configured,
  };
}

function isCanonicalAbsoluteDirectory(path: string, pathApi: PlatformPath): boolean {
  if (!pathApi.isAbsolute(path) || pathApi.normalize(path) !== path) return false;
  const root = pathApi.parse(path).root;
  if (root.length === 0 || (path !== root && /[\\/]$/.test(path))) return false;
  if (path === root) {
    if (pathApi.sep !== "\\") return path === "/";
    return /^[A-Za-z]:\\$/.test(root) || /^\\\\[^\\]+\\[^\\]+\\$/.test(root);
  }
  const suffix = path.slice(root.length);
  const parts = suffix.split(/[\\/]/);
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) return false;
  if (pathApi.sep === "\\") {
    if (path.includes("/") || root === "\\" || /^\\\\[?.]\\/.test(path)) return false;
    return /^[A-Za-z]:\\$/.test(root) || /^\\\\[^\\]+\\[^\\]+\\$/.test(root);
  }
  return !path.includes("\\");
}

function isCanonicalAbsoluteFile(path: string, pathApi: PlatformPath): boolean {
  if (!pathApi.isAbsolute(path) || pathApi.normalize(path) !== path || /[\\/]$/.test(path)) return false;
  const parent = pathApi.dirname(path);
  return isCanonicalAbsoluteDirectory(parent, pathApi)
    && pathApi.join(parent, pathApi.basename(path)) === path;
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
  return result.error === undefined
    && result.status === 1
    && /enterprise policy (?:denied|refused)|disabled by (?:an )?administrator policy/i.test(
      `${result.stdout}\n${result.stderr}`,
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

function manual(operation: "configure" | "remove", registration?: McpRegistration): SetupResult {
  return operation === "configure"
    ? failed(MANUAL_CONFIGURE_DETAIL, registration)
    : failed(MANUAL_REMOVE_DETAIL);
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
    const rootNamespace = observeNamespace(stagingRoot, pathApi);
    if (rootNamespace?.at(-1)?.identity?.kind !== "directory") return undefined;
    const path = mkdtempSync(pathApi.join(stagingRoot, "rocky-claude-code-"));
    chmodSync(path, 0o700);
    if (!namespaceUnchanged(rootNamespace, pathApi)) return undefined;
    const stageIdentity = identity(lstatSync(path));
    if (stageIdentity?.kind !== "directory"
      || (process.platform !== "win32" && stageIdentity.mode !== 0o700)) return undefined;
    return { path, rootNamespace, identity: stageIdentity };
  } catch {
    return undefined;
  }
}

function stageIdentityUnchanged(stage: PrivateStage, pathApi: PlatformPath): boolean {
  try {
    return namespaceUnchanged(stage.rootNamespace, pathApi)
      && sameDirectoryAuthority(identity(lstatSync(stage.path)), stage.identity);
  } catch {
    return false;
  }
}

function authoritativeStagePath(stage: PrivateStage, pathApi: PlatformPath): string | undefined {
  return stageIdentityUnchanged(stage, pathApi) ? stage.path : undefined;
}

// Node 18 exposes no inode-conditional unlink/rmdir. Stages therefore remain
// private and recoverable; pathname-only best-effort cleanup could delete a
// same-user replacement installed after the last observable identity check.

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
  pathApi: PlatformPath,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<boolean> {
  const options = {
    timeoutMs: CLAUDE_COMMAND_TIMEOUT_MS,
    env: forcedEnvironment(env, stage.path),
    cwd,
  };
  try {
    if (!stageIdentityUnchanged(stage, pathApi)) return false;
    const version = await runner.run(executable, ["--version"], options);
    if (!exactVersion(version) || !stageIdentityUnchanged(stage, pathApi)) return false;
    const addHelp = await runner.run(executable, ADD_HELP_ARGS, options);
    if (!addHelpIsExact(addHelp) || !stageIdentityUnchanged(stage, pathApi)) return false;
    const removeHelp = await runner.run(executable, REMOVE_HELP_ARGS, options);
    return removeHelpIsExact(removeHelp) && stageIdentityUnchanged(stage, pathApi);
  } catch {
    return false;
  }
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
  const cloned = { ...root };
  if (isObject(root.mcpServers)) {
    const servers = { ...root.mcpServers };
    delete servers.rocky;
    cloned.mcpServers = servers;
  }
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
  invocationStartedAt: number,
  invocationCompletedAt: number,
): AuditedStage | undefined {
  if (!stageIdentityUnchanged(stage, pathApi) || original.file === undefined || original.root === undefined) {
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
    const timestampText = backupName.slice(manifest.backup.filePrefix.length);
    const timestamp = Number(timestampText);
    if (!backupName.startsWith(manifest.backup.filePrefix)
      || !/^\d{13,}$/.test(timestampText)
      || !Number.isSafeInteger(timestamp)
      || String(timestamp) !== timestampText
      || timestamp < invocationStartedAt
      || timestamp > invocationCompletedAt) return undefined;
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
          return stageIdentityUnchanged(stage, pathApi)
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
  const transaction = inspectTransaction ? transactions.inspect(resolved.configPath) : undefined;
  if (transaction?.status === "pending") {
    return {
      public: {
        state: "unreadable",
        detail: withRecovery(
          "Claude Code config recovery is pending; retry after recovery",
          transaction.recoveryPath,
        ),
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
      && isCanonicalAbsoluteFile(dependencies.userConfigPath, pathApi)
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
      || !validManifest(manifest, platform, architecture, pathApi)) return manual(operation, registration);

    const parentNamespace = observeNamespace(pathApi.dirname(resolved.configPath), pathApi);
    if (parentNamespace?.at(-1)?.identity?.kind !== "directory") return manual(operation, registration);
    const policy = capturePolicyProof(
      manifest,
      resolved,
      cwd,
      setupEnv,
      pathApi,
      parentNamespace,
    );
    if (policy === undefined) return manual(operation, registration);

    const capabilityStage = createPrivateStage(stagingRoot, pathApi);
    if (capabilityStage === undefined) return manual(operation, registration);
    if (!await proveCapability(
      runner,
      executable!,
      capabilityStage,
      pathApi,
      setupEnv,
      cwd,
    )) return manual(operation, registration);

    const stage = createPrivateStage(stagingRoot, pathApi);
    if (stage === undefined || !copySnapshotToStage(stage, inspection.file, pathApi)) {
      return failed(withRecovery(
        "Unable to create exact private Claude Code stage",
        stage === undefined ? undefined : authoritativeStagePath(stage, pathApi),
      ), operation === "configure" ? registration : undefined);
    }
    const beforeNames = readdirSync(stage.path).sort();
    const expectedBefore = inspection.file.read.status === "valid" ? [".claude.json"] : [];
    if (!isDeepStrictEqual(beforeNames, expectedBefore)
      || !policy.guard.unchanged()
      || !fileSnapshotUnchanged(inspection.file, pathApi)) {
      return failed(withRecovery(
        "Claude Code staging stopped",
        authoritativeStagePath(stage, pathApi),
      ), operation === "configure" ? registration : undefined);
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
    const invocationStartedAt = Date.now();
    for (const args of commands) {
      if (!stageIdentityUnchanged(stage, pathApi)
        || !policy.guard.unchanged()
        || !fileSnapshotUnchanged(inspection.file, pathApi)) {
        return failed(withRecovery(
          "Claude Code staged transformation authority changed",
          authoritativeStagePath(stage, pathApi),
        ), operation === "configure" ? registration : undefined);
      }
      let outcome: ProcessResult;
      try {
        outcome = await run(args);
      } catch {
        return failed(withRecovery(
          "Claude Code staged transformation failed",
          authoritativeStagePath(stage, pathApi),
        ),
          operation === "configure" ? registration : undefined);
      }
      if (!succeeded(outcome)) {
        const result = isPolicyRefusal(outcome)
          ? blocked("Claude Code policy refused staged registration update",
            operation === "configure" ? registration : undefined)
          : failed("Claude Code staged registration update failed",
            operation === "configure" ? registration : undefined);
        return {
          ...result,
          detail: withRecovery(
            result.detail ?? "Claude Code staged update failed",
            authoritativeStagePath(stage, pathApi),
          ),
        };
      }
    }
    const invocationCompletedAt = Date.now();

    const audited = auditStage(
      stage,
      stagingRoot,
      inspection,
      operation,
      registration,
      manifest,
      pathApi,
      invocationStartedAt,
      invocationCompletedAt,
    );
    if (audited === undefined || !policy.guard.unchanged() || !fileSnapshotUnchanged(inspection.file, pathApi)) {
      return failed(withRecovery(
        "Claude Code staged audit failed",
        authoritativeStagePath(stage, pathApi),
      ),
        operation === "configure" ? registration : undefined);
    }
    const targetGuard = createTargetTransactionGuard(
      resolved.configPath,
      inspection.file,
      audited.bytes,
      pathApi,
    );
    const nonTargetGuard = combineGuards(policy.guard, audited.guard);
    const guard = combineGuards(nonTargetGuard, targetGuard);
    let written: ConditionalBytesWriteResult;
    try {
      written = transactions.write(
        resolved.configPath,
        audited.bytes,
        inspection.file.read,
        guard,
      );
    } catch {
      return failed(withRecovery(
        "Unable to publish staged Claude Code registration",
        authoritativeStagePath(stage, pathApi),
      ),
        operation === "configure" ? registration : undefined);
    }
    const selectAuthoritativeRecovery = (candidate: string | undefined): string | undefined => {
      const stageBeforeCandidate = authoritativeStagePath(stage, pathApi);
      const taskOneRecovery = targetGuard.authoritativeRecoveryPath(candidate);
      if (taskOneRecovery !== undefined) return taskOneRecovery;
      return stageBeforeCandidate === undefined
        ? undefined
        : authoritativeStagePath(stage, pathApi);
    };
    if (written.status !== "written") {
      return failed(withRecovery(
        written.status === "changed"
          ? "Claude Code config changed before publication"
          : "Claude Code publication requires manual recovery",
        selectAuthoritativeRecovery(written.recoveryPath),
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
      && isDeepStrictEqual(verifiedRoot, audited.parsed)
      && guard.unchanged();
    if (!exact) {
      return failed(withRecovery(
        "Claude Code published state could not be verified",
        selectAuthoritativeRecovery(written.recoveryPath),
      ), operation === "configure" ? registration : undefined);
    }
    const finalAuthority = targetGuard.finalAuthority(written.recoveryPath, nonTargetGuard);
    if (finalAuthority.status === "changed") {
      return failed(withRecovery(
        "Claude Code stage authority changed after publication",
        selectAuthoritativeRecovery(written.recoveryPath),
      ), operation === "configure" ? registration : undefined);
    }
    const detail = `Claude Code recovery artifact: ${finalAuthority.recoveryPath}`;
    return operation === "configure"
      ? { client: "claude-code", status: "configured", detail }
      : { client: "claude-code", status: "removed", detail };
  }

  return {
    id: "claude-code",

    async inspect(registration) {
      if (executable === undefined) return { state: "blocked", detail: MISSING_DETAIL };
      return inspectUserConfig(resolved, registration, pathApi, transactions).public;
    },

    async configure(registration, replace) {
      if (executable === undefined) return skipped();
      if (resolved.status === "manual") return manual("configure", registration);
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
      if (resolved.status === "manual") return manual("remove");
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
