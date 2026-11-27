import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, unlinkSync, type BigIntStats } from "node:fs";
import { dirname } from "node:path";
import { NO_BLOCK_FLAG, NO_FOLLOW_FLAG, sameFilesystemIdentity } from "../../core/fs-safety.js";
import { atomicWriteBytesIfUnchanged, type ConditionalBytesWriteResult } from "../../setup/file-transaction.js";

type Snapshot =
  | { status: "missing" | "changed" }
  | { status: "valid"; bytes: Buffer; metadata: BigIntStats };

export type ManagedPluginWriteResult =
  | (Extract<ConditionalBytesWriteResult, { status: "written" }> & { digest: string })
  | Exclude<ConditionalBytesWriteResult, { status: "written" }>;

function digestOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isSameFile(before: BigIntStats, after: BigIntStats): boolean {
  return after.isFile() && after.nlink === 1n && sameFilesystemIdentity(before, after)
    && before.size === after.size && before.mode === after.mode
    && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}

function snapshot(path: string): Snapshot {
  let descriptor: number | undefined;
  try {
    const before = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (!before) return { status: "missing" };
    if (!before.isFile() || before.nlink !== 1n) return { status: "changed" };
    descriptor = openSync(path, constants.O_RDONLY | NO_FOLLOW_FLAG | NO_BLOCK_FLAG);
    if (!isSameFile(before, fstatSync(descriptor, { bigint: true }))) return { status: "changed" };
    const bytes = readFileSync(descriptor);
    const metadata = fstatSync(descriptor, { bigint: true });
    const listed = lstatSync(path, { bigint: true });
    if (!isSameFile(before, metadata) || !isSameFile(metadata, listed) || BigInt(bytes.length) !== metadata.size) {
      return { status: "changed" };
    }
    return { status: "valid", bytes, metadata };
  } catch {
    return { status: "changed" };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** The caller persists the digest returned by a successful write as ownership evidence. */
export function writeManagedPluginFile(
  path: string, content: string | Buffer, managedDigest?: string,
): ManagedPluginWriteResult {
  const prior = snapshot(path);
  const bytes = Buffer.from(content);
  const digest = digestOf(bytes);
  if (prior.status === "missing") {
    const result = atomicWriteBytesIfUnchanged(path, bytes, { status: "missing" });
    return result.status === "written" ? { ...result, digest } : result;
  }
  if (prior.status !== "valid" || digestOf(prior.bytes) !== managedDigest) return { status: "changed" };
  if (prior.bytes.equals(bytes)) return { status: "written", digest };
  const { dev, ino, mode } = prior.metadata;
  const result = atomicWriteBytesIfUnchanged(path, bytes, {
    status: "valid", bytes: prior.bytes, mode: Number(mode & 0o777n),
    identity: { dev: Number(dev), ino: Number(ino) },
  });
  return result.status === "written" ? { ...result, digest } : result;
}

/** A header is descriptive. Only the recorded digest authorizes deletion. */
export function removeManagedPluginFile(
  path: string, managedDigest: string,
): { status: "removed" | "missing" | "changed" } {
  try {
    const parent = dirname(path);
    const directory = lstatSync(parent, { bigint: true, throwIfNoEntry: false });
    if (!directory) return { status: "missing" };
    if (!directory.isDirectory()) return { status: "changed" };
    const prior = snapshot(path);
    if (prior.status === "missing") return { status: "missing" };
    if (prior.status !== "valid" || digestOf(prior.bytes) !== managedDigest) return { status: "changed" };

    // Node offers no portable compare-and-unlink. Revalidate both identities
    // and the file metadata immediately before the pathname mutation.
    if (!sameFilesystemIdentity(directory, lstatSync(parent, { bigint: true }))
      || !isSameFile(prior.metadata, lstatSync(path, { bigint: true }))) {
      return { status: "changed" };
    }
    unlinkSync(path);
    return { status: "removed" };
  } catch {
    return { status: "changed" };
  }
}
