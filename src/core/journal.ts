/**
 * Rocky's dogfood journal: user-authored one-line notes in journal.jsonl.
 * Separate from memory.jsonl and deliberately without the transaction/lock
 * machinery — single-user append-only log, small atomic appends.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { resolveRockyPaths } from "./state-paths.js";

export const MAX_JOURNAL_NOTE_CHARS = 500;

export interface JournalRecord {
  v: 1;
  kind: "journal";
  id: string;
  ts: number;
  note: string;
}

export interface JournalReadResult {
  records: JournalRecord[];
  skipped: number;
}

export function normalizeJournalNote(raw: string): string {
  return raw
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "")
    .trim()
    .slice(0, MAX_JOURNAL_NOTE_CHARS);
}

export function appendJournal(note: string, path = resolveRockyPaths().journal, now = Date.now()): JournalRecord {
  const normalized = normalizeJournalNote(note);
  if (normalized.length === 0) throw new Error("journal note is empty after normalization");
  const record: JournalRecord = { v: 1, kind: "journal", id: randomUUID(), ts: now, note: normalized };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  return record;
}

export function readJournal(path = resolveRockyPaths().journal): JournalReadResult {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { records: [], skipped: 0 };
  }
  const records: JournalRecord[] = [];
  let skipped = 0;
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    const parsed = parseJournalLine(line);
    if (parsed === undefined) skipped += 1;
    else records.push(parsed);
  }
  return { records, skipped };
}

function parseJournalLine(line: string): JournalRecord | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null) return undefined;
    const record = value as Record<string, unknown>;
    if (record.v !== 1 || record.kind !== "journal" || typeof record.id !== "string" || record.id.length === 0 ||
        typeof record.ts !== "number" || !Number.isSafeInteger(record.ts) || record.ts < 0 ||
        typeof record.note !== "string" || record.note.length === 0) return undefined;
    return { v: 1, kind: "journal", id: record.id, ts: record.ts, note: record.note };
  } catch {
    return undefined;
  }
}
