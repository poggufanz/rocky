import { similarity, tokens } from "./fingerprint.js";
import type { MemoryRecord, TripleRecord } from "./memory-read.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const QUIZ_MIN_AGE_MS = 24 * 60 * 60 * 1000;

export interface DictionaryHit { triple: TripleRecord; score: number }
export interface DigestBucket { tag: string; count: number; examples: string[] }

function triples(records: readonly MemoryRecord[]): TripleRecord[] {
  return records.filter((record): record is TripleRecord => record.kind === "triple");
}

function mechanismIdentity(triple: TripleRecord): string {
  const first = triple.mechanism.files[0];
  return first ? first.props[0] ?? first.path : "";
}

export function queryDictionary(records: readonly MemoryRecord[], query: string, limit = 5): DictionaryHit[] {
  const queryTokens = tokens(query);
  const scored: DictionaryHit[] = [];
  for (const triple of triples(records)) {
    if (!triple.intent) continue;
    const haystack = `${triple.intent.text} ${triple.rationale?.tags.join(" ") ?? ""}`;
    const score = similarity(queryTokens, tokens(haystack));
    if (score > 0) scored.push({ triple, score });
  }
  scored.sort((a, b) => b.score - a.score || b.triple.ts - a.triple.ts);
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

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

export function triplesForFile(records: readonly MemoryRecord[], path: string, limit = 5): TripleRecord[] {
  const target = normalizePath(path);
  return triples(records)
    .filter((triple) => triple.mechanism.files.some((file) => {
      const candidate = normalizePath(file.path);
      return candidate === target || candidate.endsWith(`/${target}`);
    }))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit);
}

function basename(path: string): string {
  const parts = normalizePath(path).split("/");
  return parts[parts.length - 1] || path;
}

export function digestBuckets(records: readonly MemoryRecord[], now: number, windowMs = WEEK_MS): DigestBucket[] {
  const buckets = new Map<string, { count: number; examples: string[] }>();
  for (const triple of triples(records)) {
    if (now - triple.ts > windowMs || triple.ts > now) continue;
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

export function quizCandidates(records: readonly MemoryRecord[], now: number, limit = 5): TripleRecord[] {
  return triples(records)
    .filter((triple) => triple.intent
      && now - triple.ts >= QUIZ_MIN_AGE_MS
      && triple.mechanism.files.some((file) => file.props.length > 0))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit);
}
