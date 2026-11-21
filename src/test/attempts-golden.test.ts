import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildProblems, type AttemptOutcome } from "../core/attempts.js";
import {
  MEMORY_FORMAT_VERSION,
  parseMemoryRecord,
  resolveMemoryRecords,
  type MemoryCoverage,
  type MemoryRecord,
} from "../core/memory-read.js";

interface ExpectedEntry {
  cwd: string;
  keyStrength: "output" | "command";
  outcomes: AttemptOutcome[];
  historyMayStartEarlier?: boolean;
  crossSession?: boolean;
}

interface GoldenFixture {
  now: number;
  coverage?: MemoryCoverage;
  lines: unknown[];
  expect: {
    ungroupedLegacy?: number;
    entries: ExpectedEntry[];
  };
}

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixturesDir = join(packageRoot, "fixtures", "attempts");

const fixtureFiles = readdirSync(fixturesDir)
  .filter((name) => name.endsWith(".json"))
  .sort();

for (const file of fixtureFiles) {
  test(`golden attempts: ${file}`, () => {
    const fixture = JSON.parse(readFileSync(join(fixturesDir, file), "utf8")) as GoldenFixture;
    const records: MemoryRecord[] = [];
    for (const rawLine of fixture.lines) {
      let parsedJson: unknown = rawLine;
      if (typeof rawLine === "string") {
        try {
          parsedJson = JSON.parse(rawLine);
        } catch {
          continue;
        }
      }
      const record = parseMemoryRecord(parsedJson);
      if (record !== undefined) records.push(record);
    }
    resolveMemoryRecords(records, fixture.now);

    const coverage: MemoryCoverage = fixture.coverage ?? {
      version: MEMORY_FORMAT_VERSION,
      scanned: fixture.lines.length,
      skipped: 0,
      truncated: 0,
      bytesScanned: 0,
      bytesTotal: 0,
      complete: true,
    };

    const result = buildProblems(records, coverage, { now: fixture.now });

    if (fixture.expect.ungroupedLegacy !== undefined) {
      assert.equal(result.ungroupedLegacy, fixture.expect.ungroupedLegacy);
    }
    assert.equal(result.entries.length, fixture.expect.entries.length);

    for (let index = 0; index < fixture.expect.entries.length; index += 1) {
      const expected = fixture.expect.entries[index]!;
      const actual = result.entries[index]!;
      assert.equal(actual.cwd, expected.cwd, `${file} entry[${index}].cwd`);
      assert.equal(actual.keyStrength, expected.keyStrength, `${file} entry[${index}].keyStrength`);
      assert.deepEqual(
        actual.attempts.map((attempt) => attempt.outcome),
        expected.outcomes,
        `${file} entry[${index}].outcomes`,
      );
      if (expected.historyMayStartEarlier !== undefined) {
        assert.equal(
          actual.historyMayStartEarlier,
          expected.historyMayStartEarlier,
          `${file} entry[${index}].historyMayStartEarlier`,
        );
      }
      if (expected.crossSession !== undefined) {
        assert.equal(
          actual.attempts.some((attempt) => attempt.crossSession === true),
          expected.crossSession,
          `${file} entry[${index}].crossSession`,
        );
      }
    }
  });
}
