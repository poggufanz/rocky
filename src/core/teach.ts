import { createHash } from "node:crypto";
import { similarity, tokens } from "./fingerprint.js";
import { canonicalPath, type ExplainRecord, type MemoryRecord } from "./memory-read.js";

export const TEACH_SIMILARITY_THRESHOLD = 0.34;

/**
 * Normalize then hash a hunk for content-keyed lookup. Mirrors
 * `explainContentHash` in `core/memory.ts` exactly but lives here so the
 * read-only teach modules (and the MCP surface that consumes them) never
 * reach the writable memory module.
 */
function explainContentHash(snippet: string): string {
  const normalized = snippet.replace(/\s+/gu, " ").trim();
  return createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 32);
}

export interface TeachHit {
  record: ExplainRecord;
  match: "hash" | "similarity";
  score: number;
}

export function teachLookup(
  records: readonly MemoryRecord[],
  query: { path: string; snippet?: string; cwd?: string },
): TeachHit | undefined {
  const explainRecords: ExplainRecord[] = [];
  for (const record of records) {
    if (record === undefined || record.kind !== "explain") continue;
    if (!sameFile(record, query)) continue;
    explainRecords.push(record);
  }

  if (query.snippet === undefined) {
    const witness = newestExplain(explainRecords);
    if (witness === undefined) return undefined;
    return { record: witness, match: "similarity", score: 0 };
  }

  const queryHash = explainContentHash(query.snippet);
  let hashHit: ExplainRecord | undefined;
  for (const record of explainRecords) {
    if (record.contentHash === undefined || record.contentHash !== queryHash) continue;
    if (hashHit === undefined || record.ts > hashHit.ts) hashHit = record;
  }
  if (hashHit !== undefined) return { record: hashHit, match: "hash", score: 1 };

  const queryTokens = tokens(query.snippet);
  let bestScore = 0;
  let bestRecord: ExplainRecord | undefined;
  for (const record of explainRecords) {
    if (record.snippet === undefined) continue;
    const score = similarity(queryTokens, tokens(record.snippet));
    if (score < TEACH_SIMILARITY_THRESHOLD) continue;
    if (bestRecord === undefined || score > bestScore || (score === bestScore && record.ts > bestRecord.ts)) {
      bestScore = score;
      bestRecord = record;
    }
  }
  if (bestRecord === undefined) return undefined;
  return { record: bestRecord, match: "similarity", score: bestScore };
}

function sameFile(record: ExplainRecord, query: { path: string; cwd?: string }): boolean {
  const recordIdentity = canonicalPath(record.path, { cwd: record.cwd });
  const queryIdentity = canonicalPath(query.path, { cwd: query.cwd ?? record.cwd });
  if (recordIdentity.length > 0 && queryIdentity.length > 0) return recordIdentity === queryIdentity;
  return record.path === query.path;
}

function newestExplain(records: readonly ExplainRecord[]): ExplainRecord | undefined {
  let newest: ExplainRecord | undefined;
  for (const record of records) {
    if (newest === undefined || record.ts > newest.ts) newest = record;
  }
  return newest;
}
