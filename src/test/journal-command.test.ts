import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { journalCommand } from "../commands/journal.js";
import { readJournal } from "../core/journal.js";

test("journalCommand appends note to ROCKY_HOME journal and exits 0", () => {
  const home = mkdtempSync(join(tmpdir(), "rocky-home-"));
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  try {
    const code = journalCommand(["rocky", "helped", "today"]);
    assert.equal(code, 0);
    const loaded = readJournal(join(home, "journal.jsonl"));
    assert.equal(loaded.records.length, 1);
    assert.equal(loaded.records[0].note, "rocky helped today");
  } finally {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
  }
});

test("journalCommand without note reports usage error", () => {
  const code = journalCommand([]);
  assert.equal(code, 2);
});

test("journalCommand strips leading -- separator", () => {
  const home = mkdtempSync(join(tmpdir(), "rocky-home-"));
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  try {
    assert.equal(journalCommand(["--", "--quiet", "looking", "note"]), 0);
    const loaded = readJournal(join(home, "journal.jsonl"));
    assert.equal(loaded.records[0].note, "--quiet looking note");
  } finally {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
  }
});

test("journalCommand with whitespace-only note exits 1", () => {
  const home = mkdtempSync(join(tmpdir(), "rocky-home-"));
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  try {
    assert.equal(journalCommand(["   "]), 1);
    assert.equal(readJournal(join(home, "journal.jsonl")).records.length, 0);
  } finally {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
  }
});
