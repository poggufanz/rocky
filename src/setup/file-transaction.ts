import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { directorySyncCapability } from "./directory-sync.js";

/**
 * Opaque authority to mutate a previously validated filesystem topology.
 * This closes observable check/use windows, but Node has no portable way to
 * make the final identity check and following namespace syscall indivisible.
 */
export interface FileMutationGuard {
  unchanged(): boolean;
}

class FileMutationGuardChangedError extends Error {}

export function mutationGuardUnchanged(guard: FileMutationGuard | undefined): boolean {
  try {
    return guard?.unchanged() ?? true;
  } catch {
    return false;
  }
}

export interface FileIdentity {
  dev: number;
  ino: number;
}

export function requireMutationGuard(guard: FileMutationGuard | undefined): void {
  if (!mutationGuardUnchanged(guard)) throw new FileMutationGuardChangedError();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return isObject(error) && typeof error.code === "string" ? error.code : undefined;
}

export function syncParentDirectory(path: string): void {
  directorySyncCapability.sync(dirname(path));
}

function syncDirectory(path: string): void {
  directorySyncCapability.sync(path);
}

/**
 * What a recovery/settle/write call actually proved and did, established
 * once — by the code that acted, at the moment it acted — rather than
 * re-derived later by whatever prints a message about it. Every user-facing
 * sentence about a recovery outcome must be a pure function of this record;
 * nothing downstream may re-check the filesystem to decide what to claim.
 *
 * `outcome` is optional on the result types below purely for backward
 * compatibility with existing callers (`json-config.ts` and its adapters)
 * that predate this record and only ever read `recoveryPath`; every
 * production code path in this module populates it.
 */
export interface RecoveryOutcome {
  /** A transaction directory this call examined, when one resolved. */
  transactionDirectory?: string;
  /**
   * A live regular file, proven — at the moment this call finished acting —
   * to be a genuine, singly-owned copy of content derived from the target's
   * prior bytes (`isManagedRegularFile`, not a bare existence check). Never
   * a directory, a symlink, an unrelated file, or a path that merely
   * exists. Absent when no such artifact is proven.
   */
  provenCopy?: string;
  /**
   * A message-layer fact only: whether `path` still resolves to *something*
   * (`pathExists`, i.e. `lstatSync` succeeding), read by `hook.ts` solely to
   * choose which sentence to speak about `path`. This is deliberately NOT the
   * same predicate `resolveUndisplacedTransaction` uses to decide whether
   * discarding a staged artifact is safe (round 9, R1 — round 8's I2 fix
   * applied `isLiveRegularFile` to both the decision site and this field, and
   * their safe directions are opposite: a destroy/keep decision must be
   * conservative about destroying — treat anything short of a proven live
   * regular file as "not there", so a dangling or valid symlink still blocks
   * discard — while a message must be conservative about claiming — treat
   * anything that resolves, including a valid symlink to real content, as
   * "still there", so Rocky never tells the user their file is "gone" when a
   * name still stands at that path). One predicate cannot serve both
   * purposes; this field exists so the same boolean is never reused for
   * both. See `ambiguousOutcome` (message derivation) versus
   * `resolveUndisplacedTransaction` (decision derivation) below.
   */
  targetExists: boolean;
  /** True only when this very call wrote bytes to `path` (created or restored it). */
  targetWritten: boolean;
  /**
   * True when this call found a transaction directory it could not prove
   * safe to discard and left it in place rather than guessing.
   *
   * There is deliberately no field recording whether a transaction
   * directory was *removed*: round 8 found `directoryRemoved` written by
   * ten call sites and read by none (I1) — an unread fact is not a safety
   * mechanism, it is the enumeration gap wearing the enumeration's uniform.
   * The fix is not to wire it up; it is that recovery no longer removes a
   * transaction directory at all (see `resolveUndisplacedTransaction`'s doc
   * comment). A capability that does not exist cannot be exercised
   * silently, and needs no field to disclose it.
   */
  artifactRetainedUnproven: boolean;
}

export type BytesReadResult =
  | { status: "missing" }
  | { status: "valid"; bytes: Buffer; mode?: number; identity?: FileIdentity };

export type ConditionalBytesWriteResult =
  | { status: "written"; recoveryPath?: string; outcome?: RecoveryOutcome }
  | { status: "changed"; recoveryPath?: string; outcome?: RecoveryOutcome }
  | { status: "recovery-required"; recoveryPath?: string; outcome?: RecoveryOutcome };

export type FileTransactionRecoveryResult =
  | { status: "clear" }
  | { status: "recovered"; recoveryPath?: string; outcome?: RecoveryOutcome }
  | { status: "manual"; recoveryPath?: string; outcome?: RecoveryOutcome };

export type FileTransactionInspectionResult =
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

function fileIdentityMatches(path: string, identity: FileIdentity): boolean {
  try {
    const metadata = lstatSync(path);
    return metadata.isFile()
      && !metadata.isSymbolicLink()
      && sameIdentity(metadata, identity);
  } catch {
    return false;
  }
}

export function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    return true;
  }
}

/**
 * Proves `path` itself holds live, reachable content — a genuine regular
 * file, not merely a name that resolves. `pathExists`/`lstatSync` return
 * true for a dangling symlink, a valid symlink, a directory, a socket, or
 * any other non-regular name (round 8, I2: `resolveUndisplacedTransaction`
 * used to treat any of those as proof that discarding a staged artifact
 * loses nothing — false for a dangling symlink, where the staged artifact
 * can be the only surviving copy of anything).
 */
function isLiveRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
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

interface RecoveryFileIdentity {
  dev: number;
  ino: number;
  nlink: number;
}

interface RecoveryPublication {
  source: RecoveryFileIdentity;
  destination: RecoveryFileIdentity;
  expectedBytes: Buffer;
  expectedDigest: string;
  expectedLength: number;
  expectedMode: number;
}

function sameIdentity(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function stableSourceMetadata(
  left: Stats,
  right: Stats,
): boolean {
  return sameIdentity(left, right)
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && observableRecoveryMode(left) === observableRecoveryMode(right);
}

function observableRecoveryMode(metadata: Stats): number {
  const mode = metadata.mode & 0o777;
  return process.platform === "win32" ? ((mode & 0o222) === 0 ? 0 : 1) : mode;
}

function recoveryDigest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function recoveryReadOpenFlags(): number {
  if (process.platform === "win32") return fsConstants.O_RDONLY;
  return fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
}

function recoveryDestinationOpenFlags(): number {
  return fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR;
}

function readDescriptorExactly(descriptor: number, length: number): Buffer {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error("Recovery file length is invalid");
  }
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const read = readSync(descriptor, bytes, offset, length - offset, offset);
    if (read <= 0) throw new Error("Recovery file ended during positional read");
    offset += read;
  }
  return bytes;
}

function writeDescriptorCompletely(descriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (written <= 0) throw new Error("Recovery publication made no write progress");
    offset += written;
  }
}

function recoveryIdentityMatches(
  metadata: Stats,
  identity: RecoveryFileIdentity,
): boolean {
  return sameIdentity(metadata, identity) && metadata.nlink === identity.nlink;
}

function publishedDescriptorMatches(
  metadata: Stats,
  identity: RecoveryFileIdentity,
  publication: RecoveryPublication,
): boolean {
  return metadata.isFile()
    && recoveryIdentityMatches(metadata, identity)
    && metadata.size === publication.expectedLength
    && observableRecoveryMode(metadata) === publication.expectedMode;
}

function publishedPathMatches(
  metadata: Stats,
  identity: RecoveryFileIdentity,
  publication: RecoveryPublication,
): boolean {
  return !metadata.isSymbolicLink()
    && publishedDescriptorMatches(metadata, identity, publication);
}

function stablePublishedObservation(
  previous: Stats,
  descriptor: Stats,
  path: Stats,
  identity: RecoveryFileIdentity,
  publication: RecoveryPublication,
): boolean {
  return publishedDescriptorMatches(descriptor, identity, publication)
    && publishedPathMatches(path, identity, publication)
    && stableSourceMetadata(previous, descriptor)
    && stableSourceMetadata(descriptor, path);
}

function exactPublishedSnapshot(
  bytes: Buffer,
  publication: RecoveryPublication,
): boolean {
  return bytes.equals(publication.expectedBytes)
    && recoveryDigest(bytes) === publication.expectedDigest;
}

function validatePublishedPair(
  publication: RecoveryPublication,
  existingPath: string,
  newPath: string,
): boolean {
  let sourceDescriptor: number | undefined;
  let destinationDescriptor: number | undefined;
  try {
    const sourceBefore = lstatSync(existingPath);
    if (!publishedPathMatches(sourceBefore, publication.source, publication)) return false;
    sourceDescriptor = openSync(existingPath, recoveryReadOpenFlags());
    const openedSource = fstatSync(sourceDescriptor);
    if (!publishedDescriptorMatches(openedSource, publication.source, publication)
      || !stableSourceMetadata(sourceBefore, openedSource)) {
      return false;
    }

    const destinationBefore = lstatSync(newPath);
    if (!publishedPathMatches(destinationBefore, publication.destination, publication)) return false;
    destinationDescriptor = openSync(newPath, recoveryReadOpenFlags());
    const openedDestination = fstatSync(destinationDescriptor);
    if (!publishedDescriptorMatches(openedDestination, publication.destination, publication)
      || !stableSourceMetadata(destinationBefore, openedDestination)) {
      return false;
    }

    // Both descriptors remain live while each namespace is re-observed. A
    // source mutation initiated by destination open is therefore in-bounds.
    const pairedSourceDescriptor = fstatSync(sourceDescriptor);
    const pairedDestinationDescriptor = fstatSync(destinationDescriptor);
    const pairedSourcePath = lstatSync(existingPath);
    const pairedDestinationPath = lstatSync(newPath);
    if (!stablePublishedObservation(
      openedSource,
      pairedSourceDescriptor,
      pairedSourcePath,
      publication.source,
      publication,
    ) || !stablePublishedObservation(
      openedDestination,
      pairedDestinationDescriptor,
      pairedDestinationPath,
      publication.destination,
      publication,
    )) {
      return false;
    }

    const sourceBytes = readDescriptorExactly(sourceDescriptor, publication.expectedLength);
    const destinationBytes = readDescriptorExactly(
      destinationDescriptor,
      publication.expectedLength,
    );
    const sourceAfterRead = fstatSync(sourceDescriptor);
    const destinationAfterRead = fstatSync(destinationDescriptor);
    const sourcePathAfterRead = lstatSync(existingPath);
    const destinationPathAfterRead = lstatSync(newPath);
    if (!exactPublishedSnapshot(sourceBytes, publication)
      || !exactPublishedSnapshot(destinationBytes, publication)
      || !sourceBytes.equals(destinationBytes)
      || !stablePublishedObservation(
        pairedSourceDescriptor,
        sourceAfterRead,
        sourcePathAfterRead,
        publication.source,
        publication,
      )
      || !stablePublishedObservation(
        pairedDestinationDescriptor,
        destinationAfterRead,
        destinationPathAfterRead,
        publication.destination,
        publication,
      )) {
      return false;
    }

    // One finite final pass rechecks source bytes after destination bytes, then
    // re-observes both descriptors and namespaces before either descriptor closes.
    const finalDestinationBytes = readDescriptorExactly(
      destinationDescriptor,
      publication.expectedLength,
    );
    const finalSourceBytes = readDescriptorExactly(sourceDescriptor, publication.expectedLength);
    const finalSourceDescriptor = fstatSync(sourceDescriptor);
    const finalDestinationDescriptor = fstatSync(destinationDescriptor);
    const finalSourcePath = lstatSync(existingPath);
    const finalDestinationPath = lstatSync(newPath);
    return exactPublishedSnapshot(finalSourceBytes, publication)
      && exactPublishedSnapshot(finalDestinationBytes, publication)
      && finalSourceBytes.equals(finalDestinationBytes)
      && stablePublishedObservation(
        sourceAfterRead,
        finalSourceDescriptor,
        finalSourcePath,
        publication.source,
        publication,
      )
      && stablePublishedObservation(
        destinationAfterRead,
        finalDestinationDescriptor,
        finalDestinationPath,
        publication.destination,
        publication,
      );
  } catch {
    return false;
  } finally {
    if (destinationDescriptor !== undefined) {
      try { closeSync(destinationDescriptor); } catch { /* retain every ambiguous file */ }
    }
    if (sourceDescriptor !== undefined) {
      try { closeSync(sourceDescriptor); } catch { /* retain recovery authority */ }
    }
  }
}

// linkSync provides no handle proving which inode still occupies its destination
// after return. Exclusive read/write open does: descriptor identity is established
// by creation, supports positional readback, and never authorizes ambiguous cleanup.
function copyRegularFileExclusiveNoFollow(
  existingPath: string,
  newPath: string,
): RecoveryPublication {
  const before = lstatSync(existingPath);
  if (!before.isFile()
    || before.isSymbolicLink()
    || !isManagedRegularFile(existingPath, newPath)) {
    throw new Error("Recovery source is not a regular file");
  }

  let sourceDescriptor: number | undefined;
  let destinationDescriptor: number | undefined;
  try {
    sourceDescriptor = openSync(existingPath, recoveryReadOpenFlags());
    const openedSource = fstatSync(sourceDescriptor);
    const observedSource = lstatSync(existingPath);
    if (!openedSource.isFile()
      || !observedSource.isFile()
      || observedSource.isSymbolicLink()
      || !stableSourceMetadata(before, openedSource)
      || !stableSourceMetadata(openedSource, observedSource)) {
      throw new Error("Recovery source changed before publication");
    }

    const bytes = readDescriptorExactly(sourceDescriptor, openedSource.size);
    const digest = recoveryDigest(bytes);
    const expectedMode = observableRecoveryMode(openedSource);
    const sourceAfterRead = fstatSync(sourceDescriptor);
    const sourcePathAfterRead = lstatSync(existingPath);
    if (!stableSourceMetadata(openedSource, sourceAfterRead)
      || !stableSourceMetadata(sourceAfterRead, sourcePathAfterRead)) {
      throw new Error("Recovery source changed while reading");
    }

    destinationDescriptor = openSync(
      newPath,
      recoveryDestinationOpenFlags(),
      openedSource.mode & 0o777,
    );
    const createdDestination = fstatSync(destinationDescriptor);
    const createdPath = lstatSync(newPath);
    if (!createdDestination.isFile()
      || createdDestination.nlink !== 1
      || !createdPath.isFile()
      || createdPath.isSymbolicLink()
      || !sameIdentity(createdDestination, createdPath)
      || createdPath.nlink !== 1) {
      throw new Error("Recovery destination is not an exclusive regular file");
    }
    writeDescriptorCompletely(destinationDescriptor, bytes);
    fchmodSync(destinationDescriptor, openedSource.mode & 0o777);
    fsyncSync(destinationDescriptor);
    const publishedBytes = readDescriptorExactly(destinationDescriptor, bytes.length);
    const writtenDestination = fstatSync(destinationDescriptor);
    const finalSourceDescriptor = fstatSync(sourceDescriptor);
    const finalSourceBytes = readDescriptorExactly(sourceDescriptor, bytes.length);
    const finalSource = lstatSync(existingPath);
    const finalDestination = lstatSync(newPath);
    if (!stableSourceMetadata(sourceAfterRead, finalSourceDescriptor)
      || !stableSourceMetadata(finalSourceDescriptor, finalSource)
      || !finalSource.isFile()
      || finalSource.isSymbolicLink()
      || !sameIdentity(finalSourceDescriptor, finalSource)
      || !finalSourceBytes.equals(bytes)
      || recoveryDigest(finalSourceBytes) !== digest
      || !writtenDestination.isFile()
      || !sameIdentity(createdDestination, writtenDestination)
      || writtenDestination.nlink !== 1
      || writtenDestination.size !== bytes.length
      || observableRecoveryMode(writtenDestination) !== expectedMode
      || !publishedBytes.equals(bytes)
      || recoveryDigest(publishedBytes) !== digest
      || !finalDestination.isFile()
      || finalDestination.isSymbolicLink()
      || !stableSourceMetadata(writtenDestination, finalDestination)
      || finalDestination.nlink !== writtenDestination.nlink
      || observableRecoveryMode(finalDestination) !== expectedMode) {
      throw new Error("Recovery publication changed before validation");
    }
    return {
      source: {
        dev: finalSource.dev,
        ino: finalSource.ino,
        nlink: finalSource.nlink,
      },
      destination: {
        dev: writtenDestination.dev,
        ino: writtenDestination.ino,
        nlink: writtenDestination.nlink,
      },
      expectedBytes: Buffer.from(bytes),
      expectedDigest: digest,
      expectedLength: bytes.length,
      expectedMode,
    };
  } catch (error) {
    // Deliberately never cleans up `newPath` here, even though O_CREAT|O_EXCL
    // guarantees this call is always the one that created it fresh: the path
    // can be rebound after creation by a concurrent writer, or its content
    // can be overwritten in place by one, before this catch ever runs (both
    // reproduced by `setup-claude-desktop.test.ts`'s rebind- and
    // overwrite-during-publication tests) — an unlink here could destroy
    // data that now belongs to someone else, at a path Rocky merely happened
    // to create the container for. F1's actual defect is not the absence of
    // cleanup; it is a caller trusting "a path exists" as proof of anything.
    // The fix lives in the outcome record instead: every caller re-observes
    // `path` itself, fresh, right now, and reports exactly what it finds —
    // never "I touch nothing" when this call may have left bytes behind,
    // and never an instruction to remove the one place old content survives.
    throw error;
  } finally {
    if (destinationDescriptor !== undefined) {
      try { closeSync(destinationDescriptor); } catch { /* retain recovery authority */ }
    }
    if (sourceDescriptor !== undefined) {
      try { closeSync(sourceDescriptor); } catch { /* retain recovery authority */ }
    }
  }
}

function writeManifest(
  transactionDirectory: string,
  target: string,
  state: TransactionState,
  guard?: FileMutationGuard,
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
export function inspectFileTransaction(path: string): FileTransactionInspectionResult {
  for (const transactionDirectory of transactionDirectories(path)) {
    if (readManifest(transactionDirectory, path)?.state === "committed") continue;
    return { status: "pending", recoveryPath: firstExistingPath(transactionDirectory) };
  }
  return { status: "clear" };
}

/**
 * A live regular file, proven right now via `isManagedRegularFile` (never a
 * bare existence check — a directory, a symlink, or a file with the wrong
 * link-count shape are all refused), that can honestly be called a
 * surviving copy of content derived from `path`'s prior bytes. Absent when
 * no such proof holds (final audit, F9 mutant A1: the message layer used to
 * accept any live file by name; the proof now lives here, once, and is
 * strictly stronger than a bare `.isFile()` check).
 */
function provenCopyOf(displacedPath: string, path: string): string | undefined {
  return isManagedRegularFile(displacedPath, path) ? displacedPath : undefined;
}

/**
 * The outcome record for a stop that resolved nothing new: proves, right
 * now, exactly what a caller may honestly claim — a transaction directory
 * only when it still exists, a copy only when `provenCopyOf` establishes
 * one, and whether `path` still resolves at all. `targetWritten` is supplied
 * by the caller, which alone knows whether its own attempt to write `path`
 * ran.
 *
 * `targetExists` here is deliberately `pathExists`, not `isLiveRegularFile`
 * (round 9, R1). This value only ever reaches a message (`hook.ts`'s
 * `reportBashrcRecoveryStop`, which picks between "I keep safe copy" and
 * "bashrc gone" purely off this field) — it is never read back into a
 * destroy/keep decision anywhere in this module. `isLiveRegularFile` is
 * right for `resolveUndisplacedTransaction`'s own decision below because a
 * decision must fail closed: treat a valid symlink as "not proven live" so a
 * staged artifact is never discarded on its account. A message must fail the
 * other way: treat that same valid symlink as "still there", because it is —
 * following it reaches the user's real file, and telling them it is "gone"
 * is false. Round 8 computed one boolean (`isLiveRegularFile`) and fed it to
 * both the decision and this field; a `.bashrc` that is a live symlink to
 * real content made the decision correctly retain it, and then this same
 * field told the message layer to say "bashrc gone" and recommend copying a
 * stale artifact over that live symlink — which follows the link and
 * destroys the user's real file. `pathExists` never makes that claim: it is
 * true for anything that resolves to a name at all (regular file, valid
 * symlink, dangling symlink, directory, socket — every non-ENOENT shape),
 * so "gone" is spoken only when `path` truly does not exist. See the
 * `RecoveryOutcome.targetExists` doc comment for the general rule this
 * follows: a decision predicate and a message predicate must never share one
 * field, because their safe directions run opposite.
 */
function ambiguousOutcome(
  transactionDirectory: string,
  path: string,
  displacedPath: string | undefined,
  targetWritten: boolean,
): RecoveryOutcome {
  const directoryStillThere = pathExists(transactionDirectory);
  return {
    transactionDirectory: directoryStillThere ? transactionDirectory : undefined,
    provenCopy: displacedPath !== undefined ? provenCopyOf(displacedPath, path) : undefined,
    targetExists: pathExists(path),
    targetWritten,
    artifactRetainedUnproven: directoryStillThere,
  };
}

/**
 * Decide whether it is safe to resolve a transaction directory that has no
 * proven `displaced` backup. Safe exactly when nothing inside it could be
 * the last surviving copy of anything: either `path` itself genuinely holds
 * live content right now, proven by `isLiveRegularFile` (round 8, I2 —
 * *not* `pathExists`, which is also true for a dangling symlink; a hard
 * link only ever loses one name, but a dangling symlink is not a hard link
 * to anything and proves nothing was ever there), or neither of the
 * directory's own staged artifacts exist (nothing to protect regardless of
 * `path`). When neither holds, the directory — and the artifact inside it
 * that cannot be vouched for — is left in place and named, so the caller has
 * something concrete to inspect rather than a dead end with no remedy.
 *
 * This decision's own `isLiveRegularFile(path)` check is inlined into the
 * condition below, not bound to a named local (round 10, S2): a local in
 * function scope stayed readable at every return in this function, so
 * nothing stopped a later edit from writing it into the returned
 * `RecoveryOutcome.targetExists` field too — a field that feeds a message,
 * which must fail closed the opposite way from this decision (see the
 * field's own doc comment; round 9 introduced exactly such a local and
 * claimed no boolean in scope meant both things, which mutants D12/D13
 * disproved by re-merging it with no test failing). Every return here
 * computes `pathExists(path)` fresh for the record instead, so the two
 * predicates cannot be conflated even by reusing this file's own name for
 * the check — there is nothing named to reuse.
 *
 * This single proof replaces two guards that used to apply this unevenly by
 * state label alone: unconditional for "prepared", conditional on
 * `pathExists(path)` for "published", and unconditional again for the
 * "displaced" fallback below. A crash can leave any of the three states
 * holding a `prepared` artifact derived from the user's file with `path`
 * externally removed afterward; the label never proved which, only the
 * artifact's own presence does (final audit, F2 + F3: protection
 * proportional to what is actually at stake, decided from evidence
 * available at recovery time, never from an assumption recorded when the
 * manifest state was written).
 *
 * Resolving never `rm -r`s the transaction directory itself (round 8, I1):
 * it discards only the (possibly absent) staged `prepared` and `link-probe`
 * artifacts. `link-probe` (round 9, r4) is a second hard link to the exact
 * same inode as `prepared`, created and removed by `atomicWriteBytesIfUnchanged`'s
 * own link-capability probe; a crash inside that narrow window can leave
 * `link-probe` standing after `prepared`'s own name is already gone. The
 * same redundancy proof that authorizes discarding `prepared` covers it,
 * since they are the same bytes under the same inode — this is the exact,
 * already-audited action the three sibling "recovered" branches in
 * `recoverFileTransaction` already take — then advances the manifest to
 * "committed", the same state those branches leave behind too. A directory
 * that is never recursively deleted here cannot be deleted wrongly, cannot
 * be deleted silently, and needs no field to disclose that it happened.
 * `pruneSupersededTransactions` — already silent, already proof-backed, and
 * unchanged by this round — reclaims it the next time a real `.bashrc`
 * write commits a fresh copy; until then, an inert directory holding at
 * most a "committed" manifest sits in `$HOME` doing nothing.
 */
function resolveUndisplacedTransaction(
  transactionDirectory: string,
  path: string,
  guard: FileMutationGuard | undefined,
): FileTransactionRecoveryResult {
  const preparedArtifactPath = join(transactionDirectory, "prepared");
  const linkProbePath = join(transactionDirectory, "link-probe");
  if (!isLiveRegularFile(path)
    && (pathExists(preparedArtifactPath) || pathExists(linkProbePath))) {
    return {
      status: "manual",
      recoveryPath: transactionDirectory,
      outcome: {
        transactionDirectory,
        targetExists: pathExists(path),
        targetWritten: false,
        artifactRetainedUnproven: true,
      },
    };
  }
  if (!mutationGuardUnchanged(guard)) {
    return {
      status: "manual",
      outcome: {
        targetExists: pathExists(path),
        targetWritten: false,
        artifactRetainedUnproven: false,
      },
    };
  }
  if ((pathExists(preparedArtifactPath) || pathExists(linkProbePath))
    && (!mutationGuardUnchanged(guard)
      || !discardPrepared(transactionDirectory, preparedArtifactPath, linkProbePath))) {
    return {
      status: "manual",
      recoveryPath: transactionDirectory,
      outcome: {
        transactionDirectory,
        targetExists: pathExists(path),
        targetWritten: false,
        artifactRetainedUnproven: true,
      },
    };
  }
  if (!mutationGuardUnchanged(guard)) {
    return {
      status: "manual",
      outcome: { targetExists: pathExists(path), targetWritten: false, artifactRetainedUnproven: false },
    };
  }
  try {
    writeManifest(transactionDirectory, path, "committed", guard);
  } catch {
    return {
      status: "manual",
      recoveryPath: transactionDirectory,
      outcome: {
        transactionDirectory,
        targetExists: pathExists(path),
        targetWritten: false,
        artifactRetainedUnproven: true,
      },
    };
  }
  return {
    status: "recovered",
    outcome: {
      targetExists: pathExists(path),
      targetWritten: false,
      artifactRetainedUnproven: false,
    },
  };
}

/** Recover an interrupted mutation before anybody interprets an absent target. */
export function recoverFileTransaction(
  path: string,
  guard?: FileMutationGuard,
): FileTransactionRecoveryResult {
  for (const transactionDirectory of transactionDirectories(path)) {
    const manifest = readManifest(transactionDirectory, path);
    if (manifest?.state === "committed") continue;
    if (manifest === undefined) {
      return {
        status: "manual",
        recoveryPath: firstExistingPath(transactionDirectory),
        outcome: ambiguousOutcome(transactionDirectory, path, undefined, false),
      };
    }

    const displacedPath = join(transactionDirectory, "displaced");
    const preparedArtifactPath = join(transactionDirectory, "prepared");

    // No displaced backup ever existed for this transaction: either the
    // process crashed before ever attempting to displace anything
    // ("prepared"), or the prior target was missing so there was never
    // anything to protect and the manifest reached "published" the instant
    // `path` was linked (see the "missing" branch of `atomicWriteBytesIfUnchanged`
    // — it writes "published" right after `linkSync`, with no "displaced"
    // state in between). `resolveUndisplacedTransaction` proves, from the
    // artifact itself, whether discarding is safe (see its own doc comment).
    if ((manifest.state === "prepared" || manifest.state === "published")
      && !pathExists(displacedPath)) {
      return resolveUndisplacedTransaction(transactionDirectory, path, guard);
    }

    if (manifest.state === "prepared"
      && pathExists(path)
      && isManagedRecoveryPair(path, displacedPath, path)) {
      // Proven now, before `discardPrepared`/`writeManifest` mutate anything
      // below: committing this transaction makes it its own "committed"
      // entry, and `isManagedRegularFile`'s link accounting reads exactly
      // that state — recomputing the proof afterward would count this
      // transaction's own just-written commit against itself and could
      // report a copy as unproven that was proven moments earlier.
      const provenCopy = provenCopyOf(displacedPath, path);
      if (pathExists(preparedArtifactPath)
        && (!mutationGuardUnchanged(guard)
          || !discardPrepared(transactionDirectory, preparedArtifactPath))) {
        return {
          status: "manual",
          recoveryPath: firstExistingPath(transactionDirectory),
          outcome: ambiguousOutcome(transactionDirectory, path, displacedPath, false),
        };
      }
      if (!mutationGuardUnchanged(guard)) {
        return { status: "manual", outcome: ambiguousOutcome(transactionDirectory, path, displacedPath, false) };
      }
      try {
        writeManifest(transactionDirectory, path, "committed", guard);
      } catch {
        return {
          status: "manual",
          recoveryPath: firstExistingPath(transactionDirectory),
          outcome: ambiguousOutcome(transactionDirectory, path, displacedPath, false),
        };
      }
      return {
        status: "recovered",
        recoveryPath: firstExistingPath(displacedPath),
        outcome: {
          transactionDirectory,
          provenCopy,
          targetExists: true,
          targetWritten: false,
          artifactRetainedUnproven: false,
        },
      };
    }

    // Complete-but-unrecorded: a crash between the publishing linkSync and
    // the manifest fully advancing to "committed" leaves the manifest at
    // "prepared", "displaced", or "published" even though the target already
    // holds the new bytes. This is provable, not guessed, in all three
    // states: `path` shares its inode with the transaction's own `prepared`
    // artifact (nlink 2, the exact pairing only that linkSync can create)
    // and the pre-write bytes are intact in `displaced`. Finish committing
    // the transaction that already happened instead of reporting an
    // unrecoverable dead end for a write that in fact succeeded.
    if ((manifest.state === "prepared"
        || manifest.state === "displaced"
        || manifest.state === "published")
      && pathExists(path)
      && pathExists(displacedPath)
      && isManagedRegularFile(displacedPath, path)
      && isManagedRecoveryPair(path, preparedArtifactPath, path)) {
      if (pathExists(preparedArtifactPath)
        && (!mutationGuardUnchanged(guard)
          || !discardPrepared(transactionDirectory, preparedArtifactPath))) {
        return {
          status: "manual",
          recoveryPath: firstExistingPath(transactionDirectory),
          outcome: ambiguousOutcome(transactionDirectory, path, displacedPath, false),
        };
      }
      if (!mutationGuardUnchanged(guard)) {
        return { status: "manual", outcome: ambiguousOutcome(transactionDirectory, path, displacedPath, false) };
      }
      try {
        writeManifest(transactionDirectory, path, "committed", guard);
      } catch {
        return {
          status: "manual",
          recoveryPath: firstExistingPath(transactionDirectory),
          outcome: ambiguousOutcome(transactionDirectory, path, displacedPath, false),
        };
      }
      // Proven by this branch's own entry condition, before `discardPrepared`/
      // `writeManifest` mutate anything above — never recomputed afterward
      // (see the same note on the legacy-pairing branch above).
      return {
        status: "recovered",
        recoveryPath: firstExistingPath(displacedPath),
        outcome: {
          transactionDirectory,
          provenCopy: displacedPath,
          targetExists: true,
          targetWritten: false,
          artifactRetainedUnproven: false,
        },
      };
    }

    // A "published" manifest that reaches here was not proven by either
    // branch above (e.g. `prepared` is already gone, so `isManagedRecoveryPair`
    // cannot pair it with `path` — the exact shape a crash or a single failed
    // write leaves between `atomicWriteBytesIfUnchanged`'s own `prepared`
    // unlink and its "committed" manifest write). round 10, S1: that shape is
    // not ambiguous — `displaced` proven a singly-owned copy of the prior
    // bytes, plus `path` itself proven a live regular file, is exactly
    // `resolveUndisplacedTransaction`'s own accepted proof (see its doc
    // comment) with a proven `displaced` on top, and committing changes
    // nothing on disk: `displaced` is retained either way, only the manifest
    // label advances. Before this fix, every such shape — including an
    // ordinary `SIGKILL` or a single failed manifest write, with no adversary
    // and no concurrency — was `manual` forever, on a target that was already
    // byte-correct.
    if (manifest.state === "published") {
      if (pathExists(displacedPath)
        && isManagedRegularFile(displacedPath, path)
        && isLiveRegularFile(path)) {
        // Proven now, before this call's own commit can distort the same
        // check (see the identical note on the two branches above and on
        // `restoreDisplaced`): once this transaction becomes its own
        // "committed" entry, recomputing this proof afterward would count
        // that self-reference against `displaced` and wrongly report it as
        // unproven.
        const provenCopy = displacedPath;
        try {
          writeManifest(transactionDirectory, path, "committed", guard);
        } catch {
          return {
            status: "manual",
            recoveryPath: firstExistingPath(transactionDirectory),
            outcome: ambiguousOutcome(transactionDirectory, path, displacedPath, false),
          };
        }
        return {
          status: "recovered",
          recoveryPath: firstExistingPath(displacedPath),
          outcome: {
            transactionDirectory,
            provenCopy,
            targetExists: true,
            targetWritten: false,
            artifactRetainedUnproven: false,
          },
        };
      }
      // Genuinely ambiguous otherwise (e.g. `path` does not exist or is not a
      // live regular file, or `displaced` cannot be proven a singly-owned
      // copy — a same-user concurrent writer inside this 0700 directory is
      // the only way to reach that second case), so this stays manual rather
      // than falling into the "prepared"/"displaced" restore-from-`displaced`
      // logic below, which assumes a state machine "published" was never
      // meant to re-enter.
      return {
        status: "manual",
        recoveryPath: firstExistingPath(transactionDirectory),
        outcome: ambiguousOutcome(transactionDirectory, path, displacedPath, false),
      };
    }

    if (pathExists(path)) {
      return {
        status: "manual",
        recoveryPath: firstExistingPath(transactionDirectory),
        outcome: ambiguousOutcome(transactionDirectory, path, displacedPath, false),
      };
    }

    if (pathExists(displacedPath)) {
      if (!isManagedRegularFile(displacedPath, path)) {
        return {
          status: "manual",
          recoveryPath: firstExistingPath(displacedPath, transactionDirectory),
          outcome: ambiguousOutcome(transactionDirectory, path, displacedPath, false),
        };
      }
      // Proven now, before anything below mutates: committing makes this
      // transaction its own "committed" entry, and recomputing the same
      // proof afterward would count that self-reference against `displaced`
      // and report it as unproven (the exact bug this note guards against
      // on the two commit branches above).
      const provenCopy = displacedPath;
      if (!mutationGuardUnchanged(guard)) {
        return { status: "manual", outcome: ambiguousOutcome(transactionDirectory, path, displacedPath, false) };
      }
      let publication: RecoveryPublication;
      try {
        publication = copyRegularFileExclusiveNoFollow(displacedPath, path);
        syncParentDirectory(path);
      } catch {
        return {
          status: "manual",
          recoveryPath: firstExistingPath(displacedPath, transactionDirectory, path),
          outcome: ambiguousOutcome(transactionDirectory, path, displacedPath, pathExists(path)),
        };
      }
      if (!validatePublishedPair(publication, displacedPath, path)) {
        return {
          status: "manual",
          recoveryPath: firstExistingPath(transactionDirectory),
          outcome: ambiguousOutcome(transactionDirectory, path, displacedPath, true),
        };
      }
      const preparedPath = join(transactionDirectory, "prepared");
      if (pathExists(preparedPath)
        && (!mutationGuardUnchanged(guard)
          || !discardPrepared(transactionDirectory, preparedPath))) {
        return {
          status: "manual",
          recoveryPath: firstExistingPath(transactionDirectory),
          outcome: ambiguousOutcome(transactionDirectory, path, displacedPath, true),
        };
      }
      if (!mutationGuardUnchanged(guard)) {
        return { status: "manual", outcome: ambiguousOutcome(transactionDirectory, path, displacedPath, true) };
      }
      if (!validatePublishedPair(publication, displacedPath, path)) {
        return {
          status: "manual",
          recoveryPath: firstExistingPath(transactionDirectory),
          outcome: ambiguousOutcome(transactionDirectory, path, displacedPath, true),
        };
      }
      // Each path's last successful paired observation still precedes manifest
      // publication. Node cannot atomically compare both files and publish this
      // manifest; mutation in that remaining interval never authorizes cleanup.
      try {
        writeManifest(transactionDirectory, path, "committed", guard);
      } catch {
        return {
          status: "manual",
          recoveryPath: firstExistingPath(transactionDirectory),
          outcome: ambiguousOutcome(transactionDirectory, path, displacedPath, true),
        };
      }
      return {
        status: "recovered",
        recoveryPath: firstExistingPath(displacedPath),
        outcome: {
          transactionDirectory,
          provenCopy,
          targetExists: true,
          targetWritten: true,
          artifactRetainedUnproven: false,
        },
      };
    } else {
      // Both target and displaced backup are absent: `resolveUndisplacedTransaction`
      // applies the same artifact-driven proof used above — safe to discard
      // only when `path` is live (it is not, here) or the staged artifact
      // does not exist; otherwise the directory is retained and named
      // rather than guessed away (final audit, F3's reasoning extended to
      // this fallback, not just the state-gated fast path above it).
      return resolveUndisplacedTransaction(transactionDirectory, path, guard);
    }
  }
  return { status: "clear" };
}

function directoryIdentity(path: string): { dev: number; ino: number } | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/**
 * Remove committed transaction directories for `path` other than `keep`.
 * Only `state: "committed"` manifests are eligible — a `committed` directory
 * is provably finished (nothing in `recoverFileTransaction`/`inspectFileTransaction`
 * ever reads it again) and, once a newer one exists, provably superseded: its
 * `displaced` bytes describe a state of `path` that is now two writes stale.
 * Pending/ambiguous transactions are never touched here; they stay exactly
 * where `recoverFileTransaction` can find them. Best-effort: a failure to
 * remove one is silently skipped rather than surfaced, so pruning stale
 * recovery copies can never itself become a new source of ambiguity.
 *
 * `keep` is compared by filesystem identity (dev+ino), not by string, so a
 * differently-spelled-but-equivalent path (a trailing slash, for example)
 * still protects the directory it names — the exemption does not rely on the
 * sole caller today always passing a canonical string.
 */
export function pruneSupersededTransactions(path: string, keep?: string): void {
  const keptIdentity = keep !== undefined ? directoryIdentity(keep) : undefined;
  for (const transactionDirectory of transactionDirectories(path)) {
    if (keptIdentity !== undefined) {
      const candidateIdentity = directoryIdentity(transactionDirectory);
      if (candidateIdentity !== undefined && sameIdentity(candidateIdentity, keptIdentity)) continue;
    }
    if (readManifest(transactionDirectory, path)?.state !== "committed") continue;
    removeTransaction(transactionDirectory);
  }
}

function restoreDisplaced(
  path: string,
  transactionDirectory: string,
  displacedPath: string,
  preparedPath: string,
  guard?: FileMutationGuard,
): ConditionalBytesWriteResult {
  // Proven now, before this call's own commit can distort the same check
  // (see the identical note in `recoverFileTransaction`'s restore branch):
  // once this transaction becomes its own "committed" entry, recomputing
  // this proof afterward would count that self-reference against
  // `displaced` and wrongly report it as unproven.
  const provenCopy = provenCopyOf(displacedPath, path);
  if (pathExists(preparedPath)
    && (!mutationGuardUnchanged(guard)
      || !discardPrepared(transactionDirectory, preparedPath))) {
    return {
      status: "recovery-required",
      recoveryPath: firstExistingPath(transactionDirectory, preparedPath),
      outcome: ambiguousOutcome(transactionDirectory, path, displacedPath, false),
    };
  }
  let publication: RecoveryPublication;
  try {
    requireMutationGuard(guard);
    publication = copyRegularFileExclusiveNoFollow(displacedPath, path);
    syncParentDirectory(path);
  } catch {
    // A partial write can leave `path` behind holding broken bytes (final
    // audit, F1) — never assumed either way, established fresh, right now.
    return {
      status: "recovery-required",
      recoveryPath: firstExistingPath(displacedPath, transactionDirectory, path),
      outcome: ambiguousOutcome(transactionDirectory, path, displacedPath, pathExists(path)),
    };
  }
  if (!validatePublishedPair(publication, displacedPath, path)) {
    return {
      status: "recovery-required",
      recoveryPath: firstExistingPath(transactionDirectory, path),
      outcome: ambiguousOutcome(transactionDirectory, path, displacedPath, true),
    };
  }
  try {
    requireMutationGuard(guard);
    if (!validatePublishedPair(publication, displacedPath, path)) {
      return {
        status: "recovery-required",
        recoveryPath: firstExistingPath(transactionDirectory, path),
        outcome: ambiguousOutcome(transactionDirectory, path, displacedPath, true),
      };
    }
    // Each path's last successful paired observation still precedes manifest
    // publication. Node cannot atomically compare both files and publish this
    // manifest; mutation in that remaining interval can remain externally
    // ambiguous, but never creates cleanup authority.
    writeManifest(transactionDirectory, path, "committed", guard);
  } catch {
    return {
      status: "recovery-required",
      recoveryPath: firstExistingPath(transactionDirectory, path),
      outcome: ambiguousOutcome(transactionDirectory, path, displacedPath, true),
    };
  }
  // recoveryPath reuses the same `provenCopy` the outcome record below
  // carries, proven once at the top of this call, before the commit above
  // could distort the check (round 9, m1: a bare `firstExistingPath` here
  // would re-derive an unproven existence check for the exact value a proof
  // already established a few lines up — the same "reuse the decision-unsafe
  // predicate for a message" shape R1 closes elsewhere in this file, applied
  // to disclosure instead of a claim).
  return {
    status: "changed",
    recoveryPath: provenCopy,
    outcome: {
      transactionDirectory,
      provenCopy,
      targetExists: true,
      targetWritten: true,
      artifactRetainedUnproven: false,
    },
  };
}

/**
 * Discards one or more individually-named, already-audited artifacts inside
 * `transactionDirectory` (round 9, r4: `resolveUndisplacedTransaction` passes
 * both `prepared` and `link-probe`, since a crash inside the link-probe
 * window can leave both names pointing at the same staged inode). Each path
 * is unlinked with `force: true`, so passing a name that never existed is a
 * no-op, not a failure — callers that only ever have one artifact keep
 * passing exactly one path.
 */
function discardPrepared(transactionDirectory: string, ...temporaryPaths: string[]): boolean {
  try {
    for (const temporaryPath of temporaryPaths) rmSync(temporaryPath, { force: true });
    syncDirectory(transactionDirectory);
    return true;
  } catch {
    return false;
  }
}

/**
 * Installs bytes only while the destination still matches the supplied read.
 * Existing destinations are displaced before comparison so a late writer is
 * preserved instead of being overwritten by a stale merge. Node 18 has no
 * portable no-replace rename or pathname compare-and-swap. A private, fsynced
 * phase journal makes interrupted displacement recoverable on the next run.
 * Successful replacements retain the displaced inode as a reported live
 * recovery so a writer with an already-open descriptor cannot lose data.
 * Hard-link failure never falls back to an overwriting rename.
 */
export function atomicWriteBytesIfUnchanged(
  path: string,
  bytes: Buffer,
  prior: BytesReadResult,
  guard?: FileMutationGuard,
): ConditionalBytesWriteResult {
  const priorIdentity = prior.status === "valid" ? prior.identity : undefined;
  if (priorIdentity !== undefined && !fileIdentityMatches(path, priorIdentity)) {
    return { status: "changed" };
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
    writeFileSync(descriptor, bytes);
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
              outcome: ambiguousOutcome(transactionDirectory, path, undefined, destinationPublished),
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
          outcome: ambiguousOutcome(transactionDirectory, path, undefined, destinationPublished),
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
      if (priorIdentity !== undefined && !fileIdentityMatches(path, priorIdentity)) {
        if (removeTransaction(transactionDirectory)) {
          transactionExists = false;
          temporaryExists = false;
          return { status: "changed" };
        }
        return {
          status: "recovery-required",
          recoveryPath: firstExistingPath(transactionDirectory, temporaryPath, path),
          outcome: ambiguousOutcome(transactionDirectory, path, undefined, destinationPublished),
        };
      }
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
          outcome: ambiguousOutcome(transactionDirectory, path, undefined, destinationPublished),
        };
      }
      throw error;
    }
    syncDirectory(transactionDirectory);
    syncParentDirectory(path);
    requireMutationGuard(guard);
    writeManifest(transactionDirectory, path, "displaced", guard);

    if (priorIdentity !== undefined && !fileIdentityMatches(recoveryPath, priorIdentity)) {
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
          outcome: ambiguousOutcome(transactionDirectory, path, recoveryPath, destinationPublished),
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
        outcome: ambiguousOutcome(transactionDirectory, path, recoveryPath, true),
      };
    }

    destinationPublished = true;
    syncParentDirectory(path);
    if (!fileMatches(path, bytes, prior.mode)) {
      return {
        status: "recovery-required",
        recoveryPath: firstExistingPath(recoveryPath, transactionDirectory, path),
        outcome: ambiguousOutcome(transactionDirectory, path, recoveryPath, destinationPublished),
      };
    }

    // Contract for external guard-based callers (e.g. the Claude staged
    // publication path's target/prepared identity check): `path` and
    // `temporaryPath` are the same inode with nlink === 2 for the entire
    // window between the linkSync above and the rmSync below — that exact
    // pairing is what a caller-supplied guard observes as proof of a
    // completed publish. Both requireMutationGuard calls in this window must
    // keep running for that proof to stay valid. Drop or reorder either one
    // and no test here will fail, but every such external observation
    // silently degrades to "could not be verified" — a fail-closed but
    // total functional break with no test naming the cause.
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
        outcome: ambiguousOutcome(transactionDirectory, path, recoveryPath, destinationPublished),
      };
    }
    // Proven now, BEFORE this call's own commit can distort the same check
    // (see the identical note on `restoreDisplaced` above and
    // `recoverFileTransaction`'s restore branches): once this transaction
    // becomes its own "committed" entry, recomputing this *proof* afterward
    // would count that self-reference against `displaced` and wrongly
    // authorize it (the mirror image of the "wrongly report it as unproven"
    // failure those sibling comments name — the self-reference cuts either
    // way, so the full proof must never run again after the commit).
    // Round 9, m1: the final success return used to skip this proof entirely
    // and disclose a bare `firstExistingPath` — an existence check, not a
    // copy proof — as the retained-copy path every caller (`hook.ts`'s
    // `reportRetainedCopy`, reached from both `hookInstall` and
    // `hookUninstall`) then spoke as fact. If the proof fails up front (only
    // reachable by a same-user concurrent writer inside this 0700 directory,
    // in the narrow window since `displaced` was last validated), this call
    // does not commit at all — the transaction stays "published".
    //
    // Round 10, S1 correction: round 9's comment here (and its report's table
    // row 33) claimed a later invocation "resolves it fresh, exactly like
    // every other unprovable shape in this module". That was false for the
    // ordinary case: before this round, `recoverFileTransaction`'s own
    // "published" fallback returned `manual` unconditionally, with no
    // re-examination of the evidence — a real `SIGKILL` right here, or a
    // single failed manifest write one line below, left the transaction
    // permanently stuck, forever, with no adversary involved. That fallback
    // now re-proves `displaced` and `path` on every later invocation (see its
    // own doc comment above) and *does* resolve fresh whenever `prepared`
    // being gone is the only reason this proof failed. It genuinely cannot
    // resolve the one case this proof itself also guards against: a
    // concurrent writer that leaves an unaccounted extra link on `displaced`
    // stays unprovable for as long as that link exists, on any later
    // invocation, and correctly stays `manual` rather than guess.
    const provenCopy = provenCopyOf(recoveryPath, path);
    if (provenCopy === undefined) {
      // round 10, s3: `targetWritten: false` here, not `destinationPublished`
      // — this specific call's own write to `path` was already proven
      // byte- and mode-correct by `fileMatches` a few lines above, before
      // this proof of `displaced` even ran. `targetWritten: true` would tell
      // `hook.ts` to render "bashrc holds unfinished write. do not trust
      // it." over a write that is not unfinished and is trustworthy — only
      // the retained copy's own provenance is what this branch could not
      // prove, not `path` itself.
      return {
        status: "recovery-required",
        recoveryPath: firstExistingPath(transactionDirectory, path),
        outcome: ambiguousOutcome(transactionDirectory, path, recoveryPath, false),
      };
    }
    requireMutationGuard(guard);
    writeManifest(transactionDirectory, path, "committed", guard);
    // A second, narrower check after the commit: not `provenCopyOf` again —
    // that would hit the exact self-reference trap the comment above
    // describes — only `pathExists`, which cannot be fooled by this
    // transaction's own now-committed manifest either way. This exists for
    // the one thing a pre-commit proof cannot see: `displaced` vanishing
    // entirely in the commit's own narrow window (a real, already-covered
    // shape — the recovery reuses the transaction directory itself, never
    // the vanished name, so nothing here is a new claim about content).
    if (!pathExists(provenCopy)) {
      return {
        status: "recovery-required",
        recoveryPath: firstExistingPath(transactionDirectory, path),
        outcome: ambiguousOutcome(transactionDirectory, path, recoveryPath, destinationPublished),
      };
    }
    return { status: "written", recoveryPath: provenCopy };
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Cleanup below remains conservative.
      }
      descriptor = undefined;
    }
    if (error instanceof FileMutationGuardChangedError) {
      return {
        status: "recovery-required",
        outcome: ambiguousOutcome(transactionDirectory, path, recoveryPath, destinationPublished),
      };
    }
    if (!mutationGuardUnchanged(guard)) {
      return {
        status: "recovery-required",
        outcome: ambiguousOutcome(transactionDirectory, path, recoveryPath, destinationPublished),
      };
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
        outcome: ambiguousOutcome(transactionDirectory, path, recoveryPath, destinationPublished),
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
        outcome: ambiguousOutcome(transactionDirectory, path, recoveryPath, destinationPublished),
      };
    }
    transactionExists = false;
    temporaryExists = false;
    throw new Error("Unable to write file");
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
