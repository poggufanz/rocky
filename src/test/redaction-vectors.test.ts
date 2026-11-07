import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { redactSecretsAtBoundary } from "../core/redact.js";

interface RedactionVector {
  readonly name: string;
  readonly input: string;
  readonly may_be_truncated: boolean;
  readonly expected: string;
}

const REPLACEMENT_LABELS = [
  "aws access key",
  "private key",
  "github token",
  "slack token",
  "anthropic key",
  "openai key",
  "npm token",
  "password assignment",
  "credential assignment",
] as const;

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const vectors: readonly RedactionVector[] = JSON.parse(
  readFileSync(join(packageRoot, "fixtures", "redaction", "vectors.json"), "utf8"),
) as readonly RedactionVector[];

test("redaction vectors match the node implementation", () => {
  for (const vector of vectors) {
    assert.equal(
      redactSecretsAtBoundary(vector.input, { mayBeTruncated: vector.may_be_truncated }),
      vector.expected,
      vector.name,
    );
  }
});

test("redaction vectors are sorted, unique, and cover every secret family", () => {
  const names = vectors.map((vector) => vector.name);
  assert.equal(new Set(names).size, names.length, "vector names must be unique");
  assert.deepEqual(names, [...names].sort(), "vector names must be sorted");
  for (const label of REPLACEMENT_LABELS) {
    assert.ok(
      vectors.some((vector) => vector.expected.includes(`[redacted ${label}]`)),
      `no expected output uses the ${label} replacement label`,
    );
  }
});
