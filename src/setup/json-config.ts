import {
  closeSync,
  constants,
  copyFileSync,
  fchmodSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

export type JsonReadResult =
  | { status: "missing"; value: Record<string, unknown> }
  | { status: "valid"; value: Record<string, unknown>; bytes: Buffer; mode?: number }
  | { status: "invalid"; error: string };

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

export function backupFile(path: string, now = new Date()): string {
  try {
    const backupPath = `${path}.backup-${backupTimestamp(now)}`;
    copyFileSync(path, backupPath, constants.COPYFILE_EXCL);
    return backupPath;
  } catch {
    throw new Error("Unable to back up JSON config");
  }
}

function syncParentDirectory(path: string): void {
  if (process.platform === "win32") return;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(dirname(path), "r");
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
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
    throw new Error("Unable to write JSON config");
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
    throw new Error("Unable to write JSON config");
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
