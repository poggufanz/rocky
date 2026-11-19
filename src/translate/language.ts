export type Lang = "en" | "id";
export type Pair = "id-en" | "en-id";

const COMMON_WORDS: Record<Lang, ReadonlySet<string>> = {
  id: new Set([
    "yang",
    "dan",
    "di",
    "ke",
    "dari",
    "tidak",
    "sudah",
    "untuk",
    "dengan",
    "ini",
    "itu",
    "karena",
    "saya",
    "belum",
  ]),
  en: new Set([
    "the",
    "and",
    "to",
    "of",
    "is",
    "that",
    "for",
    "with",
    "this",
    "not",
    "because",
    "i",
    "was",
  ]),
};

/**
 * Returns true when prose contains at least two common words of `lang`
 * and leads the other language by at least two hits.
 */
/** True for a word on either language's common-word list ("untuk", "the"). */
export function isCommonWord(word: string): boolean {
  const lower = word.toLowerCase();
  return COMMON_WORDS.id.has(lower) || COMMON_WORDS.en.has(lower);
}

export function isConfidentlyIn(prose: string, lang: Lang): boolean {
  const other: Lang = lang === "en" ? "id" : "en";
  const targetWords = COMMON_WORDS[lang];
  const otherWords = COMMON_WORDS[other];

  let targetHits = 0;
  let otherHits = 0;

  for (const token of prose.toLowerCase().split(/[^\p{L}]+/u)) {
    if (token.length === 0) continue;
    if (targetWords.has(token)) targetHits++;
    if (otherWords.has(token)) otherHits++;
  }

  return targetHits >= 2 && targetHits - otherHits >= 2;
}
