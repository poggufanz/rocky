import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildProblems, type Attempt, type AttemptOutcome } from "../core/attempts.js";
import { joinAttemptCards } from "../core/attempt-cards.js";
import {
  MEMORY_FORMAT_VERSION,
  parseMemoryRecord,
  resolveMemoryRecords,
  type MemoryCoverage,
  type MemoryRecord,
} from "../core/memory-read.js";
import type { StoredCard } from "../desk/cards-record.js";

interface ExpectedEntry {
  cwd: string;
  keyStrength: "output" | "command";
  outcomes: AttemptOutcome[];
  changes?: Array<"observed" | "testimony" | "unknown">;
  expectations?: NonNullable<Attempt["expectations"]>[];
  historyMayStartEarlier?: boolean;
  crossSession?: boolean;
  sessionScoped?: boolean[];
}

interface GoldenFixture {
  now: number;
  coverage?: MemoryCoverage;
  lines: unknown[];
  cards?: StoredCard[];
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

function readFixture(file: string) {
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
  return { fixture, records, coverage };
}

for (const file of fixtureFiles) {
  test(`golden attempts: ${file}`, () => {
    const { fixture, records, coverage } = readFixture(file);

    const result = buildProblems(records, coverage, { now: fixture.now });
    const entries = fixture.cards !== undefined
      ? joinAttemptCards(
          result.entries,
          records,
          () => ({ cards: fixture.cards!, complete: true }),
          { platform: "linux" },
        ).entries
      : result.entries;

    if (fixture.expect.ungroupedLegacy !== undefined) {
      assert.equal(result.ungroupedLegacy, fixture.expect.ungroupedLegacy);
    }
    assert.equal(entries.length, fixture.expect.entries.length);

    for (let index = 0; index < fixture.expect.entries.length; index += 1) {
      const expected = fixture.expect.entries[index]!;
      const actual = entries[index]!;
      assert.equal(actual.cwd, expected.cwd, `${file} entry[${index}].cwd`);
      assert.equal(actual.keyStrength, expected.keyStrength, `${file} entry[${index}].keyStrength`);
      assert.deepEqual(
        actual.attempts.map((attempt) => attempt.outcome),
        expected.outcomes,
        `${file} entry[${index}].outcomes`,
      );
      if (expected.changes !== undefined) {
        assert.deepEqual(
          actual.attempts.map((attempt) => attempt.changes.state),
          expected.changes,
          `${file} entry[${index}].changes`,
        );
      }
      if (expected.expectations !== undefined) {
        assert.deepEqual(
          actual.attempts.map((attempt) => attempt.expectations ?? []),
          expected.expectations,
          `${file} entry[${index}].expectations`,
        );
      }
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
      if (expected.sessionScoped !== undefined) {
        assert.deepEqual(
          actual.attempts.map((a) => a.sessionScoped),
          expected.sessionScoped,
          `${file} entry[${index}].sessionScoped`,
        );
      }
    }
  });
}

test("mcp rationale goes to expectations, never to stated", () => {
  const { fixture, records, coverage } = readFixture("21-expectation-same-command-passed.json");
  const { entries } = buildProblems(records, coverage, { now: fixture.now });
  const attempt = entries[0]!.attempts[0]!;
  assert.deepEqual(attempt.stated, {
    text: "Updated the auth test data.",
    source: "rationale",
    recordId: "r-human",
  });
  assert.deepEqual(attempt.changes, {
    state: "testimony",
    files: ["test/auth.ts"],
    rationaleId: "r-human",
  });
  assert.deepEqual(attempt.expectations, [{
    text: "expect auth tests pass",
    command: "npm test",
    rationaleId: "r1",
    observed: "same_command_passed",
  }]);
});

test("observed matrix", () => {
  const fingerprint = "aaaa000000000021";
  const cases = [
    ["21-expectation-same-command-passed.json", "same_command_passed"],
    ["22-expectation-same-command-failed.json", "same_command_failed"],
    ["23-expectation-no-matching-run.json", "no_matching_run"],
    ["24-expectation-not-comparable.json", "not_comparable"],
  ] as const;

  for (const [file, observed] of cases) {
    const { fixture, records, coverage } = readFixture(file);
    const now = fixture.now;
    const full = buildProblems(records, coverage, { now });
    const single = buildProblems(records, coverage, { now, fingerprint });
    assert.equal(single.entries.length, 1);
    const fullEntry = full.entries.find((entry) => entry.fingerprint === fingerprint);
    assert.deepEqual(single.entries[0], fullEntry, file);
    assert.equal(single.entries[0]!.attempts[0]!.expectations?.[0]?.observed, observed, file);
  }
});
