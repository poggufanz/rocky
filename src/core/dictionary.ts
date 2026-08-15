import { similarity, tokens } from "./fingerprint.js";
import { boundTripleRecord, canonicalPath, isOperationalMemoryRecord } from "./memory-read.js";
import { whyFile } from "./memory-query.js";
import type { MemoryRecord, NoteRecord, TripleRecord } from "./memory-read.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const QUIZ_MIN_AGE_MS = 24 * 60 * 60 * 1000;

export interface DictionaryHit { triple: TripleRecord; score: number }
export interface NoteHit { note: NoteRecord; score: number }
export interface DigestBucket { tag: string; count: number; examples: string[] }

function triples(records: readonly MemoryRecord[]): TripleRecord[] {
  return records
    .filter((record): record is TripleRecord => record.kind === "triple")
    .map((record) => boundTripleRecord(record));
}

function mechanismIdentity(triple: TripleRecord): string {
  const first = triple.mechanism.files[0];
  return first ? first.props[0] ?? first.path : "";
}

export function queryDictionary(records: readonly MemoryRecord[], query: string, limit = 5, now = Date.now()): DictionaryHit[] {
  const queryTokens = tokens(query);
  const scored: DictionaryHit[] = [];
  for (const triple of triples(records)) {
    if (!isOperationalMemoryRecord(triple, now)) continue;
    if (!triple.intent) continue;
    const haystack = `${triple.intent.text} ${triple.rationale?.tags.join(" ") ?? ""}`;
    const score = similarity(queryTokens, tokens(haystack));
    if (score > 0) scored.push({ triple, score });
  }
  scored.sort((a, b) => b.score - a.score || b.triple.ts - a.triple.ts || a.triple.id.localeCompare(b.triple.id));
  const seen = new Set<string>();
  const hits: DictionaryHit[] = [];
  for (const hit of scored) {
    const identity = mechanismIdentity(hit.triple);
    if (seen.has(identity)) continue;
    seen.add(identity);
    hits.push(hit);
    if (hits.length >= limit) break;
  }
  return hits;
}

export function queryNotes(records: readonly MemoryRecord[], query: string, limit = 5, now = Date.now()): NoteHit[] {
  const queryTokens = tokens(query);
  const seen = new Set<string>();
  return records
    .filter((record): record is NoteRecord => record.kind === "note" && isOperationalMemoryRecord(record, now)
      && !seen.has(record.id) && (seen.add(record.id), true))
    .map((note) => ({ note, score: similarity(queryTokens, tokens(`${note.cmd} ${note.file} ${note.subject} ${note.answer}`)) }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || b.note.ts - a.note.ts || a.note.id.localeCompare(b.note.id))
    .slice(0, Math.max(0, limit));
}

export function triplesForFile(records: readonly MemoryRecord[], path: string, limit = 5): TripleRecord[] {
  // Keep this legacy helper on the same trusted-root, platform-aware matcher
  // as why/why_file.  Dictionary consumers must not grow a weaker path rule.
  return whyFile(records, path, limit);
}

function basename(path: string): string {
  const parts = canonicalPath(path).split("/");
  return parts[parts.length - 1] || path;
}

export function digestBuckets(records: readonly MemoryRecord[], now: number, windowMs = WEEK_MS): DigestBucket[] {
  const buckets = new Map<string, { count: number; examples: string[] }>();
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    if (!isOperationalMemoryRecord(record, now) || now - record.ts > windowMs) continue;
    const triple = record.kind === "triple" ? boundTripleRecord(record) : undefined;
    const note = record.kind === "note" ? record : undefined;
    if (triple === undefined && note === undefined) continue;
    if (note !== undefined) {
      const tag = note.subject || basename(note.file) || "untagged";
      const bucket = buckets.get(tag) ?? { count: 0, examples: [] };
      bucket.count += 1;
      if (bucket.examples.length < 3 && note.subject && !bucket.examples.includes(note.subject)) bucket.examples.push(note.subject);
      buckets.set(tag, bucket);
      continue;
    }
    if (triple === undefined) continue;
    let tags: string[] = triple.rationale?.tags.length ? triple.rationale.tags : [];
    if (tags.length === 0) tags = triple.mechanism.files.map((file) => file.props[0]).filter((prop): prop is string => Boolean(prop));
    if (tags.length === 0) tags = triple.mechanism.files.map((file) => basename(file.path));
    for (const tag of tags.length ? [...new Set(tags)] : ["untagged"]) {
      const bucket = buckets.get(tag) ?? { count: 0, examples: [] };
      bucket.count += 1;
      const example = triple.intent?.text;
      if (example && bucket.examples.length < 3 && !bucket.examples.includes(example)) bucket.examples.push(example);
      buckets.set(tag, bucket);
    }
  }
  return [...buckets.entries()]
    .map(([tag, value]) => ({ tag, count: value.count, examples: value.examples }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export function quizCandidates(records: readonly MemoryRecord[], now: number, limit = 5): Array<TripleRecord | NoteRecord> {
  const seen = new Set<string>();
  return records
    .map((record) => record.kind === "triple" ? boundTripleRecord(record) : record)
    .filter((record): record is TripleRecord | NoteRecord =>
      (record.kind === "triple" && Boolean(record.intent)
        && record.mechanism.files.some((file) => file.props.length > 0)
        || record.kind === "note" && record.answer.length > 0)
      && isOperationalMemoryRecord(record, now)
      && now - record.ts >= QUIZ_MIN_AGE_MS
      && !seen.has(record.id) && (seen.add(record.id), true))
    .sort((a, b) => b.ts - a.ts || a.id.localeCompare(b.id))
    .slice(0, limit);
}
