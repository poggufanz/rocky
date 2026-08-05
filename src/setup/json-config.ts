import {
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { directorySyncCapability } from "./directory-sync.js";

export type JsonReadResult =
  | { status: "missing"; value: Record<string, unknown> }
  | { status: "valid"; value: Record<string, unknown>; bytes: Buffer; mode?: number }
  | { status: "invalid"; error: string };

/**
 * Opaque authority to mutate a previously validated filesystem topology.
 * This closes observable check/use windows, but Node has no portable way to
 * make the final identity check and following namespace syscall indivisible.
 */
export interface JsonMutationGuard {
  unchanged(): boolean;
}

class JsonMutationGuardChangedError extends Error {}

function mutationGuardUnchanged(guard: JsonMutationGuard | undefined): boolean {
  try {
    return guard?.unchanged() ?? true;
  } catch {
    return false;
  }
}

function requireMutationGuard(guard: JsonMutationGuard | undefined): void {
  if (!mutationGuardUnchanged(guard)) throw new JsonMutationGuardChangedError();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return isObject(error) && typeof error.code === "string" ? error.code : undefined;
}

export function readJsonObject(path: string): JsonReadResult {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    return errorCode(error) === "ENOENT"
      ? { status: "missing", value: {} }
      : { status: "invalid", error: "Unable to read JSON config" };
  }

  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { status: "invalid", error: "JSON config is invalid" };
  }
  if (!isObject(value)) {
    return { status: "invalid", error: "JSON config root must be an object" };
  }

  try {
    return {
      status: "valid",
      value,
      bytes,
      mode: statSync(path).mode & 0o777,
    };
  } catch {
    return { status: "invalid", error: "Unable to read JSON config metadata" };
  }
}

function backupTimestamp(now: Date): string {
  return now.toISOString().replaceAll("-", "").replaceAll(":", "").replace(".", "");
}

interface BackupIdentity {
  dev: number;
  ino: number;
}

function backupPathIsAuthoritative(
  path: string,
  identity: BackupIdentity | undefined,
  guard: JsonMutationGuard | undefined,
): boolean {
  if (identity === undefined || !mutationGuardUnchanged(guard)) return false;
  try {
    const metadata = lstatSync(path);
    return metadata.isFile()
      && !metadata.isSymbolicLink()
      && metadata.dev === identity.dev
      && metadata.ino === identity.ino
      && mutationGuardUnchanged(guard);
  } catch {
    return false;
  }
}

export function backupFile(
  path: string,
  now = new Date(),
  guard?: JsonMutationGuard,
): string {
  const backupPath = `${path}.backup-${backupTimestamp(now)}`;
  let sourceDescriptor: number | undefined;
  let descriptor: number | undefined;
  let backupCreated = false;
  let backupIdentity: BackupIdentity | undefined;
  try {
    requireMutationGuard(guard);
    sourceDescriptor = openSync(path, "r");
    const bytes = readFileSync(sourceDescriptor);
    const mode = fstatSync(sourceDescriptor).mode & 0o777;
    closeSync(sourceDescriptor);
    sourceDescriptor = undefined;
    requireMutationGuard(guard);
    descriptor = openSync(backupPath, "wx", 0o600);
    backupCreated = true;
    if (guard !== undefined) {
      const created = fstatSync(descriptor);
      backupIdentity = { dev: created.dev, ino: created.ino };
    }
    requireMutationGuard(guard);
    writeFileSync(descriptor, bytes);
    fchmodSync(descriptor, mode);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    requireMutationGuard(guard);
    syncParentDirectory(backupPath);
    if (guard !== undefined && !backupPathIsAuthoritative(backupPath, backupIdentity, guard)) {
      throw new JsonMutationGuardChangedError();
    }
    return backupPath;
  } catch {
    if (sourceDescriptor !== undefined) {
      try {
        closeSync(sourceDescriptor);
      } catch {
        // Preserve secret-free backup failure.
      }
    }
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve secret-free backup failure.
      }
    }
    let recoveryPath: string | undefined;
    const cleanupAllowed = guard === undefined
      || backupPathIsAuthoritative(backupPath, backupIdentity, guard);
    if (backupCreated && cleanupAllowed) {
      try {
        requireMutationGuard(guard);
        rmSync(backupPath, { force: true });
        requireMutationGuard(guard);
        syncParentDirectory(backupPath);
      } catch {
        const authoritative = guard === undefined
          ? pathExists(backupPath)
          : backupPathIsAuthoritative(backupPath, backupIdentity, guard);
        if (authoritative) {
          recoveryPath = backupPath;
        }
      }
    }
    throw new BackupFileError(recoveryPath);
  }
}

export class BackupFileError extends Error {
  constructor(readonly recoveryPath?: string) {
    super("Unable to back up JSON config");
    this.name = "BackupFileError";
  }
}

export class AtomicJsonWriteError extends Error {
  constructor(readonly committed: boolean) {
    super(committed
      ? "JSON config was replaced but directory durability is unconfirmed"
      : "Unable to write JSON config");
    this.name = "AtomicJsonWriteError";
  }
}

function syncParentDirectory(path: string): void {
  directorySyncCapability.sync(dirname(path));
}

export function atomicWriteJson(
  path: string,
  value: Record<string, unknown>,
  prior: { mode?: number } = {},
): void {
  let encoded: string;
  try {
    const serialized = JSON.stringify(value, null, 2);
    if (serialized === undefined) throw new Error("not serializable");
    encoded = `${serialized}\n`;
  } catch {
    throw new AtomicJsonWriteError(false);
  }

  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`,
  );
  let descriptor: number | undefined;
  let renamed = false;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, encoded, "utf8");
    if (prior.mode !== undefined) fchmodSync(descriptor, prior.mode);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, path);
    renamed = true;
    syncParentDirectory(path);
  } catch {
    throw new AtomicJsonWriteError(renamed);
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the operation's secret-free error.
      }
    }
    if (!renamed) {
      try {
        rmSync(temporaryPath, { force: true });
      } catch {
        // Preserve the operation's secret-free error.
      }
    }
  }
}

export type ConditionalJsonWriteResult =
  | { status: "written"; recoveryPath?: string }
  | { status: "changed"; recoveryPath?: string }
  | { status: "recovery-required"; recoveryPath?: string };

export type JsonTransactionRecoveryResult =
  | { status: "clear" }
  | { status: "recovered"; recoveryPath?: string }
  | { status: "manual"; recoveryPath?: string };

export type JsonTransactionInspectionResult =
  | { status: "clear" }
  | { status: "pending"; recoveryPath?: string };

type TransactionState = "prepared" | "displaced" | "published" | "committed";

interface TransactionManifest {
  version: 1;
  state: TransactionState;
  target: string;
}

function transactionPath(path: string): string {
  return join(
    dirname(path),
    `.${basename(path)}.transaction-${process.pid}-${randomBytes(8).toString("hex")}`,
  );
}

function fileMatches(path: string, bytes: Buffer, mode?: number): boolean {
  try {
    return readFileSync(path).equals(bytes)
      && (mode === undefined || (statSync(path).mode & 0o777) === mode);
  } catch {
    return false;
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    return true;
  }
}

function firstExistingPath(...candidates: Array<string | undefined>): string | undefined {
  return candidates.find((candidate): candidate is string =>
    candidate !== undefined && pathExists(candidate));
}

function matchingCommittedRecoveryLinks(
  transactionTarget: string,
  metadata: NonNullable<ReturnType<typeof lstatSync>>,
): number {
  let managedLinks = 0;
  for (const transactionDirectory of transactionDirectories(transactionTarget)) {
    if (readManifest(transactionDirectory, transactionTarget)?.state !== "committed") continue;
    try {
      const recovery = lstatSync(join(transactionDirectory, "displaced"));
      if (recovery.isFile()
        && recovery.dev === metadata.dev
        && recovery.ino === metadata.ino) {
        managedLinks += 1;
      }
    } catch {
      // A missing committed recovery cannot authorize an extra hard link.
    }
  }
  return managedLinks;
}

function isManagedRegularFile(path: string, transactionTarget = path): boolean {
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile()) return false;
    return metadata.nlink === matchingCommittedRecoveryLinks(transactionTarget, metadata) + 1;
  } catch {
    return false;
  }
}

function isManagedRecoveryPair(
  path: string,
  displacedPath: string,
  transactionTarget: string,
): boolean {
  try {
    const current = lstatSync(path);
    const displaced = lstatSync(displacedPath);
    if (!current.isFile()
      || !displaced.isFile()
      || current.dev !== displaced.dev
      || current.ino !== displaced.ino) {
      return false;
    }
    const expectedLinks = matchingCommittedRecoveryLinks(transactionTarget, current) + 2;
    return current.nlink === expectedLinks && displaced.nlink === expectedLinks;
  } catch {
    return false;
  }
}

function linkRegularFileNoFollow(existingPath: string, newPath: string): void {
  const before = lstatSync(existingPath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error("Recovery source is not a regular file");
  }

  let published: ReturnType<typeof lstatSync> | undefined;
  try {
    linkSync(existingPath, newPath);
    published = lstatSync(newPath);
    const after = lstatSync(existingPath);
    if (!published.isFile()
      || published.isSymbolicLink()
      || !after.isFile()
      || after.isSymbolicLink()
      || before.dev !== after.dev
      || before.ino !== after.ino
      || after.dev !== published.dev
      || after.ino !== published.ino) {
      throw new Error("Recovery source changed during publication");
    }
  } catch (error) {
    if (published !== undefined) {
      try {
        const current = lstatSync(newPath);
        if (current.dev === published.dev && current.ino === published.ino) {
          unlinkSync(newPath);
          syncParentDirectory(newPath);
        }
      } catch {
        // Caller retains the transaction as the manual recovery authority.
      }
    }
    throw error;
  }
}

function syncDirectory(path: string): void {
  directorySyncCapability.sync(path);
}

function writeManifest(
  transactionDirectory: string,
  target: string,
  state: TransactionState,
  guard?: JsonMutationGuard,
): void {
  const manifestPath = join(transactionDirectory, "manifest.json");
  const temporaryPath = join(transactionDirectory, "manifest.tmp");
  const manifest: TransactionManifest = { version: 1, state, target };
  let descriptor: number | undefined;
  try {
    requireMutationGuard(guard);
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(manifest)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    requireMutationGuard(guard);
    renameSync(temporaryPath, manifestPath);
    syncDirectory(transactionDirectory);
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Caller reports a secret-free transaction recovery path.
      }
    }
    if (mutationGuardUnchanged(guard) && pathExists(temporaryPath)) {
      try {
        requireMutationGuard(guard);
        rmSync(temporaryPath, { force: true });
      } catch {
        // Caller reports a secret-free transaction recovery path.
      }
    }
  }
}

function readManifest(transactionDirectory: string, target: string): TransactionManifest | undefined {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(transactionDirectory, "manifest.json"), "utf8"),
    );
    if (!isObject(parsed)
      || parsed.version !== 1
      || parsed.target !== target
      || (parsed.state !== "prepared"
        && parsed.state !== "displaced"
        && parsed.state !== "published"
        && parsed.state !== "committed")) {
      return undefined;
    }
    return parsed as unknown as TransactionManifest;
  } catch {
    return undefined;
  }
}

function removeTransaction(transactionDirectory: string): boolean {
  try {
    rmSync(transactionDirectory, { recursive: true });
    syncParentDirectory(transactionDirectory);
    return true;
  } catch {
    return false;
  }
}

function transactionDirectories(path: string): string[] {
  const parent = dirname(path);
  const prefix = `.${basename(path)}.transaction-`;
  try {
    return readdirSync(parent)
      .filter((name) => name.startsWith(prefix))
      .map((name) => join(parent, name))
      .filter((candidate) => {
        try {
          return lstatSync(candidate).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

/** Report unfinished transactions without changing the target or artifacts. */
export function inspectJsonTransaction(path: string): JsonTransactionInspectionResult {
  for (const transactionDirectory of transactionDirectories(path)) {
    if (readManifest(transactionDirectory, path)?.state === "committed") continue;
    return { status: "pending", recoveryPath: firstExistingPath(transactionDirectory) };
  }
  return { status: "clear" };
}

/** Recover an interrupted mutation before anybody interprets an absent config. */
export function recoverJsonTransaction(
  path: string,
  guard?: JsonMutationGuard,
): JsonTransactionRecoveryResult {
  for (const transactionDirectory of transactionDirectories(path)) {
    const manifest = readManifest(transactionDirectory, path);
    if (manifest?.state === "committed") continue;
    if (manifest === undefined) {
      return { status: "manual", recoveryPath: firstExistingPath(transactionDirectory) };
    }

    if (manifest.state === "published") {
      return { status: "manual", recoveryPath: firstExistingPath(transactionDirectory) };
    }

    const displacedPath = join(transactionDirectory, "displaced");
    if (manifest.state === "prepared" && !pathExists(displacedPath)) {
      if (!mutationGuardUnchanged(guard)) return { status: "manual" };
      if (!removeTransaction(transactionDirectory)) {
        return {
          status: "manual",
          recoveryPath: firstExistingPath(transactionDirectory, path),
        };
      }
      return { status: "recovered" };
    }

    if (manifest.state === "prepared"
      && pathExists(path)
      && isManagedRecoveryPair(path, displacedPath, path)) {
      const preparedPath = join(transactionDirectory, "prepared");
      if (pathExists(preparedPath)
        && (!mutationGuardUnchanged(guard)
          || !discardPrepared(transactionDirectory, preparedPath))) {
        return { status: "manual", recoveryPath: firstExistingPath(transactionDirectory) };
      }
      if (!mutationGuardUnchanged(guard)) return { status: "manual" };
      try {
        writeManifest(transactionDirectory, path, "committed", guard);
      } catch {
        return { status: "manual", recoveryPath: firstExistingPath(transactionDirectory) };
      }
      return { status: "recovered", recoveryPath: firstExistingPath(displacedPath) };
    }

    if (pathExists(path)) {
      return { status: "manual", recoveryPath: firstExistingPath(transactionDirectory) };
    }

    if (pathExists(displacedPath)) {
      if (!isManagedRegularFile(displacedPath, path)) {
        return {
          status: "manual",
          recoveryPath: firstExistingPath(displacedPath, transactionDirectory),
        };
      }
      if (!mutationGuardUnchanged(guard)) return { status: "manual" };
      try {
        linkRegularFileNoFollow(displacedPath, path);
        syncParentDirectory(path);
      } catch {
        return {
          status: "manual",
          recoveryPath: firstExistingPath(displacedPath, transactionDirectory, path),
        };
      }
      if (!isManagedRecoveryPair(path, displacedPath, path)) {
        return { status: "manual", recoveryPath: firstExistingPath(transactionDirectory) };
      }
      const preparedPath = join(transactionDirectory, "prepared");
      if (pathExists(preparedPath)
        && (!mutationGuardUnchanged(guard)
          || !discardPrepared(transactionDirectory, preparedPath))) {
        return { status: "manual", recoveryPath: firstExistingPath(transactionDirectory) };
      }
      if (!mutationGuardUnchanged(guard)) return { status: "manual" };
      try {
        writeManifest(transactionDirectory, path, "committed", guard);
      } catch {
        return { status: "manual", recoveryPath: firstExistingPath(transactionDirectory) };
      }
      return { status: "recovered", recoveryPath: firstExistingPath(displacedPath) };
    } else {
      if (!mutationGuardUnchanged(guard)) return { status: "manual" };
      if (!removeTransaction(transactionDirectory)) {
        return {
          status: "manual",
          recoveryPath: firstExistingPath(transactionDirectory, path),
        };
      }
      return { status: "recovered" };
    }
  }
  return { status: "clear" };
}

function restoreDisplaced(
  path: string,
  transactionDirectory: string,
  displacedPath: string,
  preparedPath: string,
  guard?: JsonMutationGuard,
): ConditionalJsonWriteResult {
  if (pathExists(preparedPath)
    && (!mutationGuardUnchanged(guard)
      || !discardPrepared(transactionDirectory, preparedPath))) {
    return {
      status: "recovery-required",
      recoveryPath: firstExistingPath(transactionDirectory, preparedPath),
    };
  }
  try {
    requireMutationGuard(guard);
    linkRegularFileNoFollow(displacedPath, path);
    syncParentDirectory(path);
  } catch {
    return {
      status: "recovery-required",
      recoveryPath: firstExistingPath(displacedPath, transactionDirectory, path),
    };
  }
  if (!isManagedRecoveryPair(path, displacedPath, path)) {
    return {
      status: "recovery-required",
      recoveryPath: firstExistingPath(transactionDirectory, path),
    };
  }
  try {
    requireMutationGuard(guard);
    writeManifest(transactionDirectory, path, "committed", guard);
  } catch {
    return {
      status: "recovery-required",
      recoveryPath: firstExistingPath(transactionDirectory, path),
    };
  }
  return { status: "changed", recoveryPath: firstExistingPath(displacedPath) };
}

function discardPrepared(transactionDirectory: string, temporaryPath: string): boolean {
  try {
    rmSync(temporaryPath, { force: true });
    syncDirectory(transactionDirectory);
    return true;
  } catch {
    return false;
  }
}

/**
 * Installs JSON only while the destination still matches the supplied read.
 * Existing destinations are displaced before comparison so a late writer is
 * preserved instead of being overwritten by a stale merge. Node 18 has no
 * portable no-replace rename or pathname compare-and-swap. A private, fsynced
 * phase journal makes interrupted displacement recoverable on the next run.
 * Successful replacements retain the displaced inode as a reported live
 * recovery so a writer with an already-open descriptor cannot lose data.
 * Hard-link failure never falls back to an overwriting rename.
 */
export function atomicWriteJsonIfUnchanged(
  path: string,
  value: Record<string, unknown>,
  prior: JsonReadResult,
  guard?: JsonMutationGuard,
): ConditionalJsonWriteResult {
  if (prior.status === "invalid") throw new Error("Unable to write JSON config");

  let encoded: Buffer;
  try {
    const serialized = JSON.stringify(value, null, 2);
    if (serialized === undefined) throw new Error("not serializable");
    encoded = Buffer.from(`${serialized}\n`, "utf8");
  } catch {
    throw new Error("Unable to write JSON config");
  }

  const transactionDirectory = transactionPath(path);
  const temporaryPath = join(transactionDirectory, "prepared");
  let descriptor: number | undefined;
  let transactionExists = false;
  let temporaryExists = false;
  let recoveryPath: string | undefined;
  let recoveryExists = false;
  let destinationPublished = false;
  try {
    requireMutationGuard(guard);
    mkdirSync(transactionDirectory, { mode: 0o700 });
    transactionExists = true;
    syncParentDirectory(transactionDirectory);
    requireMutationGuard(guard);
    descriptor = openSync(temporaryPath, "wx", 0o600);
    temporaryExists = true;
    writeFileSync(descriptor, encoded);
    const intendedMode = prior.status === "valid" ? prior.mode : undefined;
    if (intendedMode !== undefined) fchmodSync(descriptor, intendedMode);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    syncDirectory(transactionDirectory);
    requireMutationGuard(guard);
    writeManifest(transactionDirectory, path, "prepared", guard);

    if (prior.status === "missing") {
      try {
        requireMutationGuard(guard);
        linkSync(temporaryPath, path);
      } catch (error) {
        if (errorCode(error) === "EEXIST") {
          requireMutationGuard(guard);
          if (!removeTransaction(transactionDirectory)) {
            return {
              status: "recovery-required",
              recoveryPath: firstExistingPath(transactionDirectory, path),
            };
          }
          transactionExists = false;
          temporaryExists = false;
          return { status: "changed" };
        }
        throw error;
      }
      destinationPublished = true;
      syncParentDirectory(path);
      requireMutationGuard(guard);
      writeManifest(transactionDirectory, path, "published", guard);
      requireMutationGuard(guard);
      if (!removeTransaction(transactionDirectory)) {
        return {
          status: "recovery-required",
          recoveryPath: firstExistingPath(transactionDirectory, path),
        };
      }
      transactionExists = false;
      temporaryExists = false;
      return { status: "written" };
    }

    if (!isManagedRegularFile(path)) {
      throw new Error("unsupported destination");
    }

    const probePath = join(transactionDirectory, "link-probe");
    requireMutationGuard(guard);
    linkSync(temporaryPath, probePath);
    requireMutationGuard(guard);
    rmSync(probePath);
    syncDirectory(transactionDirectory);

    recoveryPath = join(transactionDirectory, "displaced");
    try {
      requireMutationGuard(guard);
      renameSync(path, recoveryPath);
      recoveryExists = true;
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        requireMutationGuard(guard);
        if (removeTransaction(transactionDirectory) || !pathExists(transactionDirectory)) {
          transactionExists = false;
          temporaryExists = false;
          return { status: "changed" };
        }
        return {
          status: "recovery-required",
          recoveryPath: firstExistingPath(transactionDirectory, temporaryPath),
        };
      }
      throw error;
    }
    syncDirectory(transactionDirectory);
    syncParentDirectory(path);
    requireMutationGuard(guard);
    writeManifest(transactionDirectory, path, "displaced", guard);

    if (!isManagedRegularFile(recoveryPath, path)
      || !fileMatches(recoveryPath, prior.bytes, prior.mode)) {
      const restored = restoreDisplaced(
        path,
        transactionDirectory,
        recoveryPath,
        temporaryPath,
        guard,
      );
      if (restored.status === "changed") {
        temporaryExists = false;
      } else if (!pathExists(temporaryPath)) temporaryExists = false;
      return restored;
    }

    try {
      requireMutationGuard(guard);
      linkSync(temporaryPath, path);
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        requireMutationGuard(guard);
        if (discardPrepared(transactionDirectory, temporaryPath)) temporaryExists = false;
        return {
          status: "recovery-required",
          recoveryPath: firstExistingPath(
            recoveryPath,
            transactionDirectory,
            path,
            temporaryPath,
          ),
        };
      }
      const restored = restoreDisplaced(
        path,
        transactionDirectory,
        recoveryPath,
        temporaryPath,
        guard,
      );
      if (restored.status !== "changed") return restored;
      temporaryExists = false;
      return {
        status: "recovery-required",
        recoveryPath: firstExistingPath(
          restored.recoveryPath,
          recoveryPath,
          transactionDirectory,
          path,
        ),
      };
    }

    destinationPublished = true;
    syncParentDirectory(path);
    if (!fileMatches(path, encoded, prior.mode)) {
      return {
        status: "recovery-required",
        recoveryPath: firstExistingPath(recoveryPath, transactionDirectory, path),
      };
    }

    requireMutationGuard(guard);
    writeManifest(transactionDirectory, path, "published", guard);
    requireMutationGuard(guard);
    rmSync(temporaryPath);
    temporaryExists = false;
    syncDirectory(transactionDirectory);
    if (!pathExists(recoveryPath)) {
      return {
        status: "recovery-required",
        recoveryPath: firstExistingPath(transactionDirectory, path),
      };
    }
    requireMutationGuard(guard);
    writeManifest(transactionDirectory, path, "committed", guard);
    const liveRecoveryPath = firstExistingPath(recoveryPath);
    if (liveRecoveryPath === undefined) {
      return {
        status: "recovery-required",
        recoveryPath: firstExistingPath(transactionDirectory, path),
      };
    }
    return { status: "written", recoveryPath: liveRecoveryPath };
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Cleanup below remains conservative.
      }
      descriptor = undefined;
    }
    if (error instanceof JsonMutationGuardChangedError) {
      return { status: "recovery-required" };
    }
    if (!mutationGuardUnchanged(guard)) {
      return { status: "recovery-required" };
    }
    if (recoveryPath !== undefined && recoveryExists) {
      return {
        status: "recovery-required",
        recoveryPath: firstExistingPath(
          recoveryPath,
          transactionDirectory,
          path,
          temporaryPath,
        ),
      };
    }
    if (destinationPublished || (transactionExists && !removeTransaction(transactionDirectory))) {
      return {
        status: "recovery-required",
        recoveryPath: firstExistingPath(
          recoveryPath,
          transactionDirectory,
          path,
          temporaryPath,
        ),
      };
    }
    transactionExists = false;
    temporaryExists = false;
    throw new Error("Unable to write JSON config");
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the operation's secret-free result.
      }
    }
    if (temporaryExists && !transactionExists && mutationGuardUnchanged(guard)) {
      try {
        rmSync(temporaryPath, { force: true });
      } catch {
        // Recovery path or destination remains authoritative.
      }
    }
    // Live or ambiguous transaction artifacts are intentionally retained and
    // are always surfaced by the result or the next pre-inspection recovery.
  }
}
