/** Rocky's append-only memory writers and pending-state helpers. */

import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { commandFingerprint, fingerprint, normalizeLine, signatureLines } from "./fingerprint.js";
import { resolveRockyPaths } from "./state-paths.js";
import { MAX_MEMORY_LINE_BYTES } from "./memory-read.js";
import type { FailureRecord, FixRecord, MemoryRecord, NoteRecord } from "./memory-read.js";
import type { UnresolvedLink } from "./memory-query.js";

export type { FailureRecord, FixRecord, MemoryRecord, NoteRecord } from "./memory-read.js";
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
    fingerprint: fingerprint(stderr, cmd, exitCode), signature: signatureLines(stderr), excerpt: lastLines(stderr, 4),
  };
  append(rec);
  touchPending();
  return rec;
}

export function recordWatchFailure(cmd: string, exitCode: number, stderr: string, cwd = process.cwd()): FailureRecord {
  const rec: FailureRecord = {
    kind: "failure", id: randomUUID(), ts: Date.now(), cwd, cmd, exitCode,
    fingerprint: fingerprint(stderr, cmd, exitCode), signature: signatureLines(stderr), excerpt: lastLines(stderr, 4), origin: "watch",
  };
  append(rec);
  touchPending();
  return rec;
}

/**
 * One success does not meaningfully fix thousands of failures, and a record
 * past `MAX_MEMORY_LINE_BYTES` is skipped by every later read — so it would be
 * written, counted as remembered, and then silently lost forever. Measured: at
 * ~9 400 linked failures the single fix line passed 1 MB, `recordFix` still
 * said "I remember the fix. good good good.", and `stats` reported "0 have fix".
 * Keep the newest links, and shrink until the line actually fits.
 */
export const MAX_FIX_LINKS = 200;

export function recordFix(cmd: string, links: readonly UnresolvedLink[], cwd = process.cwd()): FixRecord {
  const build = (chosen: readonly UnresolvedLink[]): FixRecord => ({
    kind: "fix", id: randomUUID(), ts: Date.now(), cwd, cmd,
    failureIds: chosen.map((link) => link.failure.id),
    links: chosen.map((link) => ({ id: link.failure.id, basis: link.basis })),
  });

  let chosen = links.slice(-MAX_FIX_LINKS);
  let rec = build(chosen);
  while (chosen.length > 1 && Buffer.byteLength(JSON.stringify(rec) + "\n", "utf8") > MAX_MEMORY_LINE_BYTES) {
    chosen = chosen.slice(Math.ceil(chosen.length / 2));
    rec = build(chosen);
  }
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

export function recordNote(input: {
  cwd: string;
  cmd: string;
  file: string;
  line: number;
  subject: string;
  answer: string;
}): void {
  const rec: NoteRecord = { kind: "note", id: randomUUID(), ts: Date.now(), ...input };
  append(rec);
}
