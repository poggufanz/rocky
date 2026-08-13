import { queryDictionary, type DictionaryHit } from "../core/dictionary.js";
import { loadMemory, type MemoryRecord } from "../core/memory-read.js";
import { ago, detail, say } from "../ui/rocky.js";

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

function subject(hit: DictionaryHit): string {
  const first = hit.triple.mechanism.files[0];
  return first ? first.props[0] ?? first.path : "something";
}

function shorten(text: string): string {
  return text.length > 40 ? `${text.slice(0, 37)}...` : text;
}

function evidence(hits: DictionaryHit[], support: (line: string) => void): void {
  for (const hit of hits) {
    const first = hit.triple.mechanism.files[0];
    if (!first || !hit.triple.intent) continue;
    support(`${shorten(hit.triple.intent.text)} -> ${subject(hit)}  (${first.path} +${first.plusMinus[0]} -${first.plusMinus[1]}, ${ago(hit.triple.ts)})`);
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
    speak(`"${query}"... I not hear this before. I listen now.`);
    return 0;
  }
  speak(`you say "${query}". it is ${subject(hits[0])}. I think. check, question`);
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
    speak(`"${query}"... no memory. you teach me when you work. good good.`);
    return 0;
  }
  speak(`last time you say "${query}", it become ${subject(hits[0])}. maybe you mean ${subject(hits[0])}, question`);
  evidence(hits, support);
  return 0;
}
