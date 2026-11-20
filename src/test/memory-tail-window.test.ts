import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  loadMemoryChecked,
  MAX_SUPPORTED_MEMORY_RECORDS,
  maxSupportedMemoryRecords,
} from "../core/memory-read.js";
import { failureLines, withRecordCap } from "./memory-cap-fixture.js";

function tempHome(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "rocky-tail-window-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("record cap seam applies only under ROCKY_TEST_SEAMS=1", (t) => {
  process.env.ROCKY_TEST_MAX_MEMORY_RECORDS = "50";
  t.after(() => { delete process.env.ROCKY_TEST_MAX_MEMORY_RECORDS; delete process.env.ROCKY_TEST_SEAMS; });
  assert.equal(maxSupportedMemoryRecords(), MAX_SUPPORTED_MEMORY_RECORDS);
  process.env.ROCKY_TEST_SEAMS = "1";
  assert.equal(maxSupportedMemoryRecords(), 50);
  process.env.ROCKY_TEST_SEAMS = "true";
  assert.equal(maxSupportedMemoryRecords(), MAX_SUPPORTED_MEMORY_RECORDS);
});

test("record cap seam ignores non-positive or non-integer values", (t) => {
  withRecordCap(t, 50);
  for (const bad of ["0", "-1", "1.5", "abc", ""]) {
    process.env.ROCKY_TEST_MAX_MEMORY_RECORDS = bad;
    assert.equal(maxSupportedMemoryRecords(), MAX_SUPPORTED_MEMORY_RECORDS);
  }
});

test("reader stops at the seam cap", (t) => {
  withRecordCap(t, 50);
  const home = tempHome(t);
  writeFileSync(join(home, "memory.jsonl"), failureLines(50));
  assert.equal(loadMemoryChecked(join(home, "memory.jsonl")).coverage.complete, true);
  writeFileSync(join(home, "memory-over.jsonl"), failureLines(51));
  const over = loadMemoryChecked(join(home, "memory-over.jsonl"));
  assert.equal(over.records.length, 50);
  assert.equal(over.coverage.complete, false);
  assert.equal(over.coverage.reason, "record-cap");
});
