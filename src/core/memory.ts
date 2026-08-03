/**
 * Rocky's photographic memory.
 *
 * Every failure and every fix is appended to a local JSONL file
 * (~/.rocky/memory.jsonl). Nothing leaves the machine. Eridians remember
 * everything; so does this file.
 *
 * MVP notes: append-only JSONL, fully loaded into RAM per invocation.
 * Fine for years of normal use (a heavy week of failures is a few hundred KB).
 * Indexing can come later if anyone's memory file gets huge.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { commandFingerprint, fingerprint, normalizeLine, signatureLines, similarity, tokens } from "./fingerprint.js";

export interface FailureRecord {
  kind: "failure";
  id: string;
  ts: number;
  cwd: string;
  cmd: string;
  exitCode: number;
  fingerprint: string;
  signature: string[];
  excerpt: string; // last raw lines of stderr, for display
  origin?: "run" | "hook"; // absent = "run" (records predate the field)
  resolvedBy?: string; // id of the fix record, patched in memory at load time
}

export interface FixRecord {
  kind: "fix";
  id: string;
  ts: number;
  cwd: string;
  cmd: string; // the command that succeeded
  failureIds: string[]; // failures this fix resolves
}

export type MemoryRecord = FailureRecord | FixRecord;

const ROCKY_DIR = process.env.ROCKY_HOME ?? join(homedir(), ".rocky");
const MEMORY_FILE = join(ROCKY_DIR, "memory.jsonl");

export function memoryPath(): string {
  return MEMORY_FILE;
}

function ensureDir(): void {
  if (!existsSync(ROCKY_DIR)) mkdirSync(ROCKY_DIR, { recursive: true });
}

export function loadMemory(): MemoryRecord[] {
  if (!existsSync(MEMORY_FILE)) return [];
  const records: MemoryRecord[] = [];
  for (const line of readFileSync(MEMORY_FILE, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as MemoryRecord);
    } catch {
      // a corrupt line never kills the memory; skip it
    }
  }
  // link fixes back onto failures
  const byId = new Map(records.map((r) => [r.id, r]));
  for (const r of records) {
    if (r.kind !== "fix") continue;
    for (const fid of r.failureIds) {
      const f = byId.get(fid);
      if (f && f.kind === "failure") f.resolvedBy = r.id;
    }
  }
  return records;
}

function append(record: MemoryRecord): void {
  ensureDir();
  appendFileSync(MEMORY_FILE, JSON.stringify(record) + "\n", "utf8");
}

export function recordFailure(cmd: string, exitCode: number, stderr: string): FailureRecord {
  const rec: FailureRecord = {
    kind: "failure",
    id: randomUUID(),
    ts: Date.now(),
    cwd: process.cwd(),
    cmd,
    exitCode,
    fingerprint: fingerprint(stderr),
    signature: signatureLines(stderr),
    excerpt: lastLines(stderr, 4),
  };
  append(rec);
  touchPending();
  return rec;
}

export function recordFix(cmd: string, failures: FailureRecord[]): FixRecord {
  const rec: FixRecord = {
    kind: "fix",
    id: randomUUID(),
    ts: Date.now(),
    cwd: process.cwd(),
    cmd,
    failureIds: failures.map((f) => f.id),
  };
  append(rec);
  return rec;
}

/** All failures with this exact fingerprint, oldest first. */
export function findByFingerprint(records: MemoryRecord[], fp: string): FailureRecord[] {
  return records.filter((r): r is FailureRecord => r.kind === "failure" && r.fingerprint === fp);
}

export function getFix(records: MemoryRecord[], failure: FailureRecord): FixRecord | undefined {
  if (!failure.resolvedBy) return undefined;
  return records.find((r): r is FixRecord => r.kind === "fix" && r.id === failure.resolvedBy);
}

/**
 * Unresolved failures from the same working directory whose command shares a
 * base program with `cmd`, within `windowMs`. Used to link a success to the
 * failures it just fixed.
 */
export function recentUnresolvedFailures(
  records: MemoryRecord[],
  cmd: string,
  windowMs = 1000 * 60 * 60 * 48
): FailureRecord[] {
  const base = cmd.trim().split(/\s+/)[0];
  const cutoff = Date.now() - windowMs;
  return records.filter(
    (r): r is FailureRecord =>
      r.kind === "failure" &&
      !r.resolvedBy &&
      r.ts >= cutoff &&
      r.cwd === process.cwd() &&
      r.cmd.trim().split(/\s+/)[0] === base
  );
}

export interface SearchHit {
  failure: FailureRecord;
  fix?: FixRecord;
  score: number;
}

/** Fuzzy search over remembered failures. One hit per distinct error. */
export function search(records: MemoryRecord[], query: string, limit = 3): SearchHit[] {
  const q = tokens(query);
  const best = new Map<string, SearchHit>(); // fingerprint -> best hit
  for (const r of records) {
    if (r.kind !== "failure") continue;
    const bag = tokens([r.cmd, ...r.signature].join(" "));
    const score = similarity(q, bag);
    if (score <= 0.05) continue;
    const hit: SearchHit = { failure: r, fix: getFix(records, r), score };
    const prev = best.get(r.fingerprint);
    // prefer an occurrence that has a fix; then the newer one
    if (!prev || (!prev.fix && hit.fix) || (!!prev.fix === !!hit.fix && r.ts > prev.failure.ts)) {
      best.set(r.fingerprint, hit);
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

function lastLines(text: string, n: number): string {
  const lines = text
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
  return lines.slice(-n).join("\n");
}

const PENDING_FILE = join(ROCKY_DIR, "pending");

export function pendingPath(): string {
  return PENDING_FILE;
}

/** Flag file: unresolved failures exist. Lets the bash hook skip spawning
 *  node on successful commands unless a fix-link attempt is worth it. */
export function touchPending(): void {
  ensureDir();
  writeFileSync(PENDING_FILE, "", "utf8");
}

export function hasUnresolvedRecent(records: MemoryRecord[], windowMs = 1000 * 60 * 60 * 48): boolean {
  const cutoff = Date.now() - windowMs;
  return records.some((r) => r.kind === "failure" && !r.resolvedBy && r.ts >= cutoff);
}

export function clearPendingIfResolved(records: MemoryRecord[]): void {
  if (!hasUnresolvedRecent(records)) rmSync(PENDING_FILE, { force: true });
}

/** Failure heard through the shell hook: no stderr, shallow fingerprint. */
export function recordHookFailure(cmd: string, exitCode: number, cwd: string): FailureRecord {
  const rec: FailureRecord = {
    kind: "failure",
    id: randomUUID(),
    ts: Date.now(),
    cwd,
    cmd,
    exitCode,
    fingerprint: commandFingerprint(cmd, exitCode),
    signature: [normalizeLine(cmd)],
    excerpt: `exit ${exitCode}`,
    origin: "hook",
  };
  append(rec);
  touchPending();
  return rec;
}
