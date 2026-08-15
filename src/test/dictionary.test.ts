import { strict as assert } from "node:assert";
import { test } from "node:test";
import { digestBuckets, queryDictionary, queryNotes, quizCandidates, triplesForFile } from "../core/dictionary.js";
import type { MemoryRecord, NoteRecord, TripleRecord } from "../core/memory-read.js";

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

test("triplesForFile prefers exact paths over suffix paths", () => {
  const a = triple({ ts: NOW - DAY, intent: "a", path: "src/app.css" });
  const b = triple({ ts: NOW, intent: "b", path: "web/src/app.css" });
  const other = triple({ ts: NOW, intent: "c", path: "src/other.css" });
  const hits = triplesForFile([a, b, other], "src/app.css");
  assert.deepEqual(hits.map((t) => t.id), [a.id]);
  assert.deepEqual(triplesForFile([b], "app.css").map((t) => t.id), [b.id]);
  assert.equal(triplesForFile([other], "app.css").length, 0);
});

test("path identity folds Windows-origin case but keeps POSIX case distinct", () => {
  const windows = { ...triple({ ts: NOW, intent: "windows", path: "SRC/App.ts" }), platform: "win32" as const };
  const posix = { ...triple({ ts: NOW, intent: "posix", path: "SRC/App.ts" }), platform: "linux" as const };
  assert.equal(triplesForFile([windows], "src/app.ts").length, 1);
  assert.equal(triplesForFile([posix], "src/app.ts").length, 0);
});

test("dictionary and note queries use shared Unicode NFC and numeric tokens", () => {
  const intent = triple({ ts: NOW, intent: "cafe\u0301 404" });
  const note: NoteRecord = {
    kind: "note", id: "nfc-note", ts: NOW, cwd: "/w", cmd: "rocky note",
    file: "src/app.ts", line: 1, subject: "café", answer: "status 404",
  };
  assert.equal(queryDictionary([intent], "café 404")[0]?.triple.id, intent.id);
  assert.equal(queryNotes([note], "café 404")[0]?.note.id, note.id);
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

test("digest and quiz include each eligible note once and ignore future notes", () => {
  const note: NoteRecord = {
    kind: "note", id: "eligible-note", ts: NOW - 2 * DAY, cwd: "/w", cmd: "rocky note",
    file: "src/app.ts", line: 1, subject: "cache", answer: "banana 404",
  };
  const future: NoteRecord = { ...note, id: "future-note", ts: NOW + 1 };
  const buckets = digestBuckets([note, future], NOW);
  assert.deepEqual(buckets, [{ tag: "cache", count: 1, examples: ["cache"] }]);
  assert.deepEqual(quizCandidates([note, future], NOW).map((record) => record.id), [note.id]);
  assert.deepEqual(quizCandidates([note], NOW).map((record) => record.id), quizCandidates([note], NOW).map((record) => record.id));
});

test("quiz candidates use newest-first with stable id tie-break", () => {
  const sameTime = NOW - 2 * DAY;
  const older: NoteRecord = {
    kind: "note", id: "z-note", ts: sameTime - 1, cwd: "/w", cmd: "rocky note",
    file: "src/z.ts", line: 1, subject: "z", answer: "z answer",
  };
  const first: NoteRecord = { ...older, id: "a-note", ts: sameTime, subject: "a" };
  const second: NoteRecord = { ...older, id: "b-note", ts: sameTime, subject: "b" };
  assert.deepEqual(quizCandidates([older, second, first], NOW).map((record) => record.id), ["a-note", "b-note", "z-note"]);
});

test("quizCandidates needs intent, props, and 24h distance", () => {
  const fresh = triple({ ts: NOW - DAY / 2, intent: "too fresh" });
  const good = triple({ ts: NOW - 2 * DAY, intent: "naikin dikit" });
  const propless = triple({ ts: NOW - 2 * DAY, intent: "x", props: [] });
  const candidates = quizCandidates([fresh, good, propless], NOW);
  assert.deepEqual(candidates.map((t) => t.id), [good.id]);
});
