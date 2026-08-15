import { constants, type BigIntStats, type Stats } from "node:fs";

/**
 * Node exposes O_NOFOLLOW on POSIX but not on native Windows.  Keep this
 * capability decision in one place so every bounded local writer applies the
 * same policy.  Callers must still compare lstat/fstat identities before and
 * after a read or mutation; a zero Windows flag is never treated as proof of
 * reparse safety.
 */
export const NO_FOLLOW_FLAG = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
export const NO_BLOCK_FLAG = process.platform === "win32" ? 0 : constants.O_NONBLOCK;
export const WINDOWS_REPARSE_PROOF = process.platform !== "win32";

type FilesystemStats = Stats | BigIntStats;

export function regularDescriptorSafe(stats: FilesystemStats | undefined): boolean {
  return stats !== undefined && stats.isFile() && !stats.isSymbolicLink();
}

function filesystemNodeSafe(stats: FilesystemStats | undefined): boolean {
  return stats !== undefined && (stats.isFile() || stats.isDirectory()) && !stats.isSymbolicLink();
}

export function filesystemIdentity(stats: FilesystemStats | undefined): readonly [bigint, bigint] | undefined {
  if (stats === undefined || !filesystemNodeSafe(stats)) return undefined;
  const dev = typeof stats.dev === "bigint"
    ? stats.dev
    : Number.isSafeInteger(stats.dev) ? BigInt(stats.dev) : undefined;
  const ino = typeof stats.ino === "bigint"
    ? stats.ino
    : Number.isSafeInteger(stats.ino) ? BigInt(stats.ino) : undefined;
  if (dev === undefined || ino === undefined || dev < 0n || ino < 0n || (dev === 0n && ino === 0n)) return undefined;
  return [dev, ino];
}

export function sameFilesystemIdentity(left: FilesystemStats | undefined, right: FilesystemStats | undefined): boolean {
  const leftIdentity = filesystemIdentity(left);
  const rightIdentity = filesystemIdentity(right);
  if (leftIdentity !== undefined && rightIdentity !== undefined) {
    return leftIdentity[0] === rightIdentity[0] && leftIdentity[1] === rightIdentity[1];
  }
  // Native Windows may expose coarse/unsafe inode fields.  Callers must not
  // use a pathname-only mutation in that case; fail closed at the boundary.
  return false;
}
