import { strict as assert } from "node:assert";
import { test } from "node:test";
import { digestBuckets, queryDictionary, quizCandidates, triplesForFile } from "../core/dictionary.js";
import type { MemoryRecord, TripleRecord } from "../core/memory-read.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;
let seq = 0;
function triple(input: { ts: number; intent?: string; tags?: string[]; path?: string; props?: string[] }): TripleRecord {
  seq += 1;
  return {
    kind: "triple", id: `t${seq}`, ts: input.ts, cwd: "/w", schemaV: 1, agent: "claude-code", origin: "agent-hook",
    ...(input.intent === undefined ? {} : { intent: { text: input.intent } }),
    ...(input.tags === undefined ? {} : { rationale: { text: "r", tags: input.tags, source: "transcript" as const } }),
    mechanism: { files: [{ path: input.path ?? "src/app.css", plusMinus: [1, 1] as [number, number], props: input.props ?? ["margin-top"] }], truncatedFiles: 0 },
  };
}
const failure: MemoryRecord = { kind: "failure", id: "f1", ts: NOW, cwd: "/w", cmd: "x", exitCode: 1, fingerprint: "fp", signature: [], excerpt: "" };

test("queryDictionary ranks token overlap, skips non-triples and intentless triples", () => {
  const records: MemoryRecord[] = [
    failure,
    triple({ ts: NOW - DAY, intent: "naikin dikit buttonnya", props: ["margin-top"] }),
    triple({ ts: NOW, path: "b.css", props: ["color"] }),                      // no intent
    triple({ ts: NOW, intent: "ganti warna teks", props: ["color"] }),
  ];
  const hits = queryDictionary(records, "naikin button");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].triple.intent?.text, "naikin dikit buttonnya");
  assert.ok(hits[0].score > 0);
});

test("queryDictionary dedups by mechanism identity; newest wins among equal scores", () => {
  // Identical intents => identical Jaccard scores => ts desc decides => newer survives dedup.
  const older = triple({ ts: NOW - 2 * DAY, intent: "naikin margin", props: ["margin-top"] });
  const newer = triple({ ts: NOW - DAY, intent: "naikin margin", props: ["margin-top"] });
  const hits = queryDictionary([older, newer], "naikin margin");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].triple.id, newer.id);
});

test("queryDictionary keeps the higher-scored triple when scores differ", () => {
  const exact = triple({ ts: NOW - 2 * DAY, intent: "naikin margin", props: ["margin-top"] });
  const diluted = triple({ ts: NOW - DAY, intent: "naikin lagi margin", props: ["margin-top"] });
  const hits = queryDictionary([exact, diluted], "naikin margin");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].triple.id, exact.id); // score 1.0 beats 0.667 even though older
});

test("triplesForFile matches exact and suffix paths, newest first", () => {
  const a = triple({ ts: NOW - DAY, intent: "a", path: "src/app.css" });
  const b = triple({ ts: NOW, intent: "b", path: "web/src/app.css" });
  const other = triple({ ts: NOW, intent: "c", path: "src/other.css" });
  const hits = triplesForFile([a, b, other], "src/app.css");
  assert.deepEqual(hits.map((t) => t.id), [b.id, a.id]);
  assert.equal(triplesForFile([other], "app.css").length, 0);
});

test("digestBuckets groups by tag, then prop, then file basename, within window", () => {
  const records: MemoryRecord[] = [
    triple({ ts: NOW - DAY, intent: "naikin", tags: ["spacing"] }),
    triple({ ts: NOW - 2 * DAY, intent: "geser", tags: ["spacing", "flexbox"] }),
    triple({ ts: NOW - DAY, intent: "warna", props: ["color"] }),               // no tags -> prop bucket
    triple({ ts: NOW - DAY, intent: "utak atik", path: "src/deep/thing.rs", props: [] }), // no tags, no props -> basename bucket
    triple({ ts: NOW - 30 * DAY, intent: "lama", tags: ["spacing"] }),          // outside window
  ];
  const buckets = digestBuckets(records, NOW);
  assert.deepEqual(buckets[0], { tag: "spacing", count: 2, examples: ["naikin", "geser"] });
  assert.ok(buckets.some((bucket) => bucket.tag === "color" && bucket.count === 1));
  assert.ok(buckets.some((bucket) => bucket.tag === "thing.rs" && bucket.count === 1));
  assert.ok(!buckets.some((bucket) => bucket.examples.includes("lama")));
});

test("quizCandidates needs intent, props, and 24h distance", () => {
  const fresh = triple({ ts: NOW - DAY / 2, intent: "too fresh" });
  const good = triple({ ts: NOW - 2 * DAY, intent: "naikin dikit" });
  const propless = triple({ ts: NOW - 2 * DAY, intent: "x", props: [] });
  const candidates = quizCandidates([fresh, good, propless], NOW);
  assert.deepEqual(candidates.map((t) => t.id), [good.id]);
});
