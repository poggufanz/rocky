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
const TAG_RE = /<x id="(\d+)"><\/x>/g;
const TOKEN_RE = /V(\d+)/g;
// Prose that already holds a capital V-number, or a tag followed by a digit,
// would make the tokens ambiguous on the way back. A lowercase `v2` is safe:
// only a capital V is read back, and a clash still fails `restoreLine`.
const TOKEN_UNSAFE_RE = /V\d|<\/x>\d/;

/**
 * Bergamot strips tags before the model runs, so `Di <x id="0"></x>:` reaches
 * it as `Di :` and comes back as `In In`. A word-like token `V1` keeps the
 * sentence whole. Returns undefined when the line keeps its tags instead.
 */
function toTokens(line: PreparedLine): string | undefined {
  if (line.codes.length === 0 || TOKEN_UNSAFE_RE.test(line.html)) return undefined;
  return line.html.replace(TAG_RE, (_, id: string) => `V${Number(id) + 1}`);
}

function fromTokens(out: string): string {
  return out.replace(TOKEN_RE, (_, n: string) => `<x id="${Number(n) - 1}"></x>`);
}

/** Restores one engine output line, or undefined on any drift. */
function restoreOutput(out: unknown, line: PreparedLine, tokened: boolean): string | undefined {
  if (typeof out !== "string" || /[\r\n]/.test(out)) return undefined;
  return restoreLine(tokened ? fromTokens(out) : out, line);
}

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
  let loaded: TranslatorLoad;
  try {
    loaded = await load(pair);
  } catch {
    return { ok: false, reason: "load-failed" };
  }
  if (!loaded.ok) {
    return { ok: false, reason: loaded.reason };
  }

  const sendLines = prepared.lines.filter(
    (line): line is PreparedLine => line !== null && line.send,
  );
  const tokenLines = sendLines.map(toTokens);
  const translator = loaded.translator;
  const run = (lines: string[]): string[] | "engine-error" | "placeholder-mismatch" => {
    let out: string[];
    try {
      out = translator.translate(lines);
    } catch {
      return "engine-error";
    }
    return Array.isArray(out) && out.length === lines.length ? out : "placeholder-mismatch";
  };

  const first = run(sendLines.map((line, i) => tokenLines[i] ?? line.html));
  if (typeof first === "string") return { ok: false, reason: first };
  const restored = sendLines.map((line, i) =>
    restoreOutput(first[i], line, tokenLines[i] !== undefined),
  );

  // Tokens that drift get one more pass with the tag placeholders.
  const retry = sendLines
    .map((_, i) => i)
    .filter((i) => restored[i] === undefined && tokenLines[i] !== undefined);
  if (retry.length > 0) {
    const second = run(retry.map((i) => sendLines[i].html));
    if (typeof second === "string") return { ok: false, reason: second };
    retry.forEach((i, j) => {
      restored[i] = restoreOutput(second[j], sendLines[i], false);
    });
  }
  if (restored.some((text) => text === undefined)) {
    return { ok: false, reason: "placeholder-mismatch" };
  }

  let restoredIndex = 0;
  const assembled = prepared.lines.map((line) => {
    if (line === null) return "";
    if (!line.send) return line.plain;
    return restored[restoredIndex++];
  });

  return { ok: true, from, text: assembled.join("\n") };
}
