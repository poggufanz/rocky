import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface CausalWordsFixture {
  readonly id_words: readonly string[];
  readonly en_phrases: readonly string[];
}

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const fixture = JSON.parse(
  readFileSync(join(packageRoot, "fixtures", "causal-words.json"), "utf8"),
) as CausalWordsFixture;

const idBanned = new Set(fixture.id_words.map((word) => word.toLowerCase()));
const enBanned = fixture.en_phrases.map((phrase) => phrase.toLowerCase());

export function causalWordViolations(texts: readonly string[]): string[] {
  const violations: string[] = [];
  for (const text of texts) {
    const lower = text.toLowerCase();
    for (const word of lower.split(/[^\p{L}\p{N}]+/u)) {
      if (idBanned.has(word)) {
        violations.push(`banned ID word \`${word}\` in \`${text}\``);
      }
    }
    for (const phrase of enBanned) {
      if (lower.includes(phrase)) {
        violations.push(`banned EN phrase \`${phrase}\` in \`${text}\``);
      }
    }
  }
  return violations;
}
