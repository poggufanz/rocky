import { existsSync, readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { resolveRockyPaths } from "./state-paths.js";

export type FailureOrigin = "run" | "hook" | "watch";

export interface FailureRecord {
  kind: "failure";
  id: string;
  ts: number;
  cwd: string;
  cmd: string;
  exitCode: number;
  fingerprint: string;
  signature: string[];
  excerpt: string;
  origin?: FailureOrigin;
  resolvedBy?: string;
}

export type LinkBasis = "signature" | "program";
export interface FixLink { id: string; basis: LinkBasis }

export interface FixRecord {
  kind: "fix";
  id: string;
  ts: number;
  cwd: string;
  cmd: string;
  failureIds: string[];
  links?: FixLink[];
}

export interface NoteRecord {
  kind: "note";
  id: string;
  ts: number;
  cwd: string;
  cmd: string;
  file: string;
  line: number;
  subject: string;
  answer: string;
}

export type MemoryRecord = FailureRecord | FixRecord | NoteRecord;

export const MAX_MEMORY_LINE_BYTES = 1024 * 1024;

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? [...value]
    : undefined;
}

// A record's origin is defined but not one of the three known values — including when it
// isn't a string at all (a number, an object, null) — is read as "run" rather than
// discarding the whole record. Compatibility cost the spec accepts: an already-released
// v0.2.1 binary's parser only knows "run"/"hook" and still discards a "watch" record
// outright, so a v0.3 -> v0.2.1 downgrade loses those records. Accepted because the
// package is still beta; after v1, this kind of loosening must ship before any new
// origin value is introduced, not after.
function normalizeOrigin(origin: unknown): FailureOrigin | undefined {
  if (origin === undefined) return undefined;
  if (origin === "run" || origin === "hook" || origin === "watch") return origin;
  return "run";
}

export function parseMemoryRecord(value: unknown): MemoryRecord | undefined {
  const record = objectValue(value);
  if (!record || typeof record.id !== "string" || typeof record.ts !== "number" || !Number.isFinite(record.ts) ||
      typeof record.cwd !== "string" || typeof record.cmd !== "string") return undefined;
  if (record.kind === "failure") {
    const signature = strings(record.signature);
    if (typeof record.exitCode !== "number" || !Number.isInteger(record.exitCode) || typeof record.fingerprint !== "string" ||
        !signature || typeof record.excerpt !== "string") return undefined;
    const origin = normalizeOrigin(record.origin);
    return {
      kind: "failure", id: record.id, ts: Number(record.ts), cwd: record.cwd,
      cmd: record.cmd, exitCode: Number(record.exitCode), fingerprint: record.fingerprint,
      signature, excerpt: record.excerpt,
      ...(origin === undefined ? {} : { origin }),
    };
  }
  if (record.kind === "fix") {
    const failureIds = strings(record.failureIds);
    if (!failureIds) return undefined;
    let links: FixLink[] | undefined;
    if (record.links !== undefined) {
      links = parseFixLinks(record.links);
      if (!links) return undefined;
    }
    return {
      kind: "fix", id: record.id, ts: Number(record.ts), cwd: record.cwd, cmd: record.cmd, failureIds,
      ...(links === undefined ? {} : { links }),
    };
  }
  if (record.kind === "note") {
    if (typeof record.file !== "string" || typeof record.line !== "number" || !Number.isInteger(record.line) ||
        typeof record.subject !== "string" || typeof record.answer !== "string") return undefined;
    return {
      kind: "note", id: record.id, ts: Number(record.ts), cwd: record.cwd, cmd: record.cmd,
      file: record.file, line: Number(record.line), subject: record.subject, answer: record.answer,
    };
  }
  return undefined;
}

function parseFixLinks(value: unknown): FixLink[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const links: FixLink[] = [];
  for (const entry of value) {
    const obj = objectValue(entry);
    if (!obj || typeof obj.id !== "string" || (obj.basis !== "signature" && obj.basis !== "program")) return undefined;
    links.push({ id: obj.id, basis: obj.basis });
  }
  return links;
}

export function loadMemory(path = resolveRockyPaths().memory): MemoryRecord[] {
  if (!existsSync(path)) return [];
  const records: MemoryRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (Buffer.byteLength(line, "utf8") > MAX_MEMORY_LINE_BYTES) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = parseMemoryRecord(JSON.parse(trimmed));
      if (record) records.push(record);
    } catch {
      // a corrupt line never kills the memory; skip it
    }
  }
  const byId = new Map(records.map((record) => [record.id, record]));
  for (const record of records) {
    if (record.kind !== "fix") continue;
    for (const failureId of record.failureIds) {
      const failure = byId.get(failureId);
      if (failure?.kind === "failure") failure.resolvedBy = record.id;
    }
  }
  return records;
}
