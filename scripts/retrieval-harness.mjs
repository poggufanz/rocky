/**
 * Dev measurement harness for the retrieval-quality spec (§3 / §10).
 * Not part of `npm test`. Reads the live memory file (read-only, honoring
 * ROCKY_HOME) and prints the top knowledge-search hits for the five
 * reference queries, so any retrieval change can show its ranking delta
 * against real memory instead of a synthetic fixture.
 *
 * Usage: node scripts/retrieval-harness.mjs
 */
import { loadMemoryChecked } from "../dist/core/memory-read.js";
import { searchKnowledge } from "../dist/core/memory-query.js";

const QUERIES = [
  "readStdin tty pipe",
  "release check pin",
  "hook powershell",
  "rationale gate",
  "npm test failed",
];

const { records } = loadMemoryChecked();
console.log(`records: ${records.length}`);
for (const query of QUERIES) {
  console.log(`\n=== ${query}`);
  const hits = searchKnowledge(records, { query, limit: 3 });
  if (hits.length === 0) {
    console.log("  (no hits)");
    continue;
  }
  for (const hit of hits) {
    const snippet = hit.snippet.replace(/\s+/gu, " ").slice(0, 70);
    console.log(`  ${hit.score.toFixed(3)} [${hit.kind}] ${snippet}`);
  }
}
