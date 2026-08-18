import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendJournal, MAX_JOURNAL_NOTE_CHARS, normalizeJournalNote, readJournal } from "../core/journal.js";
import { resolveRockyPaths } from "../core/state-paths.js";

test("resolveRockyPaths exposes journal and state paths under home", () => {
  const paths = resolveRockyPaths({ ROCKY_HOME: "/tmp/rocky-home" } as NodeJS.ProcessEnv, "/tmp/fallback", "/");
  assert.equal(paths.journal, join("/tmp/rocky-home", "journal.jsonl"));
  assert.equal(paths.state, join("/tmp/rocky-home", "state.json"));
});

test("appendJournal writes one enveloped line and readJournal reads it back", () => {
  const dir = mkdtempSync(join(tmpdir(), "rocky-journal-"));
  const path = join(dir, "journal.jsonl");
  const written = appendJournal("rocky helped find old fix", path, 1_800_000_000_000);
  assert.equal(written.v, 1);
  assert.equal(written.kind, "journal");
  assert.equal(written.ts, 1_800_000_000_000);
  assert.equal(written.note, "rocky helped find old fix");
  const raw = readFileSync(path, "utf8");
  assert.ok(raw.endsWith("\n"));
  const loaded = readJournal(path);
  assert.equal(loaded.records.length, 1);
  assert.equal(loaded.skipped, 0);
  assert.equal(loaded.records[0].note, "rocky helped find old fix");
});

test("normalizeJournalNote flattens newlines, strips control chars, caps length", () => {
  assert.equal(normalizeJournalNote("line one\nline two\r\n"), "line one line two");
  assert.equal(normalizeJournalNote("a\u0007b"), "ab");
  assert.equal(normalizeJournalNote("x".repeat(600)).length, MAX_JOURNAL_NOTE_CHARS);
});

test("appendJournal rejects note that is empty after normalization", () => {
  const dir = mkdtempSync(join(tmpdir(), "rocky-journal-"));
  assert.throws(() => appendJournal("  \n\t ", join(dir, "journal.jsonl")));
});

test("readJournal skips malformed lines without dying and reports missing file as empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "rocky-journal-"));
  const path = join(dir, "journal.jsonl");
  assert.deepEqual(readJournal(path), { records: [], skipped: 0 });
  writeFileSync(path, `not json\n${JSON.stringify({ v: 1, kind: "journal", id: "a", ts: 5, note: "ok" })}\n{"v":1,"kind":"journal"}\n`, "utf8");
  const loaded = readJournal(path);
  assert.equal(loaded.records.length, 1);
  assert.equal(loaded.skipped, 2);
});

test("appendJournal appends, never overwrites, preserving order", () => {
  const dir = mkdtempSync(join(tmpdir(), "rocky-journal-"));
  const path = join(dir, "journal.jsonl");
  appendJournal("first note", path, 1_800_000_000_000);
  appendJournal("second note", path, 1_800_000_000_001);
  const loaded = readJournal(path);
  assert.equal(loaded.records.length, 2);
  assert.equal(loaded.records[0].note, "first note");
  assert.equal(loaded.records[1].note, "second note");
});
