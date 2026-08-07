import {
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import {
  atomicWriteBytesIfUnchanged,
  inspectFileTransaction,
  mutationGuardUnchanged,
  pathExists,
  pruneSupersededTransactions,
  recoverFileTransaction,
  requireMutationGuard,
  syncParentDirectory,
} from "./file-transaction.js";
import type {
  BytesReadResult,
  ConditionalBytesWriteResult,
  FileTransactionInspectionResult,
  FileTransactionRecoveryResult,
} from "./file-transaction.js";

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

export type ConditionalJsonWriteResult = ConditionalBytesWriteResult;

export type JsonTransactionRecoveryResult = FileTransactionRecoveryResult;

export type JsonTransactionInspectionResult = FileTransactionInspectionResult;

/** Report unfinished transactions without changing the target or artifacts. */
export function inspectJsonTransaction(path: string): JsonTransactionInspectionResult {
  return inspectFileTransaction(path);
}

/** Recover an interrupted mutation before anybody interprets an absent config. */
export function recoverJsonTransaction(
  path: string,
  guard?: JsonMutationGuard,
): JsonTransactionRecoveryResult {
  return recoverFileTransaction(path, guard);
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
 *
 * A successful or refused-but-displaced write also prunes this target's own
 * superseded committed transaction directories (round 9, r5). `hook.ts`'s
 * bashrc route has always done this at both its settle and publish call
 * sites; this JSON engine's only production consumers (Claude Desktop/Code
 * adapters, via `claude-desktop.ts`/`claude-code.ts`) call straight into
 * this function and never prune themselves, so every crashed-prepare
 * leftover this route ever settles was retained forever — the bounded-growth
 * property the engine's own doc comments promise held only on the bashrc
 * route. Pruning here, once, closes it for every JSON consumer without
 * touching any of them.
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

  const snapshot: BytesReadResult = prior.status === "valid"
    ? { status: "valid", bytes: prior.bytes, mode: prior.mode }
    : { status: "missing" };
  let result: ConditionalJsonWriteResult;
  try {
    result = atomicWriteBytesIfUnchanged(path, encoded, snapshot, guard);
  } catch {
    throw new Error("Unable to write JSON config");
  }
  if ((result.status === "written" || result.status === "changed") && result.recoveryPath !== undefined) {
    pruneSupersededTransactions(path, dirname(result.recoveryPath));
  }
  return result;
}
