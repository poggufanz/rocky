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
    for (const word of lower.split(/[^\p{Alphabetic}\p{N}]+/u)) {
      if (idBanned.has(word)) {
        violations.push(`banned ID word \`${word}\` in \`${text}\``);
      }
    }
    for (const phrase of enBanned) {
      if (phrase.length === 0) continue;
      let index = lower.indexOf(phrase);
      while (index !== -1) {
        violations.push(`banned EN phrase \`${phrase}\` in \`${text}\``);
        index = lower.indexOf(phrase, index + phrase.length);
      }
    }
  }
  return violations;
}
