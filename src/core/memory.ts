/** Rocky's append-only memory writers and pending-state helpers. */

import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { commandFingerprint, fingerprint, normalizeLine, signatureLines } from "./fingerprint.js";
import { resolveRockyPaths } from "./state-paths.js";
import type { FailureRecord, FixRecord, MemoryRecord } from "./memory-read.js";
import type { UnresolvedLink } from "./memory-query.js";

export type { FailureRecord, FixRecord, MemoryRecord } from "./memory-read.js";
export { loadMemory, parseMemoryRecord, MAX_MEMORY_LINE_BYTES } from "./memory-read.js";

export function memoryPath(): string {
  return resolveRockyPaths().memory;
}

function ensureDir(home: string): void {
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
}

function append(record: MemoryRecord): void {
  const paths = resolveRockyPaths();
  ensureDir(paths.home);
  appendFileSync(paths.memory, JSON.stringify(record) + "\n", "utf8");
}

export function recordFailure(cmd: string, exitCode: number, stderr: string): FailureRecord {
  const rec: FailureRecord = {
    kind: "failure", id: randomUUID(), ts: Date.now(), cwd: process.cwd(), cmd, exitCode,
    fingerprint: fingerprint(stderr), signature: signatureLines(stderr), excerpt: lastLines(stderr, 4),
  };
  append(rec);
  touchPending();
  return rec;
}

export function recordWatchFailure(cmd: string, exitCode: number, stderr: string, cwd = process.cwd()): FailureRecord {
  const rec: FailureRecord = {
    kind: "failure", id: randomUUID(), ts: Date.now(), cwd, cmd, exitCode,
    fingerprint: fingerprint(stderr), signature: signatureLines(stderr), excerpt: lastLines(stderr, 4), origin: "watch",
  };
  append(rec);
  touchPending();
  return rec;
}

export function recordFix(cmd: string, links: readonly UnresolvedLink[], cwd = process.cwd()): FixRecord {
  const rec: FixRecord = {
    kind: "fix", id: randomUUID(), ts: Date.now(), cwd, cmd,
    failureIds: links.map((link) => link.failure.id),
    links: links.map((link) => ({ id: link.failure.id, basis: link.basis })),
  };
  append(rec);
  return rec;
}

function lastLines(text: string, n: number): string {
  const lines = text.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
  return lines.slice(-n).join("\n");
}

export function pendingPath(): string {
  return resolveRockyPaths().pending;
}

export function touchPending(): void {
  const paths = resolveRockyPaths();
  ensureDir(paths.home);
  writeFileSync(paths.pending, "", "utf8");
}

export function hasUnresolvedRecent(records: MemoryRecord[], windowMs = 1000 * 60 * 60 * 48): boolean {
  const cutoff = Date.now() - windowMs;
  return records.some((record) => record.kind === "failure" && !record.resolvedBy && record.ts >= cutoff);
}

export function clearPendingIfResolved(records: MemoryRecord[]): void {
  if (!hasUnresolvedRecent(records)) rmSync(resolveRockyPaths().pending, { force: true });
}

export function recordHookFailure(cmd: string, exitCode: number, cwd: string): FailureRecord {
  const rec: FailureRecord = {
    kind: "failure", id: randomUUID(), ts: Date.now(), cwd, cmd, exitCode,
    fingerprint: commandFingerprint(cmd, exitCode), signature: [normalizeLine(cmd)], excerpt: `exit ${exitCode}`, origin: "hook",
  };
  append(rec);
  touchPending();
  return rec;
}
