import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { causalWordViolations } from "./causal-words.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface CausalWordsFixture {
  readonly id_words: readonly string[];
  readonly en_phrases: readonly string[];
}

test("fixture holds the 13 canonical entries", () => {
  const fixture = JSON.parse(
    readFileSync(join(packageRoot, "fixtures", "causal-words.json"), "utf8"),
  ) as CausalWordsFixture;

  assert.equal(fixture.id_words.length, 7);
  assert.equal(fixture.en_phrases.length, 6);
  assert.deepEqual(fixture.id_words, [
    "untuk",
    "agar",
    "supaya",
    "karena",
    "sehingga",
    "diperbaiki",
    "memperbaiki",
  ]);
  assert.deepEqual(fixture.en_phrases, [
    "because",
    "so that",
    "in order to",
    "to ensure",
    "fixed",
    "resolved",
  ]);
});

test("matches the Rust rule", () => {
  assert.deepEqual(causalWordViolations(["passed after edit", "Untukmu"]), []);
  assert.equal(causalWordViolations(["passed karena edit"]).length, 1);
  assert.equal(causalWordViolations(["It was Fixed"]).length, 1);
  assert.equal(causalWordViolations(["Edited in order to pass"]).length, 1);
  assert.equal(causalWordViolations(["KARENA, edit"]).length, 1);
});
