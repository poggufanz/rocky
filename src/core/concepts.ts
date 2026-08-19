/**
 * Deterministic concept lexicon and matcher.
 *
 * Concepts are stable engineering failure domains (idempotency, retry
 * semantics, locking, ...) keyed by a small keyword lexicon. Matching is
 * purely deterministic: token-set hits from the same tokenizer retrieval
 * uses, plus substring checks for hyphenated multi-word keywords, plus
 * caller-supplied aliases that map a user phrase straight onto a concept.
 */

import { tokens } from "./fingerprint.js";

export interface Concept { id: string; label: string; keywords: readonly string[] }

export const CONCEPTS: readonly Concept[] = [
  { id: "idempotency", label: "idempotency", keywords: ["idempotent", "idempotency", "duplicate", "twice", "exactly-once", "replay", "dedupe"] },
  { id: "retry-backoff", label: "retry semantics", keywords: ["retry", "retries", "backoff", "exponential", "attempt", "requeue"] },
  { id: "transaction-boundary", label: "transaction boundary", keywords: ["transaction", "commit", "rollback", "atomic", "isolation"] },
  { id: "cache-invalidation", label: "cache invalidation", keywords: ["cache", "invalidate", "stale", "ttl", "evict", "memoize"] },
  { id: "race-condition", label: "race condition", keywords: ["race", "concurrent", "interleave", "atomicity", "check-then-act"] },
  { id: "timeout", label: "timeout", keywords: ["timeout", "deadline", "hang", "expire", "abort"] },
  { id: "locking", label: "locking", keywords: ["lock", "mutex", "deadlock", "contention", "reclaim", "semaphore"] },
  { id: "auth", label: "auth", keywords: ["auth", "token", "session", "permission", "credential", "expiry", "unauthorized"] },
  { id: "migration", label: "migration", keywords: ["migration", "migrate", "schema-change", "backfill", "rollout"] },
  { id: "encoding", label: "encoding", keywords: ["encoding", "utf8", "unicode", "charset", "mojibake", "bom"] },
  { id: "path-handling", label: "path handling", keywords: ["path", "separator", "realpath", "symlink", "case-sensitive", "traversal"] },
  { id: "input-validation", label: "input validation", keywords: ["validate", "validation", "sanitize", "boundary", "untrusted", "parse"] },
  { id: "dependency-conflict", label: "dependency conflict", keywords: ["dependency", "version", "peer", "resolution", "lockfile", "mismatch"] },
  { id: "config-env", label: "config and env", keywords: ["config", "env", "environment", "variable", "settings", "flag"] },
  { id: "test-isolation", label: "test isolation", keywords: ["flaky", "isolation", "tmpdir", "fixture", "teardown", "leak-between-tests"] },
  { id: "resource-leak", label: "resource leak", keywords: ["leak", "descriptor", "handle", "memory-growth", "unclosed", "dangling"] },
  { id: "error-propagation", label: "error propagation", keywords: ["swallow", "rethrow", "propagate", "silent-failure", "exit-code", "stderr"] },
  { id: "serialization", label: "serialization", keywords: ["serialize", "json", "parse-error", "schema", "envelope", "round-trip"] },
  { id: "network-egress", label: "network egress", keywords: ["egress", "offline", "loopback", "request", "fetch", "registry"] },
  { id: "append-only-log", label: "append-only log", keywords: ["append-only", "jsonl", "truncation", "compaction", "tombstone", "offset"] },
];

export interface ConceptMatch { concept: Concept; score: number; matched: readonly string[] }
export const CONCEPT_MATCH_THRESHOLD = 0.34;

export function matchConcepts(text: string, aliases?: ReadonlyMap<string, string>): ConceptMatch[] {
  const bag = new Set(tokens(text));
  const lower = text.toLowerCase();
  const out: ConceptMatch[] = [];
  for (const concept of CONCEPTS) {
    const matched: string[] = [];
    for (const kw of concept.keywords) {
      if (kw.includes("-") ? lower.includes(kw.replace(/-/g, " ")) || lower.includes(kw) : bag.has(kw)) matched.push(kw);
    }
    if (aliases) {
      for (const [phrase, target] of aliases) {
        if (target === concept.id && lower.includes(phrase.toLowerCase())) matched.push(`alias:${phrase}`);
      }
    }
    const aliasHit = matched.some((m) => m.startsWith("alias:"));
    const score = aliasHit ? 1 : matched.length / Math.max(3, Math.min(concept.keywords.length, 5));
    if (matched.length > 0 && (aliasHit || matched.length >= 2 || score >= CONCEPT_MATCH_THRESHOLD)) {
      out.push({ concept, score: Math.min(1, score), matched });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}
