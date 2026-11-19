import { isConfidentlyIn, type Lang, type Pair } from "./language.js";
import { prepareQuote, restoreLine, type PreparedLine } from "./segments.js";

export interface Translator {
  translate(htmlLines: string[]): string[];
}

export type LoadFailure = "engine-missing" | "model-missing" | "load-failed";

export type TranslatorLoad =
  | { ok: true; translator: Translator }
  | { ok: false; reason: LoadFailure };

export type QuoteFailure =
  | "same-language"
  | "no-prose"
  | LoadFailure
  | "engine-error"
  | "placeholder-mismatch";

export type QuoteResult =
  | { ok: true; from: Lang; text: string }
  | { ok: false; reason: QuoteFailure };

const UNICODE_LETTER_RE = /\p{L}/u;

/**
 * Translates one agent quote into `to` using a pluggable translator loader,
 * failing closed on language/prose skips, load/engine errors, or placeholder drift.
 */
export async function translateQuote(
  text: string,
  to: Lang,
  load: (pair: Pair) => Promise<TranslatorLoad>,
): Promise<QuoteResult> {
  const prepared = prepareQuote(text);
  if (!UNICODE_LETTER_RE.test(prepared.prose)) {
    return { ok: false, reason: "no-prose" };
  }

  if (isConfidentlyIn(prepared.prose, to)) {
    return { ok: false, reason: "same-language" };
  }

  const from: Lang = to === "en" ? "id" : "en";
  const pair: Pair = to === "en" ? "id-en" : "en-id";
  const loaded = await load(pair);
  if (!loaded.ok) {
    return { ok: false, reason: loaded.reason };
  }

  const sendLines = prepared.lines.filter(
    (line): line is PreparedLine => line !== null && line.send,
  );
  const htmlLines = sendLines.map((line) => line.html);

  let translated: string[];
  try {
    translated = loaded.translator.translate(htmlLines);
  } catch {
    return { ok: false, reason: "engine-error" };
  }

  if (!Array.isArray(translated) || translated.length !== sendLines.length) {
    return { ok: false, reason: "placeholder-mismatch" };
  }

  const restored: string[] = [];
  for (let i = 0; i < sendLines.length; i++) {
    const outLine = translated[i];
    if (typeof outLine !== "string") {
      return { ok: false, reason: "placeholder-mismatch" };
    }
    const lineText = restoreLine(outLine, sendLines[i]);
    if (lineText === undefined) {
      return { ok: false, reason: "placeholder-mismatch" };
    }
    restored.push(lineText);
  }

  let restoredIndex = 0;
  const assembled = prepared.lines.map((line) => {
    if (line === null) return "";
    if (!line.send) return line.plain;
    return restored[restoredIndex++];
  });

  return { ok: true, from, text: assembled.join("\n") };
}
