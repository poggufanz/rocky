import { queryDictionary, type DictionaryHit } from "../core/dictionary.js";
import { loadMemory, type MemoryRecord } from "../core/memory-read.js";
import { replaceAnsiAndControls, stripInvisibleControls } from "../core/redact.js";
import { truncateUtf8 } from "../mcp/privacy.js";
import { ago, detail, say } from "../ui/rocky.js";

const MAX_QUERY_DISPLAY_BYTES = 160;
const MAX_SUBJECT_DISPLAY_BYTES = 120;
const MAX_PATH_DISPLAY_BYTES = 180;
const MAX_INTENT_DISPLAY_BYTES = 128;
const MAX_OUTPUT_LINE_BYTES = 512;

export interface DictionaryCommandDeps {
  load?: () => MemoryRecord[];
  say?: (line: string) => void;
  out?: (line: string) => void;
}

interface Sinks {
  speak: (line: string) => void;
  support: (line: string) => void;
  records: () => MemoryRecord[];
}

function resolve(deps: DictionaryCommandDeps): Sinks {
  return { speak: deps.say ?? say, support: deps.out ?? detail, records: deps.load ?? loadMemory };
}

function terminalSafe(value: string, maximumBytes: number): string {
  const withoutSequences = replaceAnsiAndControls(value, " ", " ");
  const withoutControls = stripInvisibleControls(withoutSequences)
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/[\u2028\u2029]/gu, " ")
    .replace(/[?？]/gu, " ");
  return truncateUtf8(withoutControls, maximumBytes).value;
}

function subject(hit: DictionaryHit): string {
  const first = hit.triple.mechanism.files[0];
  return terminalSafe(first ? first.props[0] ?? first.path : "something", MAX_SUBJECT_DISPLAY_BYTES);
}

function shorten(text: string): string {
  const safe = terminalSafe(text, MAX_INTENT_DISPLAY_BYTES);
  return safe.length > 40 ? `${safe.slice(0, 37)}...` : safe;
}

function evidence(hits: DictionaryHit[], support: (line: string) => void): void {
  for (const hit of hits) {
    const first = hit.triple.mechanism.files[0];
    if (!first || !hit.triple.intent) continue;
    const line = `${shorten(hit.triple.intent.text)} -> ${subject(hit)}  (${terminalSafe(first.path, MAX_PATH_DISPLAY_BYTES)} +${first.plusMinus[0]} -${first.plusMinus[1]}, ${ago(hit.triple.ts)})`;
    support(terminalSafe(line, MAX_OUTPUT_LINE_BYTES));
  }
}

export function what(argv: string[], deps: DictionaryCommandDeps = {}): number {
  const { speak, support, records } = resolve(deps);
  const query = argv.join(" ").trim();
  if (!query) {
    speak('what needs word to look up. rocky what "naikin", question');
    return 2;
  }
  const hits = queryDictionary(records(), query);
  if (hits.length === 0) {
    speak(terminalSafe(`"${terminalSafe(query, MAX_QUERY_DISPLAY_BYTES)}"... I not hear this before. I listen now.`, MAX_OUTPUT_LINE_BYTES));
    return 0;
  }
  speak(terminalSafe(`you say "${terminalSafe(query, MAX_QUERY_DISPLAY_BYTES)}". it is ${subject(hits[0])}. I think. check, question`, MAX_OUTPUT_LINE_BYTES));
  evidence(hits, support);
  return 0;
}

export function how(argv: string[], deps: DictionaryCommandDeps = {}): number {
  const { speak, support, records } = resolve(deps);
  const query = argv.join(" ").trim();
  if (!query) {
    speak('how needs word to remember. rocky how "naikin", question');
    return 2;
  }
  const hits = queryDictionary(records(), query);
  if (hits.length === 0) {
    speak(terminalSafe(`"${terminalSafe(query, MAX_QUERY_DISPLAY_BYTES)}"... no memory. you teach me when you work. good good.`, MAX_OUTPUT_LINE_BYTES));
    return 0;
  }
  const safeQuery = terminalSafe(query, MAX_QUERY_DISPLAY_BYTES);
  const safeSubject = subject(hits[0]);
  speak(terminalSafe(`last time you say "${safeQuery}", it become ${safeSubject}. maybe you mean ${safeSubject}, question`, MAX_OUTPUT_LINE_BYTES));
  evidence(hits, support);
  return 0;
}
